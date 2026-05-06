#!/usr/bin/env node
// Nemo Browser Controller — MCP server.
//
// Speaks MCP over stdio to Claude Code (or any MCP client) and hosts a
// WebSocket on localhost that the Chrome extension's service worker connects
// to. Each MCP tool call is forwarded to the extension as { id, type, payload }
// and the extension's response is returned to the MCP client.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.NEMO_WS_PORT || 9223);
const TIMEOUT_MS = Number(process.env.NEMO_TIMEOUT_MS || 30000);

// ---------------------------------------------------------------------------
// IMPORTANT: MCP uses stdout for the protocol. All logging must go to stderr.
// ---------------------------------------------------------------------------
const log = (...args) => console.error("[nemo-mcp]", ...args);

// ---------------------------------------------------------------------------
// WebSocket bridge to the Chrome extension.
// ---------------------------------------------------------------------------
let extSocket = null;
const pending = new Map(); // id -> { resolve, reject, timer }

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
wss.on("listening", () => log(`WS bridge listening on 127.0.0.1:${PORT}`));
wss.on("error", (err) => log("WS server error:", err.message));

wss.on("connection", (ws) => {
  if (extSocket && extSocket.readyState === ws.OPEN) {
    log("replacing previous extension connection");
    try { extSocket.close(); } catch {}
  }
  extSocket = ws;
  log("extension connected");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      log("bad message from extension:", err.message);
      return;
    }
    const { id, ...rest } = msg;
    const p = pending.get(id);
    if (!p) return; // unknown / late response
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(rest);
  });

  ws.on("close", () => {
    log("extension disconnected");
    if (extSocket === ws) extSocket = null;
    // Fail any pending requests so MCP returns errors rather than hanging.
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Extension disconnected mid-request"));
      pending.delete(id);
    }
  });

  ws.on("error", (err) => log("extension socket error:", err.message));
});

