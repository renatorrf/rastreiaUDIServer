SET LOCAL search_path TO rastreia, public;

ALTER TABLE courier_workdays
  ADD COLUMN decline_reason_code text,
  ADD COLUMN decline_reason_detail text,
  ADD COLUMN declined_at timestamptz,
  ADD COLUMN decline_revoked_at timestamptz,
  ADD COLUMN decline_revoked_by uuid REFERENCES users(id),
  ADD COLUMN decline_revocation_reason text;

UPDATE courier_workdays SET decline_reason_code='OTHER',
  decline_reason_detail='Ausência registrada antes da atualização',
  declined_at=COALESCE(confirmed_at,updated_at,created_at)
WHERE status='DECLINED';

ALTER TABLE courier_workdays ADD CONSTRAINT courier_workdays_decline_reason_check CHECK (
  (status <> 'DECLINED') OR (
    declined_at IS NOT NULL
    AND decline_reason_code IN ('PERSONAL_EMERGENCY','HEALTH','VEHICLE','WEATHER','OTHER')
    AND (decline_reason_code <> 'OTHER' OR length(trim(COALESCE(decline_reason_detail,''))) >= 3)
  )
);

CREATE INDEX courier_workdays_declined_store
  ON courier_workdays(store_id, starts_at)
  WHERE status='DECLINED';
