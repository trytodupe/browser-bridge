"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Minimal 1x1 red PNG base64
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function startMcpHarness(handler) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-test-"));
  const sockPath = path.join(tmpDir, "bridge.sock");
  const shotDir = path.join(tmpDir, "shots");

  const receivedCmds = [];
  const server = net.createServer(conn => {
    let buf = "";
    conn.on("data", chunk => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        receivedCmds.push(msg);
        Promise.resolve(handler(msg)).then(reply => {
          if (reply === "__SILENT_TIMEOUT__") return;
          conn.write(JSON.stringify(Object.assign({}, reply, { _id: msg._id })) + "\n");
        });
      }
    });
  });

  return new Promise(resolve => {
    server.listen(sockPath, () => {
      const proc = spawn(process.execPath, [path.join(__dirname, "..", "host", "mcp-server.js")], {
        env: Object.assign({}, process.env, {
          BRIDGE_SOCK: sockPath,
          BRIDGE_SCREENSHOT_DIR: shotDir
        }),
        stdio: ["pipe", "pipe", "pipe"]
      });

      let outBuf = "";
      const waiters = new Map();
      proc.stdout.on("data", chunk => {
        outBuf += chunk.toString();
        let idx;
        while ((idx = outBuf.indexOf("\n")) !== -1) {
          const line = outBuf.slice(0, idx);
          outBuf = outBuf.slice(idx + 1);
          if (!line.trim()) continue;
          const resp = JSON.parse(line);
          if (waiters.has(resp.id)) {
            const w = waiters.get(resp.id);
            waiters.delete(resp.id);
            w(resp);
          }
        }
      });

      let rpcId = 1;
      function rpc(method, params) {
        const id = rpcId++;
        return new Promise(res => {
          waiters.set(id, res);
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
      }

      async function cleanup() {
        proc.kill();
        await new Promise(r => server.close(r));
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      resolve({ rpc, receivedCmds, shotDir, cleanup });
    });
  });
}

test("tools/list exposes exactly the 8 lean on-demand tools", async () => {
  const h = await startMcpHarness(async () => ({}));
  try {
    const init = await h.rpc("initialize", {});
    assert.equal(init.result.serverInfo.version, "2.0.1");

    const list = await h.rpc("tools/list", {});
    const names = list.result.tools.map(t => t.name);
    assert.deepEqual(names, [
      "browser_tabs",
      "browser_js",
      "browser_read",
      "browser_html",
      "browser_navigate",
      "browser_screenshot",
      "browser_pick",
      "browser_diagnostics"
    ]);
  } finally {
    await h.cleanup();
  }
});

test("browser_tabs forwards query filter and returns compact tab list", async () => {
  const h = await startMcpHarness(async msg => {
    assert.equal(msg.cmd, "tabs");
    assert.equal(msg.query, "bilibili");
    return {
      totalMatched: 1,
      tabs: [{ tabId: 363, windowId: 1, active: false, discarded: false, title: "Bilibili", url: "https://t.bilibili.com/" }]
    };
  });
  try {
    const res = await h.rpc("tools/call", {
      name: "browser_tabs",
      arguments: { action: "list", query: "bilibili" }
    });
    const parsed = JSON.parse(res.result.content[0].text);
    assert.equal(parsed.totalMatched, 1);
    assert.equal(parsed.tabs[0].tabId, 363);
  } finally {
    await h.cleanup();
  }
});

test("browser_js does NOT auto-retry when execution times out", async () => {
  const h = await startMcpHarness(async () => "__SILENT_TIMEOUT__");
  try {
    const res = await h.rpc("tools/call", {
      name: "browser_js",
      arguments: { code: "await new Promise(() => {})", tabId: 339, timeoutMs: 500 }
    });
    assert.equal(res.result.isError, true);
    // Crucial check: command was sent ONCE, never retried 3x!
    assert.equal(h.receivedCmds.length, 1);
    assert.equal(h.receivedCmds[0].tabId, 339);
  } finally {
    await h.cleanup();
  }
});

test("browser_screenshot writes image to owner-only file and strips base64 from JSON", async () => {
  const h = await startMcpHarness(async msg => {
    assert.equal(msg.cmd, "screenshot");
    return {
      dataUrl: TINY_PNG_DATA_URL,
      mimeType: "image/png",
      width: 1280,
      height: 720,
      originalWidth: 5210,
      originalHeight: 2784,
      tabId: 364,
      windowId: 1,
      active: false,
      discarded: false,
      title: "Video",
      url: "https://www.bilibili.com/video/BV1ehsm69E9Y/"
    };
  });
  try {
    const res = await h.rpc("tools/call", {
      name: "browser_screenshot",
      arguments: { tabId: 364, format: "png" }
    });
    const parsed = JSON.parse(res.result.content[0].text);
    assert.equal(parsed.dataUrl, undefined);
    assert.ok(parsed.filePath.startsWith(h.shotDir));
    assert.ok(fs.existsSync(parsed.filePath));
    assert.equal(parsed.width, 1280);
    assert.equal(parsed.originalWidth, 5210);
    const mode = fs.statSync(parsed.filePath).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await h.cleanup();
  }
});
