-- D1 schema for nvr-key
-- 创建记录表
CREATE TABLE IF NOT EXISTS records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_code   TEXT    NOT NULL,
    activation_key TEXT    NOT NULL,
    license_type   TEXT    NOT NULL,
    expiry_date    TEXT,
    operator       TEXT    DEFAULT '',
    created_at     TEXT    NOT NULL
);

-- 加速分页查询
CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at DESC);
