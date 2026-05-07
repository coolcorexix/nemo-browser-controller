// Visually marks the tab being driven by the Nemo controller with two
// indicators that persist for the life of the session:
//   1. Tab group "Nemo" (green) — visible in the Chrome tab strip.
//   2. Green inset border over the page viewport — visible to the user and
//      captured in screenshots, so it's clear which tab the agent is acting on.

const GROUP_TITLE = "Nemo";
const GROUP_COLOR = "green";
const OVERLAY_ID = "__nemo_control_indicator__";
const BORDER_COLOR = "#16a34a"; // green-700

// Track tabs we've already grouped so we don't thrash the tabGroups API on
// every command (SW eviction resets this, but that's fine — we re-check
// tab.groupId before calling chrome.tabs.group).
const groupedTabs = new Set();

// ---- Tab group ---------------------------------------------------------------

async function ensureGroupId(windowId) {
  const existing = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId });
  return existing[0]?.id ?? null;
}

async function addToNemoGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const knownGroupId = await ensureGroupId(tab.windowId);

  // Already in the right group — nothing to do.
  if (knownGroupId != null && tab.groupId === knownGroupId) return;

  const newGroupId = await chrome.tabs.group(
    knownGroupId != null
      ? { tabIds: tabId, groupId: knownGroupId }
      : { tabIds: tabId }
  );
  await chrome.tabGroups.update(newGroupId, { title: GROUP_TITLE, color: GROUP_COLOR });
}

// ---- Viewport overlay --------------------------------------------------------

// Runs in the page world — must be self-contained (no closure references).
function _applyOverlay({ id, color }) {
  if (document.getElementById(id)) return;
  const el = document.createElement("div");
  el.id = id;
  el.style.cssText =
    "position:fixed;top:0;left:0;right:0;bottom:0;" +
    `border:4px solid ${color};` +
    "pointer-events:none;z-index:2147483647;box-sizing:border-box;";
  (document.documentElement ?? document.body).appendChild(el);
}

async function injectOverlay(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: _applyOverlay,
    args: [{ id: OVERLAY_ID, color: BORDER_COLOR }],
  });
}

// ---- Public API --------------------------------------------------------------

export async function markTabAsControlled(tabId) {
  // Tab group: skip if already handled this session and still in a group.
  if (!groupedTabs.has(tabId)) {
    addToNemoGroup(tabId)
      .then(() => groupedTabs.add(tabId))
      .catch((err) => console.warn("[Nemo] tab group error:", err?.message ?? err));
  }

  // Viewport overlay: inject on every call — idempotent inside the page
  // (skips if the div already exists), re-injects after navigation wipes it.
  injectOverlay(tabId).catch(() => {
    // Silently ignore restricted pages (chrome://, web store, etc.).
  });
}

export function forgetTab(tabId) {
  groupedTabs.delete(tabId);
}
