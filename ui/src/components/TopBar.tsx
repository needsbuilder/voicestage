/** The bar across the top: what stage this is, the scenario player, and the voice and inspector switches. */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { showToast, updateSettings, useStage } from '../store';
import { voice } from '../voice';
import { Logo, MuteIcon, NextIcon, PanelIcon, PlayIcon, ResetIcon, SpeakerIcon, StopIcon } from './icons';
import { VoiceMenu } from './VoiceMenu';

const fail = (error: unknown) => showToast(error instanceof Error ? error.message : String(error));

function ScenarioPlayer() {
  const stage = useStage((state) => state.stage)!;
  const run = stage.run;
  const running = run?.status === 'running';
  const [scenarioId, setScenarioId] = useState(() => new URLSearchParams(location.search).get('scenario') ?? run?.scenario.id ?? stage.scenarios[0]?.id ?? '');
  const [mode, setMode] = useState<'scripted' | 'live'>('scripted');
  const [stepwise, setStepwise] = useState(false);
  const liveReady = stage.devices.some((device) => device.provider.ready && device.provider.id !== 'scripted');

  useEffect(() => {
    if (!stage.scenarios.some((scenario) => scenario.id === scenarioId)) setScenarioId(stage.scenarios[0]?.id ?? '');
  }, [stage.scenarios, scenarioId]);
  // Show the scenario that is playing, also when it was started from somewhere else.
  useEffect(() => {
    if (run?.status === 'running' && stage.scenarios.some((scenario) => scenario.id === run.scenario.id)) {
      setScenarioId(run.scenario.id);
      setMode(run.mode);
    }
  }, [run?.runId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (stage.scenarios.length === 0) return <p className="topbar__hint">No scenarios loaded. Add a folder under &ldquo;scenarios&rdquo; in the configuration.</p>;

  const current = run?.steps.find((step) => step.status === 'running') ?? (run?.waitingForNext ? run.steps.find((step) => step.status === 'pending') : undefined);
  const done = run ? run.steps.filter((step) => step.status === 'passed' || step.status === 'failed' || step.status === 'skipped').length : 0;

  return (
    <div className="player">
      <label className="sr-only" htmlFor="scenario">
        Scenario
      </label>
      <select id="scenario" value={scenarioId} disabled={running} onChange={(event) => setScenarioId(event.target.value)}>
        {stage.scenarios.map((scenario) => (
          <option key={scenario.id} value={scenario.id}>
            {scenario.name}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="mode">
        Who drives the assistant
      </label>
      <select id="mode" value={mode} disabled={running} onChange={(event) => setMode(event.target.value as 'scripted' | 'live')} title="Scripted replays the scenario's script with no model. Live lets the configured model decide.">
        <option value="scripted">Scripted</option>
        <option value="live" disabled={!liveReady}>
          Live model{liveReady ? '' : ' (not configured)'}
        </option>
      </select>
      <label className="check" title="Wait for Next before each step. Useful when recording.">
        <input type="checkbox" checked={stepwise} disabled={running} onChange={(event) => setStepwise(event.target.checked)} />
        Step by step
      </label>
      {running ? (
        <>
          {run.waitingForNext && (
            <button type="button" className="primary" onClick={() => void api.next().catch(fail)}>
              <NextIcon /> Next
            </button>
          )}
          <button type="button" className="secondary" onClick={() => void api.stop().catch(fail)}>
            <StopIcon /> Stop
          </button>
        </>
      ) : (
        <button
          type="button"
          className="primary"
          disabled={!scenarioId}
          onClick={() => {
            updateSettings({ inspectorTab: 'scenario' });
            void api.play(scenarioId, { mode, pacing: stepwise ? 'step' : 'auto' }).catch(fail);
          }}
        >
          <PlayIcon /> Play
        </button>
      )}
      {run && (
        <button type="button" className={`runstate runstate--${run.status}`} onClick={() => updateSettings({ inspector: true, inspectorTab: 'scenario' })} title="Show the steps and checks">
          {running ? (
            <>
              <span className="runstate__count">
                {Math.min(done + 1, run.steps.length)}/{run.steps.length}
              </span>
              <span className="runstate__label">{current?.label ?? 'Starting'}</span>
            </>
          ) : (
            <>
              <span className="runstate__count">{run.status}</span>
              <span className="runstate__label">
                {run.steps.filter((step) => step.status === 'passed').length} of {run.steps.length} steps passed
              </span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

export function TopBar() {
  const stage = useStage((state) => state.stage);
  const settings = useStage((state) => state.settings);
  const connected = useStage((state) => state.connected);
  return (
    <header className="topbar">
      <div className="brand">
        <Logo className="brand__logo" />
        <span className="brand__name">Voicestage</span>
        {stage && <span className="brand__stage">{stage.name}</span>}
        {!connected && stage && <span className="brand__offline">Reconnecting...</span>}
      </div>
      {stage && <ScenarioPlayer />}
      <div className="topbar__tools">
        <button
          type="button"
          className="icon-button"
          aria-label="Start over: forget every conversation"
          title="Start over: forget every conversation"
          onClick={() => {
            voice.cancel();
            void api.resetAll().catch(fail);
          }}
        >
          <ResetIcon />
        </button>
        <label className="check" title="In a played scenario, also speak the people's lines aloud.">
          <input type="checkbox" checked={settings.voicePeople} onChange={(event) => updateSettings({ voicePeople: event.target.checked })} />
          Speak people&rsquo;s lines
        </label>
        <VoiceMenu />
        <button type="button" className={`icon-button${settings.voice ? ' is-on' : ''}`} aria-pressed={settings.voice} aria-label={settings.voice ? 'Sound is on. Switch to captions only' : 'Captions only. Switch sound on'} title={settings.voice ? 'Sound on' : 'Captions only'} onClick={() => updateSettings({ voice: !settings.voice })}>
          {settings.voice ? <SpeakerIcon /> : <MuteIcon />}
        </button>
        <button type="button" className={`icon-button${settings.inspector ? ' is-on' : ''}`} aria-pressed={settings.inspector} aria-label={settings.inspector ? 'Hide the inspector' : 'Show the inspector'} title="Inspector (press I)" onClick={() => updateSettings({ inspector: !settings.inspector })}>
          <PanelIcon />
        </button>
      </div>
    </header>
  );
}
