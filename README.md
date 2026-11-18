# browser-bridge (Zero-Footprint On-Demand Edition)

Lightweight Firefox WebExtension + Native Messaging MCP bridge for coding agents, engineered for **zero idle overhead in a daily-driver browser**.

## Key Architecture Differences vs Upstream v1.x

- **Zero Static Injection**: No `content_scripts` in `manifest.json`, no global `MutationObserver`, no `webRequestBlocking`, and no overrides on `fetch`, `XMLHttpRequest`, `WebSocket`, or `alert`/`confirm`/`prompt`. Idle tabs pay **0% CPU and 0 bytes** of extension overhead.
- **Explicit `tabId` Background Execution**: All tools accept Firefox's stable integer `tabId` (`tab.id`), automatically wake `discarded` tabs, and run silently in background tabs without stealing foreground window/tab focus.
- **Native `MAIN` World JS + Automatic CSP Fallback**: `browser_js` executes directly in the page's `MAIN` world (native access to `window.jQuery`, React Fiber, Vue/Lit state, same-origin `iframe.contentWindow`, and authenticated `fetch`) and automatically falls back to `ISOLATED` world on strict-CSP pages. Never auto-retries on timeout.
- **4K HiDPI Crisp Screenshots (`browser_screenshot`)**: Uses `browser.tabs.captureTab(tabId, { scale: 1, format: "png" })` by default — rasterizing vectors & CJK text directly in Firefox WebRender at exact `1x` CSS pixel density (75% fewer pixels than `2x` 4K Retina with zero `<canvas>` resampling blur or JPEG ringing), writing owner-only (`0600`) files to `/tmp/browser-bridge-screenshots/`.
- **Interactive Element Picker (`browser_pick`)**: On-demand visual element selector (`Click`, `Cmd/Ctrl+Click` multi-select, `Enter` confirm, `Esc` cancel) returning unique CSS selectors and bounding boxes.
- **Opt-In Per-Tab Diagnostics (`browser_diagnostics`)**: Instant `PerformanceResourceTiming` snapshot without prior hooks, or opt-in `{ tabId }`-scoped `webRequest` + console/error capture.

## Tools (8)

| Tool | Purpose |
| :--- | :--- |
| `browser_tabs` | `list` (with `query` substring/`/regex/` & `activeOnly`), `switch`, `close` |
| `browser_js` | Execute JS/async IIFE on `tabId` (`timeoutMs` up to `120000`, `world`: `auto`/`MAIN`/`ISOLATED`) |
| `browser_read` | Extract visible/scoped text from `tabId` on demand |
| `browser_html` | Extract full or `selector`-scoped `outerHTML` from `tabId` |
| `browser_navigate` | Open/navigate/reload URLs (defaults to `active: false` background tab) |
| `browser_screenshot` | Capture full viewport or `selector` crop, default downsampled to `1280px` width |
| `browser_pick` | Interactive human element picker returning unique CSS selector + metadata |
| `browser_diagnostics` | `snapshot` (Resource Timing) or `start`/`stop` per-tab network & console capture |

## Install & Sign Unlisted `.xpi`

```bash
./install.sh
cp .env.example .env
# Fill AMO_API_KEY and AMO_API_SECRET from https://addons.mozilla.org/developers/addon/api/key/
./scripts/sign-xpi.sh
```

Then uninstall the old store addon (`browser-bridge@localhost`) in Firefox `about:addons` and drag-and-drop `dist/*.xpi` into Firefox (or test immediately via `about:debugging#/runtime/this-firefox` -> **Load Temporary Add-on** -> `addon/manifest.json`).
