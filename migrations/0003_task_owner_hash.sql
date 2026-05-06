ALTER TABLE tasks ADD COLUMN owner_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_owner_created_at ON tasks(owner_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks(owner_hash, status);
