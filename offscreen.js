// Offscreen document: hosts the WebSocket bridge to the local MCP server.
// This document is created by background.js (chrome.offscreen.createDocument)
// and persists for the extension's lifetime — independent of MV3 service-worker
// eviction, and independent of whether the side panel is open.
//
// Architecture:
//   - This script holds the WebSocket. installWebSocketBridge dispatches
//     inbound MCP commands by looking up `commands[msg.type]`.
//   - We give it a Proxy whose every property is a function that forwards the
//     call to the service worker via chrome.runtime.sendMessage. The SW owns
//     the chrome.* APIs and the real `commands` table, runs the handler,
//     returns the response. The proxy resolves with the SW's response, which
//     installWebSocketBridge then sends back over the WebSocket.
//   - We also listen for bridge_status_request / bridge_reconnect_request
//     messages from the SW so the side panel's status indicator keeps working.

import { installWebSocketBridge } from "./lib/ws-client.js";

const commandsProxy = new Proxy(
  {},
  {
    get(_target, type) {
      // Each property access returns a handler that forwards to the SW.
      return (payload) =>
        chrome.runtime.sendMessage({
          type,
          payload,
          target: "background",
        });
    },
  }
);

const wsBridge = installWebSocketBridge(commandsProxy);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  if (message.type === "bridge_status_request") {
    sendResponse({ ok: true, ...wsBridge.getStatus() });
    return false;
  }
  if (message.type === "bridge_reconnect_request") {
    wsBridge.reconnect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

console.log("[Nemo offscreen] WebSocket bridge online");
