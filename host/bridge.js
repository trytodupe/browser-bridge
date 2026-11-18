#!/usr/bin/env node
"use strict";

const net = require("net");

const SOCK = process.env.BRIDGE_SOCK || "/tmp/browser-bridge.sock";
const sock = net.createConnection(SOCK);
const reqId = 1;

let buf = "";
sock.on("data", chunk => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg._probe) continue;
      if (msg._id !== reqId) continue;
      delete msg._id;
      console.log(JSON.stringify(msg, null, 2));
      sock.destroy();
      process.exit(msg.error ? 1 : 0);
    } catch (_) {}
  }
});

sock.on("error", err => {
  console.error("bridge socket error:", err.message);
  process.exit(1);
});

const cmd = process.argv[2] || "tabs";
const arg1 = process.argv[3];
const arg2 = process.argv[4];

const msg = { _id: reqId, cmd };

if (cmd === "tabs") {
  msg.action = arg1 || "list";
  if (msg.action === "list" && arg2) msg.query = arg2;
  else if (arg2) msg.tabId = Number(arg2);
} else if (cmd === "js") {
  msg.code = arg1 || "document.title";
  if (arg2) msg.tabId = Number(arg2);
} else if (cmd === "read" || cmd === "html" || cmd === "screenshot" || cmd === "diagnostics") {
  if (arg1) msg.tabId = Number(arg1);
} else if (cmd === "navigate") {
  msg.url = arg1;
  if (arg2) msg.tabId = Number(arg2);
} else if (cmd === "pick") {
  msg.message = arg1 || "Click an element";
  if (arg2) msg.tabId = Number(arg2);
}

sock.write(JSON.stringify(msg) + "\n");
setTimeout(() => {
  console.error("bridge timed out");
  sock.destroy();
  process.exit(1);
}, cmd === "pick" ? 130000 : 30000);
