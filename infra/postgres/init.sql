-- ─────────────────────────────────────────────────────────────────────────────
-- Aquarela.io — PostgreSQL bootstrap script
-- Executed once on first container creation via docker-entrypoint-initdb.d
-- Full schema is added in Phase 3 (Persistence layer)
-- ─────────────────────────────────────────────────────────────────────────────

-- Confirm the database is ready (no-op — postgres already created it via env)
SELECT 'Aquarela.io database initialised.' AS status;
