<template>
  <div class="paint-canvas-wrapper">
    <!-- Toolbar: godê palette (Swatches) + brush size -->
    <div class="paint-controls">
      <!--
        Swatches from @lk77/vue3-color is bound via a computed shim (swatchesColor)
        that converts between the plain hex string used by useCanvas and the
        full color object { hex, hsl, rgb, ... } that the library emits.
      -->
      <Swatches
        v-model="swatchesColor"
        :palette="PIGMENT_PALETTE"
        class="paint-controls__swatches"
      />

      <label class="paint-controls__brush-label">
        <span>Pincel</span>
        <input
          type="range"
          min="2"
          max="32"
          v-model.number="brushSize"
          class="paint-controls__brush-slider"
          aria-label="Tamanho do pincel"
        />
        <span class="paint-controls__brush-value">{{ brushSize }}px</span>
      </label>
    </div>

    <!--
      Canvas element — CSS width is 100% so it fills the container.
      The logical pixel dimensions (canvas.width / canvas.height) are set by
      useCanvas.initCanvas() and kept in sync via ResizeObserver.
    -->
    <canvas
      ref="canvasRef"
      class="paint-canvas"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseLeave"
      @touchstart.prevent="onTouchStart"
      @touchmove.prevent="onTouchMove"
      @touchend.prevent="onTouchEnd"
    />
  </div>
</template>

<script>
import { defineComponent, ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useCanvas } from '../composables/useCanvas.js';
import { Swatches } from '@lk77/vue3-color';

/**
 * Watercolour pigment palette passed to the Swatches component.
 * The library expects an array of groups (inner arrays), where each group
 * is rendered as one column of colour chips. We use a single group so all
 * six pigments appear in a compact horizontal strip.
 *
 * @type {string[][]}
 */
const PIGMENT_PALETTE = [
  ['#120A8F'], // Azul Ultramar
  ['#E3A857'], // Amarelo Ocre
  ['#E32636'], // Alizarin Crimson
  ['#507D2A'], // Verde Seiva
  ['#536878'], // Cinza de Payne
  ['#E97451'], // Terra de Siena Queimada
];

/** Initial pigment colour — Azul Ultramar, the first pan in the godê. */
const INITIAL_COLOR = '#120A8F';

/** Default brush diameter in pixels. */
const DEFAULT_BRUSH_SIZE = 8;

