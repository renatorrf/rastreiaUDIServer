import { describe, expect, it } from 'vitest';
import { operationalMetricsCsv } from '../src/modules/metrics/operational-metrics.service.js';
import type { OperationalMetricSet, OperationalMetricsReport } from '../src/modules/metrics/operational-metrics.types.js';

const metrics: OperationalMetricSet = {
  pickup: { evaluated: 2, onTime: 1, late: 1, pending: 0, rate: 0.5, averageDelayMinutes: 12.5 },
  delivery: { evaluated: 2, onTime: 2, late: 0, pending: 0, rate: 1, averageDelayMinutes: null },
  routes: { started: 1, completed: 1, averageDurationMinutes: 30, totalDurationHours: 0.5 },
  productivity: { delivered: 2, activeCouriers: 1, deliveriesPerCourier: 2, deliveriesPerRouteHour: 4 },
};

describe('operational metrics export', () => {
  it('gera CSV compatível, versionado e neutraliza fórmulas em dimensões', () => {
    const report: OperationalMetricsReport = {
      scope: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-08T00:00:00.000Z',
        generatedAt: '2026-08-08T00:00:00.000Z', storeId: null, courierId: null },
      summary: metrics,
      dimensions: [{ dimension: 'STORE', id: 'store-id', name: '=HIPERLINK("malicioso")', ...metrics }],
      rules: [], separation: { operational: 'Operação.', reputation: 'Reputação separada.' },
    };
    const csv = operationalMetricsCsv(report);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('sla_entrega_percentual');
    expect(csv).toContain('operational-v1');
    expect(csv).toContain("'=HIPERLINK");
    expect(csv).not.toContain('recipient_name');
    expect(csv).not.toContain('address_line');
  });
});
