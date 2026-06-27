-- ─────────────────────────────────────────────────────────────────────────────
-- Aquarela.io — PostgreSQL bootstrap script
-- Executed once on first container creation via docker-entrypoint-initdb.d
-- Phase 3: canvas_chunks persistence layer
-- ─────────────────────────────────────────────────────────────────────────────

-- ── canvas_chunks ─────────────────────────────────────────────────────────────
-- Stores the serialised stroke history for every chunk of every room.
--
-- Design decisions:
--  • Composite PK (room_id, chunk_id): the natural identity of a chunk.
--    Avoids a surrogate key and aligns with all lookup patterns.
--  • pixel_data JSONB DEFAULT '[]': strokes are stored as an ordered array.
--    Append-only during normal operation (operator ||); re-playable on the
--    frontend; compatible with Phase 6 where the Worker will consume strokes
--    to run the fluid-simulation algorithm.
--  • last_updated: lets future maintenance jobs evict stale rooms and will
--    serve as a tiebreaker in conflict resolution.
--  • version BIGINT DEFAULT 0: mirrors the in-memory OCC (Optimistic Concurrency
--    Control) version managed by chunkVersionManager.js. Incremented on every
--    accepted write; persisted by the write-batcher on each flush so the
--    Gateway can hydrate the in-memory map after a restart without losing the
--    concurrency baseline.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS canvas_chunks (
  room_id      TEXT        NOT NULL,
  chunk_id     TEXT        NOT NULL,
  pixel_data   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version      BIGINT      NOT NULL DEFAULT 0,

  CONSTRAINT canvas_chunks_pkey PRIMARY KEY (room_id, chunk_id)
);

-- Index on room_id alone: used by fetchRoomChunks to restore the full canvas
-- state when a new client joins.  The PK already covers (room_id, chunk_id)
-- lookups, so only the leading-column scan needs the extra index.
CREATE INDEX IF NOT EXISTS idx_canvas_chunks_room_id ON canvas_chunks (room_id);

SELECT 'Aquarela.io database initialised — canvas_chunks table ready.' AS status;
