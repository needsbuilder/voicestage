/**
 * The stage: every device, the loaded scenarios, and the stream of events that
 * a UI (or a test) can listen to.
 */
import { randomUUID } from 'node:crypto';
import { PRODUCT_VERSION, type ScenarioRunState, type StageEvent, type StageSnapshot } from '../shared/types.js';
import type { StageConfig } from './config.js';
import { Device, estimateSpeechMs, type DeviceHost } from './device.js';
import type { ScriptedLine } from './providers/index.js';
import { startScenario, type RunOptions, type ScenarioRun } from './scenario/runner.js';
import { loadScenarios, summarizeScenario, type Scenario } from './scenario/schema.js';

export interface StageOptions {
  env?: NodeJS.ProcessEnv;
  /** Use this provider on every device, whatever the configuration says. */
  provider?: string;
  /** Extra scenario files or folders, on top of the ones in the configuration. */
  scenarioPaths?: string[];
  /** See `DeviceHost.patience`. */
  patience?: number;
  log?: (line: string) => void;
}

export interface BuiltinServer {
  url: string;
  eventsUrl: string;
  close(): Promise<void>;
}

export class Stage implements DeviceHost {
  readonly devices = new Map<string, Device>();
  readonly vars: Record<string, unknown> = {};
  readonly env: NodeJS.ProcessEnv;
  readonly providerOverride: string | undefined;
  readonly patience: number;
  scenarios: Scenario[] = [];
  readonly scenarioErrors: Array<{ path: string; message: string }> = [];
  private readonly listeners = new Set<(event: StageEvent) => void>();
  private builtin: Promise<BuiltinServer> | undefined;
  private run: ScenarioRun | undefined;
  private lastRun: ScenarioRunState | null = null;
  private readonly log: (line: string) => void;

  constructor(
    readonly config: StageConfig,
    private readonly options: StageOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.providerOverride = options.provider;
    this.patience = options.patience ?? 1;
    this.log = options.log ?? (() => undefined);
    for (const device of config.devices) this.devices.set(device.id, new Device(device, this));
    this.reloadScenarios();
  }

  reloadScenarios(): void {
    this.scenarioErrors.length = 0;
    this.scenarios = loadScenarios([...this.config.scenarioPaths, ...(this.options.scenarioPaths ?? [])], (path, error) => {
      this.scenarioErrors.push({ path, message: error.message });
      this.log(`scenario skipped: ${error.message}`);
    });
  }

  /** Connect every device to its servers. Connection failures are recorded on the device, not thrown. */
  async start(): Promise<void> {
    await Promise.all([...this.devices.values()].map((device) => device.start()));
  }

  async close(): Promise<void> {
    this.run?.stop();
    await Promise.all([...this.devices.values()].map((device) => device.close()));
    const builtin = await this.builtin?.catch(() => undefined);
    await builtin?.close();
    this.listeners.clear();
  }

  // --- DeviceHost -------------------------------------------------------------

