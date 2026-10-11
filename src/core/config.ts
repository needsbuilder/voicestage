/**
 * Loading and validating `voicestage.config.yaml`.
 *
 * The file describes MCP servers, Agent Skills folders and devices. String
 * values may reference environment variables as `${NAME}` or
 * `${NAME:-fallback}`, so tokens do not have to be written into the file.
 * Relative paths are resolved from the directory of the config file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { compilePronunciations } from '../shared/pronounce.js';
import { commandProblem, splitCommand } from '../shared/voice-command.js';

export const PROVIDER_IDS = ['scripted', 'anthropic', 'bedrock', 'openai-compatible', 'claude-code'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const DEVICE_KINDS = ['display', 'speaker', 'phone'] as const;

const AssistantSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS).optional(),
    model: z.string().min(1).optional(),
    /** Most tool rounds in one turn before the assistant has to answer. */
    maxRounds: z.number().int().min(1).max(30).optional(),
    /** Extra text appended to the system prompt. */
    instructions: z.string().optional(),
    /** `tool`: skill bodies are loaded on demand through a `load_skill` tool. `always`: bodies are part of the system prompt. */
    skillActivation: z.enum(['tool', 'always']).optional(),
    /** Provider-specific settings: `baseUrl`, `apiKeyEnv`, `region`, `effort`, `maxTokens`, `fallbacks`. */
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type AssistantConfig = z.infer<typeof AssistantSchema>;

const ShowSchema = z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() }).strict();

const AnnounceRuleSchema = z
  .object({
    /** Event name on the events URL, or `mcp:<method>` for a notification on the MCP connection. */
    on: z.string().min(1),
    /** Devices that announce it. Default: every device connected to the server. */
    devices: z.array(z.string().min(1)).optional(),
    /** Only announce when these fields of the event data match. Keys are dot paths. */
    when: z.record(z.string(), z.unknown()).optional(),
    /** What the device says. `{{ ... }}` reads from the event data. */
    say: z.string().optional(),
    /** A tool to call when the event arrives; its result goes on the screen. */
    show: ShowSchema.optional(),
    /** Said after the tool result arrives. `{{result. ...}}` reads from its structured content. */
    then_say: z.string().optional(),
  })
  .strict()
  .refine((rule) => rule.say !== undefined || rule.show !== undefined, { message: 'An announce rule needs "say", "show", or both.' });
export type AnnounceRule = z.infer<typeof AnnounceRuleSchema>;

const EventsSchema = z
  .object({
    /** Server-sent events URL. Omit to announce MCP notifications only. */
    url: z.string().url().optional(),
    /** Extra headers for the events request. The device's headers for this server are always sent too. */
    headers: z.record(z.string(), z.string()).optional(),
    announce: z.array(AnnounceRuleSchema).default([]),
  })
  .strict();

const ServerSchema = z
  .object({
    url: z.string().url().optional(),
    /** `example` starts the built-in example MCP server and points this entry at it. */
    builtin: z.literal('example').optional(),
    /** `2025-11-25` (default) uses the initialize handshake with a session. `auto` probes for 2026-07-28 first. */
    protocol: z.enum(['2025-11-25', 'auto']).default('2025-11-25'),
    headers: z.record(z.string(), z.string()).optional(),
    events: EventsSchema.optional(),
    timeoutMs: z.number().int().min(1000).optional(),
  })
  .strict()
  .refine((server) => Boolean(server.url) !== Boolean(server.builtin), { message: 'A server needs exactly one of "url" or "builtin".' });
export type ServerConfig = z.infer<typeof ServerSchema>;

const DeviceServerSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1), headers: z.record(z.string(), z.string()).optional() }).strict(),
]);

const VoiceSchema = z
  .object({
    /**
     * Name (or part of the name) of a speech synthesis voice installed in the browser.
     * A recording made with `recording.voices.command` gives this name to that program as it is.
     */
    name: z.string().optional(),
    lang: z.string().optional(),
    rate: z.number().min(0.5).max(2).optional(),
    pitch: z.number().min(0).max(2).optional(),
  })
  .strict();

