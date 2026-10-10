/**
 * The default card: what a device screen shows for a tool result that has no
 * MCP Apps card of its own.
 *
 * `buildDefaultCard` is a pure function from a tool result to a small view
 * model. It prefers `structuredContent` and falls back to the text content.
 * Nothing here is specific to any one server; it reads common field names
 * (`title`, `message`, `status`, `amount_usd`, lists of things with a `name`).
 */
import type { ToolResult } from './types.js';

export type CardTone = 'neutral' | 'good' | 'caution' | 'stop';

export interface CardFact {
  label: string;
  value: string;
}

export interface CardListItem {
  primary: string;
  secondary?: string;
}

export interface CardSection {
  title: string;
  facts?: CardFact[];
  items?: CardListItem[];
  /** Number of further entries that were left out to keep the card short. */
  more?: number;
}

export interface DefaultCard {
  tone: CardTone;
  eyebrow: string;
  title: string;
  body?: string;
  badges: Array<{ label: string; tone: CardTone }>;
  facts: CardFact[];
  sections: CardSection[];
  /** True when there was nothing structured to show and the card is just text. */
  textOnly: boolean;
}

export interface DefaultCardInput {
  toolName: string;
  toolTitle?: string;
  result: ToolResult;
  locale?: string;
  timeZone?: string;
}

const TITLE_KEYS = ['title', 'headline', 'name', 'label', 'subject'];
const BODY_KEYS = ['say_to_user', 'message', 'summary', 'description', 'text', 'answer', 'note', 'detail', 'details'];
const STATUS_KEYS = ['status', 'state', 'verdict', 'outcome', 'result', 'decision'];
const MAX_FACTS = 8;
const MAX_ITEMS = 6;
const MAX_SECTIONS = 3;

const GOOD = /^(ok|okay|success|succeeded|successful|done|complete|completed|approved|verified|confirmed|paid|ready|active|on|open|delivered|passed|running|started|sent)$/i;
const CAUTION = /^(pending|waiting|hold|on_hold|held|unknown|warning|warn|review|needs_review|queued|scheduled|paused|partial|expired|cancelled|canceled|not_in_registry)$/i;
const STOP = /^(stop|stopped|denied|declined|rejected|error|failed|failure|blocked|mismatch|invalid|refused|unauthorized|forbidden|off)$/i;

export function toneOf(value: unknown): CardTone {
  const text = String(value ?? '').trim().replace(/[\s-]+/g, '_');
  if (GOOD.test(text)) return 'good';
  if (STOP.test(text)) return 'stop';
  if (CAUTION.test(text) || /^pending_/i.test(text)) return 'caution';
  return 'neutral';
}

export function humanizeKey(key: string): string {
  const words = key
    .replace(/_(usd|id|at|iso|utc)$/i, (match, suffix: string) => (suffix.toLowerCase() === 'id' ? ' ID' : ''))
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  const text = words || key;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function humanizeValue(text: string): string {
  // "pending_family" reads better as "Pending family"; leave real sentences and ids alone.
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(text) || /^[a-z]+$/.test(text)) {
    const spaced = text.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }
  return text;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function formatValue(key: string, value: unknown, options: { locale?: string; timeZone?: string } = {}): string | undefined {
  const locale = options.locale ?? 'en-US';
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (/(_usd|_dollars|^amount$|^price$|^total$|^cost$|^balance$)/i.test(key)) {
      const cents = Math.round(value * 100) % 100 !== 0;
      return value.toLocaleString(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
    }
    if (/(_seconds|_secs|^seconds$)$/i.test(key)) return formatDuration(value);
    if (/(_minutes|_mins|^minutes$)$/i.test(key)) return formatDuration(value * 60);
    if (/(_percent|_pct)$/i.test(key)) return `${value}%`;
    return value.toLocaleString(locale, { maximumFractionDigits: 2 });
  }
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return value.length <= 10
          ? date.toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' })
          : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: options.timeZone });
      }
    }
    return humanizeValue(value);
  }
  if (Array.isArray(value)) {
    const parts = value.filter((item) => item === null || typeof item !== 'object').map((item) => formatValue(key, item, options));
    return parts.length === value.length && parts.length > 0 ? parts.filter(Boolean).join(', ') : undefined;
  }
  return undefined;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} sec`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} hr` : `${hours} hr ${restMinutes} min`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(data: Record<string, unknown>, keys: string[], used: Set<string>): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() && !used.has(key)) {
      used.add(key);
      return value.trim();
    }
  }
  return undefined;
}

function factsOf(data: Record<string, unknown>, used: Set<string>, options: { locale?: string; timeZone?: string }, limit: number): CardFact[] {
  const facts: CardFact[] = [];
  const late: CardFact[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (used.has(key) || key.startsWith('_')) continue;
    if (isPlainObject(value)) continue;
    if (Array.isArray(value) && value.some((item) => typeof item === 'object' && item !== null)) continue;
    const text = formatValue(key, value, options);
    if (text === undefined) continue;
    // Long free text belongs in the body, not in a two-column list.
    if (text.length > 140) continue;
    const fact = { label: humanizeKey(key), value: text };
    // Identifiers and machine fields go last: a person reads the meaningful facts first.
    if (/(^id$|_id$|Id$|^next_step$|^simulated$)/.test(key)) late.push(fact);
    else facts.push(fact);
  }
  return [...facts, ...late].slice(0, limit);
}

