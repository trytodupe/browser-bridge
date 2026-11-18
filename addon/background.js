"use strict";

let port = null;

// Per-tab opt-in diagnostic state: tabId -> { requests: [], listeners: {...} }
// Empty during normal browsing so 99%+ of tabs incur zero overhead.
const monitoredTabs = new Map();
const MAX_DIAG_ENTRIES = 500;

function reply(msg, data) {
  const payload = Object.assign({}, data);
  if (msg._id != null) payload._id = msg._id;
  if (port) port.postMessage(payload);
}

function waitTabLoaded(tabId, timeout = 15000) {
  return new Promise(resolve => {
    let settled = false;
    const done = tab => {
      if (settled) return;
      settled = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(tab);
    };
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      done(tab);
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => {
      browser.tabs.get(tabId).then(done, () => {
        settled = true;
        browser.tabs.onUpdated.removeListener(onUpdated);
        resolve(null);
      });
    }, timeout);
    browser.tabs.get(tabId).then(tab => {
      if (tab && tab.status === "complete" && !tab.discarded) done(tab);
    }, () => {});
  });
}

async function resolveTab(tabId, opts = {}) {
  const { wakeDiscarded = true } = opts;
  let tab = null;
  if (tabId != null) {
    const numericId = Number(tabId);
    if (!Number.isInteger(numericId) || numericId < 0) {
      throw new Error("Invalid tabId: " + tabId + " (pass a valid integer tab.id from browser_tabs)");
    }
    try {
      tab = await browser.tabs.get(numericId);
    } catch (e) {
      throw new Error("No open tab with tabId=" + numericId + " (call browser_tabs with action='list' to find current tabIds)");
    }
  } else {
    let tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs.length) tabs = await browser.tabs.query({ active: true });
    if (!tabs.length) throw new Error("No active tab found");
    tab = tabs[0];
  }

  if (wakeDiscarded && tab.discarded) {
    await browser.tabs.reload(tab.id);
    const loaded = await waitTabLoaded(tab.id, 15000);
    if (loaded) tab = loaded;
  }
  return tab;
}

function tabMeta(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    discarded: Boolean(tab.discarded),
    title: tab.title || "",
    url: tab.url || ""
  };
}

// Executed inside the page (MAIN world) via browser.scripting.executeScript.
async function mainWorldJsRunner(code, timeoutMs) {
  function serializeValue(val, depth, seen) {
    if (val === undefined) return null;
    if (val === null || typeof val === "boolean" || typeof val === "number" || typeof val === "string") {
      if (typeof val === "number" && !Number.isFinite(val)) return String(val);
      return val;
    }
    if (typeof val === "bigint") return val.toString() + "n";
    if (typeof val === "function") return "[Function: " + (val.name || "anonymous") + "]";
    if (typeof val === "symbol") return String(val);
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack || null };
    }
    if (typeof Element !== "undefined" && val instanceof Element) {
      return {
        _element: val.tagName.toLowerCase(),
        id: val.id || null,
        class: val.getAttribute("class") || null,
        text: (val.textContent || "").trim().slice(0, 200)
      };
    }
    if (typeof DOMRectReadOnly !== "undefined" && val instanceof DOMRectReadOnly) {
      return { x: val.x, y: val.y, width: val.width, height: val.height, top: val.top, right: val.right, bottom: val.bottom, left: val.left };
    }
    if (depth > 8) return "[MaxDepth]";
    if (seen.has(val)) return "[Circular]";
    seen.add(val);
    if (Array.isArray(val)) {
      return val.map(item => serializeValue(item, depth + 1, seen));
    }
    if (val instanceof Map) {
      const obj = {};
      for (const [k, v] of val.entries()) obj[String(k)] = serializeValue(v, depth + 1, seen);
      return obj;
    }
    if (val instanceof Set) {
      return Array.from(val).map(item => serializeValue(item, depth + 1, seen));
    }
    const out = {};
    for (const key of Object.keys(val)) {
      try {
        out[key] = serializeValue(val[key], depth + 1, seen);
      } catch (e) {
        out[key] = "[Thrown: " + (e && e.message ? e.message : String(e)) + "]";
      }
    }
    return out;
  }

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let fn;
  try {
    try {
      fn = new AsyncFunction("return (\n" + code + "\n);");
    } catch (syntaxErr) {
      if (syntaxErr && syntaxErr.name === "EvalError") {
        return { __cspBlocked: true };
      }
      fn = new AsyncFunction(code);
    }
  } catch (err) {
    if (err && (err.name === "EvalError" || /Content-Security-Policy|CSP|unsafe-eval/i.test(String(err.message || err)))) {
      return { __cspBlocked: true };
    }
    return { __error: err && err.message ? err.message : String(err) };
  }

  try {
    let timer = null;
    const execPromise = Promise.resolve(fn());
    const raceList = [execPromise];
    if (timeoutMs > 0) {
      raceList.push(new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Execution timed out after " + timeoutMs + "ms")), timeoutMs);
      }));
    }
    const raw = await Promise.race(raceList);
    if (timer) clearTimeout(timer);
    return { __ok: true, result: serializeValue(raw, 0, new WeakSet()) };
  } catch (err) {
    return { __error: err && err.message ? err.message : String(err) };
  }
}

