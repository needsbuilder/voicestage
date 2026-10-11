/**
 * Code the recorder runs inside the page, kept as plain JavaScript text.
 *
 * It is text, not functions, on purpose: a function handed to the browser is
 * sent as its source, and tools that run TypeScript directly (tsx) rewrite
 * functions in ways that only work where their helpers are loaded.
 */

/**
 * A pointer drawn over the stage: a capture of a page has no mouse cursor in
 * it, and a viewer needs to see the hand that presses a button.
 * Defines `window.__voicestagePointer(action, x, y, travelMs)`.
 *
 * The position is the CSS `translate` property, not `transform`: `scale`
 * (used for the press) is applied outside `transform`, and would move the dot.
 */
export const POINTER_SCRIPT = `(() => {
  if (document.getElementById('voicestage-pointer')) return;
  const style = document.createElement('style');
  style.textContent = \`
    #voicestage-pointer, #voicestage-ripple { position: fixed; left: 0; top: 0; border-radius: 50%; pointer-events: none; z-index: 2147483647; opacity: 0; }
    #voicestage-pointer { width: 44px; height: 44px; margin: -22px 0 0 -22px; background: rgba(255, 255, 255, 0.34); border: 2px solid rgba(255, 255, 255, 0.96);
      box-shadow: 0 0 0 1px rgba(10, 14, 22, 0.45), 0 8px 22px rgba(10, 14, 22, 0.45);
      transition: opacity 0.22s ease, translate var(--travel, 0.55s) cubic-bezier(0.3, 0.7, 0.2, 1), scale 0.1s ease, background 0.1s ease; }
    #voicestage-pointer.is-on { opacity: 1; }
    #voicestage-pointer.is-down { scale: 0.8; background: rgba(255, 255, 255, 0.62); }
    #voicestage-ripple { width: 44px; height: 44px; margin: -22px 0 0 -22px; border: 2px solid rgba(255, 255, 255, 0.9); box-shadow: 0 0 0 1px rgba(10, 14, 22, 0.3); }
    #voicestage-ripple.is-on { animation: voicestage-ripple 0.55s ease-out; }
    @keyframes voicestage-ripple { from { opacity: 0.9; scale: 0.7; } to { opacity: 0; scale: 2.3; } }
  \`;
  document.head.append(style);
  const ripple = document.createElement('div');
  ripple.id = 'voicestage-ripple';
  const dot = document.createElement('div');
  dot.id = 'voicestage-pointer';
  for (const element of [ripple, dot]) {
    element.setAttribute('aria-hidden', 'true');
    document.body.append(element);
  }
  window.__voicestagePointer = function (action, x, y, travelMs) {
    if (action === 'show') {
      dot.style.setProperty('--travel', '0s');
      dot.style.translate = x + 'px ' + y + 'px';
      void dot.offsetWidth;
      dot.classList.add('is-on');
    } else if (action === 'move') {
      dot.style.setProperty('--travel', (travelMs || 550) + 'ms');
      dot.style.translate = x + 'px ' + y + 'px';
    } else if (action === 'down') {
      dot.classList.add('is-down');
      ripple.style.translate = x + 'px ' + y + 'px';
      ripple.classList.remove('is-on');
      void ripple.offsetWidth;
      ripple.classList.add('is-on');
    } else if (action === 'up') {
      dot.classList.remove('is-down');
    } else {
      dot.classList.remove('is-on', 'is-down');
    }
  };
})()`;

export function pointerCall(action: 'show' | 'move' | 'down' | 'up' | 'hide', x = 0, y = 0, travelMs = 550): string {
  return `window.__voicestagePointer && window.__voicestagePointer(${JSON.stringify(action)}, ${Math.round(x * 10) / 10}, ${Math.round(y * 10) / 10}, ${Math.round(travelMs)})`;
}

/**
 * An expression that finds a button by the words on it and gives the middle of
 * it, in the coordinates of the document it runs in: `{ x, y, disabled }`, or
 * `null`. `within` narrows the search to elements matching a selector.
 */
export function findButtonCall(label: string, within?: string): string {
  return `((label, within) => {
    const clean = function (text) { return (text || '').replace(/\\s+/g, ' ').trim().toLowerCase(); };
    const wanted = clean(label);
    const roots = within ? Array.from(document.querySelectorAll(within)) : [document];
    const candidates = roots.flatMap(function (root) {
      return Array.from(root.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[href], summary'));
    }).filter(function (element) {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    const words = function (element) { return clean(element.innerText || element.value || element.getAttribute('aria-label')); };
    const element = candidates.find(function (candidate) { return words(candidate) === wanted; })
      || candidates.find(function (candidate) { return clean(candidate.getAttribute('aria-label')) === wanted; })
      || candidates.find(function (candidate) { return words(candidate).startsWith(wanted); });
    if (!element) return null;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, disabled: element.disabled === true };
  })(${JSON.stringify(label)}, ${JSON.stringify(within ?? null)})`;
}

/** Where each device's caption strip is in the page: `[{ id, captions: { x, y, width, height } | null }]`. */
export const DEVICE_GEOMETRY = `Array.from(document.querySelectorAll('[data-device]')).map(function (element) {
  const strip = element.querySelector('.captions');
  const box = strip ? strip.getBoundingClientRect() : null;
  return { id: element.dataset.device, captions: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null };
})`;