function itemOf(value: unknown, options: { locale?: string; timeZone?: string }): CardListItem | undefined {
  if (!isPlainObject(value)) {
    const text = formatValue('', value, options);
    return text ? { primary: text } : undefined;
  }
  const used = new Set<string>();
  const primary = pickString(value, [...TITLE_KEYS, 'payee_name', 'summary', 'text', 'step', 'id'], used) ?? Object.values(value).find((item): item is string => typeof item === 'string');
  if (!primary) return undefined;
  const secondary = factsOf(value, used, options, 3)
    .filter((fact) => fact.value !== primary)
    .map((fact) => (/^(status|state|amount|quantity)$/i.test(fact.label) ? fact.value : `${fact.label}: ${fact.value}`))
    .join(' · ');
  return { primary, secondary: secondary || undefined };
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();
}

function titleFromTool(input: DefaultCardInput): string {
  return input.toolTitle?.trim() || humanizeKey(input.toolName.replace(/^[a-z0-9]+__/i, ''));
}

export function buildDefaultCard(input: DefaultCardInput): DefaultCard {
  const { result } = input;
  const options = { locale: input.locale, timeZone: input.timeZone };
  const eyebrow = titleFromTool(input);
  const text = textOf(result);

  if (result.isError) {
    const coded = /^Error \(([a-z0-9_]+)\):\s*([\s\S]*)$/i.exec(text);
    return {
      tone: 'stop',
      eyebrow,
      title: "That didn't work",
      body: (coded ? coded[2] : text) || 'The tool reported an error without a message.',
      badges: coded ? [{ label: humanizeValue(coded[1]!), tone: 'stop' }] : [],
      facts: [],
      sections: [],
      textOnly: true,
    };
  }

  const structured = result.structuredContent;
  if (!isPlainObject(structured) || Object.keys(structured).length === 0) {
    const [first = '', ...rest] = text.split(/\n\s*\n/);
    const short = first.length > 0 && first.length <= 90 && rest.length > 0;
    return {
      tone: 'neutral',
      eyebrow,
      title: short ? first : eyebrow,
      body: (short ? rest.join('\n\n') : text) || 'Done.',
      badges: [],
      facts: [],
      sections: [],
      textOnly: true,
    };
  }

  // A result that wraps everything in one object (`{ circle: {...} }`) is shown as that object.
  let data = structured;
  let wrapperTitle: string | undefined;
  const keys = Object.keys(structured);
  if (keys.length === 1 && isPlainObject(structured[keys[0]!])) {
    wrapperTitle = humanizeKey(keys[0]!);
    data = structured[keys[0]!] as Record<string, unknown>;
  }

  const used = new Set<string>();
  const body = pickString(data, BODY_KEYS, used);
  const title = pickString(data, TITLE_KEYS, used) ?? wrapperTitle ?? eyebrow;

  const badges: DefaultCard['badges'] = [];
  for (const key of STATUS_KEYS) {
    const value = data[key];
    if ((typeof value === 'string' && value.length <= 32) || typeof value === 'boolean') {
      used.add(key);
      badges.push({ label: typeof value === 'boolean' ? `${humanizeKey(key)}: ${value ? 'yes' : 'no'}` : humanizeValue(value), tone: toneOf(value) });
    }
  }
  if (data.simulated === true) badges.push({ label: 'Simulated', tone: 'neutral' });

  const facts = factsOf(data, used, options, MAX_FACTS);

  const sections: CardSection[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (sections.length >= MAX_SECTIONS) break;
    if (used.has(key) || key.startsWith('_')) continue;
    if (Array.isArray(value) && value.length > 0 && value.some((item) => typeof item === 'object' && item !== null)) {
      const items = value.map((item) => itemOf(item, options)).filter((item): item is CardListItem => Boolean(item));
      if (items.length > 0) sections.push({ title: humanizeKey(key), items: items.slice(0, MAX_ITEMS), more: Math.max(0, items.length - MAX_ITEMS) || undefined });
    } else if (Array.isArray(value) && value.length > MAX_ITEMS / 2 && value.every((item) => typeof item === 'string')) {
      // A longer list of strings (steps, ingredients) reads better as a list than as one comma-separated fact.
      const index = facts.findIndex((fact) => fact.label === humanizeKey(key));
      if (index >= 0) facts.splice(index, 1);
      sections.push({ title: humanizeKey(key), items: value.slice(0, MAX_ITEMS).map((item) => ({ primary: String(item) })), more: Math.max(0, value.length - MAX_ITEMS) || undefined });
    } else if (isPlainObject(value)) {
      const nested = factsOf(value, new Set(), options, 5);
      if (nested.length > 0) sections.push({ title: humanizeKey(key), facts: nested });
    }
  }

  const tone = badges.map((badge) => badge.tone).find((badgeTone) => badgeTone !== 'neutral') ?? 'neutral';
  return {
    tone,
    eyebrow,
    title,
    body: body ?? (facts.length === 0 && sections.length === 0 ? text || undefined : undefined),
    badges,
    facts,
    sections,
    textOnly: false,
  };
}