function buildIsolatedFallbackScript(code, timeoutMs) {
  return `(async function() {
    const page = window.wrappedJSObject || window;
    function toSafe(v) {
      if (v === undefined) return null;
      try { return JSON.parse(JSON.stringify(v)); } catch (_) { return String(v); }
    }
    let timer = null;
    const run = (async () => {
      try {
        return eval(${JSON.stringify("(" + code + ")")});
      } catch (e) {
        if (e instanceof SyntaxError) {
          const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
          return await (new AsyncFn("page", ${JSON.stringify(code)}))(page);
        }
        throw e;
      }
    })();
    try {
      const res = await Promise.race([
        run,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("Execution timed out after ${timeoutMs}ms")), ${timeoutMs}); })
      ]);
      if (timer) clearTimeout(timer);
      return { __ok: true, result: toSafe(res) };
    } catch (err) {
      if (timer) clearTimeout(timer);
      return { __error: err && err.message ? err.message : String(err) };
    }
  })();`;
}

async function handleJs(msg) {
  const tab = await resolveTab(msg.tabId);
  const frameId = Number.isInteger(msg.frameId) ? msg.frameId : 0;
  const timeoutMs = Math.min(Math.max(Number(msg.timeoutMs) || 15000, 500), 120000);
  const requestedWorld = msg.world || "auto";

  if (requestedWorld === "MAIN" || requestedWorld === "auto") {
    const injected = await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      world: "MAIN",
      func: mainWorldJsRunner,
      args: [msg.code, timeoutMs]
    });
    const res = injected && injected[0] ? injected[0].result : null;
    if (res && res.__cspBlocked && requestedWorld === "auto") {
      const isoRes = await browser.tabs.executeScript(tab.id, {
        frameId,
        code: buildIsolatedFallbackScript(msg.code, timeoutMs)
      });
      const out = isoRes && isoRes[0] ? isoRes[0] : null;
      if (!out) return Object.assign({ error: "No result from isolated fallback" }, tabMeta(tab));
      if (out.__error) return Object.assign({ error: out.__error, world: "ISOLATED" }, tabMeta(tab));
      return Object.assign({ result: out.result, world: "ISOLATED" }, tabMeta(tab));
    }
    if (!res) return Object.assign({ result: null, world: "MAIN" }, tabMeta(tab));
    if (res.__cspBlocked) {
      return Object.assign({ error: "Blocked by page CSP in MAIN world (use world='auto' or world='ISOLATED')" }, tabMeta(tab));
    }
    if (res.__error) return Object.assign({ error: res.__error, world: "MAIN" }, tabMeta(tab));
    return Object.assign({ result: res.result, world: "MAIN" }, tabMeta(tab));
  }

  const isoRes = await browser.tabs.executeScript(tab.id, {
    frameId,
    code: buildIsolatedFallbackScript(msg.code, timeoutMs)
  });
  const out = isoRes && isoRes[0] ? isoRes[0] : null;
  if (!out) return Object.assign({ result: null, world: "ISOLATED" }, tabMeta(tab));
  if (out.__error) return Object.assign({ error: out.__error, world: "ISOLATED" }, tabMeta(tab));
  return Object.assign({ result: out.result, world: "ISOLATED" }, tabMeta(tab));
}

