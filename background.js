// Nemo Browser Controller — background service worker
// Acts as the central dispatcher between the side panel UI (or any caller)
// and the underlying Chrome APIs: tabs, scripting, debugger.

import {
  snapshotDom,
  performAction,
  scrollPage,
  queryElements,
  inspectElement,
  getElementBbox,
} from "./lib/page-actions.js";
import {
  attachDebugger,
  detachDebugger,
  getConsoleLog,
  getNetworkLog,
  clearLogs,
  isAttached,
} from "./lib/cdp-client.js";
import { installWebSocketBridge } from "./lib/ws-client.js";

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("[Nemo] sidePanel.setPanelBehavior failed:", err));

// --- Helpers ---------------------------------------------------------------

async function getActiveTabId(explicit) {
  if (explicit) return explicit;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  return waitForTabComplete(tabId);
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Navigation timed out"));
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function captureVisibleScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}

// Full-page screenshot via CDP. Requires debugger attached.
async function captureFullPageScreenshot(tabId) {
  if (!isAttached(tabId)) await attachDebugger(tabId);
  const layout = await sendCdp(tabId, "Page.getLayoutMetrics");
  const { contentSize } = layout;
  const clip = {
    x: 0,
    y: 0,
    width: Math.ceil(contentSize.width),
    height: Math.ceil(contentSize.height),
    scale: 1,
  };
  const result = await sendCdp(tabId, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip,
  });
  return `data:image/png;base64,${result.data}`;
}

// Element screenshot via CDP clip. Pads the bbox by `padding` px so the
// surrounding context (siblings, parent edges) is visible to the model.
async function captureElementScreenshot(tabId, ref, padding) {
  const [{ result: bboxResult }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: getElementBbox,
    args: [{ ref }],
  });
  if (!bboxResult.ok) return bboxResult;
  if (!bboxResult.visible) return { ok: false, error: `Element ref "${ref}" has zero size` };

  if (!isAttached(tabId)) await attachDebugger(tabId);

  const pad = typeof padding === "number" && padding >= 0 ? padding : 16;
  const { x, y, w, h } = bboxResult.bbox;
  const clip = {
    x: Math.max(0, Math.floor(x - pad)),
    y: Math.max(0, Math.floor(y - pad)),
    width: Math.ceil(w + pad * 2),
    height: Math.ceil(h + pad * 2),
    scale: 1,
  };
  const shot = await sendCdp(tabId, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip,
  });
  return {
    ok: true,
    dataUrl: `data:image/png;base64,${shot.data}`,
    bbox: bboxResult.bbox,
    clip,
    tag: bboxResult.tag,
  };
}

function sendCdp(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

// --- Command dispatch ------------------------------------------------------

const commands = {
  async navigate({ url, tabId }) {
    const id = await getActiveTabId(tabId);
    await navigate(id, url);
    return { ok: true, tabId: id };
  },

  async snapshot_dom({ tabId }) {
    const id = await getActiveTabId(tabId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: snapshotDom,
    });
    return { ok: true, ...result };
  },

  async snapshot_screenshot({ tabId, fullPage }) {
    const id = await getActiveTabId(tabId);
    const dataUrl = fullPage
      ? await captureFullPageScreenshot(id)
      : await captureVisibleScreenshot(id);
    return { ok: true, dataUrl };
  },

  async screenshot_element({ tabId, ref, padding }) {
    const id = await getActiveTabId(tabId);
    return captureElementScreenshot(id, ref, padding);
  },

  async query({ tabId, selector, text, limit }) {
    const id = await getActiveTabId(tabId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: queryElements,
      args: [{ selector, text, limit }],
    });
    return result;
  },

  async inspect({ tabId, ref, selector }) {
    const id = await getActiveTabId(tabId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: inspectElement,
      args: [{ ref, selector }],
    });
    return result;
  },

  async action({ tabId, action, ref, text }) {
    const id = await getActiveTabId(tabId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: performAction,
      args: [{ action, ref, text }],
    });
    return result;
  },

  async scroll({ tabId, direction, amount }) {
    const id = await getActiveTabId(tabId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: scrollPage,
      args: [{ direction, amount }],
    });
    return result;
  },

  async attach_debugger({ tabId }) {
    const id = await getActiveTabId(tabId);
    await attachDebugger(id);
    return { ok: true, tabId: id };
  },

  async detach_debugger({ tabId }) {
    const id = await getActiveTabId(tabId);
    await detachDebugger(id);
    return { ok: true, tabId: id };
  },

  async get_console({ tabId }) {
    const id = await getActiveTabId(tabId);
    return { ok: true, entries: getConsoleLog(id) };
  },

  async get_network({ tabId }) {
    const id = await getActiveTabId(tabId);
    return { ok: true, entries: getNetworkLog(id) };
  },

  async clear_logs({ tabId }) {
    const id = await getActiveTabId(tabId);
    clearLogs(id);
    return { ok: true };
  },

  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return {
      ok: true,
      tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
    };
  },

  async ping() {
    return { ok: true, pong: Date.now() };
  },
};

// Message bridge: side panel → background.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = commands[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown command: ${message?.type}` });
    return false;
  }
  Promise.resolve(handler(message.payload ?? {}))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true; // keep channel open for async sendResponse
});

// Clean up debugger on tab close.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (isAttached(tabId)) detachDebugger(tabId).catch(() => {});
});

// Connect outbound to the local MCP server. Reconnects automatically.
const wsBridge = installWebSocketBridge(commands);

// Surface bridge status so the side panel can render a "connected" indicator.
commands.bridge_status = async () => ({ ok: true, ...wsBridge.getStatus() });
commands.bridge_reconnect = async () => {
  wsBridge.reconnect();
  return { ok: true };
};
