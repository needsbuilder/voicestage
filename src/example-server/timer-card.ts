/**
 * The timer card of the example server: one self-contained HTML page, served
 * as the MCP Apps resource `ui://example/timer-card.html`.
 *
 * It speaks the MCP Apps protocol directly (JSON-RPC over `postMessage`): the
 * `ui/initialize` handshake, `ui/notifications/tool-result` from the host, and
 * `tools/call` back through the host for its "Start again" button. No network
 * access, no dependencies.
 *
 * It also counts the timers it has shown, in `localStorage`. That only works
 * in a host that gives a card an origin of its own, as the MCP Apps
 * specification asks (a sandbox proxy on another origin). In a host that puts
 * the card in a sandboxed iframe with no origin, storage throws, and the card
 * simply leaves the line out.
 */
export const TIMER_CARD_URI = 'ui://example/timer-card.html';

export const TIMER_CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Timer</title>
<style>
:root { color-scheme: light dark; --ink: #14171f; --muted: #4b5563; --paper: #ffffff; --wash: #f3f4f6; --accent: #0f766e; --track: #d1d5db; }
@media (prefers-color-scheme: dark) { :root { --ink: #f9fafb; --muted: #cbd5e1; --paper: #111827; --wash: #030712; --accent: #5eead4; --track: #374151; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 1rem; font: 1.1rem/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--wash); }
main { max-width: 34rem; margin: 0 auto; background: var(--paper); border-radius: 1rem; padding: 1.5rem; display: grid; grid-template-columns: auto 1fr; gap: 1.5rem; align-items: center; }
.dial { position: relative; width: 9.5rem; height: 9.5rem; }
svg { width: 100%; height: 100%; transform: rotate(-90deg); }
circle { fill: none; stroke-width: 9; }
.track { stroke: var(--track); }
.bar { stroke: var(--accent); stroke-linecap: round; transition: stroke-dashoffset 0.25s linear; }
.time { position: absolute; inset: 0; display: grid; place-items: center; font-size: 2.1rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.eyebrow { margin: 0; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
h1 { margin: 0.1rem 0 0.3rem; font-size: 1.9rem; line-height: 1.15; }
p { margin: 0 0 0.9rem; color: var(--muted); }
.count { margin: 0.9rem 0 0; font-size: 0.85rem; }
button { font: inherit; font-weight: 700; min-height: 3rem; padding: 0.6rem 1.3rem; border-radius: 0.7rem; border: 2px solid var(--ink); background: transparent; color: var(--ink); cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible { outline: 4px solid #2563eb; outline-offset: 3px; }
@media (max-width: 26rem) { main { grid-template-columns: 1fr; justify-items: center; text-align: center; } }
</style>
</head>
<body>
<main aria-live="polite">
  <div class="dial" aria-hidden="true">
    <svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="44"></circle><circle class="bar" id="bar" cx="50" cy="50" r="44"></circle></svg>
    <div class="time" id="time">--:--</div>
  </div>
  <div>
    <p class="eyebrow">Timer</p>
    <h1 id="label">One moment...</h1>
    <p id="status" role="status"></p>
    <button type="button" id="again" hidden>Start again</button>
    <p class="count" id="count" hidden></p>
  </div>
</main>
<script>
(function () {
  var host = window.parent;
  var pending = {};
  var nextId = 1;
  var timer = null;
  var tick = null;
  var LENGTH = 2 * Math.PI * 44;
  var bar = document.getElementById('bar');
  bar.style.strokeDasharray = String(LENGTH);

  function post(message) { message.jsonrpc = '2.0'; host.postMessage(message, '*'); }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ id: id, method: method, params: params });
    });
  }
  function clock(seconds) {
    var s = Math.max(0, Math.ceil(seconds));
    var m = Math.floor(s / 60);
    return (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }
  function draw() {
    if (!timer) return;
    var left = (new Date(timer.ends_at).getTime() - Date.now()) / 1000;
    var done = left <= 0 || timer.status === 'done';
    document.getElementById('time').textContent = clock(done ? 0 : left);
    bar.style.strokeDashoffset = String(LENGTH * (1 - Math.max(0, Math.min(1, left / timer.seconds))));
    document.getElementById('status').textContent = done ? 'Done.' : 'Running';
    document.getElementById('again').hidden = !done;
    if (done && tick) { clearInterval(tick); tick = null; }
  }
  // How many timers this card has shown in this browser. Null where the host gives the card no storage.
  function remember(id) {
    try {
      var store = window.localStorage;
      var count = Number(store.getItem('kitchen-helper.timers') || 0);
      if (store.getItem('kitchen-helper.last') !== id) {
        count += 1;
        store.setItem('kitchen-helper.timers', String(count));
        store.setItem('kitchen-helper.last', id);
      }
      return count;
    } catch (error) {
      return null;
    }
  }
  function show(result) {
    var data = result && result.structuredContent;
    if (!data || result.isError || !data.ends_at) {
      var text = ((result && result.content) || []).map(function (block) { return block.text || ''; }).join(' ');
      document.getElementById('label').textContent = 'No timer';
      document.getElementById('status').textContent = text || 'There is nothing to show yet.';
      return;
    }
    timer = data;
    document.getElementById('label').textContent = data.label;
    var count = remember(data.timer_id);
    document.getElementById('count').hidden = count === null;
    if (count !== null) document.getElementById('count').textContent = count === 1 ? 'The first timer started from this browser.' : 'Timer ' + count + ' started from this browser.';
    if (tick) clearInterval(tick);
    tick = setInterval(draw, 250);
    draw();
  }

  window.addEventListener('message', function (event) {
    if (event.source !== host) return;
    var message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.method === undefined) {
      var waiter = pending[message.id];
      if (!waiter) return;
      delete pending[message.id];
      if (message.error) waiter.reject(new Error(message.error.message || 'Request failed'));
      else waiter.resolve(message.result);
    } else if (message.id === undefined) {
      if (message.method === 'ui/notifications/tool-result') show(message.params);
    } else if (message.method === 'ui/resource-teardown' || message.method === 'ping') {
      post({ id: message.id, result: {} });
    } else {
      post({ id: message.id, error: { code: -32601, message: 'Method not found: ' + message.method } });
    }
  });

  document.getElementById('again').addEventListener('click', function () {
    var button = this;
    if (!timer) return;
    button.disabled = true;
    request('tools/call', { name: 'start_timer', arguments: { label: timer.label, seconds: timer.seconds } })
      .then(show)
      .catch(function () { document.getElementById('status').textContent = 'Could not start the timer again.'; })
      .then(function () { button.disabled = false; });
  });

  request('ui/initialize', { appInfo: { name: 'example-timer-card', version: '0.1.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' }).then(function () {
    post({ method: 'ui/notifications/initialized', params: {} });
    var box = document.documentElement;
    post({ method: 'ui/notifications/size-changed', params: { width: Math.ceil(box.scrollWidth), height: Math.ceil(box.scrollHeight) } });
  });
})();
</script>
</body>
</html>
`;