function domReadRunner(selector, visibleOnly, maxChars) {
  let root = document.body || document.documentElement;
  if (selector) {
    const found = document.querySelector(selector);
    if (!found) return { error: "No element matched selector: " + selector };
    root = found;
  }
  if (!root) return { text: "", truncated: false, totalChars: 0 };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node;
  while ((node = walker.nextNode())) {
    const parentTag = node.parentElement ? node.parentElement.tagName : "";
    if (parentTag === "SCRIPT" || parentTag === "STYLE" || parentTag === "NOSCRIPT") continue;
    const t = node.textContent.trim();
    if (!t) continue;
    if (visibleOnly) {
      let el = node.parentElement;
      let hidden = false;
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.hidden) { hidden = true; break; }
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") { hidden = true; break; }
        el = el.parentElement;
      }
      if (hidden) continue;
    }
    parts.push(t);
  }
  const text = parts.join("\n");
  const cap = Number(maxChars) > 0 ? Number(maxChars) : 0;
  const truncated = Boolean(cap && text.length > cap);
  return {
    text: truncated ? text.slice(0, cap) : text,
    truncated,
    totalChars: text.length
  };
}

async function handleRead(msg) {
  const tab = await resolveTab(msg.tabId);
  const visibleOnly = msg.visibleOnly !== false;
  const maxChars = msg.maxChars != null ? Number(msg.maxChars) : 20000;
  const injected = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: domReadRunner,
    args: [msg.selector || null, visibleOnly, maxChars]
  });
  const res = injected && injected[0] ? injected[0].result : { error: "Failed to read tab" };
  return Object.assign({}, res, tabMeta(tab));
}

function domHtmlRunner(selector, maxChars) {
  let target = document.documentElement;
  if (selector) {
    target = document.querySelector(selector);
    if (!target) return { error: "No element matched selector: " + selector };
  }
  const html = target ? target.outerHTML : "";
  const cap = Number(maxChars) > 0 ? Number(maxChars) : 0;
  const truncated = Boolean(cap && html.length > cap);
  return {
    html: truncated ? html.slice(0, cap) : html,
    truncated,
    totalChars: html.length
  };
}

async function handleHtml(msg) {
  const tab = await resolveTab(msg.tabId);
  const maxChars = msg.maxChars != null ? Number(msg.maxChars) : 30000;
  const injected = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: domHtmlRunner,
    args: [msg.selector || null, maxChars]
  });
  const res = injected && injected[0] ? injected[0].result : { error: "Failed to read HTML" };
  return Object.assign({}, res, tabMeta(tab));
}

async function handleTabs(msg) {
  const action = msg.action || "list";
  if (action === "list") {
    let tabs = await browser.tabs.query(msg.activeOnly ? { active: true } : {});
    if (msg.query) {
      const q = String(msg.query);
      let matcher;
      if (q.length > 2 && q.startsWith("/") && q.endsWith("/")) {
        const re = new RegExp(q.slice(1, -1), "i");
        matcher = t => re.test(t.title || "") || re.test(t.url || "");
      } else {
        const lower = q.toLowerCase();
        matcher = t => (t.title || "").toLowerCase().includes(lower) || (t.url || "").toLowerCase().includes(lower);
      }
      tabs = tabs.filter(matcher);
    }
    return {
      totalMatched: tabs.length,
      tabs: tabs.map(t => ({
        tabId: t.id,
        windowId: t.windowId,
        active: Boolean(t.active),
        discarded: Boolean(t.discarded),
        title: t.title || "",
        url: t.url || ""
      }))
    };
  }
  if (action === "switch") {
    const tab = await resolveTab(msg.tabId, { wakeDiscarded: true });
    const updated = await browser.tabs.update(tab.id, { active: true });
    if (msg.focusWindow) {
      await browser.windows.update(updated.windowId, { focused: true });
    }
    return { switched: tabMeta(updated) };
  }
  if (action === "close") {
    if (msg.tabId == null) throw new Error("tabId is required for action='close'");
    const tab = await resolveTab(msg.tabId, { wakeDiscarded: false });
    const meta = tabMeta(tab);
    await browser.tabs.remove(tab.id);
    return { closed: meta };
  }
  throw new Error("Unknown tabs action: " + action);
}

