/**
 * The developer inspector: for each device, a timeline of everything that
 * happened (what was heard, each model turn, every tool call with arguments,
 * result, duration and progress, questions from servers, events, errors), the
 * state of each MCP connection, and the result of the last scenario run.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DeviceSnapshot, ScenarioRunState, ServerSnapshot, TimelineEntry, ToolSummary } from '../../../src/shared/types';
import { api } from '../api';
import { showToast, updateSettings, useStage } from '../store';
import { CheckIcon, ChevronIcon, CopyIcon, CrossIcon } from './icons';

async function copy(value: unknown, what: string): Promise<void> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${what} as JSON.`);
  } catch {
    // Clipboard access can be refused (for example without focus): fall back to a selection.
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    showToast(ok ? `Copied ${what} as JSON.` : 'Could not copy. Select the text and copy it by hand.');
  }
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Pretty-printed JSON with light colouring. */
export function Json({ value }: { value: unknown }) {
  const text = useMemo(() => (value === undefined ? 'undefined' : JSON.stringify(value, null, 2)), [value]);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index;
    if (index > last) parts.push(text.slice(last, index));
    const kind = match[1] !== undefined ? (match[2] ? 'key' : 'string') : match[3] !== undefined ? 'literal' : 'number';
    if (kind === 'key') {
      parts.push(
        <span key={index} className="json-key">
          {match[1]}
        </span>,
        match[2],
      );
    } else {
      parts.push(
        <span key={index} className={`json-${kind}`}>
          {match[0]}
        </span>,
      );
    }
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <pre className="json">{parts}</pre>;
}

