// Side panel UI — sends commands to the background service worker.

const $ = (sel) => document.querySelector(sel);

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload });
}

// --- status pill / activity log -------------------------------------------

const statusPill = $("#status-pill");
const activityLog = $("#activity-log");

function setStatus(text, kind) {
  statusPill.textContent = text;
  statusPill.classList.remove("ok", "err");
  if (kind === "ok") statusPill.classList.add("ok");
  if (kind === "err") statusPill.classList.add("err");
}

function logActivity(label, payload) {
  const ts = new Date().toLocaleTimeString();
  const json = payload ? `\n${JSON.stringify(payload, null, 2)}` : "";
  activityLog.textContent = `[${ts}] ${label}${json}\n\n${activityLog.textContent}`.slice(0, 8000);
}

async function call(type, payload) {
  setStatus(`${type}…`);
  try {
    const result = await send(type, payload);
    if (!result?.ok) {
      setStatus("err", "err");
      logActivity(`${type} ✗`, result);
      return result;
    }
    setStatus("ok", "ok");
    logActivity(`${type} ✓`, summarize(result));
    return result;
  } catch (err) {
    setStatus("err", "err");
    logActivity(`${type} ✗`, { error: String(err?.message ?? err) });
    return { ok: false, error: String(err?.message ?? err) };
  }
}

function summarize(result) {
  // Avoid dumping huge payloads (screenshots, full DOM trees) into activity log.
  const out = { ...result };
  if (typeof out.dataUrl === "string") out.dataUrl = `${out.dataUrl.slice(0, 32)}… (${out.dataUrl.length} chars)`;
  if (typeof out.tree === "string" && out.tree.length > 200) out.tree = `${out.tree.slice(0, 200)}…`;
  if (typeof out.bodyText === "string" && out.bodyText.length > 100) out.bodyText = `${out.bodyText.slice(0, 100)}…`;
  if (Array.isArray(out.entries)) out.entries = `${out.entries.length} entries`;
  if (Array.isArray(out.elements)) out.elements = `${out.elements.length} elements`;
  return out;
}

// --- Navigate --------------------------------------------------------------

$("#btn-navigate").addEventListener("click", async () => {
  const url = $("#url-input").value.trim();
  if (!url) return;
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  await call("navigate", { url: normalized });
});

$("#url-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btn-navigate").click();
});

$("#btn-list-tabs").addEventListener("click", () => call("list_tabs"));

// --- Snapshot --------------------------------------------------------------

$("#btn-snapshot-dom").addEventListener("click", async () => {
  const result = await call("snapshot_dom");
  if (!result?.ok) return;
  $("#snapshot-meta").textContent = `${result.title} — ${result.url} — ${result.count} interactive elements`;
  $("#snapshot-tree").textContent = result.tree || "(empty)";
});

$("#btn-screenshot").addEventListener("click", async () => {
  const result = await call("snapshot_screenshot");
  if (!result?.ok) return;
  $("#screenshot-container").innerHTML = `<img src="${result.dataUrl}" alt="screenshot" />`;
});

$("#btn-screenshot-full").addEventListener("click", async () => {
  const result = await call("snapshot_screenshot", { fullPage: true });
  if (!result?.ok) return;
  $("#screenshot-container").innerHTML = `<img src="${result.dataUrl}" alt="full-page screenshot" />`;
});

// --- Inspect / Query / Element screenshot --------------------------------

$("#btn-query").addEventListener("click", async () => {
  const raw = $("#query-selector").value.trim();
  if (!raw) return;
  // text:foo → text search; otherwise treat as selector
  const payload = raw.startsWith("text:")
    ? { text: raw.slice(5).trim() }
    : { selector: raw };
  const result = await call("query", payload);
  if (!result?.ok) return;
  const lines = result.elements.map((e) => {
    const cls = e.classes.length ? `.${e.classes.join(".")}` : "";
    const idStr = e.id ? `#${e.id}` : "";
    const vis = e.visible ? "" : " [hidden]";
    const text = e.text ? ` "${e.text}"` : "";
    return `[${e.ref}] <${e.tag}${idStr}${cls}>${text}${vis}`;
  });
  $("#query-output").textContent = lines.length
    ? `${result.count} match${result.count === 1 ? "" : "es"}\n${lines.join("\n")}`
    : "(no matches)";
});

$("#query-selector").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btn-query").click();
});

