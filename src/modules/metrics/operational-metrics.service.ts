import type { QueryResultRow } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError } from '../../shared/errors.js';
import type { AuthContext } from '../auth/auth.types.js';
import type {
  OperationalMetricDimension, OperationalMetricSet, OperationalMetricsFilter, OperationalMetricsReport,
} from './operational-metrics.types.js';

interface MetricRow extends QueryResultRow {
  dimension: 'SUMMARY' | 'STORE' | 'COURIER';
  dimension_id: string | null;
  dimension_name: string | null;
  pickup_evaluated: string;
  pickup_on_time: string;
  pickup_pending: string;
  pickup_average_delay_minutes: string | null;
  delivery_evaluated: string;
  delivery_on_time: string;
  delivery_pending: string;
  delivery_average_delay_minutes: string | null;
  routes_started: string;
  routes_completed: string;
  average_route_duration_minutes: string | null;
  total_route_duration_minutes: string;
  delivered_count: string;
  active_couriers: string;
}

const reportSql = `
WITH metric_events AS (
  SELECT 'PICKUP'::text AS event_type, offer.store_id,
         COALESCE(delivery.courier_profile_id, offer.winner_courier_id) AS courier_id,
         (delivery.collected_at IS NOT NULL OR offer.pickup_window_end <= $3) AS evaluated,
         (delivery.collected_at IS NOT NULL AND delivery.collected_at <= offer.pickup_window_end) AS on_time,
         CASE WHEN delivery.collected_at IS NOT NULL OR offer.pickup_window_end <= $3
              THEN GREATEST(EXTRACT(EPOCH FROM (COALESCE(delivery.collected_at, $3) - offer.pickup_window_end)) / 60, 0)
              ELSE NULL END AS delay_minutes,
         NULL::numeric AS route_duration_minutes
  FROM delivery_offers offer
  JOIN deliveries delivery ON delivery.id = offer.delivery_id AND delivery.tenant_id = offer.tenant_id
  WHERE offer.pickup_window_end >= $1 AND offer.pickup_window_end < $2
    AND offer.status IN ('ACCEPTED', 'COMPLETED')
    AND delivery.cancelled_at IS NULL
    AND ($4::uuid IS NULL OR offer.store_id = $4)
    AND ($5::uuid IS NULL OR COALESCE(delivery.courier_profile_id, offer.winner_courier_id) = $5)
    AND ($6::uuid[] IS NULL OR offer.store_id = ANY($6))

  UNION ALL

  SELECT 'DELIVERY', delivery.store_id, delivery.courier_profile_id,
         (delivery.delivered_at IS NOT NULL OR COALESCE(delivery.promised_window_end, offer.delivery_window_end) <= $3),
         (delivery.delivered_at IS NOT NULL AND delivery.delivered_at <= COALESCE(delivery.promised_window_end, offer.delivery_window_end)),
         CASE WHEN delivery.delivered_at IS NOT NULL
                    OR COALESCE(delivery.promised_window_end, offer.delivery_window_end) <= $3
              THEN GREATEST(EXTRACT(EPOCH FROM (
                     COALESCE(delivery.delivered_at, $3) - COALESCE(delivery.promised_window_end, offer.delivery_window_end)
                   )) / 60, 0)
              ELSE NULL END,
         NULL::numeric
  FROM deliveries delivery
  LEFT JOIN delivery_offers offer ON offer.delivery_id = delivery.id AND offer.tenant_id = delivery.tenant_id
  WHERE COALESCE(delivery.promised_window_end, offer.delivery_window_end) >= $1
    AND COALESCE(delivery.promised_window_end, offer.delivery_window_end) < $2
    AND delivery.cancelled_at IS NULL
    AND ($4::uuid IS NULL OR delivery.store_id = $4)
    AND ($5::uuid IS NULL OR delivery.courier_profile_id = $5)
    AND ($6::uuid[] IS NULL OR delivery.store_id = ANY($6))

  UNION ALL

  SELECT 'ROUTE', route.store_id, route.courier_profile_id,
         (route.completed_at IS NOT NULL), NULL::boolean, NULL::numeric,
         CASE WHEN route.completed_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (route.completed_at - route.started_at)) / 60 ELSE NULL END
  FROM routes route
  WHERE route.started_at >= $1 AND route.started_at < $2
    AND route.status <> 'CANCELLED'
    AND ($4::uuid IS NULL OR route.store_id = $4)
    AND ($5::uuid IS NULL OR route.courier_profile_id = $5)
    AND ($6::uuid[] IS NULL OR route.store_id = ANY($6))

  UNION ALL

  SELECT 'DELIVERED', delivery.store_id, delivery.courier_profile_id,
         TRUE, NULL::boolean, NULL::numeric, NULL::numeric
  FROM deliveries delivery
  WHERE delivery.delivered_at >= $1 AND delivery.delivered_at < $2
    AND ($4::uuid IS NULL OR delivery.store_id = $4)
    AND ($5::uuid IS NULL OR delivery.courier_profile_id = $5)
    AND ($6::uuid[] IS NULL OR delivery.store_id = ANY($6))
), grouped AS (
  SELECT store_id, courier_id, GROUPING(store_id) AS store_grouping, GROUPING(courier_id) AS courier_grouping,
         count(*) FILTER (WHERE event_type = 'PICKUP' AND evaluated)::text AS pickup_evaluated,
         count(*) FILTER (WHERE event_type = 'PICKUP' AND on_time)::text AS pickup_on_time,
         count(*) FILTER (WHERE event_type = 'PICKUP' AND NOT evaluated)::text AS pickup_pending,
         round((avg(delay_minutes) FILTER (WHERE event_type = 'PICKUP' AND evaluated AND NOT on_time))::numeric, 1)::text
           AS pickup_average_delay_minutes,
         count(*) FILTER (WHERE event_type = 'DELIVERY' AND evaluated)::text AS delivery_evaluated,
         count(*) FILTER (WHERE event_type = 'DELIVERY' AND on_time)::text AS delivery_on_time,
         count(*) FILTER (WHERE event_type = 'DELIVERY' AND NOT evaluated)::text AS delivery_pending,
         round((avg(delay_minutes) FILTER (WHERE event_type = 'DELIVERY' AND evaluated AND NOT on_time))::numeric, 1)::text
           AS delivery_average_delay_minutes,
         count(*) FILTER (WHERE event_type = 'ROUTE')::text AS routes_started,
         count(*) FILTER (WHERE event_type = 'ROUTE' AND evaluated)::text AS routes_completed,
         round((avg(route_duration_minutes) FILTER (WHERE event_type = 'ROUTE' AND evaluated))::numeric, 1)::text
           AS average_route_duration_minutes,
         COALESCE(round((sum(route_duration_minutes) FILTER (WHERE event_type = 'ROUTE' AND evaluated))::numeric, 1), 0)::text
           AS total_route_duration_minutes,
         count(*) FILTER (WHERE event_type = 'DELIVERED')::text AS delivered_count,
         count(DISTINCT courier_id) FILTER (WHERE event_type = 'DELIVERED' AND courier_id IS NOT NULL)::text
           AS active_couriers
  FROM metric_events
  GROUP BY GROUPING SETS ((store_id), (courier_id), ())
)
SELECT CASE WHEN grouped.store_grouping = 1 AND grouped.courier_grouping = 1 THEN 'SUMMARY'
            WHEN grouped.store_grouping = 0 THEN 'STORE' ELSE 'COURIER' END AS dimension,
       CASE WHEN grouped.store_grouping = 0 THEN grouped.store_id ELSE grouped.courier_id END AS dimension_id,
       CASE WHEN grouped.store_grouping = 0 THEN store.name
            WHEN grouped.courier_grouping = 0 THEN courier_user.name ELSE 'Resumo' END AS dimension_name,
       grouped.pickup_evaluated, grouped.pickup_on_time, grouped.pickup_pending,
       grouped.pickup_average_delay_minutes, grouped.delivery_evaluated, grouped.delivery_on_time,
       grouped.delivery_pending, grouped.delivery_average_delay_minutes, grouped.routes_started,
       grouped.routes_completed, grouped.average_route_duration_minutes, grouped.total_route_duration_minutes,
       grouped.delivered_count, grouped.active_couriers
FROM grouped
LEFT JOIN stores store ON grouped.store_grouping = 0 AND store.id = grouped.store_id
LEFT JOIN courier_profiles courier ON grouped.courier_grouping = 0 AND courier.id = grouped.courier_id
LEFT JOIN users courier_user ON courier_user.id = courier.user_id
WHERE (grouped.store_grouping = 1 AND grouped.courier_grouping = 1)
   OR (grouped.store_grouping = 0 AND grouped.courier_grouping = 1 AND grouped.store_id IS NOT NULL)
   OR (grouped.store_grouping = 1 AND grouped.courier_grouping = 0 AND grouped.courier_id IS NOT NULL)
ORDER BY dimension, dimension_name`;

