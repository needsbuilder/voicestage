/**
 * Renders an MCP Apps card (`ui://...`, `text/html;profile=mcp-app`) on a
 * device screen, with the official host bridge.
 *
 * As the MCP Apps specification requires of a host that is a web page, the
 * card is not loaded by this page. The iframe here loads the sandbox proxy, a
 * small page served from a second origin (another localhost port; see
 * `src/server/sandbox.ts`). The proxy says it is ready, is sent the card's
 * HTML, loads it in an iframe of its own, and passes messages both ways. The
 * card so has a real origin, which is not this page's: storage works in it,
 * and this page, its storage and its API are out of its reach. Its
 * Content-Security-Policy is built from what the resource declares (nothing
 * from the network unless it asks for it).
 *
 * `AppBridge` from `@modelcontextprotocol/ext-apps/app-bridge` speaks the MCP
 * Apps protocol with the card over `postMessage`:
 *
 *   card -> host   ui/initialize, tools/call, resources/read, ui/open-link,
 *                  ui/message, notifications/message, size changes
 *   host -> card   tool input, tool result, host context
 *
 * Tool calls and resource reads from the card are sent to the stage server,
 * which makes them on the device's own MCP connection to the server the card
 * came from. They show up in the inspector with origin "card".
 *
 * A stage started without the proxy (some tests are) falls back to one
 * sandboxed iframe with an opaque origin, in which a card has no storage.
 */
import { AppBridge, PostMessageTransport, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import { useEffect, useRef, useState } from 'react';
import { withCsp } from '../../../src/shared/card-html';
import { PRODUCT_NAME, PRODUCT_VERSION, type CardResource, type DeviceKind, type ScreenContent } from '../../../src/shared/types';
import { api } from '../api';
import { recording } from '../recording';
import { askToOpenLink, say, showToast, useStage } from '../store';

function textOfBlocks(blocks: Array<{ type: string; text?: string }> | undefined): string {
  return (blocks ?? [])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** What the card's own iframe may do, inside the proxy: run scripts, keep its origin (for storage), submit forms. */
const VIEW_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

/**
 * Where the sandbox proxy is. It must be another origin than this page; the
 * other name for this machine also makes it another site, so the browser gives
 * the card a process of its own.
 */
function sandboxUrl(port: number, csp: CardResource['csp']): string {
  const hostname = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  const query = new URLSearchParams({ host: location.origin });
  if (csp) query.set('csp', JSON.stringify(csp));
  return `http://${hostname}:${port}/sandbox?${query.toString()}`;
}

interface Props {
  deviceId: string;
  kind: DeviceKind;
  screen: ScreenContent & { card: CardResource };
}

export function AppCard({ deviceId, kind, screen }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const sandboxPort = useStage((stage) => stage.stage?.sandboxPort);

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
      // Only web links, and only when the person at the device says yes. The question is put
      // on the device's screen; the page is never stopped by a browser dialog.
      if (!/^https?:\/\//i.test(url) || disposed) return { isError: true };
      const open = await askToOpenLink(deviceId, screen.server, url);
      void api.cardEvent(deviceId, open ? 'open-link-allowed' : 'open-link-refused', { url }, card.uri);
      return open ? {} : { isError: true };
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
    // The proxy has loaded and listens: hand it the card.
    bridge.onsandboxready = () => {
      if (disposed) return;
      void bridge.sendSandboxResourceReady({ html: withCsp(card.html, card.csp), sandbox: VIEW_SANDBOX, csp: card.csp, permissions: card.permissions as never });
    };
    bridge.oninitialized = () => {
      if (disposed) return;
      setState('ready');
      void bridge.sendToolInput({ arguments: screen.arguments });
      void bridge.sendToolResult(screen.result as never);
      recording?.cardShown(deviceId, card.uri, screen.tool.name);
    };

    const failed = window.setTimeout(() => {
      if (disposed) return;
      setState((current) => (current === 'loading' ? 'failed' : current));
    }, 6000);

    // Listen first, then load, so the first message (the proxy's "ready", or the card's ui/initialize) is not missed.
    bridge
      .connect(new PostMessageTransport(target, target))
      .then(() => {
        if (disposed) return;
        if (sandboxPort !== undefined) iframe.src = sandboxUrl(sandboxPort, card.csp);
        else iframe.srcdoc = withCsp(card.html, card.csp);
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
  }, [screen.id, sandboxPort]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`app-card app-card--${state}`}>
      {/* With the proxy, the outer frame keeps the proxy's own origin (the specification's allow-same-origin); without it, the card gets none. */}
      <iframe ref={frame} title={`${screen.tool.title ?? screen.tool.name} card`} sandbox={sandboxPort !== undefined ? VIEW_SANDBOX : 'allow-scripts allow-forms'} referrerPolicy="no-referrer" />
      {state === 'failed' && (
        <p className="app-card__note" role="status">
          This card did not answer the MCP Apps handshake. Its tool result is in the inspector.
        </p>
      )}
    </div>
  );
}
