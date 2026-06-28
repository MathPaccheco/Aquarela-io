"""
worker/src/chunk_processor.py
------------------------------
Orchestrates per-chunk state: in-memory grid cache, PostgreSQL initialisation,
and coordination with the fluid simulator.

The in-memory cache avoids re-fetching the full stroke history from the
database on every simulation job.  Only the *first* job for a given
(room_id, chunk_id) pair triggers a DB query; every subsequent job updates
the already-cached grid in-place.

Caching consistency:
  The Gateway persists strokes asynchronously via the write-batcher (every
  BATCH_FLUSH_INTERVAL_MS).  The Worker's cache is always up-to-date with
  the strokes it has processed, but may lag behind the DB for strokes that
  were persisted while the chunk was not yet cached.  On cache miss, the
  Worker replays *all* historical strokes from the DB, so any missed strokes
  are included.  After the first job the cache is the source of truth.

Thread-safety:
  ``process_job_sync`` is called from a ``ThreadPoolExecutor`` in consumer.py.
  The ``_grid_cache`` dict is protected by CPython's GIL for individual key
  reads/writes, which is sufficient for the single-process deployment model.
  Under a ``ProcessPoolExecutor`` each process maintains its own independent
  cache — acceptable for the current architecture.

Public API
----------
get_or_init_chunk_grid(room_id, chunk_id, pg_pool) -> ndarray   (async)
process_job_sync(room_id, chunk_id, strokes, grid)  -> list[dict] (sync)
"""

import json
import logging
import math
import os

import asyncpg
import numpy as np

from fluid_simulator import (
    ALPHA_DECAY,
    DIFFUSION_SIGMA,
    create_empty_grid,
    extract_changed_pixels,
    render_strokes_onto_grid,
    run_diffusion,
)

logger = logging.getLogger(__name__)

# ── Chunk geometry (must match frontend constants in useCanvas.js) ─────────────

#: Canvas height in logical pixels — must equal frontend CANVAS_HEIGHT_PX.
CANVAS_HEIGHT_PX: int = int(os.getenv("CANVAS_HEIGHT_PX", "600"))

#: Default canvas width in logical pixels.
CANVAS_WIDTH_PX: int = int(os.getenv("CANVAS_WIDTH_PX", "1200"))

#: Number of chunk divisions per axis — must equal frontend CHUNK_GRID_SIZE.
CHUNK_GRID_SIZE: int = int(os.getenv("CHUNK_GRID_SIZE", "8"))

#: Pixel height of one chunk.
CHUNK_H: int = CANVAS_HEIGHT_PX // CHUNK_GRID_SIZE

#: Pixel width of one chunk.
CHUNK_W: int = CANVAS_WIDTH_PX // CHUNK_GRID_SIZE

# Number of pixels sampled beyond chunk borders when cross-chunk diffusion is
# enabled. Defaults to 3*sigma so the Gaussian kernel tails are covered.
CROSS_CHUNK_PAD_PIXELS: int = int(
    os.getenv("CROSS_CHUNK_PAD_PIXELS", str(max(1, math.ceil(3 * DIFFUSION_SIGMA))))
)


# ── In-memory grid cache ──────────────────────────────────────────────────────

# Maps "roomId::chunkId" → numpy grid (CHUNK_H, CHUNK_W, 4) float32.
# Intentionally module-level so all consumer coroutines share one cache.
_grid_cache: dict[str, np.ndarray] = {}


def _cache_key(room_id: str, chunk_id: str) -> str:
    """Builds the composite cache key for a (room_id, chunk_id) pair."""
    return f"{room_id}::{chunk_id}"


def _parse_chunk_id(chunk_id: str) -> tuple[int, int]:
    """
    Parses a chunkId string of the form "col_row" into (col, row) integers.

    :param chunk_id: Chunk identifier (e.g. "2_3").
    :returns: Tuple (col, row).
    :raises ValueError: If the format is not exactly "col_row".
    """
    parts = chunk_id.split("_")
    if len(parts) != 2:
        raise ValueError(f"Invalid chunkId format: '{chunk_id}'. Expected 'col_row'.")
    return int(parts[0]), int(parts[1])


