#!/usr/bin/env node
/**
 * The Voicestage command line.
 *
 *   voicestage dev        start the stage with the UI served by Vite (for working on Voicestage itself)
 *   voicestage start      start the stage with the built UI
 *   voicestage scenario   run scenario files and report pass or fail
 *   voicestage record     record a scenario to a video file with sound (macOS)
 *   voicestage example-server   run the built-in example MCP server on its own
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, findConfigFile, loadConfigFile, quickConfig, type ProviderId, type StageConfig } from './core/config.js';
import { formatReport, formatTimeline } from './core/scenario/runner.js';
import { loadScenarioFile, ScenarioError, type Scenario } from './core/scenario/schema.js';
import { Stage } from './core/stage.js';
import { serveStage, type StageAppOptions } from './server/app.js';
import { PRODUCT_NAME, PRODUCT_VERSION } from './shared/types.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The package folder: one level above `src/` or `dist/`. */
const packageRoot = resolve(here, '..');

const HELP = `${PRODUCT_NAME} ${PRODUCT_VERSION}: a local stage for voice-first MCP apps.

Usage
  voicestage dev [options]              Start the stage (UI served by Vite)
  voicestage start [options]            Start the stage (built UI; run "npm run build" first)
  voicestage scenario <file...> [options]   Run scenarios and report pass or fail
  voicestage record <file...> --out <dir>   Record scenarios to video files with sound (macOS)
  voicestage example-server [--port N]  Run the built-in example MCP server

What to connect to (first match wins)
  --config <file>        A voicestage.config.yaml
  --mcp <url>            Quick path: one Streamable HTTP MCP server on a display and a phone
    --header "Name: value"   Header for --mcp, repeatable (for example an Authorization header)
    --events <url>           Server-sent events URL for --mcp
    --skills <folder>        Agent Skills folder for --mcp, repeatable
  ./voicestage.config.yaml in the current folder
  otherwise the built-in example server

Assistant
  --provider <id>        scripted | anthropic | bedrock | openai-compatible | claude-code
                         (also VOICESTAGE_PROVIDER; default: the config, else scripted)
  --model <id>           Model for the provider (also VOICESTAGE_MODEL)

Stage
  --port <n>             Port for the UI and API (default 4700, or the next free one)
  --scenarios <path>     Extra scenario file or folder, repeatable

Scenario runner
  --mode scripted|live   scripted replays each step's script with no model (default);
                         live lets the configured provider drive
  --json                 Print the result as JSON
  --trace                Also print each device's timeline: what was heard, each model turn,
                         every tool call with its arguments and result
  --paced                Leave pauses between steps, as the UI does

Recording (voicestage record; needs macOS, Google Chrome and ffmpeg)
  --out <dir>            Where to write <name>.mp4 and <name>.timeline.json (default: out/recordings)
  --beat <ms>            Shortest pause between two speakers, and after a card appears (default 600)
  --gap <ms>             Pause between two sentences of one line (default 180)
  --lead <ms>, --tail <ms>   Stillness before the first step and after the last (default 1000 and 1500)
  --size <WxH>           Picture size (default 1920x1080)
  --fps <n>              Frames a second (default 30)
  --inspector            Show the developer inspector in the recording
  --controls             Show the controls for driving the stage (hidden by default)
  --chrome <path>        The browser to record with (also CHROME_PATH)
  --no-verify            Skip the checks on the finished file

Other
  -h, --help             Show this help
  -v, --version          Show the version
`;

