#!/usr/bin/env node
// Nemo TUI — token usage dashboard for the browser-controller MCP server.
//
// Tails the NDJSON log written by mcp-server/lib/usage-log.js and renders:
//   - session totals header
//   - line chart of tokens per minute (last 30 min)
//   - live table of recent transactions
//   - per-tool aggregates
//
// Open this in a separate terminal pane next to the agent. It refreshes every
// second; new transactions appear within ~1s of being written.

import blessed from "blessed";
import contrib from "blessed-contrib";
import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";

const LOG_PATH =
  process.env.NEMO_USAGE_LOG || `${homedir()}/.nemo-browser/usage.ndjson`;

// ---- State -----------------------------------------------------------------

const transactions = []; // newest last
const sessionStart = Date.now();
let fileOffset = 0;

function loadIncremental() {
  if (!existsSync(LOG_PATH)) return;
  const stat = statSync(LOG_PATH);
  if (stat.size < fileOffset) {
    // log was rotated/truncated — re-read everything
    fileOffset = 0;
    transactions.length = 0;
  }
  if (stat.size === fileOffset) return;

  const fd = openSync(LOG_PATH, "r");
  const len = stat.size - fileOffset;
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, fileOffset);
  closeSync(fd);
  fileOffset = stat.size;

  for (const line of buf.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      transactions.push(JSON.parse(line));
    } catch {
      // skip corrupt line
    }
  }
}

// ---- Aggregations ----------------------------------------------------------

function totalsSinceSessionStart() {
  let calls = 0;
  let tin = 0;
  let tout = 0;
  let errors = 0;
  for (const tx of transactions) {
    if (tx.ts < sessionStart) continue;
    calls += 1;
    tin += tx.tokens_in || 0;
    tout += tx.tokens_out || 0;
    if (!tx.ok) errors += 1;
  }
  return { calls, tin, tout, errors, total: tin + tout };
}

function tokensPerMinute(windowMinutes = 30) {
  // Bucket by minute, last `windowMinutes` minutes ending now.
  const now = Date.now();
  const buckets = new Array(windowMinutes).fill(0);
  for (const tx of transactions) {
    const ageMs = now - tx.ts;
    if (ageMs < 0 || ageMs > windowMinutes * 60_000) continue;
    const bucket = windowMinutes - 1 - Math.floor(ageMs / 60_000);
    if (bucket >= 0 && bucket < windowMinutes) {
      buckets[bucket] += tx.tokens_total || 0;
    }
  }
  const x = buckets.map((_, i) => `-${windowMinutes - 1 - i}m`);
  return { x, y: buckets };
}

function byTool() {
  const m = new Map();
  for (const tx of transactions) {
    const cur = m.get(tx.tool) || { calls: 0, tin: 0, tout: 0 };
    cur.calls += 1;
    cur.tin += tx.tokens_in || 0;
    cur.tout += tx.tokens_out || 0;
    m.set(tx.tool, cur);
  }
  return [...m.entries()]
    .map(([tool, v]) => ({ tool, ...v, total: v.tin + v.tout }))
    .sort((a, b) => b.total - a.total);
}

// ---- UI --------------------------------------------------------------------

const screen = blessed.screen({
  smartCSR: true,
  title: "Nemo Usage",
  fullUnicode: true,
});

screen.key(["q", "C-c", "escape"], () => process.exit(0));

const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// Header (rows 0-1)
const header = grid.set(0, 0, 2, 12, blessed.box, {
  label: " Nemo Usage ",
  border: { type: "line" },
  style: { border: { fg: "green" } },
  tags: true,
  padding: { left: 1, right: 1 },
});

// Line chart: tokens / minute (rows 2-6, full width)
const chart = grid.set(2, 0, 5, 12, contrib.line, {
  label: " Tokens / minute (last 30 min) ",
  showLegend: false,
  wholeNumbersOnly: true,
  style: { line: "green", text: "white", baseline: "gray" },
});

// Recent transactions table (rows 7-9, full width)
const recentTable = grid.set(7, 0, 3, 12, contrib.table, {
  label: " Recent transactions (newest first) ",
  keys: false,
  fg: "white",
  selectedFg: "white",
  selectedBg: "black",
  interactive: false,
  border: { type: "line" },
  columnSpacing: 2,
  columnWidth: [10, 28, 4, 8, 8, 8, 8],
});

// By-tool aggregate (rows 10-11, full width)
const toolTable = grid.set(10, 0, 2, 12, contrib.table, {
  label: " By tool (this log) ",
  keys: false,
  fg: "white",
  interactive: false,
  border: { type: "line" },
  columnSpacing: 2,
  columnWidth: [28, 8, 10, 10, 10],
});

// ---- Rendering -------------------------------------------------------------

function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function render() {
  loadIncremental();

  const t = totalsSinceSessionStart();
  const session = fmtDuration(Date.now() - sessionStart);
  header.setContent(
    [
      `{bold}Session{/bold} ${session}    ` +
        `{bold}Calls{/bold} ${fmtNum(t.calls)}    ` +
        `{bold}Errors{/bold} ${fmtNum(t.errors)}    ` +
        `{bold}Tokens{/bold} ${fmtNum(t.total)}  ` +
        `({green-fg}in ${fmtNum(t.tin)}{/green-fg} / {yellow-fg}out ${fmtNum(t.tout)}{/yellow-fg})`,
      `{gray-fg}Log: ${LOG_PATH}    Press q to quit.{/gray-fg}`,
    ].join("\n")
  );

  const series = tokensPerMinute(30);
  chart.setData([{ title: "tokens", x: series.x, y: series.y }]);

  const recent = transactions.slice(-15).reverse();
  recentTable.setData({
    headers: ["Time", "Tool", "OK", "In", "Out", "Total", "ms"],
    data: recent.map((tx) => [
      fmtTime(tx.ts),
      tx.tool || "?",
      tx.ok ? "✓" : "✗",
      fmtNum(tx.tokens_in),
      fmtNum(tx.tokens_out),
      fmtNum(tx.tokens_total),
      fmtNum(tx.duration_ms),
    ]),
  });

  const tools = byTool();
  toolTable.setData({
    headers: ["Tool", "Calls", "In", "Out", "Total"],
    data: tools.map((r) => [
      r.tool,
      fmtNum(r.calls),
      fmtNum(r.tin),
      fmtNum(r.tout),
      fmtNum(r.total),
    ]),
  });

  screen.render();
}

render();
setInterval(render, 1000);