const AnnouncementsSchema = z
  .object({
    /** `speak`: light the indicator, then read the announcement. `indicator`: light it and wait to be asked. */
    mode: z.enum(['speak', 'indicator']).default('speak'),
    /** How long the indicator shows before the device speaks, in milliseconds. */
    delayMs: z.number().int().min(0).max(60_000).default(1400),
  })
  .strict();

const DeviceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, 'Device ids use letters, digits, "-" and "_".'),
    name: z.string().min(1).optional(),
    kind: z.enum(DEVICE_KINDS).default('display'),
    /** Who uses the device. `voice` is the voice their lines are spoken with when a scenario is played. */
    person: z.union([z.string().min(1), z.object({ name: z.string().min(1), role: z.string().optional(), voice: VoiceSchema.omit({ lang: true }).optional() }).strict()]).optional(),
    servers: z.array(DeviceServerSchema).default([]),
    /** Skill names from the top-level `skills` map, or paths to skill folders. */
    skills: z.array(z.string().min(1)).default([]),
    assistant: AssistantSchema.optional(),
    voice: VoiceSchema.optional(),
    wakeWord: z.string().min(1).default('computer'),
    announcements: AnnouncementsSchema.optional(),
    hints: z.array(z.string()).default([]),
  })
  .strict();

/** Only read by `voicestage record`. */
const RecordingSchema = z
  .object({
    voices: z
      .object({
        /**
         * A program that renders one sentence to a WAV file, used for every line of a recording
         * in place of the system voices. A list of arguments, or one string cut at spaces.
         * See `src/shared/voice-command.ts` for the names in braces it may use.
         */
        command: z.union([z.string().min(1), z.array(z.string()).min(1)]),
        /** A short name for the program, written into the timeline. */
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9 ._-]*$/i, 'Use letters, digits, spaces, ".", "-" and "_".')
          .optional(),
      })
      .strict()
      .optional(),
    /** Another spelling for the voice, per word or phrase. See `src/shared/pronounce.ts`. */
    pronounce: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict();

const ConfigSchema = z
  .object({
    name: z.string().optional(),
    port: z.number().int().min(0).max(65535).optional(),
    assistant: AssistantSchema.optional(),
    recording: RecordingSchema.optional(),
    servers: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i), ServerSchema).default({}),
    skills: z.record(z.string(), z.string()).default({}),
    devices: z.array(DeviceSchema).min(1, 'Define at least one device.'),
    /** Scenario files or folders. Folders are searched for *.yaml and *.yml. */
    scenarios: z.array(z.string()).default([]),
  })
  .strict();
export type RawConfig = z.infer<typeof ConfigSchema>;

export interface ResolvedDeviceServer {
  id: string;
  url?: string;
  builtin?: 'example';
  protocol: 'legacy' | 'auto';
  headers: Record<string, string>;
  timeoutMs?: number;
  events?: { url?: string; headers: Record<string, string>; announce: AnnounceRule[] };
}

export interface ResolvedDevice {
  id: string;
  name: string;
  kind: (typeof DEVICE_KINDS)[number];
  person: { name: string; role?: string; voice?: { name?: string; rate?: number; pitch?: number } };
  servers: ResolvedDeviceServer[];
  /** Absolute paths of skill folders. */
  skillPaths: string[];
  assistant: AssistantConfig;
  voice: z.infer<typeof VoiceSchema>;
  wakeWord: string;
  announcements: z.infer<typeof AnnouncementsSchema>;
  hints: string[];
}

export interface RecordingConfig {
  /** The program that renders the voices of a recording. Without it, the system voices are used. */
  voices?: {
    /** What the timeline calls it. */
    name: string;
    /** The program and its arguments, with the names in braces still to be filled in. */
    command: string[];
    /** The folder the program is started in: the folder of the configuration file. */
    cwd: string;
  };
  /** What is written, and how the voice should be given it. */
  pronounce: Record<string, string>;
}