export default defineComponent({
  name: 'PaintCanvas',

  components: { Swatches },

  props: {
    /**
     * Function to send a message payload over the active WebSocket connection.
     * Provided by the parent (App.vue) from the useWebSocket composable.
     * @type {(payload: object) => void}
     */
    send: {
      type: Function,
      required: true,
    },

    /**
     * Reactive ref or plain object containing the last message received from
     * the WebSocket server. The component watches this for incoming stroke_event
     * messages from other users.
     * @type {object|null}
     */
    lastMessage: {
      type: Object,
      default: null,
    },

    /**
     * Unique identifier for the local user, generated once per browser session
     * using the Web Crypto API. Used to filter out echoed strokes from the server.
     * @type {string}
     */
    userId: {
      type: String,
      required: true,
    },

    /**
     * Room identifier for the collaborative session this canvas belongs to.
     * Included in every outgoing stroke_event payload.
     * @type {string}
     */
    roomId: {
      type: String,
      required: true,
    },
  },

  setup(props) {
    const {
      canvasRef,
      isDrawing,
      initCanvas,
      drawStroke,
      startStroke,
      continueStroke,
      endStroke,
      calculateChunkId,
      destroyCanvas,
    } = useCanvas();

    /** @type {import('vue').Ref<string>} Currently selected pigment colour from the godê. */
    const selectedColor = ref(INITIAL_COLOR);

    /**
     * Computed shim that bridges the plain hex string (`selectedColor`) with the
     * full color object `{ hex, hsl, rgb, ... }` that @lk77/vue3-color Swatches
     * uses internally for v-model.
     *
     * - getter: wraps the hex string in a minimal object so Swatches can highlight
     *   the currently selected swatch.
     * - setter: extracts only the `.hex` field from the emitted color object and
     *   writes it back to `selectedColor`, keeping useCanvas blissfully unaware
     *   of the library's internal color representation.
     *
     * @type {import('vue').WritableComputedRef<{ hex: string }>}
     */
    const swatchesColor = computed({
      get: () => ({ hex: selectedColor.value }),
      set: (colorObj) => {
        if (colorObj && colorObj.hex) {
          selectedColor.value = colorObj.hex;
        }
      },
    });

    /** @type {import('vue').Ref<number>} Currently selected brush diameter in pixels. */
    const brushSize = ref(DEFAULT_BRUSH_SIZE);

    // -------------------------------------------------------------------------
    // Coordinate helpers
    // -------------------------------------------------------------------------

    /**
     * Extracts canvas-relative pixel coordinates from a MouseEvent.
     * Uses getBoundingClientRect to correctly account for CSS scaling and layout.
     *
     * @param {MouseEvent} event
     * @returns {{ x: number, y: number }}
     */
    function getMouseCoords(event) {
      const rect = canvasRef.value.getBoundingClientRect();
      return {
        x: Math.round(event.clientX - rect.left),
        y: Math.round(event.clientY - rect.top),
      };
    }

    /**
     * Extracts canvas-relative pixel coordinates from a Touch object.
     *
     * @param {Touch} touch - A single touch point from a TouchEvent.
     * @returns {{ x: number, y: number }}
     */
    function getTouchCoords(touch) {
      const rect = canvasRef.value.getBoundingClientRect();
      return {
        x: Math.round(touch.clientX - rect.left),
        y: Math.round(touch.clientY - rect.top),
      };
    }

    // -------------------------------------------------------------------------
    // Core paint action
    // -------------------------------------------------------------------------

    /**
     * Renders a brush stamp locally and broadcasts a stroke_event to the gateway.
     *
     * Optimistic rendering decision: the stroke is drawn on the local canvas
     * immediately, without waiting for the server echo. This gives instant visual
     * feedback to the painter and is consistent with the Optimistic Locking strategy
     * introduced in Phase 5. Remote echoes of the local user's own strokes are
     * suppressed in the incoming message watcher to prevent double-drawing.
     *
     * Chunk partitioning decision: each payload includes a `chunkId` computed from
     * the pixel position. The gateway and worker use this field to route simulation
     * jobs and apply per-chunk version locks (Phase 5).
     *
     * @param {number} x - Canvas X coordinate.
     * @param {number} y - Canvas Y coordinate.
     */
    function emitAndDrawStroke(x, y) {
      const chunkId = calculateChunkId(x, y);

      /** @type {{ type: string, roomId: string, userId: string, x: number, y: number, color: string, brushSize: number, timestamp: number, chunkId: string }} */
      const payload = {
        type: 'stroke_event',
        roomId: props.roomId,
        userId: props.userId,
        x,
        y,
        color: selectedColor.value,
        brushSize: brushSize.value,
        timestamp: Date.now(),
        chunkId,
      };

      // Optimistic local render — immediate visual feedback, no round-trip.
      drawStroke(x, y, selectedColor.value, brushSize.value);

      props.send(payload);
    }

    // -------------------------------------------------------------------------
    // Mouse event handlers
    // -------------------------------------------------------------------------

    /**
     * Initiates a new stroke on mouse button press.
     * @param {MouseEvent} event
     */
    function onMouseDown(event) {
      startStroke();
      const { x, y } = getMouseCoords(event);
      emitAndDrawStroke(x, y);
    }

    /**
     * Continues the active stroke while the mouse moves over the canvas.
     * Guards against spurious moves when no button is pressed.
     * @param {MouseEvent} event
     */
    function onMouseMove(event) {
      if (!isDrawing.value) return;
      continueStroke();
      const { x, y } = getMouseCoords(event);
      emitAndDrawStroke(x, y);
    }

    /**
     * Terminates the stroke on mouse button release.
     */
    function onMouseUp() {
      endStroke();
    }

    /**
     * Terminates the stroke when the cursor exits the canvas boundary.
     * Prevents a "sticky brush" where the stroke continues invisibly off-canvas.
     */
    function onMouseLeave() {
      endStroke();
    }

    // -------------------------------------------------------------------------
    // Touch event handlers
    // -------------------------------------------------------------------------

    /**
     * Initiates a stroke from the first touch contact point.
     * The .prevent modifier on the template suppresses native scroll behaviour
     * so painting does not accidentally scroll the page on mobile.
     * @param {TouchEvent} event
     */
    function onTouchStart(event) {
      startStroke();
      const { x, y } = getTouchCoords(event.touches[0]);
      emitAndDrawStroke(x, y);
    }

    /**
     * Continues the stroke as the finger moves across the canvas.
     * @param {TouchEvent} event
     */
    function onTouchMove(event) {
      if (!isDrawing.value) return;
      continueStroke();
      const { x, y } = getTouchCoords(event.touches[0]);
      emitAndDrawStroke(x, y);
    }

    /**
     * Terminates the stroke when the finger is lifted.
     */
    function onTouchEnd() {
      endStroke();
    }

    // -------------------------------------------------------------------------
    // Remote stroke rendering
    // -------------------------------------------------------------------------

    /**
     * Watches for incoming WebSocket messages and renders strokes from other users.
     *
     * Filtering decision: strokes originating from the local userId are skipped
     * because they were already rendered optimistically in emitAndDrawStroke().
     * Rendering them again would produce duplicated, darker marks on the canvas.
     * The gateway broadcasts stroke_event to all room members including the sender,
     * so client-side filtering by userId is the correct suppression point.
     *
     * canvas_state handling: when a client first joins a room it receives a
     * `canvas_state` message containing all persisted strokes grouped by chunk.
     * Each stroke is re-played through drawStroke() to restore the canvas to its
     * last saved state.  This message always arrives after `room_joined` so the
     * canvas element is guaranteed to be mounted and initialised.
     */
    watch(
      () => props.lastMessage,
      (message) => {
        if (!message) return;

        if (message.type === 'stroke_event') {
          // Skip own echoes — already rendered optimistically on emit.
          if (message.userId === props.userId) return;
          drawStroke(message.x, message.y, message.color, message.brushSize);
          return;
        }

        if (message.type === 'canvas_state') {
          // Re-play every persisted stroke to reconstruct the canvas state.
          // Ordering is preserved because strokes were appended sequentially
          // to the JSONB array in the database.
          for (const chunk of message.chunks) {
            for (const stroke of chunk.strokes) {
              drawStroke(stroke.x, stroke.y, stroke.color, stroke.brushSize);
            }
          }
        }
      }
    );

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    onMounted(() => {
      initCanvas(canvasRef.value);
    });

    onUnmounted(() => {
      destroyCanvas();
    });

    return {
      canvasRef,
      selectedColor,
      swatchesColor,
      brushSize,
      PIGMENT_PALETTE,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      onMouseLeave,
      onTouchStart,
      onTouchMove,
      onTouchEnd,
    };
  },
});
</script>