async function handleNavigate(msg) {
  const active = msg.active === true;
  if (msg.reload && !msg.url) {
    const tab = await resolveTab(msg.tabId, { wakeDiscarded: false });
    if (active) await browser.tabs.update(tab.id, { active: true });
    await browser.tabs.reload(tab.id, { bypassCache: Boolean(msg.bypassCache) });
    const loaded = (await waitTabLoaded(tab.id, 15000)) || (await browser.tabs.get(tab.id));
    return tabMeta(loaded);
  }
  if (!msg.url) throw new Error("url is required unless reload=true");
  const openNewTab = msg.tabId == null ? msg.newTab !== false : Boolean(msg.newTab);
  if (openNewTab) {
    const created = await browser.tabs.create({ url: msg.url, active });
    const loaded = (await waitTabLoaded(created.id, 15000)) || (await browser.tabs.get(created.id));
    return tabMeta(loaded);
  }
  const target = await resolveTab(msg.tabId, { wakeDiscarded: false });
  const updateProps = { url: msg.url };
  if (msg.active != null) updateProps.active = Boolean(msg.active);
  await browser.tabs.update(target.id, updateProps);
  const loaded = (await waitTabLoaded(target.id, 15000)) || (await browser.tabs.get(target.id));
  return tabMeta(loaded);
}

function getViewportAndRectRunner(selector) {
  const viewport = {
    cssWidth: window.innerWidth || document.documentElement.clientWidth || 1920,
    cssHeight: window.innerHeight || document.documentElement.clientHeight || 1080,
    dpr: window.devicePixelRatio || 1
  };
  if (!selector) return viewport;

  const el = document.querySelector(selector);
  if (!el) return Object.assign({ error: "No element matched selector: " + selector }, viewport);
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) {
    return Object.assign({ error: "Matched element has zero dimensions (" + r.width + "x" + r.height + ")" }, viewport);
  }
  return Object.assign({
    rect: {
      x: Math.max(0, Math.floor(window.scrollX + r.left)),
      y: Math.max(0, Math.floor(window.scrollY + r.top)),
      width: Math.ceil(r.width),
      height: Math.ceil(r.height)
    }
  }, viewport);
}

function measureDataUrlDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Failed to decode captured tab screenshot"));
    img.src = dataUrl;
  });
}

async function handleScreenshot(msg) {
  const tab = await resolveTab(msg.tabId, { wakeDiscarded: true });
  const format = msg.format === "jpeg" ? "jpeg" : "png";
  const quality = Math.min(Math.max(Number(msg.quality) || 90, 1), 100);

  let cssWidth = tab.width || 0;
  let cssHeight = tab.height || 0;
  let dpr = 2;
  let rect = null;

  if (msg.selector || !cssWidth || !cssHeight) {
    const injected = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      func: getViewportAndRectRunner,
      args: [msg.selector || null]
    }).catch(() => null);
    const info = injected && injected[0] ? injected[0].result : null;
    if (msg.selector && (!info || info.error)) {
      return Object.assign({ error: info ? info.error : "Failed to locate selector" }, tabMeta(tab));
    }
    if (info) {
      cssWidth = info.cssWidth || cssWidth;
      cssHeight = info.cssHeight || cssHeight;
      dpr = info.dpr || dpr;
      rect = info.rect || null;
    }
  }

  const baseCssWidth = rect ? rect.width : (cssWidth || 1920);
  // Default scale=1 renders directly in WebRender at 1:1 CSS pixels (75% fewer pixels than 2x 4K HiDPI,
  // while keeping 12px CJK text integer-aligned and vector-sharp with zero canvas resampling blur).
  let targetScale = Number(msg.scale) > 0 ? Number(msg.scale) : 1;
  const maxWidth = Number(msg.maxWidth) || 0;
  if (maxWidth > 0 && baseCssWidth * targetScale > maxWidth) {
    targetScale = maxWidth / baseCssWidth;
  }

  const captureOpts = {
    format,
    scale: targetScale
  };
  if (format === "jpeg") captureOpts.quality = quality;
  if (rect) {
    captureOpts.rect = rect;
    captureOpts.scroll = "document";
  }

  const dataUrl = await browser.tabs.captureTab(tab.id, captureOpts);
  const dims = await measureDataUrlDimensions(dataUrl);
  return Object.assign({
    dataUrl,
    mimeType: format === "png" ? "image/png" : "image/jpeg",
    width: dims.width,
    height: dims.height,
    cssWidth: baseCssWidth,
    cssHeight: rect ? rect.height : cssHeight,
    scale: Number(targetScale.toFixed(4))
  }, tabMeta(tab));
}

