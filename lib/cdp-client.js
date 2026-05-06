// Per-tab buffers for console messages and network events captured via the
// chrome.debugger API (Chrome DevTools Protocol). Mirrors what DevTools shows
// in the Console and Network tabs.

const CDP_VERSION = "1.3";
const MAX_CONSOLE = 500;
const MAX_NETWORK = 500;

// tabId -> { console: [], network: Map<requestId, entry>, networkOrder: [] }
const sessions = new Map();

export function isAttached(tabId) {
  return sessions.has(tabId);
}

export async function attachDebugger(tabId) {
  if (sessions.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  sessions.set(tabId, {
    console: [],
    network: new Map(),
    networkOrder: [],
  });

  const send = (method, params) => sendCdp(tabId, method, params);
  // Enable the domains we care about. Order doesn't matter; run in parallel.
  await Promise.all([
    send("Runtime.enable"),
    send("Log.enable"),
    send("Network.enable"),
    send("Page.enable"),
  ]);
}

export async function detachDebugger(tabId) {
  if (!sessions.has(tabId)) return;
  sessions.delete(tabId);
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // ignore lastError — tab may already be gone
      resolve();
    });
  });
}

export function getConsoleLog(tabId) {
  const s = sessions.get(tabId);
  if (!s) return [];
  return s.console.slice();
}

export function getNetworkLog(tabId) {
  const s = sessions.get(tabId);
  if (!s) return [];
  return s.networkOrder.map((id) => s.network.get(id)).filter(Boolean);
}

export function clearLogs(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.console.length = 0;
  s.network.clear();
  s.networkOrder.length = 0;
}

function sendCdp(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function pushConsole(tabId, entry) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.console.push(entry);
  if (s.console.length > MAX_CONSOLE) s.console.shift();
}

function previewArg(arg) {
  // RemoteObject from Runtime — render to a string for human/LLM consumption.
  if (!arg) return "";
  if (arg.value !== undefined) return JSON.stringify(arg.value);
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.description) return arg.description;
  return arg.type || "";
}

// --- CDP event listener ----------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  const { tabId } = source;
  if (!tabId || !sessions.has(tabId)) return;

  switch (method) {
    case "Runtime.consoleAPICalled": {
      // params.type: "log" | "info" | "warn" | "error" | "debug" | ...
      const text = (params.args || []).map(previewArg).join(" ");
      pushConsole(tabId, {
        kind: "console",
        level: params.type,
        text,
        timestamp: params.timestamp,
        stackTrace: params.stackTrace || null,
      });
      break;
    }
    case "Runtime.exceptionThrown": {
      const ex = params.exceptionDetails;
      pushConsole(tabId, {
        kind: "exception",
        level: "error",
        text: ex.exception?.description || ex.text || "Exception",
        timestamp: params.timestamp,
        url: ex.url,
        line: ex.lineNumber,
        column: ex.columnNumber,
        stackTrace: ex.stackTrace || null,
      });
      break;
    }
    case "Log.entryAdded": {
      const e = params.entry;
      pushConsole(tabId, {
        kind: "log",
        level: e.level,
        source: e.source,
        text: e.text,
        url: e.url,
        timestamp: e.timestamp,
      });
      break;
    }
    case "Network.requestWillBeSent": {
      const s = sessions.get(tabId);
      const { requestId, request, type, timestamp, initiator, redirectResponse } = params;
      if (redirectResponse) {
        // The previous request in this chain ended with a redirect — close it out.
        const prev = s.network.get(requestId);
        if (prev) {
          prev.status = redirectResponse.status;
          prev.statusText = redirectResponse.statusText;
          prev.responseHeaders = redirectResponse.headers;
          prev.redirected = true;
        }
      }
      const entry = {
        requestId,
        url: request.url,
        method: request.method,
        type,
        requestHeaders: request.headers,
        postData: request.postData,
        initiator: initiator?.type,
        startTime: timestamp,
        status: null,
        statusText: null,
        mimeType: null,
        responseHeaders: null,
        endTime: null,
        encodedDataLength: null,
        failed: false,
        errorText: null,
      };
      if (s.network.size >= MAX_NETWORK) {
        const oldest = s.networkOrder.shift();
        s.network.delete(oldest);
      }
      s.network.set(requestId, entry);
      s.networkOrder.push(requestId);
      break;
    }
    case "Network.responseReceived": {
      const s = sessions.get(tabId);
      const entry = s.network.get(params.requestId);
      if (!entry) break;
      const r = params.response;
      entry.status = r.status;
      entry.statusText = r.statusText;
      entry.mimeType = r.mimeType;
      entry.responseHeaders = r.headers;
      entry.remoteIPAddress = r.remoteIPAddress;
      break;
    }
    case "Network.loadingFinished": {
      const s = sessions.get(tabId);
      const entry = s.network.get(params.requestId);
      if (!entry) break;
      entry.endTime = params.timestamp;
      entry.encodedDataLength = params.encodedDataLength;
      break;
    }
    case "Network.loadingFailed": {
      const s = sessions.get(tabId);
      const entry = s.network.get(params.requestId);
      if (!entry) break;
      entry.failed = true;
      entry.errorText = params.errorText;
      entry.endTime = params.timestamp;
      break;
    }
    default:
      // ignore other events
      break;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId && sessions.has(source.tabId)) {
    sessions.delete(source.tabId);
  }
});

// Helper: fetch the response body for a given requestId. Use sparingly — bodies
// can be huge. Exposed so the UI/LLM can opt in.
export async function getResponseBody(tabId, requestId) {
  const result = await sendCdp(tabId, "Network.getResponseBody", { requestId });
  return result; // { body, base64Encoded }
}
