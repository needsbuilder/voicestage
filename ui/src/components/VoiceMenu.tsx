/**
 * The voice menu: which speech synthesis voice each device's assistant uses,
 * and which voice each person's lines are read with when a scenario is played.
 *
 * Voices come from the browser, which gets them from the operating system, so
 * the list differs from machine to machine. "Automatic" picks a clear voice
 * that runs on the device and gives every device a different one; anything
 * chosen here is remembered in this browser and wins over the configuration.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceSnapshot } from '../../../src/shared/types';
import { isNoveltyVoice, rankVoices, type VoiceInfo } from '../../../src/shared/voices';
import { chooseDeviceVoice, previewVoice, useStage, voicePrefs } from '../store';
import { voice } from '../voice';
import { PlayIcon, VoiceIcon } from './icons';

function label(info: VoiceInfo): string {
  return `${info.name} · ${info.lang}${info.localService ? '' : ' · needs network'}`;
}

function VoiceSelect({ device, role, voices, slots, slot }: { device: DeviceSnapshot; role: 'assistant' | 'person'; voices: VoiceInfo[]; slot: number; slots: number }) {
  const chosen = useStage((state) => state.settings.voiceChoice[device.id]?.[role]) ?? '';
  const lang = device.voice.lang ?? 'en-US';
  const configured = role === 'assistant' ? device.voice.name : device.person.voice?.name;
  const prefs = voicePrefs(device, role);
  // What "Automatic" means right now: the configured voice if it exists here, else the chooser's pick.
  const automatic = voice.voiceFor({ role, slot, slots, prefs: { ...prefs, name: configured } });
  const { clear, others } = useMemo(() => {
    const ranked = rankVoices(voices, lang, role);
    const names = new Set(ranked.map((info) => info.name));
    return { clear: ranked, others: voices.filter((info) => info.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()) && !names.has(info.name) && isNoveltyVoice(info.name)) };
  }, [voices, lang, role]);
  const id = `voice-${device.id}-${role}`;
  return (
    <div className="voice-row">
      <label htmlFor={id}>{role === 'assistant' ? device.name : `${device.person.name}, when a scenario speaks their lines`}</label>
      <div className="voice-row__pick">
        <select id={id} value={chosen} onChange={(event) => chooseDeviceVoice(device.id, role, event.target.value)}>
          <option value="">Automatic{automatic ? ` (${automatic.name})` : ''}</option>
          <optgroup label="Clear voices">
            {clear.map((info) => (
              <option key={`${info.name}|${info.lang}`} value={info.name}>
                {label(info)}
              </option>
            ))}
          </optgroup>
          {others.length > 0 && (
            <optgroup label="Novelty voices">
              {others.map((info) => (
                <option key={`${info.name}|${info.lang}`} value={info.name}>
                  {label(info)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button type="button" className="icon-button" aria-label={`Hear this voice`} title="Hear this voice" onClick={() => previewVoice(device.id, role)}>
          <PlayIcon />
        </button>
      </div>
    </div>
  );
}

export function VoiceMenu() {
  const [open, setOpen] = useState(false);
  const devices = useStage((state) => state.stage?.devices) ?? [];
  const voices = useStage((state) => state.voices);
  const sound = useStage((state) => state.sound);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div className="voice-menu" ref={panel}>
      <button type="button" className={`icon-button${open ? ' is-on' : ''}`} aria-expanded={open} aria-haspopup="dialog" aria-label="Choose voices" title="Choose voices" onClick={() => setOpen(!open)}>
        <VoiceIcon />
      </button>
      {open && (
        <div className="voice-menu__panel" role="dialog" aria-label="Voices">
          <h2>Voices</h2>
          {sound === 'unsupported' || sound === 'no-voices' ? (
            <p className="voice-menu__note">{sound === 'unsupported' ? 'This browser has no speech synthesis.' : 'This browser has no voices installed.'} Lines are shown as captions, at the pace they would be spoken.</p>
          ) : (
            <>
              <h3>Assistants</h3>
              {devices.map((device, slot) => (
                <VoiceSelect key={device.id} device={device} role="assistant" voices={voices} slot={slot} slots={devices.length} />
              ))}
              <h3>People</h3>
              {devices.map((device, slot) => (
                <VoiceSelect key={device.id} device={device} role="person" voices={voices} slot={slot} slots={devices.length} />
              ))}
              <p className="voice-menu__note">
                The list comes from your browser and operating system. Voices that run on this computer are listed first; choices are remembered in this browser. To set a voice for everyone, use <code>voice.name</code> in the configuration file.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
