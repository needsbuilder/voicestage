/**
 * The command line of a program that renders one sentence of a recording to a
 * WAV file (`recording.voices.command` in the configuration).
 *
 * The command is a list of arguments, or one string that is cut into
 * arguments at spaces (quotes keep words together). No shell is involved, so
 * a sentence with quotes, a dollar sign or a semicolon in it is passed as it
 * is. These names in braces are filled in for each sentence:
 *
 *   {text}        the sentence
 *   {text_file}   a UTF-8 file that holds the sentence
 *   {voice}       the voice name from the configuration
 *   {rate}        the speaking rate, 1 for the voice's normal pace
 *   {lang}        the language from the configuration, or nothing
 *   {out}         where the program must leave the WAV file
 */

export const VOICE_PLACEHOLDERS = ['text', 'text_file', 'voice', 'rate', 'lang', 'out'] as const;
export type VoicePlaceholder = (typeof VOICE_PLACEHOLDERS)[number];

const PLACEHOLDER = new RegExp(`\\{(${VOICE_PLACEHOLDERS.join('|')})\\}`, 'g');

/** Cut a command written as one string into its arguments. Single and double quotes keep spaces inside an argument. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | undefined;
  let open = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      open = true;
    } else if (/\s/.test(char)) {
      if (open || current) args.push(current);
      current = '';
      open = false;
    } else {
      current += char;
    }
  }
  if (quote) throw new Error(`The command has a ${quote} that is never closed: ${command}`);
  if (open || current) args.push(current);
  return args;
}

/** Which placeholders a command uses. */
export function placeholdersIn(command: readonly string[]): Set<VoicePlaceholder> {
  const used = new Set<VoicePlaceholder>();
  for (const arg of command) for (const match of arg.matchAll(PLACEHOLDER)) used.add(match[1] as VoicePlaceholder);
  return used;
}

/** What is wrong with a command as a voice renderer, in plain words, or `undefined` when it will do. */
export function commandProblem(command: readonly string[]): string | undefined {
  if (command.length === 0 || !command[0]) return 'it is empty';
  const used = placeholdersIn(command);
  if (!used.has('out')) return 'it has no {out}, so the program is never told where to write the audio';
  if (!used.has('text') && !used.has('text_file')) return 'it has neither {text} nor {text_file}, so the program is never told what to say';
  return undefined;
}

/** The arguments for one sentence. Each placeholder is filled in inside its argument, so a sentence stays one argument. */
export function fillCommand(command: readonly string[], values: Record<VoicePlaceholder, string>): string[] {
  return command.map((arg) => arg.replace(PLACEHOLDER, (_match, name: VoicePlaceholder) => values[name]));
}