function elementPickerRunner(message, timeoutMs) {
  return new Promise(resolve => {
    const prevCleanup = window.__bridgePickerCleanup;
    if (typeof prevCleanup === "function") {
      try { prevCleanup(); } catch (_) {}
    }

    const selections = [];
    const selectedElements = new Set();

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";

    const highlight = document.createElement("div");
    highlight.style.cssText = "position:fixed;border:2px solid #3b82f6;background:rgba(59,130,246,0.12);border-radius:3px;transition:all 0.06s ease-out;pointer-events:none;";
    overlay.appendChild(highlight);

    const banner = document.createElement("div");
    banner.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#111827;color:#f9fafb;padding:10px 18px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);font:500 13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.4);pointer-events:auto;z-index:2147483647;";

    const updateBanner = () => {
      banner.textContent = message + " (" + selections.length + " selected — Click to pick, Cmd/Ctrl+Click multi-select, Enter done, Esc cancel)";
    };
    updateBanner();

    (document.body || document.documentElement).append(overlay, banner);

    function safeClassList(el) {
      const raw = el.getAttribute && el.getAttribute("class");
      if (!raw) return [];
      return raw.trim().split(/\s+/).filter(Boolean);
    }

    function uniqueSelector(el) {
      if (el.id) {
        const byId = "#" + CSS.escape(el.id);
        try {
          if (document.querySelectorAll(byId).length === 1) return byId;
        } catch (_) {}
      }
      const segments = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        let seg = cur.tagName.toLowerCase();
        if (cur.id) {
          seg += "#" + CSS.escape(cur.id);
          segments.unshift(seg);
          break;
        }
        const classes = safeClassList(cur).slice(0, 2).map(c => "." + CSS.escape(c)).join("");
        const parent = cur.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
          if (sameTag.length > 1) {
            const idx = sameTag.indexOf(cur) + 1;
            seg += classes + ":nth-of-type(" + idx + ")";
          } else {
            seg += classes;
          }
        }
        segments.unshift(seg);
        const candidate = segments.join(" > ");
        try {
          if (document.querySelectorAll(candidate).length === 1) return candidate;
        } catch (_) {}
        cur = parent;
      }
      return segments.join(" > ");
    }

    function buildInfo(el) {
      const parents = [];
      let cur = el.parentElement;
      while (cur && cur !== document.body && parents.length < 6) {
        const id = cur.id ? "#" + cur.id : "";
        const cls = safeClassList(cur).slice(0, 3).map(c => "." + c).join("");
        parents.push(cur.tagName.toLowerCase() + id + cls);
        cur = cur.parentElement;
      }
      const r = el.getBoundingClientRect();
      return {
        selector: uniqueSelector(el),
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        class: el.getAttribute("class") || null,
        text: (el.textContent || "").trim().slice(0, 200) || null,
        rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        html: el.outerHTML.slice(0, 500),
        parents: parents.join(" > ")
      };
    }

    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      banner.remove();
      selectedElements.forEach(el => {
        try { el.style.outline = ""; } catch (_) {}
      });
      if (window.__bridgePickerCleanup === cleanup) {
        delete window.__bridgePickerCleanup;
      }
    };
    window.__bridgePickerCleanup = cleanup;

    const onMove = e => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || overlay.contains(el) || banner.contains(el)) return;
      const r = el.getBoundingClientRect();
      highlight.style.top = r.top + "px";
      highlight.style.left = r.left + "px";
      highlight.style.width = r.width + "px";
      highlight.style.height = r.height + "px";
    };

    const onClick = e => {
      if (banner.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      let el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || overlay.contains(el) || banner.contains(el)) return;
      while (el.shadowRoot && el.shadowRoot.elementFromPoint) {
        const inner = el.shadowRoot.elementFromPoint(e.clientX, e.clientY);
        if (!inner || inner === el) break;
        el = inner;
      }

      if (e.metaKey || e.ctrlKey) {
        if (!selectedElements.has(el)) {
          selectedElements.add(el);
          el.style.outline = "2px solid #10b981";
          selections.push(buildInfo(el));
          updateBanner();
        }
      } else {
        const info = buildInfo(el);
        cleanup();
        resolve({ cancelled: false, picked: selections.length > 0 ? selections.concat([info]) : info });
      }
    };

    const onKey = e => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        resolve({ cancelled: true, picked: null });
      } else if (e.key === "Enter" && selections.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        resolve({ cancelled: false, picked: selections });
      }
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);

    timer = setTimeout(() => {
      cleanup();
      resolve({ cancelled: true, timedOut: true, picked: selections.length ? selections : null });
    }, timeoutMs);
  });
}

