SET search_path TO rastreia, public;

ALTER TABLE shift_confirmations
  ADD COLUMN reminder_sent_at timestamptz;

CREATE INDEX idx_shift_confirmations_reminder_due
  ON shift_confirmations (status, reminder_sent_at, due_at)
  WHERE reminder_sent_at IS NULL AND status IN ('PENDING', 'CONFIRMED');