export interface StageConfig {
  name: string;
  port?: number;
  /** Absolute path of the file this came from, when there is one. */
  path?: string;
  baseDir: string;
  recording: RecordingConfig;
  devices: ResolvedDevice[];
  /** Absolute scenario paths (files or folders). */
  scenarioPaths: string[];
}

export class ConfigError extends Error {}

const ENV_REFERENCE = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi;

/** Replace `${NAME}` and `${NAME:-fallback}` in every string of a parsed YAML document. */
export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv, missing: Set<string> = new Set()): T {
  if (typeof value === 'string') {
    return value.replace(ENV_REFERENCE, (_match, name: string, fallback: string | undefined) => {
      const found = env[name];
      if (found !== undefined && found !== '') return found;
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return '';
    }) as T;
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item, env, missing)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateEnv(item, env, missing)])) as T;
  }
  return value;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('\n');
}

function deriveEventsHeaders(serverHeaders: Record<string, string>, events: z.infer<typeof EventsSchema>): Record<string, string> {
  return { ...serverHeaders, ...events.headers };
}

/** Validate a parsed config and resolve names, defaults and paths. */
export function resolveConfig(input: unknown, options: { baseDir: string; path?: string; env?: NodeJS.ProcessEnv } = { baseDir: process.cwd() }): StageConfig {
  const env = options.env ?? process.env;
  const missing = new Set<string>();
  const interpolated = interpolateEnv(input, env, missing);
  const parsed = ConfigSchema.safeParse(interpolated);
  const where = options.path ?? 'the configuration';
  if (!parsed.success) throw new ConfigError(`${where} is not valid:\n${formatIssues(parsed.error)}`);
  if (missing.size > 0) {
    throw new ConfigError(`${where} refers to environment variables that are not set: ${[...missing].join(', ')}. Set them, or give a fallback as \${NAME:-value}.`);
  }
  const raw = parsed.data;
  const abs = (path: string) => (isAbsolute(path) ? path : resolve(options.baseDir, path));

  const seen = new Set<string>();
  const devices = raw.devices.map((device): ResolvedDevice => {
    if (seen.has(device.id)) throw new ConfigError(`${where}: two devices share the id "${device.id}".`);
    seen.add(device.id);

    const servers = device.servers.map((entry): ResolvedDeviceServer => {
      const id = typeof entry === 'string' ? entry : entry.id;
      const server = raw.servers[id];
      if (!server) {
        throw new ConfigError(`${where}: device "${device.id}" uses server "${id}", which is not defined under "servers". Defined: ${Object.keys(raw.servers).join(', ') || 'none'}.`);
      }
      const headers = { ...server.headers, ...(typeof entry === 'string' ? {} : entry.headers) };
      const rules = (server.events?.announce ?? []).filter((rule) => !rule.devices || rule.devices.includes(device.id));
      for (const rule of server.events?.announce ?? []) {
        for (const target of rule.devices ?? []) {
          if (!raw.devices.some((candidate) => candidate.id === target)) {
            throw new ConfigError(`${where}: an announce rule for "${rule.on}" on server "${id}" names device "${target}", which does not exist.`);
          }
        }
      }
      return {
        id,
        url: server.url,
        builtin: server.builtin,
        protocol: server.protocol === 'auto' ? 'auto' : 'legacy',
        headers,
        timeoutMs: server.timeoutMs,
        events: server.events ? { url: server.events.url, headers: deriveEventsHeaders(headers, server.events), announce: rules } : undefined,
      };
    });
    if (new Set(servers.map((server) => server.id)).size !== servers.length) {
      throw new ConfigError(`${where}: device "${device.id}" lists the same server twice.`);
    }

    const skillPaths = device.skills.map((entry) => abs(raw.skills[entry] ?? entry));
    const person = typeof device.person === 'string' ? { name: device.person } : (device.person ?? { name: 'Guest' });
    return {
      id: device.id,
      name: device.name ?? defaultDeviceName(device.kind),
      kind: device.kind,
      person,
      servers,
      skillPaths,
      assistant: { ...raw.assistant, ...device.assistant, options: { ...raw.assistant?.options, ...device.assistant?.options } },
      voice: device.voice ?? {},
      wakeWord: device.wakeWord,
      announcements: device.announcements ?? { mode: 'speak', delayMs: 1400 },
      hints: device.hints,
    };
  });

  return {
    name: raw.name ?? 'Voicestage',
    port: raw.port,
    path: options.path,
    baseDir: options.baseDir,
    recording: resolveRecording(raw.recording, options.baseDir, where),
    devices,
    scenarioPaths: raw.scenarios.map(abs),
  };
}