async function handlePick(msg) {
  const tab = await resolveTab(msg.tabId, { wakeDiscarded: true });
  await browser.tabs.update(tab.id, { active: true });
  try { await browser.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  const timeoutMs = Math.min(Math.max(Number(msg.timeoutMs) || 120000, 5000), 300000);
  const injected = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: elementPickerRunner,
    args: [msg.message || "Click an element to select it", timeoutMs]
  });
  const res = injected && injected[0] ? injected[0].result : { error: "Picker did not return a result" };
  return Object.assign({}, res, tabMeta(tab));
}

// Non-destructive MAIN-world console/error tap installed ONLY on tabs with active diagnostics.
// Does NOT touch fetch, XMLHttpRequest, WebSocket, or alert/confirm/prompt.
function installDiagConsoleTap() {
  if (window.__bridgeDiagInstalled) return;
  window.__bridgeDiagInstalled = true;
  const logs = [];
  window.__bridgeDiagLogs = logs;

  function formatArg(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v !== "object") return String(v).slice(0, 1000);
    if (v instanceof Error) return (v.stack || v.name + ": " + v.message).slice(0, 1500);
    try {
      const keys = Object.keys(v);
      if (keys.length > 40) return "[Object keys=" + keys.length + "]";
      return JSON.stringify(v).slice(0, 1000);
    } catch (_) {
      return Object.prototype.toString.call(v);
    }
  }

  function push(entry) {
    logs.push(entry);
    if (logs.length > 500) logs.shift();
  }

  ["log", "info", "warn", "error"].forEach(level => {
    const orig = console[level];
    if (typeof orig !== "function") return;
    console[level] = function () {
      const args = [];
      for (let i = 0; i < arguments.length; i++) args.push(formatArg(arguments[i]));
      push({ level, args, ts: Date.now() });
      return orig.apply(this, arguments);
    };
  });

  window.addEventListener("error", e => {
    const targetSrc = e.target && (e.target.src || e.target.href);
    if (targetSrc) {
      push({ level: "resource_error", message: "Failed to load resource", url: String(targetSrc), ts: Date.now() });
    } else {
      push({
        level: "uncaught_error",
        message: e.message || "Error",
        filename: e.filename || null,
        lineno: e.lineno || null,
        colno: e.colno || null,
        ts: Date.now()
      });
    }
  }, true);

  window.addEventListener("unhandledrejection", e => {
    push({
      level: "unhandled_rejection",
      reason: formatArg(e.reason),
      ts: Date.now()
    });
  });
}

function readPerformanceAndDiagRunner(urlFilter) {
  const filterStr = urlFilter ? String(urlFilter).toLowerCase() : null;
  const navEntries = performance.getEntriesByType("navigation").map(n => ({
    name: n.name,
    type: n.type,
    status: n.responseStatus || null,
    durationMs: Math.round(n.duration),
    domInteractiveMs: Math.round(n.domInteractive),
    loadEventEndMs: Math.round(n.loadEventEnd),
    transferSize: n.transferSize
  }));
  let resources = performance.getEntriesByType("resource").map(r => ({
    url: r.name,
    initiatorType: r.initiatorType,
    status: r.responseStatus != null ? r.responseStatus : null,
    durationMs: Math.round(r.duration),
    transferSize: r.transferSize,
    decodedBodySize: r.decodedBodySize
  }));
  if (filterStr) {
    resources = resources.filter(r => r.url.toLowerCase().includes(filterStr));
  }
  const consoleLogs = Array.isArray(window.__bridgeDiagLogs) ? window.__bridgeDiagLogs.slice(-200) : [];
  return {
    navigation: navEntries,
    resourceCount: resources.length,
    resources: resources.slice(-300),
    consoleLogs
  };
}

function stopTabMonitor(tabId) {
  const state = monitoredTabs.get(tabId);
  if (!state) return false;
  browser.webRequest.onBeforeRequest.removeListener(state.onBefore);
  browser.webRequest.onCompleted.removeListener(state.onCompleted);
  browser.webRequest.onErrorOccurred.removeListener(state.onError);
  browser.webNavigation.onCommitted.removeListener(state.onCommitted);
  monitoredTabs.delete(tabId);
  return true;
}

