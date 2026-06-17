/**
 * @file useCanvas.js
 * @description Vue 3 composable that encapsulates all HTML5 Canvas drawing logic,
 * including stroke rendering, chunk partitioning, and responsive resize handling.
 *
 * SRP Decision: This composable is deliberately isolated from WebSocket and Vue props.
 * It only knows about canvas geometry and drawing — all network and room concerns
 * live in PaintCanvas.vue and useWebSocket.js respectively.
 *
 * Usage:
 *   const { canvasRef, isDrawing, initCanvas, drawStroke, ... } = useCanvas();
 *   onMounted(() => initCanvas(canvasRef.value));
 */

import { ref } from 'vue';

/** Fixed canvas height in logical pixels. Width is responsive via ResizeObserver. */
const CANVAS_HEIGHT_PX = 600;

/**
 * Number of divisions along each axis for the chunk partition grid.
 * An 8×8 grid produces 64 chunks, each identified by "col_row".
 *
 * Chunk partitioning decision: partitioning the canvas into chunks allows
 * the backend to apply optimistic locking per-chunk (Phase 5) rather than
 * per-pixel, reducing lock contention while keeping conflict scope small.
 */
const CHUNK_GRID_SIZE = 8;

/**
 * Composable for managing an HTML5 Canvas element: drawing, resize, and chunk math.
 *
 * @returns {{
 *   canvasRef: import('vue').Ref<HTMLCanvasElement|null>,
 *   isDrawing: import('vue').Ref<boolean>,
 *   initCanvas: (el: HTMLCanvasElement) => void,
 *   drawStroke: (x: number, y: number, color: string, brushSize: number) => void,
 *   startStroke: () => void,
 *   continueStroke: () => void,
 *   endStroke: () => void,
 *   calculateChunkId: (x: number, y: number) => string,
 *   destroyCanvas: () => void,
 * }}
 */
export function useCanvas() {
  /** @type {import('vue').Ref<HTMLCanvasElement|null>} Template ref target for the canvas element. */
  const canvasRef = ref(null);

  /** @type {import('vue').Ref<boolean>} Whether a stroke is currently in progress. */
  const isDrawing = ref(false);

  /** @type {CanvasRenderingContext2D|null} 2D rendering context, set during initCanvas. */
  let ctx = null;

  /** @type {ResizeObserver|null} Observes the canvas container to keep canvas width in sync. */
  let resizeObserver = null;

  // ---------------------------------------------------------------------------
  // Initialisation & resize
  // ---------------------------------------------------------------------------

  /**
   * Sets the logical pixel dimensions of the canvas element to match the
   * container's current width and the fixed CANVAS_HEIGHT_PX.
   *
   * Note: changing canvas.width/height clears the bitmap. This is acceptable
   * on resize because the persistent state lives in the database (Phase 3);
   * the server will push the full chunk state to reconnected clients.
   *
   * @param {HTMLCanvasElement} el - The canvas DOM element.
   */
  function resizeCanvas(el) {
    const containerWidth = el.parentElement
      ? el.parentElement.clientWidth
      : el.clientWidth;

    el.width = containerWidth || 800;
    el.height = CANVAS_HEIGHT_PX;
  }

  /**
   * Initialises the canvas: acquires the 2D context, sizes the element, and
   * attaches a ResizeObserver so width stays in sync with the container.
   *
   * @param {HTMLCanvasElement} el - The canvas DOM element to initialise.
   */
  function initCanvas(el) {
    if (!el) return;

    ctx = el.getContext('2d');
    resizeCanvas(el);

    // Observe the parent container rather than the canvas itself, because the
    // canvas CSS width is set to 100% and the logical size is driven by JS.
    const target = el.parentElement || el;
    resizeObserver = new ResizeObserver(() => resizeCanvas(el));
    resizeObserver.observe(target);
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  /**
   * Draws a filled circle (one brush stamp) at the given canvas coordinates.
   * This function is the single rendering primitive for both local (optimistic)
   * and remote (received via WebSocket) strokes.
   *
   * @param {number} x - X coordinate in canvas pixels.
   * @param {number} y - Y coordinate in canvas pixels.
   * @param {string} color - CSS color string (e.g., '#e63946').
   * @param {number} brushSize - Brush diameter in pixels.
   */
  function drawStroke(x, y, color, brushSize) {
    if (!ctx) return;
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // Stroke state management (SRP: only the draw state flag lives here)
  // ---------------------------------------------------------------------------

  /**
   * Marks the beginning of a new drawing stroke.
   * Call this on mousedown / touchstart.
   */
  function startStroke() {
    isDrawing.value = true;
  }

  /**
   * Acknowledges a continuation point within the active stroke.
   * The caller (PaintCanvas.vue) is responsible for guarding this with isDrawing.
   */
  function continueStroke() {
    // Intentionally minimal — stroke state transitions are binary (drawing / not drawing).
    // Interpolation between points is a future enhancement (Phase 6 fluid simulation).
  }

  /**
   * Ends the current drawing stroke.
   * Call this on mouseup / mouseleave / touchend.
   */
  function endStroke() {
    isDrawing.value = false;
  }

  // ---------------------------------------------------------------------------
  // Chunk partitioning
  // ---------------------------------------------------------------------------

  /**
   * Calculates the chunk identifier for a given canvas coordinate.
   *
   * The canvas is partitioned into a CHUNK_GRID_SIZE × CHUNK_GRID_SIZE grid.
   * Each cell is identified by its zero-based column and row indices, formatted
   * as the string "col_row" (e.g., "0_0", "3_5", "7_7").
   *
   * This format matches the gateway's expected `chunkId` field in stroke_event
   * messages and will be used as the locking key in Phase 5 (Optimistic Locking).
   *
   * @param {number} x - X coordinate in canvas pixels.
   * @param {number} y - Y coordinate in canvas pixels.
   * @returns {string} Chunk identifier, e.g., "0_0".
   */
  function calculateChunkId(x, y) {
    const el = canvasRef.value;
    if (!el) return '0_0';

    const chunkWidth = el.width / CHUNK_GRID_SIZE;
    const chunkHeight = el.height / CHUNK_GRID_SIZE;

    const col = Math.min(Math.floor(x / chunkWidth), CHUNK_GRID_SIZE - 1);
    const row = Math.min(Math.floor(y / chunkHeight), CHUNK_GRID_SIZE - 1);

    return `${col}_${row}`;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Disconnects the ResizeObserver to prevent memory leaks.
   * Must be called from the consuming component's onUnmounted hook.
   */
  function destroyCanvas() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    ctx = null;
  }

  return {
    canvasRef,
    isDrawing,
    initCanvas,
    drawStroke,
    startStroke,
    continueStroke,
    endStroke,
    calculateChunkId,
    destroyCanvas,
  };
}
