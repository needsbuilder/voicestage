/** Calls to the stage server's JSON API. */
import type { JsonObject, ToolResult, UtteranceSource } from '../../src/shared/types';

async function post<T = { ok: true }>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `${path} answered ${response.status}`);
  return data;
}

const device = (id: string) => `/api/devices/${encodeURIComponent(id)}`;

export const api = {
  say: (deviceId: string, text: string, source: UtteranceSource = 'typed') => post(`${device(deviceId)}/say`, { text, source }),
  speechDone: (deviceId: string, speechId: string) => post(`${device(deviceId)}/speech/${encodeURIComponent(speechId)}/done`).catch(() => undefined),
  callTool: (deviceId: string, server: string, name: string, args: JsonObject | undefined, origin: 'card' | 'inspector' = 'card') =>
    post<ToolResult>(`${device(deviceId)}/tool`, { server, name, arguments: args ?? {}, origin }),
  readResource: (deviceId: string, server: string, uri: string) => post<{ contents: unknown[] }>(`${device(deviceId)}/resource`, { server, uri }),
  cardEvent: (deviceId: string, action: string, detail: unknown, uri?: string) => post(`${device(deviceId)}/card-event`, { action, detail, uri }).catch(() => undefined),
  answer: (deviceId: string, elicitationId: string, action: 'accept' | 'decline' | 'cancel', content?: JsonObject) =>
    post(`${device(deviceId)}/elicitation/${encodeURIComponent(elicitationId)}`, { action, content }),
  notification: (deviceId: string, action: 'play' | 'dismiss') => post(`${device(deviceId)}/notification`, { action }),
  resetDevice: (deviceId: string, reconnect = false) => post(`${device(deviceId)}/reset`, { reconnect }),
  resetAll: (reconnect = false) => post('/api/reset', { reconnect }),
  play: (scenarioId: string, options: { mode: 'scripted' | 'live'; pacing: 'auto' | 'step'; reset?: boolean }) => post(`/api/scenarios/${encodeURIComponent(scenarioId)}/play`, options),
  next: () => post('/api/scenarios/next'),
  stop: () => post('/api/scenarios/stop'),
  clearRun: () => post('/api/scenarios/clear'),
  cueDone: (id: string) => post(`/api/cues/${encodeURIComponent(id)}/done`).catch(() => undefined),
};