function resolveRecording(raw: z.infer<typeof RecordingSchema> | undefined, baseDir: string, where: string): RecordingConfig {
  const pronounce = raw?.pronounce ?? {};
  try {
    compilePronunciations(pronounce);
  } catch (error) {
    throw new ConfigError(`${where}: recording.pronounce: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw?.voices) return { pronounce };
  let command: string[];
  try {
    command = typeof raw.voices.command === 'string' ? splitCommand(raw.voices.command) : raw.voices.command;
  } catch (error) {
    throw new ConfigError(`${where}: recording.voices.command: ${error instanceof Error ? error.message : String(error)}`);
  }
  const problem = commandProblem(command);
  if (problem) throw new ConfigError(`${where}: recording.voices.command cannot render a voice: ${problem}. Example: my-tts --voice {voice} --rate {rate} --out {out} {text}`);
  return { voices: { name: raw.voices.name ?? 'command', command, cwd: baseDir }, pronounce };
}

function defaultDeviceName(kind: string): string {
  return kind === 'display' ? 'Smart display' : kind === 'speaker' ? 'Smart speaker' : 'Phone';
}

export function loadConfigFile(path: string, env: NodeJS.ProcessEnv = process.env): StageConfig {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new ConfigError(`No configuration file at ${absolute}.`);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${absolute} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  return resolveConfig(parsed, { baseDir: dirname(absolute), path: absolute, env });
}

export const DEFAULT_CONFIG_NAMES = ['voicestage.config.yaml', 'voicestage.config.yml'];

export function findConfigFile(cwd: string = process.cwd()): string | undefined {
  for (const name of DEFAULT_CONFIG_NAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The `--mcp <url>` quick path: a smart display and a phone, both connected to
 * one server with the same headers. Enough to poke at any Streamable HTTP MCP
 * server without writing a config file.
 */
export function quickConfig(options: { url: string; headers?: Record<string, string>; eventsUrl?: string; baseDir?: string; skills?: string[]; provider?: ProviderId }): StageConfig {
  new URL(options.url);
  return resolveConfig(
    {
      name: new URL(options.url).host,
      assistant: options.provider ? { provider: options.provider } : undefined,
      servers: {
        mcp: { url: options.url, headers: options.headers, events: options.eventsUrl ? { url: options.eventsUrl } : undefined },
      },
      devices: [
        { id: 'display', name: 'Smart display', kind: 'display', person: 'You', servers: ['mcp'], skills: options.skills ?? [] },
        { id: 'phone', name: 'Phone', kind: 'phone', person: 'Someone else', servers: ['mcp'], skills: options.skills ?? [] },
      ],
    },
    { baseDir: options.baseDir ?? process.cwd() },
  );
}

/** Which provider a device should use: an explicit override wins, then the environment, then the config, then `scripted`. */
export function selectProviderId(assistant: AssistantConfig, env: NodeJS.ProcessEnv = process.env, override?: string): ProviderId {
  const candidate = override ?? env.VOICESTAGE_PROVIDER ?? assistant.provider ?? 'scripted';
  if (!(PROVIDER_IDS as readonly string[]).includes(candidate)) {
    throw new ConfigError(`Unknown provider "${candidate}". Choose one of: ${PROVIDER_IDS.join(', ')}.`);
  }
  return candidate as ProviderId;
}
