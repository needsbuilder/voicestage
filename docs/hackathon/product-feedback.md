# Product feedback: what we built Voicestage with

Voicestage is a local simulator for voice-first MCP apps, and the stage our track entry, Hold On, is demonstrated on. It is an MCP **client and host**: it connects to someone else's server, runs an assistant per simulated device, renders MCP Apps cards, loads Agent Skills, and listens and speaks through the browser. Hold On's feedback ([`holdon/docs/hackathon/product-feedback.md`](https://github.com/needsbuilder/holdon/blob/main/docs/hackathon/product-feedback.md)) covers the same standards from the server's side; this document is the view from the other end of the connection.

The incidents behind each criticism are in [friction-log.md](friction-log.md), cited here as V-01 to V-15. Where we cite F-numbers, they are entries in Hold On's log that we met again as a host.

**Scope, stated plainly.** No Alexa+ developer tooling was available to hackathon participants, which is why this simulator exists (V-15). We did not use the Category SDK, the MCP Toolkit, the CLI or the Web Simulator, and Voicestage has never been compared with an Alexa+ device. Every decision in it about how a voice assistant treats a tool result is ours. Nothing below is a claim about how Alexa+ behaves.

**AWS.** We used no AWS service. Voicestage has a `bedrock` provider written against the Converse API, tested against a fake client only; it was never run against AWS, so we have no feedback on Bedrock and make no AWS claim.

| What | Version | Used for |
| --- | --- | --- |
| MCP specification, Streamable HTTP | 2025-11-25 by default, 2026-07-28 on request | Everything between a device and a server |
| MCP TypeScript SDK v2: `client`, and `server`, `node`, `express` for the built-in example server | 2.3.1, 2.3.1, 2.1.1, 2.0.2 | The MCP client in each device; a two-tool example server |
| MCP Apps: `@modelcontextprotocol/ext-apps` | 2.0.3 (specification 2026-01-26) | The card host (`AppBridge`); the example card's registration |
| Agent Skills | agentskills.io specification | Loading `SKILL.md` folders into each device's assistant |
| Claude Agent SDK | 0.3.296 | The one model provider we could run live (`claude-code`) |
| Web Speech API | Google Chrome 154 on macOS 27 | Speaking and listening |

Times below come from the build session's own log. The code was written with an AI coding agent, so read them as an order of events and a lower bound, not as what a person would need.

## 1. MCP specification, 2025-11-25 and 2026-07-28, over Streamable HTTP

**What we used it for.** One connection per simulated device, each with its own HTTP headers, so two people with two tokens can be on stage together. Tools with `outputSchema` and `structuredContent`, progress notifications, form elicitation, resource reads for `ui://` cards, tool annotations, logging notifications, and both revisions.

**What worked well.**
- **Identity is just the connection.** Hold On gives the older adult's token eight tools and her daughter's four. In Voicestage that needed no code: two devices, two headers, and the inspector shows two different tool lists.
- **Structured output makes a screen possible without a card.** For any tool with `structuredContent`, Voicestage draws a default card from it. A server that ships no UI still shows something sensible.
- **Form elicitation fits a voice.** A question with a fixed list of answers can be asked aloud. From the example server's schema Voicestage says "How long should the timer run? You can say: 3 seconds, 1 minute, 3 minutes, 5 minutes, or 10 minutes.", and "Three seconds" goes back as `{"duration":"3"}`.
- **Progress gives a device something to show** while a tool works, in the server's own words.
- **Two revisions, one host.** The same client code ran the same scenario on 2025-11-25 and on 2026-07-28, including the question round. Only the configuration differed.

**What needs work.**
- **Nothing reaches a person who did not ask.** A server has no standard way to say "tell her now" when no request is in flight (V-03). We added a second channel beside MCP, and so did Hold On. For a household assistant this is the main event, not an extra.
- **Nothing says "speak this".** A tool can return text, but no field means "these are the words for the person". Ours is called `say_to_user`, and a live model reworded it on the first run (V-08).
- **Elicitation is specified for forms.** How to read choices aloud, what counts as an answer, whether to ask again after an unclear one: we wrote that mapping ourselves (in `src/shared/speech.ts`), and another host will write a different one.
- **Session loss is the client's duty, with nothing to hang it on.** The 2025-11-25 transport says a client MUST start a new session after a 404. In practice the application has to notice and do it (V-01).
- **No word on devices without a screen.** A speaker receives a result from a tool that links a card. Voicestage speaks and shows nothing. We do not know what a real host should do.

**Zero to a first working call.** Twenty-five minutes after `npm install`, a real client and our own example server completed one scenario end to end: a tool call with structured output and three progress notifications, a form elicitation answered by a spoken line, a card resource read, and an announcement. Fifteen seconds later the three Hold On scenarios passed against Hold On's server, which we had not written. That second fact is the better compliment to the protocol.

**Would we build with it again?** Yes. A simulator for somebody else's server is only possible because the server's whole surface is discoverable over the wire.

## 2. MCP TypeScript SDK v2

**What we used it for.** In each device: `Client` and `StreamableHTTPClientTransport` with per-device headers, `versionNegotiation`, `callTool` with `onprogress`, a request handler for `elicitation/create`, notification handlers, `readResource`, `ping`. In the example server: `McpServer.registerTool`, `createMcpHandler`, `NodeStreamableHTTPServerTransport`, `isLegacyRequest`, `inputRequired` and `inputResponse`, `createMcpExpressApp`.

**What worked well.**
- **Negotiation is one option and three getters.** `versionNegotiation: { mode }` chooses the handshake; `getNegotiatedProtocolVersion()`, `getProtocolEra()` and `getServerCapabilities()` fill the inspector's connection panel. Showing a developer exactly what was negotiated took a few lines.
- **One elicitation handler for both revisions.** Our `elicitation/create` handler is called on a 2025-11-25 session and on 2026-07-28 alike. The host does not know the difference.
- **`capabilities.extensions` is typed.** Advertising MCP Apps support (`io.modelcontextprotocol/ui`) needed no cast.
- **`onprogress` with `resetTimeoutOnProgress`** did what a host waiting on a person needs.
- **`SdkHttpError.status`.** Once we knew what to look for, detecting a lost session was `error instanceof SdkHttpError && error.status === 404`.
- **The comments in the type definitions.** The note on `createMcpHandler`'s `legacy` option says exactly what the default cannot do and what to write instead. We followed it and it was right.

**What needs work.**
- **A restarted server leaves the client holding a dead session**, and the two errors an application sees are a bare `fetch failed` and an HTTP 404 labelled `CLIENT_HTTP_NOT_IMPLEMENTED` (V-01). This cost us the most of anything in the SDK, because a simulator's user restarts their server all day.
- **The API is hard to find in the installed package.** The READMEs are an install line and links; the declarations are bundled chunks behind mangled import aliases (V-12).
- **The default HTTP handler cannot ask a 2025-11-25 client a question** (F-01). Our example server carries 41 lines of session routing for that reason, the same lines Hold On carries.
- **The client writes its own progress text into the caller's `onprogress`** on 2026-07-28 (F-09). A host that shows progress to the person shows that sentence too. Ours did, until we filtered it by matching the words.

**Zero to a first working call.** `npm install`, then reading type definitions until the client was written: eight minutes from the first `ls` of the package to the connection class. It connected and listed tools on its first run. The time went on finding names, not on fixing mistakes.

**Would we build with it again?** Yes. The client is small, typed and predictable, and the two-revision design let one host serve both. We would start by wrapping it in the reconnection logic we ended up with.

## 3. MCP Apps (`@modelcontextprotocol/ext-apps`)

**What we used it for.** The host side: `AppBridge` and `PostMessageTransport` render a card in an iframe on a device screen, and pass tool input, tool results and host context to it. Calls the card makes (`tools/call`, `resources/read`, `ui/open-link`, `ui/message`) come back through the bridge to our server, which makes them on that device's own MCP connection. On the server side, `registerAppTool` and `registerAppResource` for the example timer card.

**What worked well.**
- **`AppBridge` does not insist on owning an MCP client.** `new AppBridge(null, ...)` with `oncalltool` and `onreadresource` let us keep the bridge in the browser and the MCP connection, with its tokens, on the server. That split is the reason a card in Voicestage cannot see a credential.
- **We never had to debug the handshake.** The initialization, tool input and tool result came up as the types said. About a quarter of an hour after the first line of host code, a click on Deny inside Hold On's approval card, a card we had not written, reached Hold On's server through our host and was announced on the other device.
- **The same bridge runs in tests.** Our example card is tested in jsdom against `AppBridge` itself.
- **Registering a card is short.** Two helper calls and a `_meta.ui.resourceUri`.
- **The security model is easy to explain** to someone pointing the simulator at their own server: a card can only ask the host, and the host only talks to the card's own server.

**What needs work.**
- **The sandbox proxy is required and not provided.** The specification says a web host MUST use a proxy on a second origin. The npm package has the bridge half and no proxy page, and its README says there is no supported host. We first shipped a single sandboxed iframe, which worked and did not conform (a card that uses `localStorage` failed in it), and then wrote the proxy ourselves: 178 lines, and three decisions with security consequences that a shipped proxy would have made for us (V-02). We think most small hosts will take the first step and not the second.
- **Declarations are written out structurally**, so a type error is a screen of braces, and the host entry point does not export `EXTENSION_ID` (V-13).
- **Nothing for hosts without a keyboard.** How large a card may be on a phone or a countertop display, whether the host may scale it, what a screenless device does, whether anything is spoken when a card appears. We scale cards with CSS `zoom` to fit a simulated screen. That is a guess, and it has a side effect on automated testing (F-10).

**Zero to a first card.** Server side: two helper calls. Host side: one component of 141 lines, and the quarter of an hour described above.

**Would we build with it again?** Yes, and we would write the proxy on the first day. Seeing the card is what turned "the tool returned JSON" into a product someone could judge.

## 4. Agent Skills

**What we used it for.** A loader (`src/core/skills.ts`, 180 lines) that reads `SKILL.md` folders, validates the frontmatter and gives each device's assistant its skills by progressive disclosure: names and descriptions in the system prompt, the body through a built-in `load_skill` tool, other files through `read_skill_file`. Scripts are never run. We loaded our own example skill and Hold On's.

**What worked well.**
- **The format is small enough that a host is an afternoon's work, or less.** Frontmatter, a body, a folder.
- **Progressive disclosure worked with a live model with no coaxing.** In the live run the model's first action was `load_skill` for Hold On's skill; it then called the tools in the order the skill gives.
- **The guide for client authors is practical.** It describes the dedicated-tool activation we had arrived at ourselves, and names the YAML mistake we made.

**What needs work.**
- **A description with a colon is invalid YAML**, and the Specification page does not warn about it. The guide for clients does, on a page we found only afterwards (V-11).
- **A skill cannot say which MCP tools it needs** (F-12). In our configuration, skills and servers are listed separately for each device, and nothing checks that they belong together.
- **A skill is written to be read; the assistant here speaks.** Hold On's skill says "Say `say_to_user` as written." and the live model did not (V-08). That is the model, but for skills meant for voice assistants a line of guidance about spoken wording would help authors.

**Zero to a first loaded skill.** The loader and the example skill were written in one pass. The first failure was the YAML one.

**Would we build with it again?** Yes. It is the only part of this stack where a server author can say how to behave, not only what can be called.

## 5. Claude Agent SDK

**What we used it for.** The `claude-code` provider: a local Claude Code login acts as a device's assistant, with no API key. `query()` in streaming-input mode, `tools: []`, `strictMcpConfig: true`, `settingSources: []`, `persistSession: false`, a `canUseTool` callback, and an in-process MCP server that offers exactly the device's tools. The test runs used `claude-haiku-5-5`.

Voicestage also has `anthropic`, `bedrock` and `openai-compatible` providers. We had no credentials for them. They are tested against fake clients only, so we give no feedback on those services.

**What worked well.**
- **A live assistant with nothing to configure.** For a simulator that other people will install, "it uses your Claude Code login" removes the step where they stop.
- **The options that shut things off do what they say.** With built-in tools, settings files and session persistence all off, the model used the device's tools and nothing else in every run we made.
- **It passed the first time.** The first live run of Hold On's hardest scenario passed all four steps: the model checked the request, placed the hold and did not pay.
- **The warning in V-10** is the best error message we met in this project: what is wrong, why, and two ways to fix it.

**What needs work.**
- **In-process tools want Zod shapes and the v1 MCP SDK** (V-09). We already had JSON Schemas from a remote server and a v2 stack, and ended up with both SDK generations in one process.
- **`allowedTools` reads as a filter and acts as auto-approval** (V-10).

**Zero to a first live turn.** The provider was written from `sdk.d.ts` (538,514 bytes; the same search-first experience as V-12). Its first live run passed.

**Would we build with it again?** Yes, as the development-time provider. It is the reason Voicestage can be tried with a real model by anyone who already has Claude Code.

## 6. Web Speech API in Google Chrome

**What we used it for.** `speechSynthesis` for every device's voice and, when a scenario plays, for the people's lines. `SpeechRecognition` for hold-to-talk, tap-to-toggle and a wake word. `getUserMedia` for a level meter, and the Permissions API to know about a blocked microphone before anyone presses a button.

**What worked well.**
- **No dependency, no key, no model download.** A simulator that anyone can run needs exactly that.
- **Synthesis events are precise.** Captions change within a millisecond of each utterance's `start`; utterances never overlapped; a tab in the background kept speaking; an interruption cut cleanly.
- **Recognition was accurate on clear speech.** All twelve spoken lines of our scenarios, said by a synthetic voice, were recognised well enough to drive the right tool calls.
- **`navigator.permissions.query({ name: 'microphone' })`** let us explain a blocked microphone as the page opens.

**What needs work.**
- **Recognition cannot be tested unattended by any documented route** (V-04).
- **Speech fails silently before a click, and voice choice is a list of names** (V-05).
- **Single-phrase mode drops phrases, and errors carry no message** (V-06).
- **A microphone withheld by the operating system looks healthy** (V-07).
- **It is not local.** Chrome sends audio to an online recognition service; with that unreachable, recognition fails with `network` in about 190 ms. A simulator that otherwise runs entirely on one machine depends on it.

**Zero to first sound.** Longer than it looked. The code was written early and "worked" in a headless browser that has no audible output. It was only when we ran a visible Chrome, with no automation defaults, that we saw what a person would get (V-05, V-14).

**Would we build with it again?** For a simulator, yes: nothing else is free of setup. For a product, no: we cannot choose or guarantee a voice, and recognition belongs to the browser vendor.

**What we did not test.** A real microphone and a human voice, any browser other than Chrome, any system other than macOS. And no script can hear: that speech is audible is inferred from the browser's events.

## 7. Alexa+ developer tooling and the hackathon's guidance

**What we used.** The Official Rules, the FAQ and the resources page. Nothing else was available to us.

**What worked well.**
- The FAQ says plainly that the tools are not available and that a web simulator is an acceptable way to demonstrate. Voicestage is that sentence taken literally, and made reusable.
- Building on open standards means the simulator is useful beyond this hackathon: it works with any Streamable HTTP MCP server.

**What needs work.**
- Without the runtime or a description of it, a simulator can only guess (V-15). We had to decide alone what is spoken and what is shown, how a server's question is asked aloud, how big a card is, and how an announcement interrupts. A demonstration on a simulator shows that a server works. It cannot show that it works on the target.

**Would we build for it again?** Yes. The combination the track points at, voice plus a screen plus a second person on another device, is where MCP is least explored and most interesting. We would want one thing first: a way to check a simulator against the real behaviour.

## Feature requests

| Priority | Request | For | Why it mattered here |
| --- | --- | --- | --- |
| Critical | A published description of the host's behaviour (revision, client capabilities, what is spoken and shown, how notifications arrive), or simulator access | Alexa+ | Every such choice in Voicestage is a guess (V-15) |
| Critical | A standard notification for events meant for the person, on both revisions, with replay after reconnecting | MCP specification | Proactive announcements are a second, home-made channel in both our projects (V-03) |
| Important | Session recovery in the client transport, or a named error for a lost session | MCP TypeScript SDK | Every server restart broke every device (V-01) |
| Important | The sandbox proxy page in the `ext-apps` package, and a word on where the card's policy is applied | MCP Apps | We first shipped a host that did not conform, then wrote the proxy ourselves (V-02) |
| Important | A field on tool results for text to be spoken as written, and speech hints for elicitation choices | MCP specification | `say_to_user` is a private convention; a live model reworded it (V-08) |
| Important | A supported way to test speech recognition with no person present | Chrome | Voice input could only be tested through an undocumented path (V-04) |
| Important | Guidance for hosts without a keyboard: card size on small screens, devices with no screen, what is said when a card appears | MCP Apps, MCP specification | We decided each of these alone |
| Nice-to-have | Tools from JSON Schema, and v2 servers, in the Agent SDK | Claude Agent SDK | Two MCP SDK generations in one process (V-09) |
| Nice-to-have | Readable declarations and a working example in each package README | MCP TypeScript SDK | The API was found by searching bundled chunks (V-12) |
| Nice-to-have | Named types in `AppBridge`'s declarations; `EXTENSION_ID` exported from `/app-bridge` | MCP Apps | V-13 |
| Nice-to-have | A flag on progress items the SDK generates itself | MCP TypeScript SDK | We filter one by matching its wording (F-09) |
| Nice-to-have | A note on quoting beside `description` in the specification | Agent Skills | V-11 |
| Nice-to-have | A "may I speak yet" state, voice metadata, messages on recognition errors, a muted track when the system withholds the microphone | Web Speech API, browsers | V-05, V-06, V-07 |
