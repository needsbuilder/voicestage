/**
 * Choosing and creating a model provider.
 *
 *   scripted           no model; replays scenario scripts (the default)
 *   anthropic          Claude through the Anthropic API            ANTHROPIC_API_KEY
 *   bedrock            Amazon Bedrock Converse API with tool use   AWS credentials + region + model
 *   openai-compatible  any Chat Completions server with tools      base URL + model (+ key)
 *   claude-code        Claude through a local Claude Code login    no key
 *
 * The provider is picked from, in order: an explicit override (the CLI's
 * `--provider`), the `VOICESTAGE_PROVIDER` environment variable, the device's
 * `assistant.provider`, the top-level `assistant.provider`, then `scripted`.
 */
import { selectProviderId, type AssistantConfig, type ProviderId } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { BedrockProvider } from './bedrock.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { ScriptedProvider, type ScriptedLine } from './scripted.js';
import { ProviderNotConfiguredError, type Provider } from './types.js';

export { ProviderNotConfiguredError, type Provider } from './types.js';
export { ScriptedProvider, type ScriptedLine } from './scripted.js';

export interface CreateProviderOptions {
  assistant: AssistantConfig;
  env?: NodeJS.ProcessEnv;
  /** Wins over the environment and the configuration. */
  override?: string;
  /** Lines the scripted provider can match free speech against. */
  scriptedLines?: () => ScriptedLine[];
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  scripted: 'Scripted (no model)',
  anthropic: 'Anthropic API',
  bedrock: 'Amazon Bedrock (Converse)',
  'openai-compatible': 'OpenAI-compatible',
  'claude-code': 'Claude Code (local login)',
};

/** Create the provider a device should use. Throws `ProviderNotConfiguredError` with instructions when it cannot work. */
export function createProvider(options: CreateProviderOptions): Provider {
  const env = options.env ?? process.env;
  const id = selectProviderId(options.assistant, env, options.override);
  const input = { assistant: options.assistant, env };
  switch (id) {
    case 'scripted':
      return new ScriptedProvider(options.scriptedLines);
    case 'anthropic':
      return new AnthropicProvider(input);
    case 'bedrock':
      return new BedrockProvider(input);
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(input);
    case 'claude-code':
      return new ClaudeCodeProvider(input);
    default:
      throw new ProviderNotConfiguredError(id, `Unknown provider "${String(id)}".`);
  }
}