function callExtension(type, payload) {
  return new Promise((resolve, reject) => {
    if (!extSocket || extSocket.readyState !== 1 /* OPEN */) {
      return reject(
        new Error(
          "Chrome extension is not connected. Open the Nemo side panel in Chrome (click the extension icon) so its service worker can connect to this MCP server."
        )
      );
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout (${TIMEOUT_MS}ms) waiting for ${type}`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      extSocket.send(JSON.stringify({ id, type, payload: payload ?? {} }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Tool definitions. cmd is the message.type the extension already understands.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "browser_navigate",
    description: "Navigate the active tab to a URL. Waits for load to complete.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL (https://...)" },
        tabId: { type: "number", description: "Optional tab to target. Defaults to active tab." },
      },
      required: ["url"],
    },
    cmd: "navigate",
  },
  {
    name: "browser_snapshot_dom",
    description:
      "Read the current page as a tree of interactive elements. Each element gets a short [ref] ID that can be used in subsequent browser_action calls. Returns title, url, count, the tree text, and a structured elements[] array.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
    },
    cmd: "snapshot_dom",
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a PNG screenshot of the active tab. Set fullPage=true for the entire scroll height (requires the debugger to be attached). Returns the image as an MCP image content block.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        fullPage: { type: "boolean", description: "Whole scroll height instead of just the viewport." },
      },
    },
    cmd: "snapshot_screenshot",
  },
  {
    name: "browser_query",
    description:
      "Find elements by CSS selector or visible text content. Unlike browser_snapshot_dom (which only returns interactive elements), this works on ANY element — decorative SVGs, structural divs, positioned wrappers. Returned refs are usable in browser_inspect, browser_action, and browser_screenshot_element.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector (e.g. 'svg.leaf', '.vine > path', '[data-role=hero]')" },
        text: { type: "string", description: "Substring of visible text content (case-insensitive)" },
        limit: { type: "number", description: "Max results (default 50)" },
        tabId: { type: "number" },
      },
    },
    cmd: "query",
  },
  {
    name: "browser_inspect",
    description:
      "Return rich layout info for one element: bounding box, curated computed styles (~35 layout-relevant CSS properties), parent chain (6 deep), immediate children with bboxes, attributes, truncated outerHTML. Use this to answer 'why is X positioned where it is'. Pass either ref (from a prior snapshot/query) or selector.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        selector: { type: "string" },
        tabId: { type: "number" },
      },
    },
    cmd: "inspect",
  },
  {
    name: "browser_screenshot_element",
    description:
      "Crop a screenshot to a single element plus padding for context. Faster, less noisy than full-page when tuning a small region. Requires the element's ref (from snapshot or query). Padding defaults to 16px. Auto-attaches debugger if needed.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        padding: { type: "number", description: "Pixels of context to include around the element (default 16)" },
        tabId: { type: "number" },
      },
      required: ["ref"],
    },
    cmd: "screenshot_element",
  },
  {
    name: "browser_action",
    description:
      "Perform an action on a ref'd element. Take a browser_snapshot_dom first to get refs. Actions: click, type, press_enter, focus, hover, select, submit. text is required for type and select.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "type", "press_enter", "focus", "hover", "select", "submit"],
        },
        ref: { type: "string", description: "ref ID from a previous snapshot" },
        text: { type: "string", description: "text for type / value for select" },
        tabId: { type: "number" },
      },
      required: ["action", "ref"],
    },
    cmd: "action",
  },
  {
    name: "browser_scroll",
    description: "Scroll the page. direction: up | down | top | bottom. amount in pixels (default ~80% of viewport for up/down).",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
        amount: { type: "number" },
        tabId: { type: "number" },
      },
      required: ["direction"],
    },
    cmd: "scroll",
  },
  {
    name: "browser_attach_debugger",
    description:
      "Attach Chrome's debugger (CDP) to the tab so console messages and network activity can be captured. Chrome will show a yellow 'this tab is being debugged' bar — that is normal.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
    cmd: "attach_debugger",
  },
  {
    name: "browser_detach_debugger",
    description: "Detach the debugger from the tab and stop capturing console + network.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
    cmd: "detach_debugger",
  },
  {
    name: "browser_get_console",
    description:
      "Return buffered console messages, exceptions, and browser-level log entries captured since browser_attach_debugger. Each entry has level, text, optional stack trace.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
    cmd: "get_console",
  },
  {
    name: "browser_get_network",
    description:
      "Return buffered network requests captured since browser_attach_debugger. Each entry has method, status, type, url, mimeType, requestHeaders, responseHeaders, timing, and failure info.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
    cmd: "get_network",
  },
  {
    name: "browser_clear_logs",
    description: "Clear the buffered console + network entries for the tab.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
    cmd: "clear_logs",
  },
  {
    name: "browser_list_tabs",
    description: "List all open Chrome tabs with id, url, title, and active flag.",
    inputSchema: { type: "object", properties: {} },
    cmd: "list_tabs",
  },
];

// ---------------------------------------------------------------------------
// MCP server setup.
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "nemo-browser-controller", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    };
  }

  let result;
  try {
    result = await callExtension(tool.cmd, req.params.arguments ?? {});
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: String(err?.message ?? err) }],
    };
  }

  // Return screenshots as image content blocks so the model can see them.
  if (
    (tool.cmd === "snapshot_screenshot" || tool.cmd === "screenshot_element") &&
    result.ok &&
    typeof result.dataUrl === "string"
  ) {
    const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
    const blocks = [{ type: "image", data: base64, mimeType: "image/png" }];
    // Element screenshots also carry useful metadata; surface it as text.
    if (tool.cmd === "screenshot_element") {
      const meta = `<${result.tag}> at (${Math.round(result.bbox.x)}, ${Math.round(result.bbox.y)}) size ${Math.round(result.bbox.w)}×${Math.round(result.bbox.h)}`;
      blocks.push({ type: "text", text: meta });
    }
    return { content: blocks };
  }

  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: result.error || "Unknown error" }],
    };
  }

  return {
    content: [{ type: "text", text: formatResult(tool.cmd, result) }],
  };
});

function formatResult(cmd, result) {
  // The DOM tree is the most useful textual payload — promote it to top level.
  if (cmd === "snapshot_dom") {
    return [
      `URL: ${result.url}`,
      `Title: ${result.title}`,
      `Interactive elements: ${result.count}`,
      "",
      result.tree || "(no interactive elements found)",
    ].join("\n");
  }
  if (cmd === "query") {
    if (!result.elements?.length) return "No elements matched.";
    const head = `Matched ${result.count}${result.total > result.count ? ` of ${result.total}` : ""}.`;
    const lines = result.elements.map((e) => {
      const cls = e.classes.length ? `.${e.classes.join(".")}` : "";
      const idStr = e.id ? `#${e.id}` : "";
      const vis = e.visible ? "" : " [hidden]";
      const text = e.text ? ` "${e.text}"` : "";
      return `[${e.ref}] <${e.tag}${idStr}${cls}>${text} @ (${Math.round(e.bbox.x)}, ${Math.round(e.bbox.y)}) ${Math.round(e.bbox.w)}×${Math.round(e.bbox.h)}${vis}`;
    });
    return [head, "", ...lines].join("\n");
  }
  if (cmd === "inspect") {
    const lines = [];
    const cls = result.classes?.length ? `.${result.classes.join(".")}` : "";
    const idStr = result.id ? `#${result.id}` : "";
    lines.push(`<${result.tag}${idStr}${cls}>`);
    lines.push(`bbox (viewport): ${Math.round(result.bbox.x)}, ${Math.round(result.bbox.y)} — ${Math.round(result.bbox.w)}×${Math.round(result.bbox.h)}`);
    lines.push(`bbox (document): ${Math.round(result.documentBbox.x)}, ${Math.round(result.documentBbox.y)}`);
    lines.push("");
    lines.push("Computed styles:");
    for (const [k, v] of Object.entries(result.styles)) lines.push(`  ${k}: ${v}`);
    if (result.attributes?.length) {
      lines.push("");
      lines.push("Attributes:");
      for (const a of result.attributes) lines.push(`  ${a.name}="${a.value}"`);
    }
    if (result.parents?.length) {
      lines.push("");
      lines.push("Parent chain (closest first):");
      for (const p of result.parents) {
        const pcls = p.classes.length ? `.${p.classes.join(".")}` : "";
        const pid = p.id ? `#${p.id}` : "";
        const tx = p.transform ? `, transform=${p.transform}` : "";
        lines.push(`  <${p.tag}${pid}${pcls}> display=${p.display} position=${p.position} overflow=${p.overflow}${tx}  bbox=${Math.round(p.bbox.x)},${Math.round(p.bbox.y)} ${Math.round(p.bbox.w)}×${Math.round(p.bbox.h)}`);
      }
    }
    if (result.children?.length) {
      lines.push("");
      lines.push(`Children (${result.childrenCount} total, showing ${result.children.length}):`);
      for (const c of result.children) {
        const ccls = c.classes.length ? `.${c.classes.join(".")}` : "";
        const cid = c.id ? `#${c.id}` : "";
        const tx = c.text ? ` "${c.text}"` : "";
        lines.push(`  <${c.tag}${cid}${ccls}>${tx}  bbox=${Math.round(c.bbox.x)},${Math.round(c.bbox.y)} ${Math.round(c.bbox.w)}×${Math.round(c.bbox.h)}`);
      }
    }
    if (result.outerHTML) {
      lines.push("");
      lines.push("outerHTML:");
      lines.push(result.outerHTML);
    }
    return lines.join("\n");
  }
  // Default: pretty JSON, minus huge fields the LLM rarely needs verbatim.
  const trimmed = { ...result };
  if (typeof trimmed.dataUrl === "string") trimmed.dataUrl = `${trimmed.dataUrl.slice(0, 32)}…(${trimmed.dataUrl.length} chars)`;
  if (typeof trimmed.bodyText === "string" && trimmed.bodyText.length > 1000) {
    trimmed.bodyText = trimmed.bodyText.slice(0, 1000) + "…";
  }
  return JSON.stringify(trimmed, null, 2);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
log(`MCP server ready (stdio) — extension should connect to ws://127.0.0.1:${PORT}`);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