function loadDotEnv(): void {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (error) {
    console.error(`Could not read .env: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseHeaders(values: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of values ?? []) {
    const colon = value.indexOf(':');
    if (colon <= 0) throw new ConfigError(`--header expects "Name: value", got "${value}".`);
    headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
  }
  return headers;
}

interface Flags {
  config?: string;
  mcp?: string;
  header?: string[];
  events?: string;
  skills?: string[];
  provider?: string;
  model?: string;
  port?: string;
  scenarios?: string[];
  mode?: string;
  json?: boolean;
  trace?: boolean;
  paced?: boolean;
  out?: string;
  beat?: string;
  gap?: string;
  lead?: string;
  tail?: string;
  size?: string;
  fps?: string;
  inspector?: boolean;
  controls?: boolean;
  chrome?: string;
  'no-verify'?: boolean;
  help?: boolean;
  version?: boolean;
}

/** The built-in default: the example server on a display and a phone. Also shipped as voicestage.config.yaml. */
function defaultConfig(): StageConfig {
  const shipped = join(packageRoot, 'voicestage.config.yaml');
  if (existsSync(shipped)) return loadConfigFile(shipped);
  throw new ConfigError('No configuration was given and the default voicestage.config.yaml is missing from the package. Pass --config or --mcp.');
}

function resolveStageConfig(flags: Flags, scenario?: Scenario): StageConfig {
  if (flags.config) return loadConfigFile(flags.config);
  if (flags.mcp) {
    return quickConfig({
      url: flags.mcp,
      headers: parseHeaders(flags.header),
      eventsUrl: flags.events,
      skills: (flags.skills ?? []).map((path) => resolve(path)),
      provider: flags.provider as ProviderId | undefined,
    });
  }
  if (scenario?.configPath) return loadConfigFile(scenario.configPath);
  const found = findConfigFile();
  return found ? loadConfigFile(found) : defaultConfig();
}

async function serve(command: 'dev' | 'start', flags: Flags): Promise<void> {
  const config = resolveStageConfig(flags);
  if (flags.model) process.env.VOICESTAGE_MODEL = flags.model;
  const stage = new Stage(config, {
    provider: flags.provider,
    scenarioPaths: (flags.scenarios ?? []).map((path) => resolve(path)),
    log: (line) => console.log(`[stage] ${line}`),
  });

  let devMiddleware: StageAppOptions['devMiddleware'];
  let closeVite: (() => Promise<void>) | undefined;
  if (command === 'dev') {
    const { createServer } = await import('vite');
    const vite = await createServer({ configFile: join(packageRoot, 'vite.config.ts'), server: { middlewareMode: true }, appType: 'spa', logLevel: 'warn' });
    devMiddleware = vite.middlewares as never;
    closeVite = () => vite.close();
  } else if (!existsSync(join(packageRoot, 'dist', 'ui', 'index.html'))) {
    throw new ConfigError('The UI has not been built yet. Run "npm run build" first, or use "npm run dev".');
  }

  const port = flags.port !== undefined ? Number(flags.port) : (config.port ?? 4700);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`--port must be a number between 0 and 65535, got "${flags.port}".`);
  const running = await serveStage({ stage, uiDir: join(packageRoot, 'dist', 'ui'), devMiddleware, log: (line) => console.log(`[stage] ${line}`), port, strictPort: flags.port !== undefined });

  console.log(`\n  ${PRODUCT_NAME} is on stage at ${running.url}\n`);
  console.log(`  Configuration: ${config.path ?? (flags.mcp ? `--mcp ${flags.mcp}` : 'built-in example')}`);
  console.log(`  Cards are loaded through the sandbox proxy on port ${running.sandboxPort} (a second origin).`);
  await stage.start();
  for (const device of stage.devices.values()) {
    const snapshot = device.snapshot();
    const provider = snapshot.provider.ready ? `${snapshot.provider.id}${snapshot.provider.model ? ` (${snapshot.provider.model})` : ''}` : `${snapshot.provider.id}: NOT CONFIGURED`;
    console.log(`\n  ${snapshot.name} [${snapshot.kind}] used by ${snapshot.person.name}, assistant: ${provider}`);
    if (!snapshot.provider.ready && snapshot.provider.error) console.log(`    ${snapshot.provider.error}`);
    for (const server of snapshot.servers) {
      console.log(
        server.status === 'connected'
          ? `    ${server.id}: connected to ${server.url}, MCP ${server.protocolVersion}, ${server.tools.length} tools`
          : `    ${server.id}: ${server.status} (${server.url}) ${server.error ?? ''}`,
      );
    }
    if (snapshot.skills.length > 0) console.log(`    skills: ${snapshot.skills.map((skill) => skill.name).join(', ')}`);
  }
  if (stage.scenarios.length > 0) console.log(`\n  Scenarios: ${stage.scenarios.map((scenario) => scenario.id).join(', ')}`);
  for (const error of stage.scenarioErrors) console.log(`  Scenario skipped: ${error.message}`);
  console.log('\n  Unofficial tool. Not affiliated with Amazon. Press Ctrl+C to stop.\n');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await stage.close().catch(() => undefined);
    await closeVite?.().catch(() => undefined);
    await running.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

async function runScenarios(files: string[], flags: Flags): Promise<number> {
  if (files.length === 0) throw new ConfigError('Give at least one scenario file: voicestage scenario <file...>');
  const mode = flags.mode ?? 'scripted';
  if (mode !== 'scripted' && mode !== 'live') throw new ConfigError(`--mode must be "scripted" or "live", got "${mode}".`);
  const scenarios = files.map((file) => loadScenarioFile(file));
  const config = resolveStageConfig(flags, scenarios[0]);
  if (flags.model) process.env.VOICESTAGE_MODEL = flags.model;
  // Scripted mode never needs a model, whatever the configuration names.
  const stage = new Stage(config, { provider: mode === 'scripted' ? 'scripted' : flags.provider });
  const say = (line: string) => {
    if (!flags.json) console.log(line);
  };
  let failed = 0;
  const results = [];
  try {
    await stage.start();
    const problems = [...stage.devices.values()].flatMap((device) =>
      device
        .snapshot()
        .servers.filter((server) => server.status !== 'connected')
        .map((server) => `${device.id} could not connect to "${server.id}" (${server.url}): ${server.error ?? server.status}`),
    );
    if (problems.length > 0) throw new ConfigError(`The stage could not be set up:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    await Promise.all([...stage.devices.values()].map((device) => device.eventsReady()));

    for (const scenario of scenarios) {
      const run = await stage.play(scenario, { mode, paced: flags.paced === true, reset: true });
      const state = await run.done;
      results.push(state);
      if (state.status !== 'passed') failed += 1;
      say(`\n${formatReport(state, { color: process.stdout.isTTY })}`);
      if (flags.trace) {
        for (const device of stage.devices.values()) {
          const snapshot = device.snapshot();
          say(`\n  ${snapshot.name} (${snapshot.id}), assistant: ${snapshot.provider.id}${snapshot.provider.model ? ` ${snapshot.provider.model}` : ''}\n${formatTimeline(snapshot.timeline).replace(/^/gm, '    ')}`);
        }
      }
    }
  } finally {
    await stage.close().catch(() => undefined);
  }
  if (flags.json) console.log(JSON.stringify(results, null, 2));
  else say(`\n${scenarios.length - failed} of ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} passed.\n`);
  return failed === 0 ? 0 : 1;
}

function numberFlag(name: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new ConfigError(`--${name} must be a number between ${min} and ${max}, got "${value}".`);
  return number;
}

async function record(files: string[], flags: Flags): Promise<number> {
  if (files.length === 0) throw new ConfigError('Give at least one scenario file: voicestage record <file...> --out <dir>');
  const { recordScenario, RecordError } = await import('./record/recorder.js');
  const size = /^(\d{3,4})x(\d{3,4})$/.exec(flags.size ?? '1920x1080');
  if (!size) throw new ConfigError(`--size expects WIDTHxHEIGHT, for example 1920x1080, got "${flags.size}".`);
  let failed = 0;
  for (const file of files) {
    const scenario = loadScenarioFile(file);
    const config = resolveStageConfig(flags, scenario);
    try {
      const result = await recordScenario({
        scenario,
        config,
        outDir: resolve(flags.out ?? join('out', 'recordings')),
        uiDir: join(packageRoot, 'dist', 'ui'),
        beatMs: numberFlag('beat', flags.beat, 0, 10_000),
        gapMs: numberFlag('gap', flags.gap, 0, 5000),
        leadMs: numberFlag('lead', flags.lead, 0, 60_000),
        tailMs: numberFlag('tail', flags.tail, 0, 60_000),
        width: Number(size[1]),
        height: Number(size[2]),
        fps: numberFlag('fps', flags.fps, 1, 60),
        inspector: flags.inspector === true,
        controls: flags.controls === true,
        chromePath: flags.chrome,
        verify: flags['no-verify'] !== true,
        log: (line) => console.log(line),
      });
      const report = result.report;
      console.log(`\n  ${result.video}\n  ${result.timeline}`);
      console.log(`  ${result.duration.toFixed(2)} s, scenario ${result.run.status}${report ? `, ${report.sync.checked} captions checked against the voice: at most ${report.sync.maxOffsetMs} ms apart` : ''}`);
      if (report && !report.ok) for (const problem of report.problems) console.log(`  PROBLEM: ${problem}`);
      if (result.run.status !== 'passed' || (report && !report.ok)) failed += 1;
    } catch (error) {
      if (error instanceof RecordError) throw new ConfigError(error.message);
      throw error;
    }
  }
  return failed === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  loadDotEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      mcp: { type: 'string' },
      header: { type: 'string', multiple: true, short: 'H' },
      events: { type: 'string' },
      skills: { type: 'string', multiple: true },
      provider: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      port: { type: 'string' },
      scenarios: { type: 'string', multiple: true },
      mode: { type: 'string' },
      json: { type: 'boolean' },
      trace: { type: 'boolean' },
      paced: { type: 'boolean' },
      out: { type: 'string', short: 'o' },
      beat: { type: 'string' },
      gap: { type: 'string' },
      lead: { type: 'string' },
      tail: { type: 'string' },
      size: { type: 'string' },
      fps: { type: 'string' },
      inspector: { type: 'boolean' },
      controls: { type: 'boolean' },
      chrome: { type: 'string' },
      'no-verify': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const flags = values as Flags;
  const [command = 'start', ...rest] = positionals;

  if (flags.version) {
    console.log(PRODUCT_VERSION);
    return;
  }
  if (flags.help || command === 'help') {
    console.log(HELP);
    return;
  }
  if (command === 'dev' || command === 'start') {
    await serve(command, flags);
    return;
  }
  if (command === 'scenario' || command === 'scenarios') {
    const code = await runScenarios(rest, flags);
    // Model providers may keep helper processes alive; the work is done.
    process.exit(code);
  }
  if (command === 'record') {
    process.exit(await record(rest, flags));
  }
  if (command === 'example-server') {
    const { startExampleServer } = await import('./example-server/server.js');
    const server = await startExampleServer({ port: flags.port !== undefined ? Number(flags.port) : 4701, log: (line) => console.log(`[example] ${line}`) });
    console.log(`Kitchen helper (example MCP server) is listening.\n  MCP (Streamable HTTP): ${server.url}\n  Events (SSE):          ${server.eventsUrl}\nTry it:  voicestage start --mcp ${server.url} --events ${server.eventsUrl}`);
    process.once('SIGINT', () => void server.close().then(() => process.exit(0)));
    process.once('SIGTERM', () => void server.close().then(() => process.exit(0)));
    return;
  }
  throw new ConfigError(`Unknown command "${command}". Run "voicestage --help".`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof ScenarioError) console.error(`\n${error.message}\n`);
  else console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
