"""
worker/src/fluid_simulator.py
------------------------------
Core mathematical engine for the Aquarela.io watercolour fluid simulation.

Pigment concentration is modelled as a 4-channel RGBA ``float32`` NumPy array:

    shape = (CHUNK_H, CHUNK_W, 4)   — R, G, B, A in [0.0, 255.0]

Diffusion is implemented with ``scipy.ndimage.gaussian_filter`` applied once
per simulation job.  A single Gaussian call is mathematically equivalent to
hundreds of Euler explicit steps but executes in <5 ms, making the spread
parameter (``sigma`` in pixels) immediately intuitive.

The alpha (opacity) channel decays **once per job** (not per step) to simulate
pigment drying / evaporation on wet paper without accumulating decay over many
Euler iterations.

Public API
----------
create_empty_grid(chunk_h, chunk_w) -> ndarray
render_strokes_onto_grid(grid, strokes, origin_x, origin_y) -> ndarray
run_diffusion(grid, sigma, alpha_decay) -> ndarray
extract_changed_pixels(original, diffused, origin_x, origin_y) -> list[dict]
"""

import os
from typing import TypedDict

import numpy as np

# ── Tuneable simulation parameters ────────────────────────────────────────────

#: Gaussian sigma for pigment diffusion, in pixels.
#: Controls the spread radius of the watercolour bleed per job.
#: sigma=8 produces a visible ~8 px spread that feels like wet-on-wet paper.
DIFFUSION_SIGMA: float = float(os.getenv("DIFFUSION_SIGMA", "8.0"))

#: Per-job multiplicative decay applied **once** to the alpha channel after diffusion.
#: 1.0 = no evaporation; 0.999 = very slow drying.  Kept close to 1.0 so that
#: pigment does not disappear after a few strokes.
#: NOTE: this is applied per-job (not per Euler step) — changing this value
#: has a direct, predictable effect on opacity across strokes.
ALPHA_DECAY: float = float(os.getenv("ALPHA_DECAY", "0.9998"))

#: Minimum summed RGBA change (L1-norm per pixel) required to include a pixel
#: in the output diff.  Filters floating-point noise from the output.
CHANGE_THRESHOLD: float = float(os.getenv("CHANGE_THRESHOLD", "1.0"))


# ── Type aliases ──────────────────────────────────────────────────────────────

class Stroke(TypedDict):
    """A single paint stroke event received from the Gateway."""

    x: int
    y: int
    color: str        # CSS hex string, e.g. "#120A8F"
    brushSize: int    # brush diameter in pixels
    userId: str
    timestamp: int


class ChangedPixel(TypedDict):
    """A single diffused pixel to broadcast to the Frontend via pixel_update."""

    x: int    # canvas-absolute horizontal coordinate
    y: int    # canvas-absolute vertical coordinate
    r: int
    g: int
    b: int
    a: int


# ── Helper functions ──────────────────────────────────────────────────────────

def _hex_to_rgba(hex_color: str) -> tuple[int, int, int, int]:
    """
    Converts a CSS hex colour string to an (R, G, B, A) integer tuple.

    Supports 6-character (#RRGGBB) and 8-character (#RRGGBBAA) formats.
    Alpha defaults to 255 (fully opaque) for 6-character inputs.

    :param hex_color: CSS hex string with or without a leading '#'.
    :returns: Tuple (r, g, b, a) with values in [0, 255].
    :raises ValueError: If the string length is not 6 or 8 after stripping '#'.
    """
    stripped = hex_color.lstrip('#')
    if len(stripped) == 6:
        r = int(stripped[0:2], 16)
        g = int(stripped[2:4], 16)
        b = int(stripped[4:6], 16)
        return r, g, b, 255
    if len(stripped) == 8:
        r = int(stripped[0:2], 16)
        g = int(stripped[2:4], 16)
        b = int(stripped[4:6], 16)
        a = int(stripped[6:8], 16)
        return r, g, b, a
    raise ValueError(f"Unrecognised hex colour format: '{hex_color}'")



# ── Public API ────────────────────────────────────────────────────────────────