$("#btn-inspect").addEventListener("click", async () => {
  const ref = $("#inspect-ref").value.trim();
  if (!ref) return;
  const result = await call("inspect", { ref });
  if (!result?.ok) {
    $("#inspect-output").textContent = result?.error || "(failed)";
    return;
  }
  const out = [];
  const cls = result.classes?.length ? `.${result.classes.join(".")}` : "";
  out.push(`<${result.tag}${result.id ? `#${result.id}` : ""}${cls}>`);
  out.push(`bbox: ${Math.round(result.bbox.x)},${Math.round(result.bbox.y)} ${Math.round(result.bbox.w)}×${Math.round(result.bbox.h)}`);
  out.push("\nComputed styles:");
  for (const [k, v] of Object.entries(result.styles)) out.push(`  ${k}: ${v}`);
  out.push("\nParent chain:");
  for (const p of result.parents) {
    const pcls = p.classes.length ? `.${p.classes.join(".")}` : "";
    out.push(`  <${p.tag}${p.id ? `#${p.id}` : ""}${pcls}> display=${p.display} position=${p.position}`);
  }
  if (result.children?.length) {
    out.push(`\nChildren (${result.childrenCount}):`);
    for (const c of result.children) {
      const ccls = c.classes.length ? `.${c.classes.join(".")}` : "";
      out.push(`  <${c.tag}${c.id ? `#${c.id}` : ""}${ccls}>${c.text ? ` "${c.text}"` : ""}`);
    }
  }
  $("#inspect-output").textContent = out.join("\n");
});

$("#btn-screenshot-element").addEventListener("click", async () => {
  const ref = $("#inspect-ref").value.trim();
  const padding = parseInt($("#screenshot-padding").value, 10);
  if (!ref) return;
  const result = await call("screenshot_element", {
    ref,
    padding: Number.isFinite(padding) ? padding : undefined,
  });
  if (!result?.ok) return;
  $("#element-screenshot").innerHTML = `<img src="${result.dataUrl}" alt="element screenshot" />`;
});

// --- Actions --------------------------------------------------------------

document.querySelectorAll("button[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    const ref = $("#action-ref").value.trim();
    const text = $("#action-text").value;
    if (!ref) {
      setStatus("ref?", "err");
      return;
    }
    call("action", { action, ref, text });
  });
});

document.querySelectorAll("button[data-scroll]").forEach((btn) => {
  btn.addEventListener("click", () => {
    call("scroll", { direction: btn.dataset.scroll });
  });
});

// --- DevTools --------------------------------------------------------------

$("#btn-attach").addEventListener("click", () => call("attach_debugger"));
$("#btn-detach").addEventListener("click", () => call("detach_debugger"));
$("#btn-clear").addEventListener("click", () => call("clear_logs"));

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`#tab-${tab.dataset.tab}`).classList.add("active");
  });
});

$("#btn-refresh-console").addEventListener("click", refreshConsole);
$("#btn-refresh-network").addEventListener("click", refreshNetwork);

async function refreshConsole() {
  const result = await call("get_console");
  if (!result?.ok) return;
  const out = $("#console-output");
  if (!result.entries.length) {
    out.textContent = "(no console entries — attach the debugger and reload the page to start capturing)";
    return;
  }
  out.innerHTML = "";
  for (const e of result.entries) {
    const div = document.createElement("div");
    div.className = `console-line ${e.level || ""}`;
    const prefix = `[${e.level || "log"}]`;
    div.innerHTML = `<span class="console-prefix">${prefix}</span>${escapeHtml(e.text || "")}`;
    out.appendChild(div);
  }
  out.scrollTop = out.scrollHeight;
}

async function refreshNetwork() {
  const result = await call("get_network");
  if (!result?.ok) return;
  const tbody = $("#network-table tbody");
  tbody.innerHTML = "";
  if (!result.entries.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" class="muted">(no network entries yet — attach debugger and reload)</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const e of result.entries) {
    const tr = document.createElement("tr");
    const status = e.failed ? "ERR" : (e.status ?? "—");
    const statusClass = typeof e.status === "number" ? `status-${Math.floor(e.status / 100)}` : "";
    tr.innerHTML = `
      <td class="${statusClass}">${status}</td>
      <td>${e.method || ""}</td>
      <td>${e.type || ""}</td>
      <td class="url-cell" title="${escapeAttr(e.url)}">${escapeHtml(shortUrl(e.url))}</td>
    `;
    tbody.appendChild(tr);
  }
}

function shortUrl(u) {
  if (!u) return "";
  try {
    const url = new URL(u);
    return `${url.host}${url.pathname}${url.search}`;
  } catch {
    return u;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/\n/g, " ");
}

// --- MCP bridge status ----------------------------------------------------

const bridgePill = $("#bridge-pill");
async function refreshBridgeStatus() {
  try {
    const res = await send("bridge_status");
    if (res?.connected) {
      bridgePill.textContent = "MCP ✓";
      bridgePill.className = "pill ok";
      bridgePill.title = `Connected since ${new Date(res.connectedSince).toLocaleTimeString()}`;
    } else {
      bridgePill.textContent = "MCP ✗";
      bridgePill.className = "pill err";
      bridgePill.title = res?.lastError || "MCP server not reachable. Start the server (claude-code launches it automatically) and reconnect.";
    }
  } catch (err) {
    bridgePill.textContent = "MCP ?";
    bridgePill.className = "pill";
  }
}
bridgePill.addEventListener("click", () => send("bridge_reconnect").then(refreshBridgeStatus));
refreshBridgeStatus();
setInterval(refreshBridgeStatus, 5000);

// Initial state
setStatus("ready", "ok");
