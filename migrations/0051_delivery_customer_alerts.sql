-- Operational milestones, separate from delivery status and incident reports.
ALTER TABLE rastreia.deliveries ADD COLUMN arrived_at timestamptz;
ALTER TABLE rastreia.deliveries ADD COLUMN waiting_at_gate_at timestamptz;
