/**
 * One device on the stage: its body (a smart display, a phone or a speaker),
 * what is on its screen, the captions, and the dock where you talk to it.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { CardResource, DeviceSnapshot, ScreenContent } from '../../../src/shared/types';
import { api } from '../api';
import { recording } from '../recording';
import { describeMicProblem } from '../../../src/shared/voices';
import { answerLink, say, showToast, startListening, stopListening, stopWake, useStage, type Caption } from '../store';
import { recognitionAvailable } from '../voice';
import { AppCard } from './AppCard';
import { DefaultCardView } from './DefaultCardView';
import { BellIcon, MicIcon, ResetIcon, SendIcon, WakeIcon } from './icons';
import { QuestionForm } from './QuestionForm';

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function greeting(date: Date): string {
  const hour = date.getHours();
  return hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

type Activity = 'idle' | 'listening' | 'thinking' | 'speaking' | 'asking' | 'notifying';

function activityOf(device: DeviceSnapshot, caption: Caption | undefined, listening: boolean): Activity {
  if (listening) return 'listening';
  if (device.elicitation) return 'asking';
  if (caption?.assistant?.speaking) return 'speaking';
  if (device.status === 'thinking') return 'thinking';
  if (device.notification?.state === 'pending') return 'notifying';
  return 'idle';
}

const ACTIVITY_LABEL: Record<Activity, string> = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Working',
  speaking: 'Speaking',
  asking: 'Waiting for your answer',
  notifying: 'Notification',
};

function Ambient({ device }: { device: DeviceSnapshot }) {
  const now = useClock();
  // The device speaks one language; its clock uses the same one, whatever the browser is set to.
  const locale = device.voice.lang ?? 'en-US';
  const disconnected = device.servers.filter((server) => server.status === 'error' || server.status === 'closed');
  return (
    <div className="ambient">
      <p className="ambient__time">{now.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}</p>
      <p className="ambient__date">{now.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <p className="ambient__hello">
        {greeting(now)}, {device.person.name}.
      </p>
      {disconnected.length > 0 ? (
        <p className="ambient__problem" role="status">
          Not connected to {disconnected.map((server) => server.id).join(', ')}. {disconnected[0]!.error}
        </p>
      ) : (
        device.hints.length > 0 && (
          <div className="ambient__hints">
            <p>Try saying</p>
            <ul>
              {device.hints.slice(0, 2).map((hint) => (
                <li key={hint}>
                  <button type="button" onClick={() => say(device.id, hint, 'typed')} title="Say this">
                    &ldquo;{hint}&rdquo;
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      )}
    </div>
  );
}

function ScreenBody({ device }: { device: DeviceSnapshot }) {
  const screen = device.screen;
  // An MCP Apps card says for itself when it has been drawn; the default card is drawn at once.
  useEffect(() => {
    if (screen && !screen.card) recording?.cardShown(device.id, 'default', screen.tool.name);
  }, [device.id, screen?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (device.elicitation) return <QuestionForm key={device.elicitation.id} deviceId={device.id} question={device.elicitation} />;
  if (!screen) return <Ambient device={device} />;
  const serverTitle = device.servers.find((server) => server.id === screen.server)?.serverInfo?.title ?? screen.server;
  return (
    <div className="content" key={screen.id}>
      <p className="content__source">
        <span>{serverTitle}</span>
        {screen.tool.title ?? screen.tool.name}
      </p>
      {screen.card ? <AppCard deviceId={device.id} kind={device.kind} screen={screen as ScreenContent & { card: CardResource }} /> : <DefaultCardView screen={screen} />}
    </div>
  );
}

function Captions({ device, caption }: { device: DeviceSnapshot; caption: Caption | undefined }) {
  const user = caption?.user;
  const assistant = caption?.assistant;
  return (
    <div className={`captions${assistant?.speaking || user?.state === 'listening' || user?.state === 'typing' ? ' captions--live' : ''}`} aria-live="polite">
      {user && user.state === 'missed' && <p className="captions__user captions__user--missed">{user.text}</p>}
      {user && user.state !== 'missed' && (
        <p className={`captions__user captions__user--${user.state}`}>
          <span className="captions__who">{device.person.name}</span>
          {user.text || (user.state === 'listening' ? 'Listening...' : user.state === 'opening' ? 'Opening the microphone...' : '')}
        </p>
      )}
      {assistant && <p className={`captions__assistant${assistant.speaking ? ' is-speaking' : ''}`}>{assistant.text}</p>}
      {!user && !assistant && <p className="captions__idle">Captions appear here.</p>}
    </div>
  );
}

function StatusLayer({ device }: { device: DeviceSnapshot }) {
  const notification = device.notification;
  const progress = device.progress;
  return (
    <>
      {progress && (
        <div className="progress" role="status">
          <span className="progress__bar" style={{ width: `${Math.max(4, Math.min(100, progress.total ? (progress.progress / progress.total) * 100 : 40))}%` }} />
          <span className="progress__text">{progress.message ?? `${progress.tool}...`}</span>
        </div>
      )}
      {notification && notification.state !== 'done' && (
        <button
          type="button"
          className={`notice notice--${notification.state}`}
          onClick={() => void api.notification(device.id, 'play')}
          aria-label={`Notification: ${notification.text}`}
          title={notification.state === 'pending' ? 'Play this notification' : undefined}
        >
          <BellIcon />
          <span>{notification.state === 'pending' ? 'New notification' : notification.text}</span>
        </button>
      )}
    </>
  );
}

/** A card on this device wants to open a link: the device asks, and opens it only on a yes. */
function LinkPrompt({ device }: { device: DeviceSnapshot }) {
  const link = useStage((state) => state.link);
  const open = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (link?.deviceId === device.id) open.current?.focus({ preventScroll: true });
  }, [link?.id, link?.deviceId, device.id]);
  if (!link || link.deviceId !== device.id) return null;
  let host = link.url;
  try {
    host = new URL(link.url).host;
  } catch {
    // Shown as it came.
  }
  const from = device.servers.find((server) => server.id === link.server)?.serverInfo?.title ?? link.server;
  return (
    <div className="link-prompt" role="alertdialog" aria-labelledby={`link-${link.id}-title`} aria-describedby={`link-${link.id}-url`} onKeyDown={(event) => event.key === 'Escape' && answerLink(false)}>
      <div className="link-prompt__sheet">
        <p className="link-prompt__title" id={`link-${link.id}-title`}>
          Open {host}?
        </p>
        <p className="link-prompt__from">The {from} card wants to open a web page in a new tab.</p>
        <p className="link-prompt__url" id={`link-${link.id}-url`}>
          {link.url}
        </p>
        <div className="link-prompt__actions">
          <button
            type="button"
            className="link-prompt__open"
            ref={open}
            onClick={() => {
              // Opened here, in the click itself, so the browser sees it as the person's doing.
              window.open(link.url, '_blank', 'noopener,noreferrer');
              answerLink(true);
            }}
          >
            Open
          </button>
          <button type="button" className="link-prompt__no" onClick={() => answerLink(false)}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

function Dock({ device, listening }: { device: DeviceSnapshot; listening: 'talk' | 'wake' | null }) {
  const [text, setText] = useState('');
  const mic = useStage((state) => state.mic);
  const micTitle = !recognitionAvailable ? describeMicProblem('unsupported').message : mic ? `${mic.message} Click to try the microphone again.` : 'Hold to talk, or tap to start and tap again to stop';
  const holding = useRef(false);
  const pressedAt = useRef(0);
  const connection = device.servers[0];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    say(device.id, text, 'typed');
    setText('');
  };
  // Hold to talk; a quick tap toggles instead, which also works from the keyboard.
  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !recognitionAvailable) return;
    if (listening === 'talk') {
      stopListening(true);
      return;
    }
    holding.current = true;
    pressedAt.current = Date.now();
    startListening(device.id, 'talk');
  };
  const up = () => {
    if (!holding.current) return;
    holding.current = false;
    if (Date.now() - pressedAt.current > 450) stopListening(true);
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!recognitionAvailable) return showToast(describeMicProblem('unsupported').message);
    if (listening === 'talk') stopListening(true);
    else startListening(device.id, 'talk');
  };

  return (
    <div className="dock">
      <div className="dock__who">
        <span className="avatar" aria-hidden="true">
          {initials(device.person.name)}
        </span>
        <div>
          <p className="dock__name">{device.person.name}</p>
          <p className="dock__device">
            {device.name}
            {connection && (
              <span className={`dot dot--${connection.status}`} title={connection.status === 'connected' ? `Connected to ${connection.id}, MCP ${connection.protocolVersion}` : `${connection.id}: ${connection.error ?? connection.status}`} />
            )}
          </p>
        </div>
      </div>
      <form className="dock__talk" onSubmit={submit}>
        <button
          type="button"
          className={`mic${listening === 'talk' ? ' is-on' : ''}${mic || !recognitionAvailable ? ' has-problem' : ''}`}
          aria-pressed={listening === 'talk'}
          aria-label={listening === 'talk' ? `Stop listening for ${device.person.name}` : `Talk as ${device.person.name}`}
          title={micTitle}
          disabled={!recognitionAvailable}
          onPointerDown={down}
          onPointerUp={up}
          onPointerLeave={up}
          onKeyDown={key}
        >
          <MicIcon />
        </button>
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={device.elicitation ? `Answer as ${device.person.name}...` : `Type what ${device.person.name} says...`}
          aria-label={`What ${device.person.name} says to ${device.name}`}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="send" aria-label="Send" disabled={!text.trim()}>
          <SendIcon />
        </button>
        <button
          type="button"
          className={`ghost${listening === 'wake' ? ' is-on' : ''}`}
          aria-pressed={listening === 'wake'}
          aria-label={listening === 'wake' ? 'Stop listening for the wake word' : `Listen for the wake word "${device.wakeWord}"`}
          title={recognitionAvailable ? `Wake word: say "${device.wakeWord}, ..." hands-free` : describeMicProblem('unsupported').message}
          disabled={!recognitionAvailable}
          onClick={() => (listening === 'wake' ? stopWake() : startListening(device.id, 'wake'))}
        >
          <WakeIcon />
        </button>
        <button type="button" className="ghost" aria-label={`Reset ${device.name}`} title="Forget this conversation" onClick={() => void api.resetDevice(device.id).catch((error: unknown) => showToast(String(error)))}>
          <ResetIcon />
        </button>
      </form>
    </div>
  );
}