function clock(iso: string): string {
  const date = new Date(iso);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function clip(text: string, length = 150): string {
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

interface Row {
  label: string;
  title: ReactNode;
  meta?: string[];
  tone?: 'ok' | 'error' | 'running' | 'warn';
}

function describe(entry: TimelineEntry): Row {
  switch (entry.kind) {
    case 'utterance':
      return { label: 'Heard', title: `"${entry.text}"`, meta: [entry.source] };
    case 'speech':
      return { label: entry.reason === 'announcement' ? 'Announced' : entry.reason === 'question' ? 'Asked' : 'Said', title: entry.text };
    case 'model': {
      const calls = entry.toolCalls.map((call) => call.name).join(', ');
      const title = calls ? `calls ${calls}` : entry.text ? clip(entry.text) : (entry.note ?? 'no output');
      const usage = entry.usage?.inputTokens !== undefined || entry.usage?.outputTokens !== undefined ? `${entry.usage.inputTokens ?? '?'} in / ${entry.usage.outputTokens ?? '?'} out` : undefined;
      return { label: 'Model', title, meta: [entry.model ?? entry.provider, `round ${entry.round}`, entry.stopReason, usage, entry.durationMs !== undefined ? `${entry.durationMs} ms` : undefined].filter((item): item is string => Boolean(item)) };
    }
    case 'tool':
      return {
        label: 'Tool',
        title: (
          <>
            <code>{entry.name}</code>
            {entry.progress.length > 0 && <span className="muted"> {entry.progress.length} progress</span>}
          </>
        ),
        meta: [entry.server, entry.origin, entry.durationMs !== undefined ? `${entry.durationMs} ms` : 'running'],
        tone: entry.status,
      };
    case 'elicitation':
      return { label: 'Question', title: entry.message, meta: [entry.server, entry.status === 'pending' ? 'waiting' : `${entry.status}${entry.answeredBy ? ` by ${entry.answeredBy}` : ''}`], tone: entry.status === 'pending' ? 'running' : entry.status === 'accept' ? 'ok' : 'warn' };
    case 'event':
      return { label: 'Event', title: <code>{entry.name}</code>, meta: [entry.server, entry.channel === 'sse' ? 'server-sent event' : 'MCP notification', entry.matched ? 'announced' : undefined].filter((item): item is string => Boolean(item)) };
    case 'resource':
      return { label: 'Resource', title: <code>{entry.uri}</code>, meta: [entry.server, entry.mimeType, entry.bytes !== undefined ? `${entry.bytes} bytes` : undefined, entry.durationMs !== undefined ? `${entry.durationMs} ms` : undefined].filter((item): item is string => Boolean(item)), tone: entry.error ? 'error' : undefined };
    case 'connection':
      return {
        label: 'Connection',
        title: entry.status === 'connected' ? `${entry.server}: MCP ${entry.protocolVersion}, ${entry.toolCount} tools` : `${entry.server}: ${entry.error ?? entry.status}`,
        meta: [entry.url],
        tone: entry.status === 'connected' ? 'ok' : 'error',
      };
    case 'skill':
      return { label: 'Skill', title: entry.action === 'loaded' ? `loaded ${entry.name}` : `read ${entry.file} from ${entry.name}`, meta: entry.chars !== undefined ? [`${entry.chars} characters`] : [] };
    case 'card':
      return { label: 'Card', title: entry.action, meta: entry.uri ? [entry.uri] : [] };
    case 'error':
      return { label: 'Error', title: entry.message, meta: entry.detail ? [clip(entry.detail, 120)] : [], tone: 'error' };
  }
}

function Details({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'tool') {
    return (
      <>
        <h4>Arguments</h4>
        <Json value={entry.arguments} />
        {entry.progress.length > 0 && (
          <>
            <h4>Progress</h4>
            <ol className="progress-list">
              {entry.progress.map((item, index) => (
                <li key={index}>
                  <span>{clock(item.at)}</span>
                  {item.progress}
                  {item.total !== undefined ? ` / ${item.total}` : ''} {item.message}
                </li>
              ))}
            </ol>
          </>
        )}
        <h4>{entry.status === 'running' ? 'Result (waiting)' : entry.error ? 'Error' : 'Result'}</h4>
        {entry.error && !entry.result ? <p className="detail-error">{entry.error}</p> : <Json value={entry.result} />}
        {entry.uiResourceUri && (
          <p className="muted">
            Card: <code>{entry.uiResourceUri}</code>
          </p>
        )}
      </>
    );
  }
  const { id: _id, seq: _seq, ...rest } = entry;
  return <Json value={rest} />;
}

const FILTERS: Array<{ id: string; label: string; test(entry: TimelineEntry): boolean }> = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'voice', label: 'Voice', test: (entry) => entry.kind === 'utterance' || entry.kind === 'speech' || entry.kind === 'elicitation' },
  { id: 'model', label: 'Model', test: (entry) => entry.kind === 'model' || entry.kind === 'skill' },
  { id: 'tools', label: 'Tools', test: (entry) => entry.kind === 'tool' || entry.kind === 'resource' || entry.kind === 'card' },
  { id: 'events', label: 'Events', test: (entry) => entry.kind === 'event' || entry.kind === 'connection' },
  { id: 'errors', label: 'Errors', test: (entry) => entry.kind === 'error' || (entry.kind === 'tool' && entry.status === 'error') || (entry.kind === 'resource' && Boolean(entry.error)) },
];

