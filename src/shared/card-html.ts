/**
 * Preparing the HTML of an MCP Apps card for its sandboxed iframe: a
 * Content-Security-Policy that denies everything the resource did not ask for.
 *
 * A card may declare, under `_meta.ui.csp` on its resource, the origins it
 * needs: `connectDomains` (fetch, XHR, WebSocket), `resourceDomains` (scripts,
 * styles, images, fonts, media), `frameDomains` and `baseUriDomains`. A card
 * that declares nothing gets no network access at all.
 */
import type { CardResource } from './types.js';

/** Only origins and scheme sources may be added to the policy; anything else could smuggle in a directive. */
function sources(values: string[] | undefined): string {
  return (values ?? []).filter((value) => /^[a-z][a-z0-9+.-]*:(\/\/[a-z0-9*.[\]:_-]+)?$/i.test(value)).join(' ');
}

export function cardCsp(csp: CardResource['csp']): string {
  const resources = sources(csp?.resourceDomains);
  const connect = sources(csp?.connectDomains);
  const frames = sources(csp?.frameDomains);
  const base = sources(csp?.baseUriDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${connect || "'none'"}`,
    `frame-src ${frames || "'none'"}`,
    `base-uri ${base || "'self'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Put the policy first in the document, before anything the card could load. */
export function withCsp(html: string, csp: CardResource['csp']): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cardCsp(csp).replace(/"/g, '&quot;')}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${meta}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (root) => `${root}<head>${meta}</head>`);
  return `${meta}${html}`;
}
