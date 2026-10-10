/**
 * Renders an MCP Apps card (`ui://...`, `text/html;profile=mcp-app`) on a
 * device screen, with the official host bridge.
 *
 * The card's HTML goes into a sandboxed iframe (`sandbox="allow-scripts
 * allow-forms"`, so it has an opaque origin and cannot reach this page, its
 * storage or its cookies) behind a Content-Security-Policy built from what the
 * resource declares (nothing from the network unless it asks for it).
 * `AppBridge` from `@modelcontextprotocol/ext-apps/app-bridge` speaks the MCP
 * Apps protocol with it over `postMessage`:
 *
 *   card -> host   ui/initialize, tools/call, resources/read, ui/open-link,
 *                  ui/message, notifications/message, size changes
 *   host -> card   tool input, tool result, host context
 *
 * Tool calls and resource reads from the card are sent to the stage server,
 * which makes them on the device's own MCP connection to the server the card
 * came from. They show up in the inspector with origin "card".
 */
import { AppBridge, PostMessageTransport, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import { useEffect, useRef, useState } from 'react';
import { PRODUCT_NAME, PRODUCT_VERSION, type CardResource, type DeviceKind, type ScreenContent } from '../../../src/shared/types';
import { api } from '../api';
import { say, showToast } from '../store';

/** The Content-Security-Policy for a card: deny by default, allow only what the resource declared. */
export function cardCsp(csp: CardResource['csp']): string {
  const resources = (csp?.resourceDomains ?? []).join(' ');
  const connect = (csp?.connectDomains ?? []).join(' ');
  const frames = (csp?.frameDomains ?? []).join(' ');
  const base = (csp?.baseUriDomains ?? []).join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${connect || "'none'"}`,
    `frame-src ${frames || "'none'"}`,
    `base-uri ${base || "'none'"}`,
    "form-action 'none'",
  ].join('; ');
}

export function withCsp(html: string, csp: CardResource['csp']): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cardCsp(csp).replace(/"/g, '&quot;')}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${meta}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (root) => `${root}<head>${meta}</head>`);
  return `${meta}${html}`;
}

function textOfBlocks(blocks: Array<{ type: string; text?: string }> | undefined): string {
  return (blocks ?? [])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

interface Props {
  deviceId: string;
  kind: DeviceKind;
  screen: ScreenContent & { card: CardResource };
}

export function AppCard({ deviceId, kind, screen }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    const iframe = frame.current;
    const target = iframe?.contentWindow;
    if (!iframe || !target) return;
    let disposed = false;
    const { card } = screen;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const hostContext: McpUiHostContext = {
      theme: dark ? 'dark' : 'light',
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      containerDimensions: { width: iframe.clientWidth, maxHeight: iframe.clientHeight },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: `${PRODUCT_NAME}/${PRODUCT_VERSION}`,
      platform: kind === 'phone' ? 'mobile' : 'web',
      deviceCapabilities: { touch: kind !== 'speaker', hover: kind === 'phone' ? false : true },
      toolInfo: { tool: { name: screen.tool.name, title: screen.tool.title, description: screen.tool.description, inputSchema: (screen.tool.inputSchema ?? { type: 'object' }) as never } },
    };
    const bridge = new AppBridge(
      null,
      { name: PRODUCT_NAME, version: PRODUCT_VERSION },
      { serverTools: {}, serverResources: {}, logging: {}, openLinks: {}, message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} }, sandbox: { csp: card.csp } },
      { hostContext },
    );

    bridge.oncalltool = async (params) => (await api.callTool(deviceId, screen.server, params.name, params.arguments as Record<string, unknown> | undefined, 'card')) as never;
    bridge.onreadresource = async (params) => (await api.readResource(deviceId, screen.server, params.uri)) as never;
    bridge.onopenlink = async ({ url }) => {
      void api.cardEvent(deviceId, 'open-link', { url }, card.uri);
      const safe = /^https?:\/\//i.test(url);
      if (safe && window.confirm(`The card from "${screen.server}" wants to open:\n\n${url}\n\nOpen it in a new tab?`)) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return {};
      }
      return { isError: true };
    };
    bridge.onmessage = async (params) => {
      // The card adds a message to the conversation, as if the person had said it.
      const text = textOfBlocks(params.content as Array<{ type: string; text?: string }>);
      void api.cardEvent(deviceId, 'message', { text }, card.uri);
      if (!text) return { isError: true };
      say(deviceId, text, 'typed');
      return {};
    };
    bridge.onupdatemodelcontext = async (params) => {
      void api.cardEvent(deviceId, 'update-model-context', params, card.uri);
      return {};
    };
    bridge.onrequestdisplaymode = async () => ({ mode: 'inline' });
    bridge.onloggingmessage = (params) => void api.cardEvent(deviceId, 'log', params, card.uri);
    bridge.oninitialized = () => {
      if (disposed) return;
      setState('ready');
      void bridge.sendToolInput({ arguments: screen.arguments });
      void bridge.sendToolResult(screen.result as never);
    };

    const failed = window.setTimeout(() => {
      if (disposed) return;
      setState((current) => (current === 'loading' ? 'failed' : current));
    }, 6000);

    // Listen first, then load the card, so its first message (ui/initialize) is not missed.
    bridge
      .connect(new PostMessageTransport(target, target))
      .then(() => {
        if (!disposed) iframe.srcdoc = withCsp(card.html, card.csp);
      })
      .catch((error: unknown) => {
        setState('failed');
        showToast(`Could not start the card: ${error instanceof Error ? error.message : String(error)}`);
      });

    return () => {
      disposed = true;
      window.clearTimeout(failed);
      // Let the card clean up if it wants to, then drop the connection.
      void bridge
        .teardownResource({}, { timeout: 500 })
        .catch(() => undefined)
        .finally(() => void bridge.close().catch(() => undefined));
    };
    // A new tool result is a new card instance.
  }, [screen.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`app-card app-card--${state}`}>
      <iframe ref={frame} title={`${screen.tool.title ?? screen.tool.name} card`} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />
      {state === 'failed' && (
        <p className="app-card__note" role="status">
          This card did not answer the MCP Apps handshake. Its tool result is in the inspector.
        </p>
      )}
    </div>
  );
}
