# Voicestage

**A local stage for voice-first MCP apps.** Point it at a Streamable HTTP MCP server, and optionally at Agent Skills folders, and it gives you simulated devices you can talk to: a smart display, a speaker, a phone. Each one has its own assistant, its own MCP connection, a screen that renders MCP Apps cards, captions, and a developer inspector that shows every tool call.

![A kitchen display showing a hold card, and a phone showing the family approval card](docs/screenshots/03-hold-and-approval.png)

> **Unofficial.** Voicestage is an independent open-source project. It is not affiliated with, endorsed by, or an official tool of Amazon. It does not emulate any real device or assistant exactly; it is a stand-in for an Alexa+-style voice and screen assistant, for people who are building MCP servers and Agent Skills for one and have no device or official simulator to test against.

## Why

If you are building a voice-first add-on as a self-hosted MCP server or an Agent Skill, the hard part to test is everything around the tools: what the assistant says, what goes on a screen, what happens when a server asks the person a question, how a second person on another device fits in, what the device does when something happens later. A chat window with a tool list does not show you any of that.

Voicestage does. It runs on your machine, needs no account, and works with no model at all.

## Quickstart

Requires Node.js 24 or later and a recent Chrome, Edge or Safari.

```bash
npm install
npm run dev          # http://localhost:4700
```

That starts the stage with a built-in example MCP server ("Kitchen helper": a timer and a three-recipe cookbook) on a kitchen display and a phone. Then:

- Press **Play** to run the example scenario, or
- type into the box under a device, or
- hold the microphone button and talk (browser speech recognition), or
- open the inspector's **Connections** tab and call any tool by hand.

For a production build: `npm run build && npm start`.

### Point it at your own server

```bash
npm run dev -- --mcp http://localhost:3000/mcp \
               --header "Authorization: Bearer my-token" \
               --events http://localhost:3000/events \
               --skills ./my-skills
```

