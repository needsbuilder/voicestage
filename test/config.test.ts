import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, interpolateEnv, loadConfigFile, quickConfig, resolveConfig, selectProviderId } from '../src/core/config.js';

const base = {
  servers: { app: { url: 'http://localhost:3000/mcp' } },
  devices: [{ id: 'display', servers: ['app'] }],
};

function write(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'voicestage-config-'));
  const file = join(dir, 'voicestage.config.yaml');
  writeFileSync(file, text);
  return file;
}

describe('configuration', () => {
  it('fills in defaults for a minimal configuration', () => {
    const config = resolveConfig(base, { baseDir: '/tmp/x', env: {} });
    expect(config.name).toBe('Voicestage');
    expect(config.devices).toHaveLength(1);
    const device = config.devices[0]!;
    expect(device).toMatchObject({ id: 'display', name: 'Smart display', kind: 'display', person: { name: 'Guest' }, wakeWord: 'computer' });
    expect(device.servers[0]).toMatchObject({ id: 'app', url: 'http://localhost:3000/mcp', protocol: 'legacy', headers: {} });
    expect(device.announcements).toEqual({ mode: 'speak', delayMs: 1400 });
  });

  it('gives each device its own headers on top of the server headers', () => {
    const config = resolveConfig(
      {
        servers: { app: { url: 'http://localhost:3000/mcp', headers: { 'X-App': 'stage' } } },
        devices: [
          { id: 'kitchen', person: { name: 'Margaret', role: 'member' }, servers: [{ id: 'app', headers: { Authorization: 'Bearer one' } }] },
          { id: 'phone', kind: 'phone', person: 'Sarah', servers: [{ id: 'app', headers: { Authorization: 'Bearer two' } }] },
        ],
      },
      { baseDir: '/tmp/x', env: {} },
    );
    expect(config.devices[0]!.servers[0]!.headers).toEqual({ 'X-App': 'stage', Authorization: 'Bearer one' });
    expect(config.devices[1]!.servers[0]!.headers).toEqual({ 'X-App': 'stage', Authorization: 'Bearer two' });
    expect(config.devices[0]!.person).toEqual({ name: 'Margaret', role: 'member' });
    expect(config.devices[1]!.person).toEqual({ name: 'Sarah' });
    expect(config.devices[1]!.name).toBe('Phone');
  });

  it('sends announce rules only to the devices they name, and passes device headers to the events URL', () => {
    const config = resolveConfig(
      {
        servers: {
          app: {
            url: 'http://localhost:3000/mcp',
            events: {
              url: 'http://localhost:3000/events',
              headers: { 'X-Stream': '1' },
              announce: [
                { on: 'order.created', devices: ['phone'], say: 'New order.' },
                { on: 'order.done', say: 'Done.', show: { tool: 'get_order', args: { id: '{{order.id}}' } }, then_say: '{{result.message}}' },
              ],
            },
          },
        },
        devices: [
          { id: 'kitchen', servers: [{ id: 'app', headers: { Authorization: 'Bearer one' } }] },
          { id: 'phone', kind: 'phone', servers: ['app'] },
        ],
      },
      { baseDir: '/tmp/x', env: {} },
    );
    const [kitchen, phone] = config.devices;
    expect(kitchen!.servers[0]!.events!.announce.map((rule) => rule.on)).toEqual(['order.done']);
    expect(phone!.servers[0]!.events!.announce.map((rule) => rule.on)).toEqual(['order.created', 'order.done']);
    expect(kitchen!.servers[0]!.events!.headers).toEqual({ Authorization: 'Bearer one', 'X-Stream': '1' });
    expect(kitchen!.servers[0]!.events!.url).toBe('http://localhost:3000/events');
  });

  it('reads environment variables, with fallbacks', () => {
    expect(interpolateEnv({ a: 'Bearer ${TOKEN}', b: ['${MISSING:-fallback}', 1, true] }, { TOKEN: 'abc' })).toEqual({ a: 'Bearer abc', b: ['fallback', 1, true] });
    const config = resolveConfig(
      { servers: { app: { url: '${APP_URL:-http://localhost:9}/mcp' } }, devices: [{ id: 'd', servers: [{ id: 'app', headers: { Authorization: 'Bearer ${APP_TOKEN}' } }] }] },
      { baseDir: '/tmp/x', env: { APP_TOKEN: 's3cret' } },
    );
    expect(config.devices[0]!.servers[0]).toMatchObject({ url: 'http://localhost:9/mcp', headers: { Authorization: 'Bearer s3cret' } });
  });

  it('names the environment variables that are not set', () => {
    expect(() => resolveConfig({ ...base, servers: { app: { url: 'http://localhost:3000/mcp', headers: { Authorization: 'Bearer ${NOPE_TOKEN}' } } } }, { baseDir: '/tmp/x', env: {} })).toThrow(/NOPE_TOKEN/);
  });

  it('resolves skill and scenario paths from the folder of the config file', () => {
    const file = write(`
skills:
  helper: ./skills/helper
servers:
  app: { builtin: example }
devices:
  - id: display
    servers: [app]
    skills: [helper, ../elsewhere/skill]
scenarios: [scenarios, /abs/one.yaml]
`);
    const config = loadConfigFile(file, {});
    const dir = resolve(file, '..');
    expect(config.path).toBe(file);
    expect(config.devices[0]!.skillPaths).toEqual([join(dir, 'skills/helper'), resolve(dir, '../elsewhere/skill')]);
    expect(config.scenarioPaths).toEqual([join(dir, 'scenarios'), '/abs/one.yaml']);
    expect(config.devices[0]!.servers[0]).toMatchObject({ builtin: 'example', url: undefined });
  });

  it('explains what is wrong with a bad configuration', () => {
    expect(() => resolveConfig({ devices: [] }, { baseDir: '/', env: {} })).toThrow(/Define at least one device/);
    expect(() => resolveConfig({ ...base, devices: [{ id: 'display', servers: ['nope'] }] }, { baseDir: '/', env: {} })).toThrow(/uses server "nope", which is not defined.*Defined: app/s);
    expect(() => resolveConfig({ ...base, devices: [{ id: 'a' }, { id: 'a' }] }, { baseDir: '/', env: {} })).toThrow(/two devices share the id "a"/);
    expect(() => resolveConfig({ ...base, servers: { app: {} } }, { baseDir: '/', env: {} })).toThrow(/exactly one of "url" or "builtin"/);
    expect(() => resolveConfig({ ...base, devices: [{ id: 'display', kind: 'toaster' }] }, { baseDir: '/', env: {} })).toThrow(ConfigError);
    expect(() => resolveConfig({ ...base, surprise: true }, { baseDir: '/', env: {} })).toThrow(/surprise/);
    expect(() => resolveConfig({ ...base, servers: { app: { url: 'http://x/mcp', events: { announce: [{ on: 'e', devices: ['ghost'], say: 'x' }] } } } }, { baseDir: '/', env: {} })).toThrow(/names device "ghost"/);
    expect(() => resolveConfig({ ...base, servers: { app: { url: 'http://x/mcp', events: { announce: [{ on: 'e' }] } } } }, { baseDir: '/', env: {} })).toThrow(/needs "say", "show", or both/);
    expect(() => loadConfigFile('/nope/voicestage.config.yaml')).toThrow(/No configuration file/);
    expect(() => loadConfigFile(write('devices: [unclosed'))).toThrow(/not valid YAML/);
  });

  it('merges the top-level assistant settings into each device', () => {
    const config = resolveConfig(
      {
        ...base,
        assistant: { provider: 'anthropic', model: 'claude-opus-5-5', options: { effort: 'low', maxTokens: 500 } },
        devices: [
          { id: 'a', servers: ['app'] },
          { id: 'b', servers: ['app'], assistant: { provider: 'scripted', options: { effort: 'high' } } },
        ],
      },
      { baseDir: '/', env: {} },
    );
    expect(config.devices[0]!.assistant).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', options: { effort: 'low', maxTokens: 500 } });
    expect(config.devices[1]!.assistant).toMatchObject({ provider: 'scripted', model: 'claude-opus-5-5', options: { effort: 'high', maxTokens: 500 } });
  });

  it('builds the --mcp quick configuration: a display and a phone on one server', () => {
    const config = quickConfig({ url: 'http://localhost:8787/mcp', headers: { Authorization: 'Bearer t' }, eventsUrl: 'http://localhost:8787/events' });
    expect(config.name).toBe('localhost:8787');
    expect(config.devices.map((device) => [device.id, device.kind])).toEqual([
      ['display', 'display'],
      ['phone', 'phone'],
    ]);
    for (const device of config.devices) {
      expect(device.servers[0]).toMatchObject({ id: 'mcp', url: 'http://localhost:8787/mcp', headers: { Authorization: 'Bearer t' }, protocol: 'legacy' });
      expect(device.servers[0]!.events?.url).toBe('http://localhost:8787/events');
    }
    expect(() => quickConfig({ url: 'not a url' })).toThrow();
  });

  it('loads the configurations that ship with the project', () => {
    const root = resolve(import.meta.dirname, '..');
    const example = loadConfigFile(join(root, 'voicestage.config.yaml'), {});
    expect(example.devices.map((device) => device.kind)).toEqual(['display', 'phone']);
    expect(example.devices[0]!.servers[0]!.builtin).toBe('example');
    const three = loadConfigFile(join(root, 'examples/three-devices.config.yaml'), {});
    expect(three.devices.map((device) => device.kind)).toEqual(['display', 'speaker', 'phone']);
    expect(three.devices[1]!.announcements.mode).toBe('indicator');
    const holdon = loadConfigFile(join(root, 'examples/holdon/voicestage.config.yaml'), { HOLDON_URL: 'http://localhost:1234' });
    expect(holdon.devices[0]!.servers[0]).toMatchObject({ url: 'http://localhost:1234/mcp', headers: { Authorization: 'Bearer demo-member-margaret' } });
    expect(holdon.devices[1]!.servers[0]!.headers).toEqual({ Authorization: 'Bearer demo-contact-sarah' });
    expect(holdon.devices[1]!.servers[0]!.events!.announce.map((rule) => rule.on)).toEqual(['hold.created', 'hold.created']);
    expect(holdon.devices[0]!.servers[0]!.events!.announce.map((rule) => rule.on)).toEqual(['hold.decided']);
  });
});

describe('provider selection', () => {
  it('uses an override, then the environment, then the configuration, then scripted', () => {
    expect(selectProviderId({}, {})).toBe('scripted');
    expect(selectProviderId({ provider: 'bedrock' }, {})).toBe('bedrock');
    expect(selectProviderId({ provider: 'bedrock' }, { VOICESTAGE_PROVIDER: 'anthropic' })).toBe('anthropic');
    expect(selectProviderId({ provider: 'bedrock' }, { VOICESTAGE_PROVIDER: 'anthropic' }, 'claude-code')).toBe('claude-code');
  });

  it('rejects a provider that does not exist', () => {
    expect(() => selectProviderId({}, { VOICESTAGE_PROVIDER: 'gpt' })).toThrow(/Unknown provider "gpt".*scripted, anthropic, bedrock, openai-compatible, claude-code/);
  });
});
