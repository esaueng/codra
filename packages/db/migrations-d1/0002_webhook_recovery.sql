ALTER TABLE jobs ADD COLUMN webhook_delivery_id TEXT;

CREATE UNIQUE INDEX jobs_webhook_delivery_idx
  ON jobs (webhook_delivery_id)
  WHERE webhook_delivery_id IS NOT NULL;

ALTER TABLE webhook_deliveries
  ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'received'
  CHECK (processing_status IN ('received', 'queue_pending', 'processed', 'ignored'));

ALTER TABLE webhook_deliveries ADD COLUMN processed_at TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;

CREATE INDEX webhook_deliveries_processing_idx
  ON webhook_deliveries (processing_status, received_at);

CREATE TABLE webhook_queue_submissions (
  id             TEXT PRIMARY KEY,
  delivery_id    TEXT NOT NULL UNIQUE REFERENCES webhook_deliveries(delivery_id) ON DELETE CASCADE,
  job_id         TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  message_json   TEXT NOT NULL CHECK (json_valid(message_json)),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sending', 'sent')),
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  locked_at      TEXT,
  sent_at        TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX webhook_queue_submissions_pending_idx
  ON webhook_queue_submissions (status, locked_at, created_at)
  WHERE status != 'sent';
