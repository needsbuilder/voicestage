import { useEffect, type CSSProperties } from 'react';
import { DeviceView } from './components/DeviceView';
import { Inspector } from './components/Inspector';
import { TopBar } from './components/TopBar';
import { describeMicProblem } from '../../src/shared/voices';
import { connect, dismissMicProblem, getState, showToast, updateSettings, useStage } from './store';
import { recognitionAvailable, type SoundState } from './voice';

const SOUND_NOTES: Partial<Record<SoundState, string>> = {
  'needs-click': 'Sound is waiting for you. Browsers only speak after a click or a key press on the page: click anywhere, and the next line will be heard. Until then lines are shown as captions.',
  'no-voices': 'This browser has no speech voices installed, so nothing can be spoken. Lines are shown as captions, at the pace they would be spoken.',
  unsupported: 'This browser has no speech synthesis, so nothing can be spoken. Lines are shown as captions, at the pace they would be spoken.',
};

/** Plain words for the two things that silently go wrong with voice in a browser: no sound, and no microphone. */
function Notices() {
  const sound = useStage((state) => state.sound);
  const mic = useStage((state) => state.mic);
  const supported = recognitionAvailable;
  const soundNote = SOUND_NOTES[sound];
  if (!soundNote && !mic && supported) return null;
  return (
    <div className="notices" role="status">
      {soundNote && (
        <p className="notice-line notice-line--sound">
          <strong>Sound</strong>
          <span>{soundNote}</span>
        </p>
      )}
      {(mic || !supported) && (
        <p className="notice-line notice-line--mic">
          <strong>Microphone</strong>
          <span>{mic ? mic.message : describeMicProblem('unsupported').message}</span>
          {mic && (
            <button type="button" className="link" onClick={dismissMicProblem}>
              Dismiss
            </button>
          )}
        </p>
      )}
    </div>
  );
}

export function App() {
  const stage = useStage((state) => state.stage);
  const everConnected = useStage((state) => state.everConnected);
  const inspector = useStage((state) => state.settings.inspector);
  const toast = useStage((state) => state.toast);

  useEffect(() => {
    connect();
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'i' || event.key === 'I') updateSettings({ inspector: !getState().settings.inspector });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  useEffect(() => {
    document.title = stage ? `${stage.name} · Voicestage` : 'Voicestage';
  }, [stage?.name]);

  return (
    <div className={`app${inspector ? ' app--inspecting' : ''}`}>
      <TopBar />
      <Notices />
      <main className="stage" data-devices={stage?.devices.length ?? 0}>
        {!stage ? (
          <p className="stage__wait" role="status">
            {everConnected ? 'Setting the stage...' : 'Connecting to the stage server...'}
          </p>
        ) : (
          <div
            className="stage__devices"
            style={
              {
                '--displays': stage.devices.filter((device) => device.kind === 'display').length,
                '--phones': stage.devices.filter((device) => device.kind === 'phone').length,
                '--speakers': stage.devices.filter((device) => device.kind === 'speaker').length,
              } as CSSProperties
            }
          >
            {stage.devices.map((device) => (
              <DeviceView key={device.id} device={device} />
            ))}
          </div>
        )}
        <p className="stage__legal">Unofficial simulator. Not affiliated with Amazon.</p>
      </main>
      {inspector && <Inspector />}
      {toast && (
        <div className="toast" role="alert">
          <span>{toast}</span>
          <button type="button" aria-label="Dismiss" onClick={() => showToast(null)}>
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