function number(value: string | null): number { return value === null ? 0 : Number(value); }
function nullableNumber(value: string | null): number | null { return value === null ? null : Number(value); }
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function metricSet(row?: MetricRow): OperationalMetricSet {
  const pickupEvaluated = number(row?.pickup_evaluated ?? '0');
  const pickupOnTime = number(row?.pickup_on_time ?? '0');
  const deliveryEvaluated = number(row?.delivery_evaluated ?? '0');
  const deliveryOnTime = number(row?.delivery_on_time ?? '0');
  const totalRouteMinutes = number(row?.total_route_duration_minutes ?? '0');
  const delivered = number(row?.delivered_count ?? '0');
  const activeCouriers = number(row?.active_couriers ?? '0');
  return {
    pickup: {
      evaluated: pickupEvaluated, onTime: pickupOnTime, late: pickupEvaluated - pickupOnTime,
      pending: number(row?.pickup_pending ?? '0'), rate: ratio(pickupOnTime, pickupEvaluated),
      averageDelayMinutes: nullableNumber(row?.pickup_average_delay_minutes ?? null),
    },
    delivery: {
      evaluated: deliveryEvaluated, onTime: deliveryOnTime, late: deliveryEvaluated - deliveryOnTime,
      pending: number(row?.delivery_pending ?? '0'), rate: ratio(deliveryOnTime, deliveryEvaluated),
      averageDelayMinutes: nullableNumber(row?.delivery_average_delay_minutes ?? null),
    },
    routes: {
      started: number(row?.routes_started ?? '0'), completed: number(row?.routes_completed ?? '0'),
      averageDurationMinutes: nullableNumber(row?.average_route_duration_minutes ?? null),
      totalDurationHours: Math.round((totalRouteMinutes / 60) * 100) / 100,
    },
    productivity: {
      delivered, activeCouriers, deliveriesPerCourier: ratio(delivered, activeCouriers),
      deliveriesPerRouteHour: ratio(delivered, totalRouteMinutes / 60),
    },
  };
}

