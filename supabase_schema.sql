-- Tokimeter — Supabase / Postgres Schema
--
-- Run this in your Supabase SQL Editor (Dashboard → SQL → New Query)
-- to create the table, indexes, and security policies for Tokimeter.
--
-- After running this, get your project URL and anon key from:
--   Dashboard → Settings → API
-- And set environment variables:
--   export TOKIMETER_SUPABASE_URL=https://yourproject.supabase.co
--   export TOKIMETER_SUPABASE_KEY=your-anon-key

-- ─── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS llm_calls (
    id           TEXT PRIMARY KEY,
    timestamp    DOUBLE PRECISION NOT NULL,
    provider     TEXT NOT NULL DEFAULT '',
    model        TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    input_cost   DOUBLE PRECISION NOT NULL DEFAULT 0,
    output_cost  DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_cost   DOUBLE PRECISION NOT NULL DEFAULT 0,
    agent_name   TEXT NOT NULL DEFAULT 'default',
    workflow     TEXT NOT NULL DEFAULT 'default',
    customer     TEXT NOT NULL DEFAULT '',
    latency_ms   DOUBLE PRECISION NOT NULL DEFAULT 0,
    success      BOOLEAN NOT NULL DEFAULT TRUE,
    error        TEXT NOT NULL DEFAULT '',
    tags         JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ─── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_llm_calls_timestamp  ON llm_calls (timestamp);
CREATE INDEX IF NOT EXISTS idx_llm_calls_agent_name ON llm_calls (agent_name);
CREATE INDEX IF NOT EXISTS idx_llm_calls_model      ON llm_calls (model);
CREATE INDEX IF NOT EXISTS idx_llm_calls_workflow   ON llm_calls (workflow);
CREATE INDEX IF NOT EXISTS idx_llm_calls_customer   ON llm_calls (customer);

-- ─── Row Level Security ─────────────────────────────────────────────────────
-- Enable RLS and create a policy that allows inserts with the anon key
-- (the SDK needs to write calls) and selects for reading data back.

ALTER TABLE llm_calls ENABLE ROW LEVEL SECURITY;

-- Allow anonymous inserts (the SDK writes from your application)
CREATE POLICY "Allow anon insert" ON llm_calls
    FOR INSERT TO anon WITH CHECK (true);

-- Allow anonymous reads (the dashboard reads from your project)
CREATE POLICY "Allow anon select" ON llm_calls
    FOR SELECT TO anon USING (true);

-- NOTE: For production, you should use the service_role key for writes
-- and restrict reads to authenticated users. The above policies are for
-- getting started quickly. To lock down:
--
-- DROP POLICY "Allow anon insert" ON llm_calls;
-- DROP POLICY "Allow anon select" ON llm_calls;
-- CREATE POLICY "Allow authenticated all" ON llm_calls
--     FOR ALL TO authenticated USING (true) WITH CHECK (true);
