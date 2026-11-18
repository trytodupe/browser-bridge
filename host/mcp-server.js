#!/usr/bin/env node
"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SOCK = process.env.BRIDGE_SOCK || "/tmp/browser-bridge.sock";
const SCREENSHOT_DIR = process.env.BRIDGE_SCREENSHOT_DIR || path.join(os.tmpdir(), "browser-bridge-screenshots");
const MAX_SCREENSHOT_FILES = 30;

let sock = null;
let sockConnected = false;
let buf = "";
const pending = new Map();
let nextId = 1;

function failAllPending(reason) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.onSocketClose(reason);
  }
  pending.clear();
}

function connect() {
  if (sock) return;
  sockConnected = false;
  const s = net.createConnection(SOCK);
  sock = s;

  s.on("connect", () => {
    sockConnected = true;
  });

  s.on("data", chunk => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg._id != null && pending.has(msg._id)) {
          const entry = pending.get(msg._id);
          pending.delete(msg._id);
          clearTimeout(entry.timer);
          entry.resolve(msg);
        }
      } catch (_) {}
    }
  });

  s.on("error", () => {});

  s.on("close", () => {
    if (sock === s) {
      sock = null;
      sockConnected = false;
    }
    failAllPending("Unix socket closed (is Firefox running with browser-bridge enabled?)");
  });
}

// Send a command over the Unix socket to host.js -> Firefox addon.
// Never retries after a timeout (prevents duplicate execution of batch JS/fetch).
// Only retries once if a previously idle socket had silently closed right as we wrote.
function send(msg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const attempt = allowReconnectRetry => {
      const wasAlreadyOpen = Boolean(sock && sockConnected);
      if (!sock) connect();
      const id = nextId++;
      const sentAt = Date.now();
      const wireMsg = Object.assign({}, msg, { _id: id });

      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Timed out after " + timeoutMs + "ms waiting for browser response"));
      }, timeoutMs);

      pending.set(id, {
        timer,
        resolve: resp => {
          delete resp._id;
          if (resp && resp.text === "" && resp.tabId === undefined && msg.cmd !== "read") {
            reject(new Error("Legacy browser-bridge v1.x addon responded; reload/install the v2.0 addon in Firefox"));
            return;
          }
          resolve(resp);
        },
        onSocketClose: reason => {
          // Only reconnect-retry if we wrote to a pre-existing idle socket that broke immediately (<250ms).
          if (allowReconnectRetry && wasAlreadyOpen && Date.now() - sentAt < 250) {
            attempt(false);
            return;
          }
          reject(new Error(reason));
        }
      });

      try {
        sock.write(JSON.stringify(wireMsg) + "\n");
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        try { sock && sock.destroy(); } catch (_) {}
        sock = null;
        sockConnected = false;
        if (allowReconnectRetry) {
          attempt(false);
          return;
        }
        reject(err);
      }
    };

    attempt(true);
  });
}

function saveScreenshotToDisk(resp) {
  if (!resp || !resp.dataUrl) return resp;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(resp.dataUrl);
  if (!match) {
    throw new Error("Unexpected screenshot dataUrl format");
  }
  const mimeType = match[1];
  const ext = mimeType === "image/png" ? "png" : "jpg";
  const bytes = Buffer.from(match[2], "base64");

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(SCREENSHOT_DIR, 0o700); } catch (_) {}

  const fileName = `shot-${Date.now()}-tab${resp.tabId || 0}.${ext}`;
  const filePath = path.join(SCREENSHOT_DIR, fileName);
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });

  // Prune old screenshots so /tmp stays bounded.
  try {
    const entries = fs.readdirSync(SCREENSHOT_DIR)
      .filter(f => f.startsWith("shot-"))
      .map(f => {
        const full = path.join(SCREENSHOT_DIR, f);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const old of entries.slice(MAX_SCREENSHOT_FILES)) {
      try { fs.unlinkSync(old.full); } catch (_) {}
    }
  } catch (_) {}

  const out = Object.assign({}, resp);
  delete out.dataUrl;
  out.filePath = filePath;
  out.mimeType = mimeType;
  out.bytes = bytes.length;
  return out;
}

