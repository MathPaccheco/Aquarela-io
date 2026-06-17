<template>
  <div id="aquarela-app">
    <header class="app-header">
      <h1>Aquarela.io</h1>
      <div class="status-badge" :class="`status-badge--${status}`">
        {{ status }}
      </div>
    </header>

    <PaintCanvas
      :send="send"
      :last-message="lastMessage"
      :user-id="userId"
      :room-id="roomId"
    />

    <section class="event-log">
      <h2>Eventos recebidos</h2>
      <ul v-if="eventLog.length > 0">
        <li v-for="(event, index) in eventLog" :key="index" class="event-log__item">
          <span class="event-log__type">{{ event.type }}</span>
          <span class="event-log__detail">{{ event.detail }}</span>
          <span class="event-log__time">{{ event.time }}</span>
        </li>
      </ul>
      <p v-else class="event-log__empty">Aguardando eventos...</p>
    </section>
  </div>
</template>

<script>
import { defineComponent, ref, watch, onMounted } from 'vue';
import { useWebSocket } from './composables/useWebSocket.js';
import PaintCanvas from './components/PaintCanvas.vue';

/** Room every client joins on startup during Phase 1. */
const DEFAULT_ROOM_ID = 'default';

/** WebSocket server URL — falls back to same host on non-dev environments. */
const GATEWAY_WS_URL = import.meta.env.VITE_GATEWAY_WS_URL || 'ws://localhost:3000';

/** Maximum number of events displayed in the debug log. */
const MAX_EVENT_LOG_SIZE = 50;

export default defineComponent({
  name: 'App',

  components: { PaintCanvas },

  setup() {
    const { status, lastMessage, connect, send } = useWebSocket();

    /**
     * @type {import('vue').Ref<string>}
     * Unique user identifier generated once per session via the Web Crypto API.
     */
    const userId = ref('');

    /**
     * @type {import('vue').Ref<Array<{type: string, detail: string, time: string}>>}
     * Circular buffer of the last MAX_EVENT_LOG_SIZE received events for debugging.
     */
    const eventLog = ref([]);

    /**
     * Appends an event entry to the debug log, trimming the oldest entry when full.
     *
     * @param {string} type - The event type string.
     * @param {string} detail - A human-readable summary of the event data.
     */
    function appendToEventLog(type, detail) {
      const time = new Date().toLocaleTimeString();
      eventLog.value.unshift({ type, detail, time });
      if (eventLog.value.length > MAX_EVENT_LOG_SIZE) {
        eventLog.value.pop();
      }
    }

    // React to every new message received from the server.
    watch(lastMessage, (message) => {
      if (!message) return;

      switch (message.type) {
        case 'room_joined':
          appendToEventLog('room_joined', `room=${message.roomId}, clients=${message.clientCount}`);
          break;
        case 'client_joined':
          appendToEventLog('client_joined', `user=${message.userId}, clients=${message.clientCount}`);
          break;
        case 'client_left':
          appendToEventLog('client_left', `user=${message.userId}, clients=${message.clientCount}`);
          break;
        case 'stroke_event':
          appendToEventLog('stroke_event', `user=${message.userId} @ (${message.x},${message.y}) chunk=${message.chunkId}`);
          break;
        case 'canvas_state': {
          const totalStrokes = message.chunks.reduce((sum, c) => sum + c.strokes.length, 0);
          appendToEventLog('canvas_state', `${message.chunks.length} chunk(s), ${totalStrokes} stroke(s) restaurados`);
          break;
        }
        case 'error':
          appendToEventLog('error', message.message);
          break;
        default:
          appendToEventLog(message.type, JSON.stringify(message));
      }
    });

    // Send join_room automatically once the connection is established.
    watch(status, (newStatus) => {
      if (newStatus === 'connected') {
        send({ type: 'join_room', roomId: DEFAULT_ROOM_ID, userId: userId.value });
      }
    });

    onMounted(() => {
      // Generate a stable user ID for this browser session using the native Web Crypto API.
      userId.value = crypto.randomUUID();
      connect(GATEWAY_WS_URL);
    });

    return { status, lastMessage, send, userId, roomId: DEFAULT_ROOM_ID, eventLog };
  },
});
</script>

<style>
body {
  margin: 0;
  font-family: sans-serif;
  background: #f5f0eb;
  min-height: 100vh;
}

#aquarela-app {
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.app-header h1 {
  margin: 0;
  font-size: 2rem;
  color: #3a2e2e;
}

.status-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.status-badge--connecting  { background: #fef3c7; color: #92400e; }
.status-badge--connected   { background: #d1fae5; color: #065f46; }
.status-badge--disconnected { background: #fee2e2; color: #991b1b; }

.phase-note {
  color: #6b5c5c;
  margin-bottom: 1.5rem;
}

.event-log h2 {
  font-size: 1rem;
  color: #3a2e2e;
  margin-bottom: 0.5rem;
}

.event-log ul {
  list-style: none;
  padding: 0;
  margin: 0;
  border: 1px solid #d9cfc9;
  border-radius: 6px;
  overflow: hidden;
}

.event-log__item {
  display: flex;
  gap: 0.75rem;
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
  font-family: monospace;
  border-bottom: 1px solid #ede8e4;
  background: #fff;
}

.event-log__item:last-child { border-bottom: none; }

.event-log__type   { color: #1d4ed8; min-width: 130px; }
.event-log__detail { color: #374151; flex: 1; }
.event-log__time   { color: #9ca3af; white-space: nowrap; }

.event-log__empty  { color: #9ca3af; font-size: 0.875rem; }
</style>
