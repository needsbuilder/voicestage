import { useEffect, type CSSProperties } from 'react';
import { DeviceView } from './components/DeviceView';
import { Inspector } from './components/Inspector';
import { TopBar } from './components/TopBar';
import { connect, getState, showToast, updateSettings, useStage } from './store';

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