const TOOLS = [
  {
    name: "browser_tabs",
    description: "List, filter, switch, or close browser tabs. Pass 'query' when listing to filter by title/URL substring (or '/regex/') instead of dumping 90+ tabs. All tools accept 'tabId' directly and execute in the background without stealing user focus, so you rarely need 'switch'.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "switch", "close"], description: "'list' (default), 'switch', or 'close'" },
        query: { type: "string", description: "For 'list': case-insensitive substring or '/regex/' matching tab title or URL" },
        activeOnly: { type: "boolean", description: "For 'list': only return active tabs across windows" },
        tabId: { type: "number", description: "Exact integer tabId (from 'list') for 'switch' or 'close'" },
        focusWindow: { type: "boolean", description: "For 'switch': also bring the browser window to OS foreground (default false)" }
      },
      required: ["action"]
    }
  },
  {
    name: "browser_js",
    description: "Execute JavaScript in a tab (defaults to MAIN world with automatic CSP fallback to ISOLATED world) and return the serialized result. Pass explicit 'tabId' so execution runs silently in the background tab without stealing focus. Never auto-retried on timeout.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JS expression, IIFE, or async IIFE '(() => { ... })()' to evaluate" },
        tabId: { type: "number", description: "Target tabId from browser_tabs (recommended; omits focus switch). Defaults to active tab if omitted." },
        timeoutMs: { type: "number", description: "Execution timeout in ms (default 15000, max 120000 for batch fetch)" },
        world: { type: "string", enum: ["auto", "MAIN", "ISOLATED"], description: "Execution world: 'auto' (default, MAIN with CSP fallback), 'MAIN', or 'ISOLATED'" },
        frameId: { type: "number", description: "Target frameId (default 0 for top-level document)" }
      },
      required: ["code"]
    }
  },
  {
    name: "browser_read",
    description: "Extract readable text from a tab (on-demand, zero background footprint). Supports scoping to a CSS selector and skipping hidden elements.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId from browser_tabs (runs in background without switching focus)" },
        selector: { type: "string", description: "Optional CSS selector to scope text extraction" },
        visibleOnly: { type: "boolean", description: "Skip display:none / visibility:hidden subtrees (default true)" },
        maxChars: { type: "number", description: "Truncate output to N chars (default 20000)" }
      }
    }
  },
  {
    name: "browser_html",
    description: "Get outerHTML of the full document or a specific CSS selector from a tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId from browser_tabs" },
        selector: { type: "string", description: "Optional CSS selector to read only that subtree's outerHTML" },
        maxChars: { type: "number", description: "Truncate output to N chars (default 30000)" }
      }
    }
  },
  {
    name: "browser_navigate",
    description: "Open a URL in a background/foreground tab, navigate an existing tabId, or reload a tabId. Opens in background by default (active=false) to avoid interrupting the user.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open or navigate to (omit when reload=true)" },
        tabId: { type: "number", description: "Existing tabId to navigate or reload" },
        newTab: { type: "boolean", description: "Open in a new tab (default true when tabId is omitted)" },
        active: { type: "boolean", description: "Focus the tab in foreground (default false)" },
        reload: { type: "boolean", description: "Reload target tabId" },
        bypassCache: { type: "boolean", description: "Bypass browser cache when reloading" }
      }
    }
  },
  {
    name: "browser_screenshot",
    description: "Capture a crisp screenshot of a tab (works on background tabs too via Firefox captureTab) and save to a local file. Defaults to WebRender native scale=1 (1:1 CSS pixel density — 75% fewer pixels than 2x 4K HiDPI while keeping 12px CJK text sharp) and lossless PNG.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId (can capture background tabs without switching focus)" },
        scale: { type: "number", description: "Device pixels per CSS pixel passed directly to WebRender (default 1 = 1x CSS resolution; pass 2 for native 4K Retina)" },
        maxWidth: { type: "number", description: "Optional max output width cap in px (default 0 = use exact scale without fractional resampling)" },
        format: { type: "string", enum: ["png", "jpeg"], description: "Output image format (default 'png' for crisp text; use 'jpeg' for photo-heavy pages)" },
        quality: { type: "number", description: "JPEG quality 1-100 when format='jpeg' (default 90)" },
        selector: { type: "string", description: "Optional CSS selector to crop screenshot to that element" }
      }
    }
  },
  {
    name: "browser_pick",
    description: "Launch an interactive visual element picker in the tab so the user can click element(s) (Cmd/Ctrl+Click for multi-select, Enter to finish, Esc to cancel). Returns unique CSS selector, bounding rect, text, and HTML snippet.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Prompt banner shown to the user (e.g. 'Click the target button')" },
        tabId: { type: "number", description: "Target tabId (automatically focused so the user can click)" },
        timeoutMs: { type: "number", description: "Max wait time for user selection in ms (default 120000)" }
      },
      required: ["message"]
    }
  },
  {
    name: "browser_diagnostics",
    description: "Zero-idle-cost network & console diagnostics for a single tab. 'snapshot' (default) instantly reads Performance Resource/Navigation entries without prior hooks. 'start' attaches per-tab webRequest & console/uncaught-error capture ONLY on that tabId (pass reload=true to capture load-time errors from document_start). 'stop' detaches.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId" },
        action: { type: "string", enum: ["snapshot", "start", "stop"], description: "'snapshot' (default), 'start', or 'stop'" },
        reload: { type: "boolean", description: "With action='start': reload the tab after attaching hooks to capture page-load errors" },
        bypassCache: { type: "boolean", description: "With reload=true: bypass cache" },
        urlFilter: { type: "string", description: "Optional case-insensitive substring to filter network URLs" }
      }
    }
  }
];