function normalizeFilter(filter: OperationalMetricsFilter) {
  const generatedAt = new Date();
  const to = filter.to ?? generatedAt;
  const from = filter.from ?? new Date(to.getTime() - 7 * 24 * 60 * 60_000);
  if (from >= to) throw new AppError(400, 'INVALID_PERIOD', 'O fim do período deve ser posterior ao início.');
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60_000) {
    throw new AppError(400, 'INVALID_PERIOD', 'O período máximo é de 366 dias.');
  }
  return { from, to, generatedAt, storeId: filter.storeId ?? null, courierId: filter.courierId ?? null };
}

export async function getOperationalMetrics(
  database: Database, auth: AuthContext, filter: OperationalMetricsFilter,
): Promise<OperationalMetricsReport> {
  const scope = normalizeFilter(filter);
  const allowedStores = auth.role === 'TENANT_MANAGER' ? null : auth.storeIds;
  const result = await withTenantTransaction(database, auth, (client) => client.query<MetricRow>(reportSql, [
    scope.from, scope.to, scope.generatedAt, scope.storeId, scope.courierId, allowedStores,
  ]));
  const summaryRow = result.rows.find((row) => row.dimension === 'SUMMARY');
  const dimensions: OperationalMetricDimension[] = result.rows
    .filter((row) => row.dimension !== 'SUMMARY' && row.dimension_id && row.dimension_name)
    .map((row) => ({ dimension: row.dimension as 'STORE' | 'COURIER', id: row.dimension_id as string,
      name: row.dimension_name as string, ...metricSet(row) }));
  return {
    scope: { from: scope.from.toISOString(), to: scope.to.toISOString(), generatedAt: scope.generatedAt.toISOString(),
      storeId: scope.storeId, courierId: scope.courierId },
    summary: metricSet(summaryRow), dimensions,
    rules: [
      { key: 'pickup_sla_v1', label: 'Coleta no prazo',
        definition: 'Coleta registrada até o fim da janela de coleta da oferta.',
        cohort: 'Ofertas aceitas ou concluídas cuja janela termina no período; cancelamentos não entram.' },
      { key: 'delivery_sla_v1', label: 'Entrega no prazo',
        definition: 'Entrega registrada até o fim da janela prometida; usa a janela da oferta quando a entrega não possui promessa própria.',
        cohort: 'Promessas que terminam no período; entregas canceladas não entram e prazos futuros ficam pendentes.' },
      { key: 'route_duration_v1', label: 'Tempo de rota',
        definition: 'Intervalo entre início e conclusão do lote.',
        cohort: 'Rotas não canceladas iniciadas no período; somente concluídas compõem duração e horas.' },
      { key: 'productivity_v1', label: 'Produtividade',
        definition: 'Entregas concluídas por entregador ativo e por hora de rota concluída.',
        cohort: 'Entregas concluídas no período; denominadores e amostras são apresentados separadamente.' },
    ],
    separation: {
      operational: 'Métricas operacionais descrevem prazo, fluxo e capacidade no recorte selecionado.',
      reputation: 'Reputação segue regras próprias do marketplace e não altera estes indicadores de SLA ou produtividade.',
    },
  };
}