def create_empty_grid(chunk_h: int, chunk_w: int) -> np.ndarray:
    """
    Allocates a zeroed RGBA ``float32`` grid for one chunk.

    :param chunk_h: Height of the chunk in pixels.
    :param chunk_w: Width of the chunk in pixels.
    :returns: Zero-filled ``ndarray`` of shape ``(chunk_h, chunk_w, 4)``,
              ``dtype=float32``, representing transparent black pixels.
    """
    return np.zeros((chunk_h, chunk_w, 4), dtype=np.float32)


def render_strokes_onto_grid(
    grid: np.ndarray,
    strokes: list[Stroke],
    chunk_origin_x: int,
    chunk_origin_y: int,
) -> np.ndarray:
    """
    Paints a list of stroke events onto the NumPy grid in-place.

    Each stroke is rendered as a filled circular brush stamp centred at the
    stroke coordinates converted to chunk-local pixel space.  Pixels whose
    centre falls outside the chunk boundary are silently clipped.

    Colour blending uses Porter-Duff **source-over** compositing so that
    semi-transparent strokes mix naturally with existing pigment on the grid.

    :param grid: Chunk grid of shape ``(H, W, 4)`` ``float32`` to paint onto.
    :param strokes: List of :class:`Stroke` dicts from the simulation job.
    :param chunk_origin_x: Left edge of this chunk in canvas-absolute pixels.
    :param chunk_origin_y: Top edge of this chunk in canvas-absolute pixels.
    :returns: The same ``grid`` ndarray (modified in-place) for chaining.
    """
    chunk_h, chunk_w, _ = grid.shape

    for stroke in strokes:
        try:
            r, g, b, a = _hex_to_rgba(stroke["color"])
        except (ValueError, KeyError):
            continue  # Malformed stroke — skip silently; logged at consumer level.

        # Convert from canvas-absolute to chunk-local coordinates.
        local_x = int(stroke["x"]) - chunk_origin_x
        local_y = int(stroke["y"]) - chunk_origin_y

        # brushSize in the payload is the *diameter*; convert to radius.
        radius = max(1, int(stroke.get("brushSize", 4)) // 2)

        # Bounding box of the brush stamp, clamped to chunk dimensions.
        y_min = max(0, local_y - radius)
        y_max = min(chunk_h, local_y + radius + 1)
        x_min = max(0, local_x - radius)
        x_max = min(chunk_w, local_x + radius + 1)

        if y_min >= y_max or x_min >= x_max:
            continue  # Stamp is entirely outside this chunk.

        # Build the circular mask using squared-distance comparison (no sqrt).
        ys = np.arange(y_min, y_max)
        xs = np.arange(x_min, x_max)
        yy, xx = np.meshgrid(ys, xs, indexing="ij")
        mask = (yy - local_y) ** 2 + (xx - local_x) ** 2 <= radius ** 2

        # Porter-Duff source-over alpha compositing (vectorised).
        src_a = a / 255.0
        dst_a = grid[y_min:y_max, x_min:x_max, 3] / 255.0
        out_a = src_a + dst_a * (1.0 - src_a)

        # Avoid division by zero for fully transparent regions.
        out_a_safe = np.where(out_a > 0.0, out_a, 1.0)

        grid[y_min:y_max, x_min:x_max, 0] = np.where(
            mask,
            (r * src_a + grid[y_min:y_max, x_min:x_max, 0] * dst_a * (1.0 - src_a)) / out_a_safe,
            grid[y_min:y_max, x_min:x_max, 0],
        )
        grid[y_min:y_max, x_min:x_max, 1] = np.where(
            mask,
            (g * src_a + grid[y_min:y_max, x_min:x_max, 1] * dst_a * (1.0 - src_a)) / out_a_safe,
            grid[y_min:y_max, x_min:x_max, 1],
        )
        grid[y_min:y_max, x_min:x_max, 2] = np.where(
            mask,
            (b * src_a + grid[y_min:y_max, x_min:x_max, 2] * dst_a * (1.0 - src_a)) / out_a_safe,
            grid[y_min:y_max, x_min:x_max, 2],
        )
        grid[y_min:y_max, x_min:x_max, 3] = np.where(
            mask,
            out_a * 255.0,
            grid[y_min:y_max, x_min:x_max, 3],
        )

    return grid


def run_diffusion(
    grid: np.ndarray,
    sigma: float = DIFFUSION_SIGMA,
    alpha_decay: float = ALPHA_DECAY,
) -> np.ndarray:
    """
    Applies Gaussian diffusion to the RGB channels of the grid and decays the
    alpha channel once per job.

    ``scipy.ndimage.gaussian_filter`` is used instead of an Euler explicit loop
    because:
      - A single Gaussian call is mathematically equivalent to ~400 Euler steps
        but executes in <5 ms (100× faster for the same visual spread).
      - The ``sigma`` parameter directly maps to pixels of spread, making
        tuning intuitive — no need to calculate α × steps.
      - Gaussian blur is unconditionally stable (no CFL condition to satisfy).

    ``alpha_decay`` is applied **once per job** (not per step) so that the
    accumulated opacity loss remains predictable regardless of sigma.

    :param grid: Chunk grid ``(H, W, 4)`` ``float32`` with values in [0, 255].
    :param sigma: Standard deviation of the Gaussian kernel in pixels.
    :param alpha_decay: Per-job multiplicative decay for the alpha channel.
    :returns: The modified grid (same object, modified in-place).
    """
    from scipy.ndimage import gaussian_filter  # noqa: PLC0415 — lazy import to avoid top-level cost

    # Diffuse RGB channels independently with the Gaussian kernel.
    # Mode='reflect' prevents pigment from wrapping around chunk edges.
    for channel_idx in range(3):
        grid[:, :, channel_idx] = gaussian_filter(
            grid[:, :, channel_idx], sigma=sigma, mode='reflect'
        )

    # Pigment drying: opacity fades once per job — predictable across strokes.
    grid[:, :, 3] *= alpha_decay

    # Clamp all channels to [0, 255] to prevent float drift outside valid range.
    np.clip(grid, 0.0, 255.0, out=grid)

    return grid


def extract_changed_pixels(
    original_grid: np.ndarray,
    diffused_grid: np.ndarray,
    chunk_origin_x: int,
    chunk_origin_y: int,
    threshold: float = CHANGE_THRESHOLD,
) -> list[ChangedPixel]:
    """
    Returns only the pixels that changed significantly after diffusion.

    Transmitting only the changed subset (diff) rather than the full grid
    dramatically reduces WebSocket message size — critical for chunks where
    most pixels are transparent / unchanged.

    The change magnitude is computed as the L1-norm of the per-pixel RGBA
    difference: ``sum(|diffused - original|)`` across the 4 channels.
    Pixels with magnitude ≤ ``threshold`` are excluded (floating-point noise).

    :param original_grid: Pre-diffusion grid ``(H, W, 4)`` ``float32``.
    :param diffused_grid: Post-diffusion grid ``(H, W, 4)`` ``float32``.
    :param chunk_origin_x: Left edge of the chunk in canvas-absolute pixels.
    :param chunk_origin_y: Top edge of the chunk in canvas-absolute pixels.
    :param threshold: Minimum per-pixel L1 change to include in the output.
    :returns: List of :class:`ChangedPixel` dicts with canvas-absolute coords.
    """
    diff = np.abs(diffused_grid - original_grid)
    change_magnitude = diff.sum(axis=2)  # shape: (H, W)

    changed_ys, changed_xs = np.where(change_magnitude > threshold)

    changed_pixels: list[ChangedPixel] = []
    for local_y, local_x in zip(changed_ys.tolist(), changed_xs.tolist()):
        r, g, b, a = diffused_grid[local_y, local_x]
        changed_pixels.append({
            "x": local_x + chunk_origin_x,
            "y": local_y + chunk_origin_y,
            "r": int(round(float(r))),
            "g": int(round(float(g))),
            "b": int(round(float(b))),
            "a": int(round(float(a))),
        })

    return changed_pixels