<style scoped>
.paint-canvas-wrapper {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

/* ── Toolbar ───────────────────────────────────────────────── */
.paint-controls {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex-wrap: wrap;
  padding: 0.6rem 0.75rem;
  background: #fff;
  border: 1px solid #d9cfc9;
  border-radius: 8px;
}

/* ── Swatches overrides ────────────────────────────────────── */
/*
  The library renders a large scrollable material-colour grid by default.
  We constrain it to a minimal strip that shows only our 6 pigment chips.
*/
:deep(.vc-swatches) {
  width: auto;
  height: auto;
  overflow: visible;
  background: transparent;
  box-shadow: none;
  padding: 0;
}

:deep(.vc-swatches-box) {
  display: flex;
  flex-direction: row;
  gap: 0.35rem;
  padding: 0;
  background: transparent;
}

:deep(.vc-swatches-color-group) {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0;
}

:deep(.vc-swatches-color-it) {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  margin: 0;
  cursor: pointer;
  transition: transform 0.12s ease;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.25);
}

:deep(.vc-swatches-color-it:hover) {
  transform: scale(1.18);
}

:deep(.vc-swatches-color-it[aria-selected='true']) {
  outline: 3px solid #3a2e2e;
  outline-offset: 2px;
  transform: scale(1.22);
}

/* Hide the checkmark SVG — the outline ring communicates selection clearly */
:deep(.vc-swatches-pick) {
  display: none;
}

.paint-controls__brush-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: #3a2e2e;
  white-space: nowrap;
}

.paint-controls__brush-slider {
  width: 90px;
  accent-color: #457b9d;
}

.paint-controls__brush-value {
  font-variant-numeric: tabular-nums;
  min-width: 2.5rem;
  color: #6b5c5c;
  font-size: 0.8rem;
}

/* ── Canvas ────────────────────────────────────────────────── */
.paint-canvas {
  display: block;
  width: 100%;
  height: 600px;
  border: 1px solid #d9cfc9;
  border-radius: 8px;
  background: #fdfaf7;
  cursor: crosshair;
  touch-action: none; /* prevents browser handling touch gestures over the canvas */
}
</style>
