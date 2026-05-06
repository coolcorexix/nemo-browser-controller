// WebSocket bridge to the local MCP server. The MCP server listens; the
// extension's service worker connects out. Each inbound message is
// { id, type, payload } — we dispatch through the same `commands` table the
// side panel already uses and send the response back tagged with the same id.
//
// Two operational notes:
// - MV3 service workers are evicted after ~30s of true idleness. While a
//   WebSocket is open AND messages flow at least every 30s, the SW stays
//   alive (Chrome 116+). We send a small heartbeat ping for that reason.
// - Only one extension instance should be connected at a time. The MCP
//   server already replaces older connections, so reconnect is safe.

const DEFAULT_URL = "ws://127.0.0.1:9223";
const INITIAL_CONNECT_DELAY_MS = 500; // small head-start so the MCP server has a chance to spawn
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const HEARTBEAT_MS = 25000;

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let connectedSince = null;
let lastError = null;
let onStatusChange = () => {};

export function installWebSocketBridge(commands, { url = DEFAULT_URL } = {}) {
  function connect() {
    cleanup();
    try {
      socket = new WebSocket(url);
    } catch (err) {
      lastError = err.message;
      console.warn("[Nemo WS] failed to construct WebSocket:", err);
      scheduleReconnect();
      notify();
      return;
    }

    socket.addEventListener("open", () => {
      console.log("[Nemo WS] connected to", url);
      connectedSince = Date.now();
      lastError = null;
      reconnectAttempts = 0; // reset backoff after a successful connection
      startHeartbeat();
      notify();
    });

    socket.addEventListener("message", async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // ignore non-JSON noise
      }
      // Server may send heartbeat pongs or other control frames in future —
      // only dispatch if it looks like a request.
      if (!msg.id || !msg.type) return;
      const handler = commands[msg.type];
      let response;
      if (!handler) {
        response = { ok: false, error: `Unknown command: ${msg.type}` };
      } else {
        try {
          response = await handler(msg.payload ?? {});
        } catch (err) {
          response = { ok: false, error: String(err?.message ?? err) };
        }
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: msg.id, ...response }));
      }
    });

    socket.addEventListener("close", () => {
      console.log("[Nemo WS] disconnected");
      connectedSince = null;
      socket = null;
      stopHeartbeat();
      scheduleReconnect();
      notify();
    });

    socket.addEventListener("error", (e) => {
      // The browser surfaces errors before close; the close handler does the
      // reconnect bookkeeping. Just record for status display.
      lastError = e?.message || "WebSocket error";
      console.warn("[Nemo WS] error", e);
      notify();
    });
  }

  function cleanup() {
    if (socket) {
      try { socket.close(); } catch {}
      socket = null;
    }
    stopHeartbeat();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    // Exponential backoff with cap. Cold-start vs MCP-server-down look the
    // same to us; backing off keeps the console quieter during long downtime
    // while still recovering quickly when the server is just slow to start.
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts,
      RECONNECT_MAX_DELAY_MS
    );
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ heartbeat: true, ts: Date.now() }));
        } catch {}
      }
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function notify() {
    try {
      onStatusChange(getStatus());
    } catch {}
  }

  // Initial attempt is delayed slightly so an extension reload that happens
  // a moment before the MCP server's listener is ready doesn't log a noisy
  // ERR_CONNECTION_REFUSED. Subsequent retries use exponential backoff.
  setTimeout(connect, INITIAL_CONNECT_DELAY_MS);

  return {
    getStatus,
    reconnect: () => {
      reconnectAttempts = 0; // explicit reconnect — try immediately
      connect();
    },
    setStatusListener: (cb) => {
      onStatusChange = cb || (() => {});
    },
  };
}

export function getStatus() {
  return {
    connected: !!socket && socket.readyState === WebSocket.OPEN,
    connectedSince,
    lastError,
  };
}