function startTabMonitor(tabId) {
  if (monitoredTabs.has(tabId)) return monitoredTabs.get(tabId);
  const byReqId = new Map();
  const requests = [];

  const pushReq = rec => {
    requests.push(rec);
    if (requests.length > MAX_DIAG_ENTRIES) {
      const evicted = requests.shift();
      if (evicted) byReqId.delete(evicted.requestId);
    }
  };

  const onBefore = details => {
    if (details.frameId === 0 && details.type === "main_frame") {
      requests.length = 0;
      byReqId.clear();
    }
    const rec = {
      requestId: details.requestId,
      type: details.type,
      method: details.method,
      url: details.url,
      frameId: details.frameId,
      startTs: Math.round(details.timeStamp),
      status: null,
      durationMs: null,
      fromCache: false,
      error: null
    };
    byReqId.set(details.requestId, rec);
    pushReq(rec);
  };

  const onCompleted = details => {
    const rec = byReqId.get(details.requestId);
    if (rec) {
      rec.status = details.statusCode;
      rec.fromCache = Boolean(details.fromCache);
      rec.durationMs = Math.max(0, Math.round(details.timeStamp) - rec.startTs);
    }
  };

  const onError = details => {
    const rec = byReqId.get(details.requestId);
    if (rec) {
      rec.error = details.error || "Network error";
      rec.durationMs = Math.max(0, Math.round(details.timeStamp) - rec.startTs);
    }
  };

  const onCommitted = details => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func: installDiagConsoleTap
    }).catch(() => {});
  };

  const filter = { urls: ["<all_urls>"], tabId };
  browser.webRequest.onBeforeRequest.addListener(onBefore, filter);
  browser.webRequest.onCompleted.addListener(onCompleted, filter);
  browser.webRequest.onErrorOccurred.addListener(onError, filter);
  browser.webNavigation.onCommitted.addListener(onCommitted);

  const state = { requests, onBefore, onCompleted, onError, onCommitted };
  monitoredTabs.set(tabId, state);
  return state;
}

browser.tabs.onRemoved.addListener(tabId => {
  stopTabMonitor(tabId);
});

async function handleDiagnostics(msg) {
  const action = msg.action || "snapshot";
  const tab = await resolveTab(msg.tabId, { wakeDiscarded: action !== "stop" });

  if (action === "stop") {
    const stopped = stopTabMonitor(tab.id);
    return Object.assign({ monitoring: false, stopped }, tabMeta(tab));
  }

  if (action === "start") {
    startTabMonitor(tab.id);
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: installDiagConsoleTap
    }).catch(() => {});

    if (msg.reload) {
      await browser.tabs.reload(tab.id, { bypassCache: Boolean(msg.bypassCache) });
      await waitTabLoaded(tab.id, 15000);
    }
  }

  const injected = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: readPerformanceAndDiagRunner,
    args: [msg.urlFilter || null]
  }).catch(() => null);

  const perfData = injected && injected[0] && injected[0].result ? injected[0].result : {
    navigation: [],
    resourceCount: 0,
    resources: [],
    consoleLogs: []
  };

  const mon = monitoredTabs.get(tab.id);
  let capturedRequests = mon ? mon.requests.slice() : [];
  if (msg.urlFilter) {
    const f = String(msg.urlFilter).toLowerCase();
    capturedRequests = capturedRequests.filter(r => r.url.toLowerCase().includes(f));
  }
  const latestTab = await browser.tabs.get(tab.id).catch(() => tab);
  return Object.assign({
    monitoring: Boolean(mon),
    capturedRequestCount: capturedRequests.length,
    capturedRequests: capturedRequests.slice(-300)
  }, perfData, tabMeta(latestTab));
}

async function dispatch(msg) {
  switch (msg.cmd) {
    case "tabs":
      return handleTabs(msg);
    case "navigate":
      return handleNavigate(msg);
    case "js":
      return handleJs(msg);
    case "read":
      return handleRead(msg);
    case "html":
      return handleHtml(msg);
    case "screenshot":
      return handleScreenshot(msg);
    case "pick":
      return handlePick(msg);
    case "diagnostics":
      return handleDiagnostics(msg);
    default:
      throw new Error("Unknown command: " + msg.cmd);
  }
}

function connect() {
  port = browser.runtime.connectNative("browser_bridge");
  port.onMessage.addListener(msg => {
    dispatch(msg).then(
      res => reply(msg, res),
      err => reply(msg, { error: err && err.message ? err.message : String(err) })
    );
  });
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 1000);
  });
}

connect();