function csvCell(value: string | number | null): string {
  const raw = value === null ? '' : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function percent(value: number | null): string { return value === null ? '' : (value * 100).toFixed(2); }

export function operationalMetricsCsv(report: OperationalMetricsReport): string {
  const header = ['tipo', 'id', 'nome', 'periodo_inicio', 'periodo_fim', 'coletas_avaliadas', 'coletas_no_prazo',
    'coletas_atrasadas', 'coletas_pendentes', 'sla_coleta_percentual', 'atraso_medio_coleta_min',
    'entregas_avaliadas', 'entregas_no_prazo', 'entregas_atrasadas', 'entregas_pendentes',
    'sla_entrega_percentual', 'atraso_medio_entrega_min', 'rotas_iniciadas', 'rotas_concluidas',
    'duracao_media_rota_min', 'horas_rota_concluida', 'entregas_concluidas', 'entregadores_ativos',
    'entregas_por_entregador', 'entregas_por_hora_rota', 'regra_versao'];
  const rows: Array<{ type: string; id: string; name: string; metrics: OperationalMetricSet }> = [
    { type: 'RESUMO', id: '', name: 'Resumo do período', metrics: report.summary },
    ...report.dimensions.map((item) => ({ type: item.dimension, id: item.id, name: item.name, metrics: item })),
  ];
  const lines = [header.map(csvCell).join(';'), ...rows.map(({ type, id, name, metrics }) => [
    type, id, name, report.scope.from, report.scope.to, metrics.pickup.evaluated, metrics.pickup.onTime,
    metrics.pickup.late, metrics.pickup.pending, percent(metrics.pickup.rate), metrics.pickup.averageDelayMinutes,
    metrics.delivery.evaluated, metrics.delivery.onTime, metrics.delivery.late, metrics.delivery.pending,
    percent(metrics.delivery.rate), metrics.delivery.averageDelayMinutes, metrics.routes.started, metrics.routes.completed,
    metrics.routes.averageDurationMinutes, metrics.routes.totalDurationHours, metrics.productivity.delivered,
    metrics.productivity.activeCouriers, metrics.productivity.deliveriesPerCourier,
    metrics.productivity.deliveriesPerRouteHour, 'operational-v1',
  ].map(csvCell).join(';'))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export async function auditOperationalMetricsExport(
  database: Database, auth: AuthContext, report: OperationalMetricsReport, ip?: string,
): Promise<void> {
  await withTenantTransaction(database, auth, (client) => writeAudit(client, {
    tenantId: auth.tenantId, actorUserId: auth.userId, action: 'OPERATIONAL_METRICS_EXPORTED',
    entityType: 'OPERATIONAL_METRICS', afterData: {
      scope: report.scope, dimensionCount: report.dimensions.length, rules: report.rules.map((rule) => rule.key),
      containsRecipientData: false,
    }, ...(ip ? { ip } : {}),
  }));
}
