/**
 * Another spelling for the voice, while a scenario is recorded.
 *
 * A synthetic voice reads some things wrong: a dollar amount with the word
 * "dollar" first, a phone number as three large numbers, a code as a word.
 * `recording.pronounce` in the configuration maps what is written to what the
 * voice should be given. Captions and the timeline keep the text as written;
 * only the text sent to the voice changes.
 *
 * Two kinds of entry:
 *
 *   IRS: I R S                         a word or phrase, matched whole and with
 *                                      its capitals as written
 *   /\$([\d,]+)/: "$1 dollars"         a regular expression between slashes; the
 *                                      replacement may use $1, $2, $&
 *
 * Plain entries are applied first, in one pass, the longest first, so
 * "Con Edison" wins over "Con" and a replacement is never replaced again.
 * Expressions are applied after them, one after another, in the order written.
 */

export class PronounceError extends Error {}

export interface PronounceRules {
  /** One expression for all the plain entries, and what each stands for. */
  plain?: { pattern: RegExp; spellings: Map<string, string> };
  expressions: Array<{ pattern: RegExp; replacement: string }>;
}

const EXPRESSION = /^\/(.+)\/([a-z]*)$/s;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Turn the map from the configuration into rules. Throws `PronounceError` for an expression that does not compile. */
export function compilePronunciations(map: Record<string, string> | undefined): PronounceRules {
  const spellings = new Map<string, string>();
  const expressions: PronounceRules['expressions'] = [];
  for (const [key, value] of Object.entries(map ?? {})) {
    const expression = EXPRESSION.exec(key);
    if (!expression) {
      spellings.set(key, value);
      continue;
    }
    const flags = [...new Set(`${expression[2]!}g`)].join('');
    try {
      expressions.push({ pattern: new RegExp(expression[1]!, flags), replacement: value });
    } catch (error) {
      throw new PronounceError(`The pronounce entry ${key} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (spellings.size === 0) return { expressions };
  const words = [...spellings.keys()].sort((a, b) => b.length - a.length).map(escape);
  // A whole word: no letter or digit right before it or right after it.
  return { plain: { pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'gu'), spellings }, expressions };
}

/** The text to give the voice for a sentence. */
export function respell(text: string, rules: PronounceRules | undefined): string {
  if (!rules) return text;
  let spoken = rules.plain ? text.replace(rules.plain.pattern, (found) => rules.plain!.spellings.get(found) ?? found) : text;
  for (const { pattern, replacement } of rules.expressions) spoken = spoken.replace(pattern, replacement);
  return spoken;
}