def _chunk_origin(chunk_id: str) -> tuple[int, int]:
    """
    Returns the top-left canvas-absolute pixel coordinate of a chunk.

    :param chunk_id: Chunk identifier (e.g. "2_3").
    :returns: Tuple (origin_x, origin_y) in canvas-absolute pixel space.
    """
    col, row = _parse_chunk_id(chunk_id)
    return col * CHUNK_W, row * CHUNK_H


def _is_valid_chunk_coords(col: int, row: int) -> bool:
    """Checks whether chunk coordinates are inside the configured grid."""
    return 0 <= col < CHUNK_GRID_SIZE and 0 <= row < CHUNK_GRID_SIZE


def _chunk_id_from_coords(col: int, row: int) -> str:
    """Formats chunk coordinates as the canonical chunkId string."""
    return f"{col}_{row}"


def _window_chunk_overlap(
    chunk_dx: int,
    chunk_dy: int,
    pad: int,
) -> tuple[slice, slice, slice, slice] | None:
    """
    Computes overlap slices between the expanded center window and one chunk.

    Window coordinates are in center-local space:
      x in [-pad, CHUNK_W + pad), y in [-pad, CHUNK_H + pad)

    Neighbor chunk coordinates are also expressed in center-local space using
    (chunk_dx, chunk_dy) offsets where center=(0,0), left=(-1,0), etc.

    :returns: Tuple (dst_y, dst_x, src_y, src_x) slices or None if no overlap.
    """
    window_x0, window_x1 = -pad, CHUNK_W + pad
    window_y0, window_y1 = -pad, CHUNK_H + pad

    chunk_x0 = chunk_dx * CHUNK_W
    chunk_x1 = chunk_x0 + CHUNK_W
    chunk_y0 = chunk_dy * CHUNK_H
    chunk_y1 = chunk_y0 + CHUNK_H

    overlap_x0 = max(window_x0, chunk_x0)
    overlap_x1 = min(window_x1, chunk_x1)
    overlap_y0 = max(window_y0, chunk_y0)
    overlap_y1 = min(window_y1, chunk_y1)

    if overlap_x0 >= overlap_x1 or overlap_y0 >= overlap_y1:
        return None

    dst_x = slice(overlap_x0 - window_x0, overlap_x1 - window_x0)
    dst_y = slice(overlap_y0 - window_y0, overlap_y1 - window_y0)
    src_x = slice(overlap_x0 - chunk_x0, overlap_x1 - chunk_x0)
    src_y = slice(overlap_y0 - chunk_y0, overlap_y1 - chunk_y0)

    return dst_y, dst_x, src_y, src_x