let stdinBuf = "";
process.stdin.on("data", chunk => {
  stdinBuf += chunk.toString();
  let newline;
  while ((newline = stdinBuf.indexOf("\n")) !== -1) {
    const line = stdinBuf.slice(0, newline);
    stdinBuf = stdinBuf.slice(newline + 1);
    if (line.trim()) handle(line);
  }
});

async function dispatchTool(name, args = {}) {
  switch (name) {
    case "browser_tabs":
      return send({
        cmd: "tabs",
        action: args.action || "list",
        query: args.query,
        activeOnly: args.activeOnly,
        tabId: args.tabId,
        focusWindow: args.focusWindow
      }, 10000);

    case "browser_js": {
      const execTimeout = Math.min(Math.max(Number(args.timeoutMs) || 15000, 500), 120000);
      return send({
        cmd: "js",
        code: args.code,
        tabId: args.tabId,
        timeoutMs: execTimeout,
        world: args.world || "auto",
        frameId: args.frameId
      }, execTimeout + 5000);
    }

    case "browser_read":
      return send({
        cmd: "read",
        tabId: args.tabId,
        selector: args.selector,
        visibleOnly: args.visibleOnly,
        maxChars: args.maxChars
      }, 20000);

    case "browser_html":
      return send({
        cmd: "html",
        tabId: args.tabId,
        selector: args.selector,
        maxChars: args.maxChars
      }, 20000);

    case "browser_navigate":
      return send({
        cmd: "navigate",
        url: args.url,
        tabId: args.tabId,
        newTab: args.newTab,
        active: args.active,
        reload: args.reload,
        bypassCache: args.bypassCache
      }, 25000);

    case "browser_screenshot": {
      const resp = await send({
        cmd: "screenshot",
        tabId: args.tabId,
        scale: args.scale,
        maxWidth: args.maxWidth,
        format: args.format,
        quality: args.quality,
        selector: args.selector
      }, 25000);
      if (resp && resp.error) return resp;
      return saveScreenshotToDisk(resp);
    }

    case "browser_pick": {
      const pickTimeout = Math.min(Math.max(Number(args.timeoutMs) || 120000, 5000), 300000);
      return send({
        cmd: "pick",
        message: args.message,
        tabId: args.tabId,
        timeoutMs: pickTimeout
      }, pickTimeout + 5000);
    }

    case "browser_diagnostics":
      return send({
        cmd: "diagnostics",
        tabId: args.tabId,
        action: args.action || "snapshot",
        reload: args.reload,
        bypassCache: args.bypassCache,
        urlFilter: args.urlFilter
      }, args.reload ? 25000 : 15000);

    default:
      throw new Error("Unknown tool: " + name);
  }
}

async function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    process.stderr.write("mcp-server invalid JSON: " + e.message + "\n");
    return;
  }

  const { id, method, params } = req;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "browser-bridge", version: "2.0.1" }
    });
    return;
  }
  if (method === "notifications/initialized") {
    return;
  }
  if (method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    try {
      const result = await dispatchTool(name, args || {});
      const isErr = Boolean(result && result.error);
      respond(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        ...(isErr ? { isError: true } : {})
      });
    } catch (e) {
      respond(id, {
        content: [{ type: "text", text: JSON.stringify({ error: e.message || String(e) }) }],
        isError: true
      });
    }
    return;
  }
  if (id !== undefined) {
    respondError(id, -32601, "Unknown method: " + method);
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
