/**
 * Splitting a spoken line into sentences. Devices speak, and caption, one
 * sentence at a time; a recording renders one audio clip per sentence. Both
 * must cut a line in the same places, so the rule lives here.
 */
export function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“(])/);
  const sentences: string[] = [];
  for (const part of parts) {
    const previous = sentences.at(-1);
    // Keep very short fragments ("Done.") with their neighbour so captions do not flicker.
    if (previous !== undefined && (previous.length < 26 || part.length < 14) && previous.length + part.length < 84) sentences[sentences.length - 1] = `${previous} ${part}`;
    else sentences.push(part);
  }
  return sentences.filter(Boolean);
}