  emit(event: StageEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener that throws must not break the device.
      }
    }
  }

  hasListeners(): boolean {
    return this.paced;
  }

  /**
   * True while at least one UI is attached. Devices then wait for the UI to
   * finish speaking; without one, speech takes no time.
   */
  private paced = false;

  /** Lines a scripted device can match free speech against: every `say` step with a script. */
  scriptedLines(): ScriptedLine[] {
    return this.scenarios.flatMap((scenario) =>
      scenario.steps.flatMap((step) => (step.kind === 'say' && step.script && step.device ? [{ deviceId: step.device, text: step.say!, script: step.script, scenario: scenario.name }] : [])),
    );
  }

  async resolveBuiltin(): Promise<{ url: string; eventsUrl: string }> {
    this.builtin ??= import('../example-server/server.js').then((module) => module.startExampleServer({ port: 0 }));
    const server = await this.builtin;
    return { url: server.url, eventsUrl: server.eventsUrl };
  }

  // --- listening --------------------------------------------------------------

  /**
   * Subscribe to stage events. `speaks: true` marks a listener that plays
   * speech and reports back when each line is finished (a browser tab).
   */
  subscribe(listener: (event: StageEvent) => void, options: { speaks?: boolean } = {}): () => void {
    this.listeners.add(listener);
    if (options.speaks) this.speakers += 1;
    this.paced = this.speakers > 0;
    return () => {
      this.listeners.delete(listener);
      if (options.speaks) this.speakers -= 1;
      this.paced = this.speakers > 0;
    };
  }

  private speakers = 0;

  /** Set by whoever serves the stage over HTTP, once the card sandbox is listening. */
  sandboxPort: number | undefined;

  snapshot(): StageSnapshot {
    return {
      name: this.config.name,
      version: PRODUCT_VERSION,
      configPath: this.config.path,
      sandboxPort: this.sandboxPort,
      devices: [...this.devices.values()].map((device) => device.snapshot()),
      scenarios: this.scenarios.map(summarizeScenario),
      run: this.run ? structuredClone(this.run.state) : this.lastRun,
    };
  }

  // --- ScenarioHost -----------------------------------------------------------

  device(id: string): Device | undefined {
    return this.devices.get(id);
  }

  deviceIds(): string[] {
    return [...this.devices.keys()];
  }

  findScenario(idOrFile: string): Scenario | undefined {
    return this.scenarios.find((scenario) => scenario.id === idOrFile || scenario.file === idOrFile);
  }

  get activeRun(): ScenarioRun | undefined {
    return this.run;
  }

  /** Start a scenario. Only one runs at a time. With `reset`, every device first forgets its conversation. */
  async play(scenario: Scenario, options: RunOptions & { reset?: boolean }): Promise<ScenarioRun> {
    if (this.run || this.starting) throw new Error(`${this.run ? `"${this.run.state.scenario.name}"` : 'A scenario'} is still playing. Stop it first.`);
    this.starting = true;
    try {
      for (const key of Object.keys(this.vars)) delete this.vars[key];
      if (options.reset) await Promise.all([...this.devices.values()].map((device) => device.reset()));
      const run = startScenario(this, scenario, {
        ...options,
        onUpdate: (state) => {
          options.onUpdate?.(state);
          this.emit({ type: 'scenario', run: state });
        },
      });
      this.run = run;
      void run.done.finally(() => {
        this.lastRun = structuredClone(run.state);
        if (this.run === run) this.run = undefined;
      });
      return run;
    } finally {
      this.starting = false;
    }
  }

  private starting = false;

  // --- speech in progress ---------------------------------------------------------

  /** Lines a browser has been asked to speak and has not reported back on, with about how long each takes. */
  private readonly unspoken = new Map<string, number>();

  speechQueued(id: string, text: string): number {
    let ahead = 0;
    for (const ms of this.unspoken.values()) ahead += ms;
    const own = estimateSpeechMs(text);
    this.unspoken.set(id, own);
    return ((ahead + own) * 1.6 + 3000) * this.patience;
  }

  speechFinished(id: string): void {
    this.unspoken.delete(id);
  }

  // --- cues -------------------------------------------------------------------

  private readonly cues = new Map<string, () => void>();

  /**
   * A scenario is about to speak a person's line: ask whoever is watching to
   * show (and voice) it first. Resolves when they report back with `cueDone`,
   * or after about as long as the line would take when nobody does.
   */
  cue(deviceId: string, text: string): Promise<void> {
    return new Promise((resolve) => {
      const id = randomUUID();
      const done = () => {
        if (!this.cues.delete(id)) return;
        clearTimeout(timer);
        this.speechFinished(id);
        resolve();
      };
      const timer = setTimeout(done, this.speechQueued(id, text));
      this.cues.set(id, done);
      this.emit({ type: 'cue', id, deviceId, text });
    });
  }

  cueDone(id: string): void {
    this.cues.get(id)?.();
  }

  /** Let every waiting cue go, for example when a scenario is stopped. */
  releaseCues(): void {
    for (const done of [...this.cues.values()]) done();
  }

  clearRun(): void {
    if (this.run) return;
    this.lastRun = null;
    this.emit({ type: 'scenario', run: null });
  }
}