function Timeline({ device }: { device: DeviceSnapshot }) {
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const test = FILTERS.find((item) => item.id === filter)!.test;
  const entries = device.timeline.filter(test);

  useEffect(() => {
    const element = list.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [entries.length, device.id]);

  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
  };

  return (
    <div className="timeline">
      <div className="timeline__bar">
        <div className="chips" role="group" aria-label="Filter the timeline">
          {FILTERS.map((item) => {
            const count = item.id === 'all' ? device.timeline.length : device.timeline.filter(item.test).length;
            return (
              <button key={item.id} type="button" className={`chip${filter === item.id ? ' is-on' : ''}`} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
                {item.label}
                {count > 0 && item.id !== 'all' && <span>{count}</span>}
              </button>
            );
          })}
        </div>
        <button type="button" className="text-button" onClick={() => void copy(entries, `${entries.length} timeline entries`)} disabled={entries.length === 0}>
          <CopyIcon /> Copy as JSON
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="empty">{device.timeline.length === 0 ? `Nothing has happened on ${device.name} yet. Say something to it.` : 'Nothing matches this filter.'}</p>
      ) : (
        <ol
          className="timeline__list"
          ref={list}
          onScroll={(event) => {
            const element = event.currentTarget;
            stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
        >
          {entries.map((entry, index) => {
            const row = describe(entry);
            const expanded = open.has(entry.id);
            const newTurn = index > 0 && entry.turn !== entries[index - 1]!.turn;
            return (
              <li key={entry.id} className={`entry entry--${entry.kind}${row.tone ? ` is-${row.tone}` : ''}${newTurn ? ' entry--break' : ''}`}>
                <button type="button" className="entry__head" aria-expanded={expanded} onClick={() => toggle(entry.id)}>
                  <ChevronIcon className={`entry__chevron${expanded ? ' is-open' : ''}`} />
                  <span className="entry__label">{row.label}</span>
                  <span className="entry__title">{row.title}</span>
                  <span className="entry__time">{clock(entry.at)}</span>
                  {row.meta && row.meta.length > 0 && <span className="entry__meta">{row.meta.join(' · ')}</span>}
                </button>
                {expanded && (
                  <div className="entry__body">
                    <Details entry={entry} />
                    <button type="button" className="text-button" onClick={() => void copy(entry, 'this entry')}>
                      <CopyIcon /> Copy as JSON
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function skeleton(tool: ToolSummary): string {
  const required = Array.isArray(tool.inputSchema?.required) ? (tool.inputSchema.required as string[]) : [];
  const properties = (tool.inputSchema?.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  const draft: Record<string, unknown> = {};
  for (const key of required) {
    const property = properties[key];
    draft[key] = property?.enum?.[0] ?? (property?.type === 'number' || property?.type === 'integer' ? 0 : property?.type === 'boolean' ? false : '');
  }
  return JSON.stringify(draft, null, 2);
}

function ToolRow({ device, tool }: { device: DeviceSnapshot; tool: ToolSummary }) {
  const [open, setOpen] = useState(false);
  const [args, setArgs] = useState(() => skeleton(tool));
  const [busy, setBusy] = useState(false);
  const run = () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args || '{}') as Record<string, unknown>;
    } catch (error) {
      showToast(`The arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setBusy(true);
    api
      .callTool(device.id, tool.server, tool.name, parsed, 'inspector')
      .then(() => updateSettings({ inspectorTab: 'timeline' }))
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return (
    <li className="tool">
      <button type="button" className="tool__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronIcon className={`entry__chevron${open ? ' is-open' : ''}`} />
        <code>{tool.name}</code>
        {tool.uiResourceUri && <span className="tag">card</span>}
        {tool.readOnly && <span className="tag">read-only</span>}
        {tool.appOnly && <span className="tag">card only</span>}
      </button>
      {open && (
        <div className="tool__body">
          {tool.title && <p className="tool__title">{tool.title}</p>}
          {tool.description && <p className="muted">{tool.description}</p>}
          {tool.uiResourceUri && (
            <p className="muted">
              Card: <code>{tool.uiResourceUri}</code>
            </p>
          )}
          <label>
            <span>Arguments (JSON)</span>
            <textarea value={args} rows={Math.min(10, Math.max(3, args.split('\n').length))} spellCheck={false} onChange={(event) => setArgs(event.target.value)} />
          </label>
          <div className="tool__actions">
            <button type="button" className="small-button" disabled={busy} onClick={run}>
              Call on {device.name}
            </button>
            <button type="button" className="text-button" onClick={() => void copy(tool.inputSchema ?? {}, 'the input schema')}>
              <CopyIcon /> Copy schema
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function ServerPanel({ device, server }: { device: DeviceSnapshot; server: ServerSnapshot }) {
  return (
    <section className="panel">
      <header className="panel__head">
        <h3>
          <span className={`dot dot--${server.status}`} aria-hidden="true" />
          {server.serverInfo?.title ?? server.serverInfo?.name ?? server.id}
        </h3>
        <span className="muted">{server.status}</span>
      </header>
      {server.error && <p className="detail-error">{server.error}</p>}
      <dl className="facts">
        <div className="facts__key">
          <dt>MCP protocol</dt>
          <dd>
            <strong>{server.protocolVersion ?? 'not negotiated'}</strong>
            {server.era ? ` (${server.era === 'legacy' ? 'initialize handshake, session' : 'stateless'})` : ''}
          </dd>
        </div>
        <div>
          <dt>Transport</dt>
          <dd>Streamable HTTP</dd>
        </div>
        <div>
          <dt>URL</dt>
          <dd>
            <code>{server.url}</code>
          </dd>
        </div>
        {server.sessionId && (
          <div>
            <dt>Session</dt>
            <dd>
              <code>{server.sessionId}</code>
            </dd>
          </div>
        )}
        {server.serverInfo && (
          <div>
            <dt>Server</dt>
            <dd>
              {server.serverInfo.name} {server.serverInfo.version}
            </dd>
          </div>
        )}
        {server.events && (
          <div>
            <dt>Events</dt>
            <dd>
              <span className={`dot dot--${server.events.status === 'open' ? 'connected' : server.events.status === 'error' ? 'error' : 'connecting'}`} aria-hidden="true" /> {server.events.status}, {server.events.received} received
              <br />
              <code>{server.events.url}</code>
              {server.events.error && <span className="detail-error"> {server.events.error}</span>}
            </dd>
          </div>
        )}
      </dl>
      {server.capabilities && (
        <details>
          <summary>Server capabilities</summary>
          <Json value={server.capabilities} />
        </details>
      )}
      {server.instructions && (
        <details>
          <summary>Server instructions</summary>
          <p className="instructions">{server.instructions}</p>
        </details>
      )}
      <h4>Tools ({server.tools.length})</h4>
      <ul className="tools">
        {server.tools.map((tool) => (
          <ToolRow key={tool.name} device={device} tool={tool} />
        ))}
      </ul>
      {server.resources.length > 0 && (
        <>
          <h4>Resources ({server.resources.length})</h4>
          <ul className="resources">
            {server.resources.map((resource) => (
              <li key={resource.uri}>
                <code>{resource.uri}</code> <span className="muted">{resource.mimeType}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Connections({ device }: { device: DeviceSnapshot }) {
  return (
    <div className="connections">
      <section className="panel">
        <header className="panel__head">
          <h3>
            <span className={`dot dot--${device.provider.ready ? 'connected' : 'error'}`} aria-hidden="true" />
            Assistant
          </h3>
          <span className="muted">{device.provider.id}</span>
        </header>
        <dl className="facts">
          <div>
            <dt>Provider</dt>
            <dd>{device.provider.label}</dd>
          </div>
          {device.provider.model && (
            <div>
              <dt>Model</dt>
              <dd>
                <code>{device.provider.model}</code>
              </dd>
            </div>
          )}
        </dl>
        {device.provider.error && <p className="detail-error">{device.provider.error}</p>}
      </section>
      {device.servers.length === 0 && <p className="empty">This device is not connected to any MCP server.</p>}
      {device.servers.map((server) => (
        <ServerPanel key={server.id} device={device} server={server} />
      ))}
      <section className="panel">
        <header className="panel__head">
          <h3>Agent Skills ({device.skills.length})</h3>
        </header>
        {device.skills.length === 0 ? (
          <p className="muted">No skills are loaded on this device.</p>
        ) : (
          <ul className="skills">
            {device.skills.map((skill) => (
              <li key={skill.name}>
                <p>
                  <code>{skill.name}</code> {skill.active ? <span className="tag tag--on">loaded into the conversation</span> : <span className="tag">description only</span>}
                </p>
                <p className="muted">{skill.description}</p>
                <p className="muted">
                  <code>{skill.path}</code> · {skill.bodyChars} characters{skill.files.length > 0 ? ` · ${skill.files.length} more files` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunPanel({ run }: { run: ScenarioRunState | null }) {
  if (!run) return <p className="empty">Pick a scenario in the bar at the top and press Play. Each step and what it checked will appear here.</p>;
  const passed = run.steps.filter((step) => step.status === 'passed').length;
  return (
    <div className="run">
      <header className="run__head">
        <div>
          <h3>{run.scenario.name}</h3>
          <p className="muted">
            {run.mode} mode · {passed} of {run.steps.length} steps passed
          </p>
        </div>
        <span className={`verdict verdict--${run.status}`}>{run.status}</span>
      </header>
      {run.scenario.description && <p className="muted run__about">{run.scenario.description}</p>}
      <ol className="run__steps">
        {run.steps.map((step) => (
          <li key={step.index} className={`step step--${step.status}`}>
            <p className="step__label">
              <span className="step__mark" aria-label={step.status}>
                {step.status === 'passed' ? <CheckIcon /> : step.status === 'failed' ? <CrossIcon /> : step.index + 1}
              </span>
              {step.label}
              {step.durationMs !== undefined && step.status !== 'skipped' && <span className="muted"> {step.durationMs} ms</span>}
            </p>
            {step.error && <p className="detail-error">{step.error}</p>}
            {step.checks.length > 0 && (
              <ul className="step__checks">
                {step.checks.map((check, index) => (
                  <li key={index} className={check.ok ? 'is-ok' : 'is-bad'}>
                    {check.ok ? <CheckIcon /> : <CrossIcon />}
                    <span>
                      {check.label}
                      {!check.ok && check.detail && <em>{check.detail}</em>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <button type="button" className="text-button" onClick={() => void copy(run, 'the run')}>
        <CopyIcon /> Copy as JSON
      </button>
    </div>
  );
}

export function Inspector() {
  const stage = useStage((state) => state.stage);
  const settings = useStage((state) => state.settings);
  if (!stage) return null;
  const device = stage.devices.find((candidate) => candidate.id === settings.inspectorDevice) ?? stage.devices[0];
  const tab = settings.inspectorTab;
  return (
    <aside className="inspector" aria-label="Developer inspector">
      <header className="inspector__head">
        <div className="tabs" role="tablist" aria-label="Device">
          {stage.devices.map((candidate) => {
            const errors = candidate.timeline.filter((entry) => entry.kind === 'error' || (entry.kind === 'tool' && entry.status === 'error')).length;
            return (
              <button key={candidate.id} type="button" role="tab" aria-selected={candidate.id === device?.id} className={`tab${candidate.id === device?.id ? ' is-on' : ''}`} onClick={() => updateSettings({ inspectorDevice: candidate.id })}>
                {candidate.name}
                {errors > 0 && <span className="tab__count" aria-label={`${errors} errors`}>{errors}</span>}
              </button>
            );
          })}
        </div>
        <div className="subtabs" role="tablist" aria-label="View">
          {(
            [
              ['timeline', 'Timeline'],
              ['connections', 'Connections'],
              ['scenario', 'Scenario'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`subtab${tab === id ? ' is-on' : ''}`} onClick={() => updateSettings({ inspectorTab: id })}>
              {label}
            </button>
          ))}
        </div>
      </header>
      {device && tab === 'timeline' && (
        <>
          <p className="inspector__summary">
            {device.servers.map((server) => (
              <span key={server.id}>
                <span className={`dot dot--${server.status}`} aria-hidden="true" /> {server.id} · MCP {server.protocolVersion ?? server.status} · {server.tools.length} tools
              </span>
            ))}
            <span>assistant: {device.provider.id}{device.provider.model ? ` (${device.provider.model})` : ''}</span>
          </p>
          <Timeline key={device.id} device={device} />
        </>
      )}
      {device && tab === 'connections' && <Connections key={device.id} device={device} />}
      {tab === 'scenario' && <RunPanel run={stage.run} />}
    </aside>
  );
}
