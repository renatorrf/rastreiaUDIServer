SET search_path TO rastreia, public;

ALTER TABLE routes
  ADD COLUMN suggested_stop_ids uuid[],
  ADD COLUMN suggestion_provider text CHECK (suggestion_provider IS NULL OR suggestion_provider IN ('GEOAPIFY', 'HAVERSINE')),
  ADD COLUMN suggested_current_distance_m integer CHECK (suggested_current_distance_m IS NULL OR suggested_current_distance_m >= 0),
  ADD COLUMN suggested_total_distance_m integer CHECK (suggested_total_distance_m IS NULL OR suggested_total_distance_m >= 0),
  ADD COLUMN suggested_total_duration_s integer CHECK (suggested_total_duration_s IS NULL OR suggested_total_duration_s >= 0),
  ADD COLUMN suggested_legs jsonb,
  ADD COLUMN suggested_at timestamptz,
  ADD COLUMN plan_applied_at timestamptz,
  ADD COLUMN estimated_total_distance_m integer CHECK (estimated_total_distance_m IS NULL OR estimated_total_distance_m >= 0),
  ADD COLUMN estimated_total_duration_s integer CHECK (estimated_total_duration_s IS NULL OR estimated_total_duration_s >= 0),
  ADD COLUMN eta_calculated_at timestamptz;

ALTER TABLE route_stops
  ADD COLUMN estimated_distance_from_previous_m integer CHECK (estimated_distance_from_previous_m IS NULL OR estimated_distance_from_previous_m >= 0),
  ADD COLUMN estimated_duration_from_previous_s integer CHECK (estimated_duration_from_previous_s IS NULL OR estimated_duration_from_previous_s >= 0),
  ADD COLUMN estimated_arrival_at timestamptz;

CREATE INDEX route_stops_eta_idx ON route_stops (tenant_id, delivery_id, estimated_arrival_at)
  WHERE stop_type = 'DELIVERY';