`--mcp` puts a display and a phone on one Streamable HTTP MCP server. `--header`, `--events` (a server-sent events URL, for proactive announcements) and `--skills` are optional and repeatable where that makes sense. For different people on different devices, different tokens, or announcement rules, write a [configuration file](#configuration).

With no model configured, use the inspector to call tools and see their cards. To talk freely, choose a [model provider](#model-providers), or write a [scenario](#scenarios) and replay it.

## What it does

| | |
| --- | --- |
| **Devices and people** | A configuration file defines devices (smart display, speaker with no screen, phone), who uses each, and which servers and skills each loads. Every device makes its own MCP connection with its own HTTP headers, so two people with two tokens can be on stage together. |
| **Voice** | Speech in through the browser's Web Speech API (hold to talk, tap to toggle, or a wake word), speech out through speech synthesis. Everything can be typed instead, and captions are always shown. Works with no microphone and with the sound off. |
| **Assistant** | One agent loop per device, with a pluggable provider: `anthropic`, `bedrock`, `openai-compatible`, `claude-code` (a local Claude Code login, no key), or `scripted` (no model). |
| **MCP client** | The official `@modelcontextprotocol/client` v2 over Streamable HTTP. Protocol 2025-11-25 with a session by default (2026-07-28 on request). Tools, structured output, progress notifications, form elicitation, resource reads, list-changed and logging notifications. The negotiated protocol version is shown in the inspector. |
| **MCP Apps** | When a tool links a `ui://` card, the card is rendered on the device screen in a sandboxed iframe using the official host bridge (`AppBridge` from `@modelcontextprotocol/ext-apps`). Tool calls and resource reads made by the card go back through the host to the card's own server. A tool result with no card gets a clean default card drawn from its structured content. |
| **Questions from a server** | A form elicitation is asked aloud and shown on the screen. The person answers by voice or by tapping, and the answer is returned to the server. |
| **Proactive announcements** | A device can subscribe to a server-sent events URL, and to notifications on the MCP connection, and turn chosen events into an announcement: an indicator first, then the voice, optionally with a tool call whose result goes on the screen. |
| **Agent Skills** | Loads `SKILL.md` folders in the open [Agent Skills](https://agentskills.io) format. Names and descriptions are always in the prompt; the body is loaded when the assistant decides it is relevant. |
| **Inspector** | Per device: a timeline of what was heard, each model turn, every tool call with arguments, result, duration and progress, questions and answers, events, errors. Copy any entry, or the whole timeline, as JSON. A second tab shows each connection (protocol version, session, capabilities, instructions, tools) and lets you call a tool by hand. |
| **Scenarios** | YAML files of steps across devices, with expectations. Run them from the command line for CI, or play them in the UI at a pace fit for recording. |

![The inspector timeline next to the devices](docs/screenshots/04-hold-and-approval-inspector.png)

## Model providers

The assistant on each device is driven by one of these. Choose with `assistant.provider` in the configuration, the `VOICESTAGE_PROVIDER` environment variable, or `--provider`. The model comes from `assistant.model`, `VOICESTAGE_MODEL` or `--model`. A `.env` file in the folder you start from is read; see [`.env.example`](.env.example).

| Provider | What it is | Needs | Default model |
| --- | --- | --- | --- |
| `scripted` | No model. Replays the `script` of scenario steps; free speech is matched against the lines of the loaded scenarios. | Nothing | n/a |
| `anthropic` | Claude through the Anthropic API (`@anthropic-ai/sdk`). | `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile) | `claude-opus-5-5` |
| `bedrock` | Amazon Bedrock Converse API with tool use (`@aws-sdk/client-bedrock-runtime`). Any Bedrock model that supports tools in Converse. | AWS credentials (standard chain), a region, and a model | none: set one |
| `openai-compatible` | Any Chat Completions server with tool calling, hosted or local (Ollama, LM Studio, vLLM and others). Plain `fetch`. | `assistant.options.baseUrl` or `OPENAI_BASE_URL`, a model, and a key if the server wants one | none: set one |
| `claude-code` | Claude through the Claude Code login on this machine (`@anthropic-ai/claude-agent-sdk`). No key. Claude Code's own tools are switched off; the assistant only gets the device's tools. | Claude Code installed and signed in | Claude Code's default |

If the selected provider is not configured, the device says so, in words that tell you what to set, and the rest of the stage keeps working.

Provider options go under `assistant.options`: `effort` (`anthropic`, `claude-code`; the `anthropic` provider uses `low` unless told otherwise, because spoken replies are short), `maxTokens`, `baseUrl`, `apiKeyEnv`, `region`, and `fallbacks: false` to switch off server-side refusal fallbacks on the `anthropic` provider.

**How these have been exercised.** `scripted` and `claude-code` have been run end to end against real MCP servers (see [Testing](#testing)). `anthropic`, `bedrock` and `openai-compatible` are written against their SDKs and wire formats and are covered by unit tests with fake clients, but have not been run against the live services by the author. If one misbehaves, the inspector's model entries show what was sent back; please open an issue.

## Configuration

`voicestage.config.yaml` in the folder you start from, or `--config <file>`. The file that ships at the top of this repository is the default stage and a good thing to copy.

```yaml
name: My stage                 # shown in the top bar
port: 4700                     # optional

assistant:                     # defaults for every device; a device can override any of it
  provider: scripted           # scripted | anthropic | bedrock | openai-compatible | claude-code
  model: claude-opus-5-5       # optional
  maxRounds: 8                 # most tool rounds in one turn
  skillActivation: tool        # tool: bodies loaded on demand. always: bodies in the prompt.
  instructions: "Extra text for the system prompt."
  options: { effort: low }

servers:
  shop:
    url: http://localhost:3000/mcp      # or  builtin: example
    protocol: "2025-11-25"              # default. "auto" probes for 2026-07-28 first.
    headers: { X-Client: voicestage }   # sent by every device
    events:
      url: http://localhost:3000/events # server-sent events; omit to announce MCP notifications only
      announce:
        - on: order.created             # event name, or "mcp:<method>" for an MCP notification
          devices: [phone]              # default: every device connected to this server
          when: { order.status: pending }             # only when these fields match (dot paths)
          say: "{{order.customer}} placed an order."  # {{ ... }} reads the event data
          show: { tool: get_order, args: { id: "{{order.id}}" } }  # call a tool, put the result on screen
          then_say: "{{result.summary}}"              # said after the tool answers

skills:                        # names for skill folders (a folder with SKILL.md, or a folder of them)
  shop-helper: ./skills/shop-helper

devices:
  - id: kitchen                # used in scenarios and announce rules
    name: Kitchen display
    kind: display              # display | speaker | phone
    person: { name: Margaret, role: the account owner }
    servers:
      - id: shop
        headers: { Authorization: "Bearer ${MARGARET_TOKEN}" }   # this device's own headers
    skills: [shop-helper]
    voice: { name: Samantha, rate: 1.0 }        # a speech synthesis voice installed in your browser
    wakeWord: computer
    announcements: { mode: speak, delayMs: 1400 }  # or mode: indicator, to wait until asked
    hints: ["What's on my list?"]               # shown on the idle screen

scenarios:                     # files, or folders of *.yaml
  - ./scenarios
```

- `${NAME}` and `${NAME:-fallback}` are replaced from the environment anywhere in the file, so tokens do not have to be written into it.
- Relative paths are resolved from the folder of the configuration file.
- When two servers on one device have a tool with the same name, the assistant sees them as `server__tool`.
- A tool marked for its card only (`_meta.ui.visibility` without `model`) is hidden from the assistant and still callable by the card.

## Scenarios

A scenario is an ordered list of steps across devices. Each step can check what happened.

```yaml
name: Pancakes and a timer
description: What this shows.
config: ../../voicestage.config.yaml    # optional: used by the CLI when --config is not given

steps:
  - device: display
    say: "Set a timer for the pancakes."     # the person speaks
    when_asked: "Three seconds"              # the answer if a server asks a question (elicitation)
    script:                                  # what the assistant does when no model is driving
      - skill: kitchen-helper                #   load a skill, as a model would
      - call: start_timer                    #   call a tool
        args: { label: pancakes }
        save: timer                          #   keep its structured result as {{timer. ...}}
      - say: "{{timer.say_to_user}}"         #   speak
        if: timer.timer_id                   #   only if this saved value is truthy (optional)
    expect:
      - asked: "How long"                    # a server asked something like this
      - tool: start_timer                    # this tool was called and succeeded ...
        args: { label: pancakes }            # ... with at least these arguments
        result: { seconds: 3, status: running }   # ... and these fields in its structured result
        save: timer                          # keep the result for later steps (works in live mode too)
      - not_tool: find_recipe
      - said: "timer is set"                 # the assistant said something containing this
      - screen: ui://example/timer-card.html # the screen shows this card ("default" or "none" also work)

  - device: display
    wait_for: { event: timer.done, timeout: 10 }   # an event reaches the device and is announced
    expect:
      - announced: "timer is done"

  - device: phone
    call: start_timer                        # a tool call straight from the device, as a tap on a card makes
    args: { label: tea, seconds: 60 }
    save: tea
    show: false                              # optional: leave the screen as it is (setup and checks)

  - pause: 1.5                               # seconds; only when playing with pacing
```

- `script` is used in **scripted** mode and ignored in **live** mode, where the device's model decides what to do and `expect` checks what it did. One file serves both.
- A step can be limited to one mode with `only: scripted` or `only: live`.
- Expected values match loosely: objects match when every listed field matches (keys may be dot paths, `holds.0.status`), and `{ contains: x }`, `{ matches: regex }`, `{ one_of: [...] }`, `{ gt | gte | lt | lte: n }`, `{ exists: true }`, `{ length: n }` and `{ not: x }` are understood. `tool` also takes `error: true` (the call must have failed) and `times: n`.
- `{{name.path}}` reads saved results. A string that is exactly one placeholder keeps the value's type. `{{a.b | "fallback"}}` gives a default.
- When a step throws (a missing device, an event that never arrives), the steps after it are skipped. A failed expectation does not stop the run.

### Running scenarios

```bash
npm run scenario -- scenarios/example/pancakes.yaml             # scripted: no model, deterministic
npm run scenario -- my.yaml --mode live --provider claude-code  # a model drives; expectations check it
npm run scenario -- my.yaml --trace                             # also print each device's timeline
npm run scenario -- a.yaml b.yaml --json                        # machine-readable
```

The exit code is 0 when every scenario passes. In the UI, pick a scenario in the top bar and press **Play**; **Step by step** waits for **Next** before each step, which helps when recording. Lines are spoken at their natural pace, and the people's lines can be voiced too.

In scripted mode a device also answers free speech: what you say is matched against the lines of the loaded scenarios (loosely, so speech recognition does not have to be perfect) and the matching script is replayed. A line written for one device can be replayed on any device that has the tools it calls.

## MCP Apps on the device screen

A tool that carries `_meta.ui.resourceUri` gets its card. Voicestage reads the `ui://` resource through the device's MCP connection, and the browser loads it like this:

- in an `<iframe sandbox="allow-scripts allow-forms">`: an opaque origin, with no access to the page around it, its storage or its cookies;
- behind a Content-Security-Policy injected at the top of the document: `default-src 'none'`, inline script and style only, and network access only to the origins the resource declares in `_meta.ui.csp`;
- connected to `AppBridge` over `postMessage`, which carries the MCP Apps protocol: the `ui/initialize` handshake, host context (theme, locale, platform, container size, the tool), tool input and tool result to the card, and from the card `tools/call`, `resources/read`, `ui/open-link` (asks you first), `ui/message` (spoken as if the person had said it), `ui/update-model-context`, logging and size changes.

Calls a card makes are sent to the stage server, which makes them on the device's own connection to the server the card came from, and nowhere else. They appear in the inspector with origin `card`.

This is a local development host. It does not serve cards from a separate sandbox origin, which the MCP Apps specification recommends for production hosts; the sandbox attribute and the policy above are what stand between a card and the page.

## Agent Skills

A skill is a folder with a `SKILL.md`: YAML frontmatter with `name` and `description`, then instructions. Voicestage follows the format's progressive disclosure:

1. Every loaded skill's name and description are in the system prompt.
2. The assistant loads a skill's body when a request matches, by calling a built-in `load_skill` tool. The inspector shows when that happens. With `skillActivation: always` the bodies are placed in the prompt instead, for models that do not call tools reliably.
3. Other files in the folder can be read with `read_skill_file`. Scripts are never executed.

Names that break the format's rules produce a warning in the inspector, not a failure.

## Example: Hold On

[`examples/holdon`](examples/holdon) sets the stage for Hold On, a separate open-source MCP server and Agent Skill: a money-safety add-on for voice assistants used by older adults. Margaret asks her kitchen display to pay something; Hold On checks the request against scam patterns published by official sources, puts it on hold, and her daughter Sarah, on her phone, approves or denies it. All payments are simulated.

```bash
# in the Hold On repository
npm install && npm run build && npm run seed:reset && npm start     # http://localhost:8787

# here
npm run dev -- --config examples/holdon/voicestage.config.yaml
```

Three scenarios ship with it: a caller claiming to be the IRS demanding gift cards (stopped, the family is told, it can only be denied), a genuine electric bill (verified, held, approved, paid, receipt), and a contractor nobody can look up (held until Sarah vouches for him). They exercise two roles with two tokens, three MCP Apps cards, an elicitation, progress notifications and announcements on both devices.

![The request was stopped: the display says so, and the phone shows why](docs/screenshots/09-stopped-request.png)

## Command line

```
voicestage dev [options]                  start the stage, UI served by Vite        (npm run dev)
voicestage start [options]                start the stage with the built UI         (npm start)
voicestage scenario <file...> [options]   run scenarios, report pass or fail        (npm run scenario)
voicestage example-server [--port N]      run the example MCP server on its own     (npm run example-server)

--config <file>   --mcp <url>   --header "Name: value"   --events <url>   --skills <folder>
--provider <id>   --model <id>  --port <n>   --scenarios <path>
--mode scripted|live   --json   --trace   --paced
```

The stage only listens on localhost, and refuses requests whose `Host` or `Origin` is not this machine, because its API can make tool calls with the tokens in your configuration.

## Testing

```bash
npm test             # vitest
npm run typecheck
```

| File | Covers |
| --- | --- |
| `test/config.test.ts` | Configuration loading, environment references, per-device headers, announce rules, the `--mcp` quick configuration, provider selection |
| `test/skills.test.ts` | Skill parsing and loading, warnings, reading skill files safely, the prompt section and built-in tools |
| `test/scenario.test.ts` | Scenario parsing and error messages, every kind of expectation, the report |
| `test/template.test.ts`, `test/speech.test.ts` | Placeholders and matching; matching speech to lines; answering a form elicitation by voice |
| `test/default-card.test.ts` | The default card for structured, text-only and error results; the card sandbox policy |
| `test/providers.test.ts` | Each provider's settings and error messages; the scripted provider; the tool loop; the Anthropic, Bedrock and OpenAI-compatible request shapes against fake clients |
| `test/events.test.ts` | The server-sent events parser and client, reconnection with `Last-Event-ID` |
| `test/stage.e2e.test.ts` | A real MCP client against the example server: protocol 2025-11-25 and 2026-07-28, sessions, structured output, progress, elicitation by voice and by screen, the card resource, announcements, the indicator mode, connection failures |
| `test/api.test.ts` | The stage server's API and event stream, a scenario played step by step, card tool calls, the localhost check |
| `test/timer-card.test.ts` | The example card driven by the official `AppBridge` in jsdom |
| `test/holdon.e2e.test.ts` | Starts a Hold On server on a free port and plays its three scenarios in scripted mode through the real client. Skipped unless a built Hold On checkout is at `../holdon` or `HOLDON_DIR`. |

`npm run screenshots` retakes the pictures in `docs/screenshots` with headless Chrome.

## How it is put together

```
src/
  cli.ts                 command line
  core/
    config.ts            voicestage.config.yaml
    mcp.ts               one MCP connection (Client + Streamable HTTP) per device and server
    device.ts            a device: connections, skills, assistant, screen, timeline, announcements
    stage.ts             all devices, scenarios, the event stream
    events.ts            server-sent events client
    prompt.ts            the assistant's system prompt
    skills.ts            Agent Skills
    providers/           scripted, anthropic, bedrock, openai-compatible, claude-code, the shared tool loop
    scenario/            scenario files and the runner
  server/app.ts          HTTP API, event stream, static UI
  example-server/        the built-in example MCP server and its card
  shared/                types, default card, templates, speech matching (used by server and browser)
ui/src/                  the React UI: devices, the MCP Apps host, the inspector, voice
scenarios/, examples/    example scenarios, configurations and a skill
```

The stage server holds the MCP connections and runs the assistants, because model credentials and a Claude Code login live on the machine, not in the browser. The browser draws the devices, hosts the cards, and does the listening and speaking.

## Limitations

- **It is a stand-in, not an emulator.** How a real assistant chooses tools, phrases things, lays out cards or delivers notifications will differ. Use Voicestage to develop and demonstrate; test on the real platform when you can.
- **Speech recognition is the browser's.** It needs Chrome, Edge or Safari and a microphone permission, and in Chrome the audio is processed by the browser vendor's service. Typing always works. The wake word is matched in the recognised text, not detected on the audio.
- **Voices are the browser's too.** Which ones exist depends on the operating system. Browsers will not speak until the page has been clicked once; until then lines are shown without sound.
- **Cards are sandboxed with an iframe attribute and a policy**, not a separate origin. See [MCP Apps on the device screen](#mcp-apps-on-the-device-screen).
- **Form elicitation only.** URL-mode elicitation is declined. Sampling and roots are not offered to servers.
- **Streamable HTTP only.** No stdio servers, and no OAuth flow: put a token in a header.
- **One browser tab is the audience.** Speech pacing follows the tabs that are open; several open tabs will each speak.
- **Three of the five providers have not been run against their live services** by the author; see [Model providers](#model-providers).

## License

MIT. See [LICENSE](LICENSE).