def is_cross_chunk_needed(
    chunk_id: str,
    strokes: list[dict],
    pad_pixels: int = CROSS_CHUNK_PAD_PIXELS,
) -> bool:
    """
    Returns True when at least one stroke may diffuse across chunk boundaries.

    A stroke is considered boundary-adjacent when its brush footprint touches
    the configured border band ``pad_pixels`` from any chunk edge.
    """
    if pad_pixels <= 0 or not strokes:
        return False

    origin_x, origin_y = _chunk_origin(chunk_id)

    for stroke in strokes:
        try:
            local_x = int(stroke["x"]) - origin_x
            local_y = int(stroke["y"]) - origin_y
        except (KeyError, TypeError, ValueError):
            continue

        radius = max(1, int(stroke.get("brushSize", 4)) // 2)

        if (
            local_x - radius < pad_pixels
            or local_y - radius < pad_pixels
            or local_x + radius >= CHUNK_W - pad_pixels
            or local_y + radius >= CHUNK_H - pad_pixels
        ):
            return True

    return False


async def preload_neighbor_grids(
    room_id: str,
    chunk_id: str,
    strokes: list[dict],
    pg_pool: asyncpg.Pool,
    pad_pixels: int = CROSS_CHUNK_PAD_PIXELS,
) -> None:
    """
    Ensures immediate neighbor chunk grids are initialized before cross-diffusion.

    This avoids composing diffusion with missing neighbors that would otherwise
    be treated as transparent and cause visual discontinuities at boundaries.
    """
    if not is_cross_chunk_needed(chunk_id, strokes, pad_pixels=pad_pixels):
        return

    col, row = _parse_chunk_id(chunk_id)

    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue

            n_col = col + dx
            n_row = row + dy
            if not _is_valid_chunk_coords(n_col, n_row):
                continue

            neighbor_chunk_id = _chunk_id_from_coords(n_col, n_row)
            await get_or_init_chunk_grid(room_id, neighbor_chunk_id, pg_pool)


def _process_job_with_cross_chunk_diffusion(
    room_id: str,
    chunk_id: str,
    strokes: list[dict],
    center_grid: np.ndarray,
    pad_pixels: int,
) -> list[dict]:
    """
    Runs diffusion on an expanded window and writes results back to neighbors.

    The center chunk and any cached immediate neighbors are stitched into a
    temporary expanded grid. Diffusion runs once on that expanded grid, then the
    overlapped regions are copied back into each participating chunk cache.
    """
    col, row = _parse_chunk_id(chunk_id)
    origin_x, origin_y = _chunk_origin(chunk_id)

    participants: dict[tuple[int, int], np.ndarray] = {(0, 0): center_grid}

    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue

            n_col = col + dx
            n_row = row + dy
            if not _is_valid_chunk_coords(n_col, n_row):
                continue

            neighbor_chunk_id = _chunk_id_from_coords(n_col, n_row)
            cached_neighbor = _grid_cache.get(_cache_key(room_id, neighbor_chunk_id))
            if cached_neighbor is not None:
                participants[(dx, dy)] = cached_neighbor

    expanded_h = CHUNK_H + 2 * pad_pixels
    expanded_w = CHUNK_W + 2 * pad_pixels
    expanded_grid = create_empty_grid(expanded_h, expanded_w)

    # Compose expanded input from center + cached neighbors.
    for (dx, dy), source_grid in participants.items():
        overlap = _window_chunk_overlap(dx, dy, pad_pixels)
        if overlap is None:
            continue
        dst_y, dst_x, src_y, src_x = overlap
        expanded_grid[dst_y, dst_x] = source_grid[src_y, src_x]

    expanded_origin_x = origin_x - pad_pixels
    expanded_origin_y = origin_y - pad_pixels

    render_strokes_onto_grid(
        expanded_grid,
        strokes,
        expanded_origin_x,
        expanded_origin_y,
    )

    # Snapshot after rendering so the diff carries only diffusion changes.
    original_snapshot = expanded_grid.copy()

    run_diffusion(expanded_grid, sigma=DIFFUSION_SIGMA, alpha_decay=ALPHA_DECAY)

    # Write back only the overlaps to each participating cached chunk.
    for (dx, dy), target_grid in participants.items():
        overlap = _window_chunk_overlap(dx, dy, pad_pixels)
        if overlap is None:
            continue
        dst_y, dst_x, src_y, src_x = overlap
        target_grid[src_y, src_x] = expanded_grid[dst_y, dst_x]

    changed_pixels = extract_changed_pixels(
        original_snapshot,
        expanded_grid,
        expanded_origin_x,
        expanded_origin_y,
    )

    logger.info(
        "[chunk_processor] cross-chunk enabled for room=%s chunk=%s with %d participant chunk(s).",
        room_id,
        chunk_id,
        len(participants),
    )

    return changed_pixels


async def _fetch_chunk_strokes(
    room_id: str,
    chunk_id: str,
    pg_pool: asyncpg.Pool,
) -> list[dict]:
    """
    Fetches the persisted stroke history for a chunk from PostgreSQL.

    Returns an empty list if the chunk has no row yet (brand-new room or
    chunk that has never been painted).

    :param room_id: Room identifier.
    :param chunk_id: Chunk identifier.
    :param pg_pool: An ``asyncpg.Pool`` connection pool.
    :returns: List of stroke dicts (same format as ``canvas_chunks.pixel_data``).
    """
    row = await pg_pool.fetchrow(
        "SELECT pixel_data FROM canvas_chunks WHERE room_id = $1 AND chunk_id = $2",
        room_id,
        chunk_id,
    )
    if row is None:
        return []

    data = row["pixel_data"]
    # asyncpg returns JSONB columns as Python dicts/lists directly, but guard
    # against the edge case where it arrives as a raw JSON string.
    return json.loads(data) if isinstance(data, str) else data


async def get_or_init_chunk_grid(
    room_id: str,
    chunk_id: str,
    pg_pool: asyncpg.Pool,
) -> np.ndarray:
    """
    Returns the in-memory grid for a chunk, initialising it from the database
    on the first access (cache miss).

    On **cache miss**:
      1. An empty RGBA ``float32`` grid is created.
      2. Historical strokes are fetched from PostgreSQL.
      3. All historical strokes are replayed onto the grid to reconstruct the
         current visual state of the chunk.
      4. The resulting grid is stored in the in-memory cache.

    On **cache hit**:
      Returns the cached grid immediately with no I/O.

    :param room_id: Room identifier.
    :param chunk_id: Chunk identifier (e.g. "0_0").
    :param pg_pool: An ``asyncpg.Pool`` connection pool.
    :returns: The current grid ``(CHUNK_H, CHUNK_W, 4)`` ``float32``.
    """
    key = _cache_key(room_id, chunk_id)

    if key in _grid_cache:
        return _grid_cache[key]

    logger.info("Cache miss for %s — initialising grid from DB.", key)
    grid = create_empty_grid(CHUNK_H, CHUNK_W)
    origin_x, origin_y = _chunk_origin(chunk_id)

    historical_strokes = await _fetch_chunk_strokes(room_id, chunk_id, pg_pool)
    if historical_strokes:
        render_strokes_onto_grid(grid, historical_strokes, origin_x, origin_y)
        logger.info(
            "Replayed %d historical stroke(s) onto grid for %s.",
            len(historical_strokes), key,
        )

    _grid_cache[key] = grid
    return grid


def process_job_sync(
    room_id: str,
    chunk_id: str,
    strokes: list[dict],
    grid: np.ndarray,
) -> list[dict]:
    """
    Synchronous simulation runner — runs the full stroke → diffusion pipeline.

    Designed to be called via ``asyncio.get_running_loop().run_in_executor``
    so that NumPy's CPU-bound computation does not block the asyncio event loop.

    Steps:
      1. Snapshot the current grid (deep copy) for pixel-diff computation.
      2. Render the new strokes onto the cached grid (in-place).
      3. Apply ``SIMULATION_STEPS`` Euler-explicit diffusion iterations.
      4. Compute the pixel diff against the pre-stroke snapshot.

    The cached grid is mutated so the next job for the same chunk starts
    from the post-diffusion state — persistent visual memory across strokes.

    :param room_id: Room identifier (used for logging only).
    :param chunk_id: Chunk identifier (used to compute the chunk origin).
    :param strokes: New strokes from the simulation job payload.
    :param grid: The cached grid ndarray; modified in-place.
    :returns: List of :class:`~fluid_simulator.ChangedPixel` dicts to broadcast.
    """
    if is_cross_chunk_needed(chunk_id, strokes):
        changed_pixels = _process_job_with_cross_chunk_diffusion(
            room_id,
            chunk_id,
            strokes,
            grid,
            pad_pixels=CROSS_CHUNK_PAD_PIXELS,
        )

        logger.info(
            "[chunk_processor] room=%s chunk=%s — %d stroke(s), %d changed pixel(s) [cross-chunk].",
            room_id, chunk_id, len(strokes), len(changed_pixels),
        )
        return changed_pixels

    origin_x, origin_y = _chunk_origin(chunk_id)

    # Render new strokes onto the grid first so the snapshot captures the
    # post-stroke state.  The diff will therefore contain only pixels changed
    # by diffusion spread — the frontend already has the stroke pixels via
    # optimistic rendering and does not need to receive them again.
    render_strokes_onto_grid(grid, strokes, origin_x, origin_y)

    # Snapshot taken AFTER stroke rendering so pixel_update sends only
    # the diffusion spread pixels (not the brush stamp pixels).
    original_snapshot = grid.copy()

    run_diffusion(grid, sigma=DIFFUSION_SIGMA, alpha_decay=ALPHA_DECAY)

    changed_pixels = extract_changed_pixels(
        original_snapshot, grid, origin_x, origin_y
    )

    logger.info(
        "[chunk_processor] room=%s chunk=%s — %d stroke(s), %d changed pixel(s).",
        room_id, chunk_id, len(strokes), len(changed_pixels),
    )

    return changed_pixels
