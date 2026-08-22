SET search_path TO rastreia, public;

CREATE INDEX deliveries_sla_deadline_idx
  ON deliveries (tenant_id, promised_window_end, store_id, courier_profile_id)
  WHERE promised_window_end IS NOT NULL AND cancelled_at IS NULL;

CREATE INDEX deliveries_productivity_idx
  ON deliveries (tenant_id, delivered_at, store_id, courier_profile_id)
  WHERE delivered_at IS NOT NULL;

CREATE INDEX delivery_offers_pickup_sla_idx
  ON delivery_offers (tenant_id, pickup_window_end, store_id, winner_courier_id)
  WHERE status IN ('ACCEPTED', 'COMPLETED');

CREATE INDEX routes_duration_metrics_idx
  ON routes (tenant_id, started_at, store_id, courier_profile_id)
  WHERE started_at IS NOT NULL AND status <> 'CANCELLED';
