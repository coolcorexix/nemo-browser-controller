// Append-only NDJSON log of every MCP tool transaction.
// One JSON object per line: easy to tail, easy to grep, easy to parse.
//
// The TUI reads the same file. Schema is intentionally flat so blessed-contrib
// charts can build series without nested traversal.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PATH = `${homedir()}/.nemo-browser/usage.ndjson`;
const LOG_PATH = process.env.NEMO_USAGE_LOG || DEFAULT_PATH;

let initialized = false;
function ensureDir() {
  if (initialized) return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
  } catch {}
  initialized = true;
}

// Anthropic's image token formula (approx): (w * h) / 750 + a small overhead.
function imageTokensFromPng(base64) {
  // PNG IHDR sits right after the 8-byte signature: 4-byte length + "IHDR"
  // + 4-byte width (BE) + 4-byte height (BE) + ... = bytes 16..23 of the file.
  try {
    const buf = Buffer.from(base64.slice(0, 64), "base64");
    if (buf.length < 24) return Math.ceil(base64.length / 4);
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (!w || !h || w > 20000 || h > 20000) {
      return Math.ceil(base64.length / 4);
    }
    return Math.ceil((w * h) / 750) + 75;
  } catch {
    return Math.ceil(base64.length / 4);
  }
}

// Rough Anthropic-equivalent text tokens: ~4 chars per token.
function textTokens(s) {
  if (!s) return 0;
  return Math.ceil(String(s).length / 4);
}

export function estimateTokens(content) {
  // content is an array of MCP content blocks: text | image
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (block?.type === "text") total += textTokens(block.text);
    else if (block?.type === "image" && typeof block.data === "string") {
      total += imageTokensFromPng(block.data);
    }
  }
  return total;
}

export function logTransaction(entry) {
  ensureDir();
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
  try {
    appendFileSync(LOG_PATH, line);
  } catch (err) {
    // Logging must never break the request — swallow write errors.
    process.stderr.write(`[nemo-mcp] usage log write failed: ${err.message}\n`);
  }
}

export const USAGE_LOG_PATH = LOG_PATH;
