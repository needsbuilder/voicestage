/**
 * Turning what a person said into something a program can use:
 * matching an utterance against known lines (scripted mode) and answering an
 * MCP form elicitation by voice.
 */
import type { JsonObject } from './types.js';

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90,
};

/** Lower-case, strip punctuation, and write money and numbers the way speech recognition does not. */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, '$1 dollars')
    .replace(/(\d),(?=\d{3})/g, '$1')
    .replace(/[^a-z0-9.'\s-]/g, ' ')
    .replace(/(\d)\.(?!\d)/g, '$1 ')
    .replace(/(?<!\d)\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words that say little about what a sentence is about. Leaving them out keeps
 * "How do I make tomato soup?" from being mistaken for "How do I make pancakes?".
 */
const STOPWORDS = new Set(
  'a an the to of and or but it is in on at for with from by my me i you your we our us please um uh so just that this these those was were be been am are do does did how what when where which who can could would will shall should have has had there here then than as if not no yes okay ok its'.split(
    ' ',
  ),
);

export function utteranceTokens(text: string): string[] {
  return normalizeUtterance(text)
    .split(' ')
    .map((token) => token.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
    .filter((token) => token.length > 0);
}

function significant(tokens: string[]): string[] {
  const kept = tokens.filter((token) => !STOPWORDS.has(token));
  return kept.length > 0 ? kept : tokens;
}

/** "pancake" and "pancakes" are the same word to a listener. */
function stem(token: string): string {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}

/** Sørensen-Dice overlap of the significant words of two utterances, 0 to 1. */
export function utteranceSimilarity(a: string, b: string): number {
  const left = significant(utteranceTokens(a)).map(stem);
  const right = significant(utteranceTokens(b)).map(stem);
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of left) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of right) {
    const available = counts.get(token) ?? 0;
    if (available > 0) {
      shared += 1;
      counts.set(token, available - 1);
    }
  }
  return (2 * shared) / (left.length + right.length);
}

export interface LineMatch<T> {
  item: T;
  score: number;
}

/** The known line closest to what was said, if it is close enough. */
export function bestLineMatch<T>(said: string, lines: Array<{ text: string; item: T }>, threshold = 0.7): LineMatch<T> | undefined {
  let best: LineMatch<T> | undefined;
  const normalized = normalizeUtterance(said);
  for (const line of lines) {
    const score = normalizeUtterance(line.text) === normalized ? 1 : utteranceSimilarity(said, line.text);
    if (!best || score > best.score) best = { item: line.item, score };
  }
  return best && best.score >= threshold ? best : undefined;
}

// --- form elicitation ---------------------------------------------------------

export interface FormOption {
  value: string;
  label: string;
}

export interface FormField {
  key: string;
  title: string;
  description?: string;
  type: 'choice' | 'multi' | 'text' | 'number' | 'boolean';
  options?: FormOption[];
  required: boolean;
  defaultValue?: unknown;
  integer?: boolean;
}

function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function optionsOf(schema: JsonObject): FormOption[] | undefined {
  const titled = (schema.oneOf ?? schema.anyOf) as Array<{ const?: unknown; title?: unknown }> | undefined;
  if (Array.isArray(titled) && titled.every((option) => option && typeof option === 'object' && 'const' in option)) {
    return titled.map((option) => ({ value: String(option.const), label: typeof option.title === 'string' ? option.title : humanize(String(option.const)) }));
  }
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? (schema.enumNames as unknown[]) : [];
    return (schema.enum as unknown[]).map((value, index) => ({ value: String(value), label: typeof names[index] === 'string' ? (names[index] as string) : humanize(String(value)) }));
  }
  return undefined;
}

/** The fields of an MCP form elicitation (`requestedSchema`: a flat object of primitive properties). */
export function formFields(requestedSchema: JsonObject): FormField[] {
  const properties = (requestedSchema.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set(Array.isArray(requestedSchema.required) ? (requestedSchema.required as string[]) : []);
  return Object.entries(properties).map(([key, schema]) => {
    const base = {
      key,
      title: typeof schema.title === 'string' ? schema.title : humanize(key),
      description: typeof schema.description === 'string' ? schema.description : undefined,
      required: required.has(key),
      defaultValue: schema.default,
    };
    if (schema.type === 'array') {
      const options = optionsOf((schema.items ?? {}) as JsonObject) ?? [];
      return { ...base, type: 'multi' as const, options };
    }
    const options = optionsOf(schema);
    if (options) return { ...base, type: 'choice' as const, options };
    if (schema.type === 'boolean') return { ...base, type: 'boolean' as const };
    if (schema.type === 'number' || schema.type === 'integer') return { ...base, type: 'number' as const, integer: schema.type === 'integer' };
    return { ...base, type: 'text' as const };
  });
}

const DECLINE = /\b(never ?mind|cancel|skip( it| that)?|forget it|i'?d rather not( say)?|no answer|don'?t want to (say|answer)|stop)\b/;
const YES = /\b(yes|yeah|yep|yup|sure|correct|right|that'?s right|it (is|was|did)|i (do|did|am|was)|true|affirmative|ok|okay)\b/;
const NO = /\b(no|nope|nah|not really|it (isn'?t|wasn'?t|didn'?t)|i (don'?t|didn'?t)|false|negative)\b/;

/** "three minutes" and "3 minutes" should compare equal: write number words as digits. */
function digits(text: string): string {
  return normalizeUtterance(text)
    .split(' ')
    .map((token) => (token in NUMBER_WORDS ? String(NUMBER_WORDS[token]) : token))
    .join(' ');
}

function chooseOption(said: string, options: FormOption[]): FormOption | undefined {
  const normalized = digits(said);
  const saidTokens = new Set(normalized.split(' '));
  let best: { option: FormOption; score: number } | undefined;
  let tied = false;
  for (const option of options) {
    const candidates = [option.label, option.value.replace(/[_-]+/g, ' ')];
    let score = 0;
    for (const candidate of candidates) {
      const text = digits(candidate);
      if (!text) continue;
      if (text === normalized) score = Math.max(score, 1);
      else if (` ${normalized} `.includes(` ${text} `)) score = Math.max(score, 0.95);
      else {
        const words = significant(text.split(' '));
        // A choice with a number in it ("3 minutes") is only meant when that number was said.
        if (!words.filter((word) => /^\d/.test(word)).every((word) => saidTokens.has(word))) continue;
        const hits = words.filter((word) => saidTokens.has(word)).length;
        if (hits > 0) score = Math.max(score, 0.5 + 0.4 * (hits / words.length));
      }
    }
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { option, score };
      tied = false;
    } else if (score === best.score) tied = true;
  }
  // Two options that fit equally well ("minutes" for both "3 minutes" and "5 minutes") is not an answer.
  return best && best.score >= 0.6 && !tied ? best.option : undefined;
}

function parseNumber(said: string): number | undefined {
  const normalized = normalizeUtterance(said);
  const digits = /-?\d+(?:\.\d+)?/.exec(normalized);
  if (digits) return Number(digits[0]);
  for (const token of normalized.split(' ')) {
    if (token in NUMBER_WORDS) return NUMBER_WORDS[token];
  }
  if (/\b(half|a half)\b/.test(normalized)) return 0.5;
  return undefined;
}

export type SpokenAnswer = { action: 'accept'; content: JsonObject } | { action: 'decline' } | { action: 'unclear'; missing: FormField[] };

/** Work out the answer to a form elicitation from one spoken sentence. */
export function answerFromSpeech(fields: FormField[], said: string): SpokenAnswer {
  const normalized = normalizeUtterance(said);
  const content: JsonObject = {};
  const missing: FormField[] = [];
  for (const field of fields) {
    let value: unknown;
    if (field.type === 'choice') value = chooseOption(said, field.options ?? [])?.value;
    else if (field.type === 'multi') {
      const chosen = (field.options ?? []).filter((option) => chooseOption(said, [option]));
      value = chosen.length > 0 ? chosen.map((option) => option.value) : undefined;
    } else if (field.type === 'boolean') value = YES.test(normalized) ? true : NO.test(normalized) ? false : undefined;
    else if (field.type === 'number') {
      const number = parseNumber(said);
      value = number === undefined ? undefined : field.integer ? Math.round(number) : number;
    } else value = fields.length === 1 && said.trim() && !DECLINE.test(normalized) ? said.trim() : undefined;

    if (value !== undefined) content[field.key] = value;
    else if (field.defaultValue !== undefined) content[field.key] = field.defaultValue;
    else if (field.required) missing.push(field);
  }
  if (missing.length === 0 && Object.keys(content).length > 0) return { action: 'accept', content };
  if (DECLINE.test(normalized)) return { action: 'decline' };
  return { action: 'unclear', missing: missing.length > 0 ? missing : fields };
}

/** A sentence that asks the question aloud, with the choices when there are few enough to say. */
export function questionForSpeech(message: string, fields: FormField[]): string {
  const single = fields.length === 1 ? fields[0] : undefined;
  if (single?.type === 'choice' && single.options && single.options.length > 0 && single.options.length <= 7) {
    const labels = single.options.map((option) => option.label);
    const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
    return `${message.trim()} You can say: ${list}.`;
  }
  return message.trim();
}
