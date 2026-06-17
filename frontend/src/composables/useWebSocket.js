/**
 * @file useWebSocket.js
 * @description Vue 3 composable that manages a WebSocket connection lifecycle,
 * including automatic reconnection with exponential backoff and jitter.
 *
 * Usage:
 *   const { status, lastMessage, connect, send, disconnect } = useWebSocket();
 *   connect('ws://localhost:3000');
 *
 * Reconnection strategy:
 *   - Attempts reconnect on unexpected close (not triggered by `disconnect()`).
 *   - Delay follows exponential backoff: 1s → 2s → 4s → 8s → … capped at 30s.
 *   - Each delay includes ±20% random jitter to avoid thundering herd on server restart.
 *   - Retry counter resets on successful connection.
 */

import { ref, onUnmounted } from 'vue';

/** @typedef {'connecting' | 'connected' | 'disconnected'} ConnectionStatus */

/** Minimum delay in milliseconds for the first reconnection attempt. */
const BASE_RECONNECT_DELAY_MS = 1000;

/** Maximum delay cap in milliseconds between reconnection attempts. */
const MAX_RECONNECT_DELAY_MS = 30000;

/** Jitter factor: delay is multiplied by a random value in [1-jitter, 1+jitter]. */
const RECONNECT_JITTER_FACTOR = 0.2;

/**
 * Calculates the next reconnection delay using exponential backoff with jitter.
 *
 * @param {number} attempt - The current attempt index (0-based).
 * @returns {number} Delay in milliseconds.
 */
function calculateBackoffDelay(attempt) {
  const exponential = BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt);
  const capped = Math.min(exponential, MAX_RECONNECT_DELAY_MS);
  const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER_FACTOR;
  return Math.floor(capped * jitter);
}

/**
 * Composable for managing a WebSocket connection with automatic reconnection.
 *
 * @returns {{
 *   status: import('vue').Ref<ConnectionStatus>,
 *   lastMessage: import('vue').Ref<object|null>,
 *   connect: (url: string) => void,
 *   send: (payload: object) => void,
 *   disconnect: () => void,
 * }}
 */
export function useWebSocket() {
  /** @type {import('vue').Ref<ConnectionStatus>} */
  const status = ref('disconnected');

  /** @type {import('vue').Ref<object|null>} */
  const lastMessage = ref(null);

  /** @type {WebSocket|null} */
  let socket = null;

  /** @type {string|null} */
  let serverUrl = null;

  /** @type {number} Current reconnection attempt index (0-based). */
  let reconnectAttempt = 0;

  /** @type {ReturnType<typeof setTimeout>|null} */
  let reconnectTimer = null;

  /** @type {boolean} Prevents reconnection when `disconnect()` is called intentionally. */
  let intentionalClose = false;

  /**
   * Clears any pending reconnection timer.
   */
  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * Schedules a reconnection attempt after an exponential backoff delay.
   */
  function scheduleReconnect() {
    if (intentionalClose) return;

    const delay = calculateBackoffDelay(reconnectAttempt);
    reconnectAttempt++;

    console.log(`[useWebSocket] reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);

    reconnectTimer = setTimeout(() => {
      if (!intentionalClose) {
        openSocket();
      }
    }, delay);
  }

  /**
   * Opens the WebSocket connection to `serverUrl`.
   * Attaches event handlers for open, message, close, and error.
   */
  function openSocket() {
    if (!serverUrl) return;

    status.value = 'connecting';
    socket = new WebSocket(serverUrl);

    socket.addEventListener('open', () => {
      status.value = 'connected';
      reconnectAttempt = 0;
      console.log('[useWebSocket] connected to', serverUrl);
    });

    socket.addEventListener('message', (event) => {
      try {
        lastMessage.value = JSON.parse(event.data);
      } catch {
        console.warn('[useWebSocket] received non-JSON message:', event.data);
      }
    });

    socket.addEventListener('close', (event) => {
      status.value = 'disconnected';
      console.log(`[useWebSocket] connection closed (code=${event.code}, wasClean=${event.wasClean})`);
      scheduleReconnect();
    });

    socket.addEventListener('error', (event) => {
      console.error('[useWebSocket] socket error:', event);
      // The 'close' event fires immediately after 'error', so reconnect is handled there.
    });
  }

  /**
   * Initiates the WebSocket connection to the given URL.
   * Stores the URL for use in automatic reconnection attempts.
   *
   * @param {string} url - The WebSocket server URL (e.g. 'ws://localhost:3000').
   */
  function connect(url) {
    serverUrl = url;
    intentionalClose = false;
    clearReconnectTimer();
    openSocket();
  }

  /**
   * Sends a JSON-serialized payload over the WebSocket connection.
   * Silently no-ops if the socket is not open.
   *
   * @param {object} payload - The data to serialize and send.
   */
  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('[useWebSocket] cannot send — socket is not open');
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  /**
   * Intentionally closes the WebSocket connection and prevents auto-reconnect.
   */
  function disconnect() {
    intentionalClose = true;
    clearReconnectTimer();

    if (socket) {
      socket.close();
      socket = null;
    }

    status.value = 'disconnected';
  }

  // Ensure the socket is closed when the component using this composable is unmounted.
  onUnmounted(() => {
    disconnect();
  });

  return { status, lastMessage, connect, send, disconnect };
}
