SET search_path TO rastreia, public;

ALTER TABLE route_stops
  ADD COLUMN urgent_at timestamptz,
  ADD COLUMN urgent_reason text CHECK (urgent_reason IS NULL OR char_length(urgent_reason) <= 240),
  ADD COLUMN urgent_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX route_stops_urgent_idx
  ON route_stops (tenant_id, route_id, urgent_at DESC)
  WHERE urgent_at IS NOT NULL;

