/**
 * The system prompt for a device's assistant.
 *
 * It describes the device (so the assistant knows whether there is a screen),
 * sets the rules for spoken replies, and passes along what the connected MCP
 * servers and the loaded Agent Skills say about themselves. Nothing in it is
 * specific to one server.
 */
import type { ResolvedDevice } from './config.js';
import { skillsPrompt, type LoadedSkill } from './skills.js';

export interface PromptInput {
  device: ResolvedDevice;
  servers: Array<{ id: string; title?: string; instructions?: string }>;
  skills: LoadedSkill[];
  skillActivation: 'tool' | 'always';
  extra?: string;
}

const DEVICE_DESCRIPTIONS: Record<ResolvedDevice['kind'], string> = {
  display: 'a smart display: a speaker with a screen, usually seen from across a room',
  speaker: 'a smart speaker with no screen',
  phone: 'the companion app on a phone',
};

export function buildSystemPrompt(input: PromptInput): string {
  const { device } = input;
  const person = device.person.role ? `${device.person.name} (${device.person.role})` : device.person.name;
  const screen =
    device.kind === 'speaker'
      ? 'This device has no screen. Everything the person needs has to be said.'
      : device.kind === 'display'
        ? 'This device has a screen. The result of each tool call is shown on it as a card, so say the gist and let the screen carry the detail. The person is usually across the room: the screen is for glancing, your voice does the work.'
        : 'This is a phone. The result of each tool call is shown on its screen as a card, and the person can tap buttons on that card. Say the gist and let the screen carry the detail.';

  const parts = [
    `You are the voice assistant on "${device.name}", ${DEVICE_DESCRIPTIONS[device.kind]}. You are talking with ${person}.`,
    [
      '# How you talk',
      '- Everything you write is read aloud by a speech synthesiser. Write plain sentences. No markdown, lists, headings, emoji, or symbols that do not read well aloud.',
      '- Be brief: one to three short sentences unless the person asks for more. This is a conversation, and replies should start right away.',
      '- Ask at most one question at a time.',
      `- ${screen}`,
      '- When a tool result contains wording meant for the person (for example a field called say_to_user), use that wording.',
    ].join('\n'),
    [
      '# How you act',
      '- Act through the tools of the connected services. Call a tool rather than describing what you would do.',
      '- Never say something was done unless a tool result says so. If a tool fails, say plainly what happened and what the person can do.',
      '- Do not invent facts, names, numbers or tool results.',
      '- A tool may ask the person a question itself while it runs. That is handled by the device; just wait for the result.',
    ].join('\n'),
  ];

  const described = input.servers.filter((server) => server.instructions?.trim());
  if (described.length > 0) {
    parts.push(['# Connected services', ...described.map((server) => `## ${server.title ?? server.id}\n${server.instructions!.trim()}`)].join('\n\n'));
  }
  const skills = skillsPrompt(input.skills, input.skillActivation);
  if (skills) parts.push(skills);
  if (input.extra?.trim()) parts.push(`# Additional instructions\n${input.extra.trim()}`);
  return parts.join('\n\n');
}