/**
 * Cards are laid out as if the display were 900 px wide and the phone 400 px,
 * then scaled to the real screen. Type on a large display is large, and a card
 * that fits one size of screen fits them all.
 */
function useCardZoom(kind: DeviceSnapshot['kind']) {
  const screen = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    const designWidth = kind === 'phone' ? 400 : 900;
    const apply = () => element.style.setProperty('--zoom', String(Math.max(0.7, Math.min(1.6, Math.round((element.clientWidth / designWidth) * 100) / 100))));
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, [kind]);
  return screen;
}

export function DeviceView({ device }: { device: DeviceSnapshot }) {
  const screenRef = useCardZoom(device.kind);
  const caption = useStage((state) => state.captions[device.id]);
  const listeningState = useStage((state) => state.listening);
  const listening = listeningState?.deviceId === device.id ? listeningState.mode : null;
  const activity = activityOf(device, caption, listening === 'talk' || (listening === 'wake' && caption?.user?.state === 'listening'));

  return (
    <section className={`device device--${device.kind} is-${activity}`} data-device={device.id} aria-label={`${device.name}, used by ${device.person.name}`}>
      <div className="device__body">
        {device.kind === 'speaker' ? (
          <div className="speaker">
            <div className="speaker__shell" aria-hidden="true">
              <span className="speaker__ring" />
              <span className="speaker__top" />
            </div>
            <div className="speaker__side">
              <StatusLayer device={device} />
              <Captions device={device} caption={caption} />
              {device.elicitation && <QuestionForm key={device.elicitation.id} deviceId={device.id} question={device.elicitation} />}
            </div>
          </div>
        ) : (
          <div className={`frame frame--${device.kind}`}>
            <div className="screen" ref={screenRef}>
              {device.kind === 'phone' && <span className="screen__island" aria-hidden="true" />}
              <StatusLayer device={device} />
              <div className="screen__main">
                <ScreenBody device={device} />
              </div>
              <LinkPrompt device={device} />
              <Captions device={device} caption={caption} />
              <span className="lightbar" role="status" aria-label={ACTIVITY_LABEL[activity]} />
            </div>
            {device.kind === 'display' && <div className="frame__base" aria-hidden="true" />}
          </div>
        )}
      </div>
      <Dock device={device} listening={listening} />
    </section>
  );
}
