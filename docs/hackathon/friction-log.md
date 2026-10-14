# Friction log: building Voicestage

Voicestage is a local simulator for voice-first MCP apps: simulated devices you can talk to, each with its own MCP connection, an assistant, a screen that renders MCP Apps cards, and an inspector. It was built for the Alexa+ track for one reason, stated in the hackathon FAQ: participants get no Alexa+ developer tools, and are told to demonstrate on "your own web-based simulator or front end". It is also the stage on which our track entry, Hold On, is demonstrated.

Hold On's own log ([`holdon/docs/hackathon/friction-log.md`](https://github.com/needsbuilder/holdon/blob/main/docs/hackathon/friction-log.md), entries F-01 to F-14) records the friction of writing an MCP server and its cards. This log is the other side of the wire: what we ran into writing the **client and host** (the MCP client, the MCP Apps host, a skills loader, an agent loop), and the browser voice APIs a simulator stands on. Where the two logs meet, we give only what the host side adds, in [Seen again from the host side](#seen-again-from-the-host-side).

Each entry says how we met it:

- **Hit.** It failed in front of us while building or testing.
- **Designed around.** We read about the limit in type definitions before writing the code and built the workaround first. Where that is the case we ran the failing version afterwards, so the error text is real.
- **Gap.** Something the documentation did not tell us, or told us only after we had built the wrong thing.

All error text is copied from a terminal or from Chrome. Reproductions were run on 2026-10-11 with the versions below. Anything we could not re-check was left out.

**How the work was done.** The code was written with an AI coding agent (Claude Code) on 2026-10-10 and 11 (Pacific time), from an empty directory, and this log is drawn from that session's record. That matters for two entries (V-12, V-13): an agent meets an SDK through `node_modules` first, not through a documentation site.

**What this log is not.** We had no access to any Alexa+ tool, device or runtime (V-15). Nothing here says how the real Alexa+ behaves.

## Environment

| | |
| --- | --- |
| Machine | macOS 27.0.1, arm64, system language Korean |
| Node.js, npm | 24.16.0, 11.13.0 |
| Browser | Google Chrome 154.0.8037.98 (installed, not a bundled Chromium) |
| `@modelcontextprotocol/client`, `/server`, `/core` | 2.3.1 |
| `@modelcontextprotocol/node`, `/express` | 2.1.1, 2.0.2 |
| `@modelcontextprotocol/ext-apps` | 2.0.3 (MCP Apps specification 2026-01-26) |
| `@anthropic-ai/claude-agent-sdk` | 0.3.296, with Claude Code 2.1.296 |
| `@modelcontextprotocol/sdk` (v1) | 1.32.1, only because the Agent SDK needs it (V-09) |
| Other | zod 4.6.5, yaml 2.9.1, TypeScript 7.0.2, React 19.3.0, Vite 8.3.4, Vitest 5.0.3, puppeteer-core 25.13.0 |

## Summary

| ID | Kind | Area | Severity | What happened |
| --- | --- | --- | --- | --- |
| V-01 | Hit | MCP TypeScript SDK (client) | Major | After a server restart the client keeps its dead session, and the errors do not say so |
| V-02 | Gap | MCP Apps | Major | The specification requires a sandbox proxy on a second origin; the npm package has none. We first shipped without one, then wrote it |
| V-03 | Designed around | MCP specification | Major | No standard way to tell the person something when no request is in flight |
| V-04 | Hit | Chrome, speech recognition | Major | Chrome's fake-microphone flags do not reach speech recognition |
| V-05 | Hit | Chrome, speech synthesis | Major | Speech is refused until the page is clicked, with no exception; the default voice is in the system's language |
| V-06 | Hit | Chrome, speech recognition | Minor | Single-phrase mode kept only the last phrase; errors carry an empty message |
| V-07 | Hit | Chrome and macOS | Minor | A microphone the operating system withholds looks live and delivers zeros |
| V-08 | Hit | MCP specification, live model | Minor | A live model does not speak the server's words; "say this" is a private convention |
| V-09 | Designed around | Claude Agent SDK | Minor | In-process tools need Zod shapes and the v1 MCP SDK |
| V-10 | Hit | Claude Agent SDK | Minor | `allowedTools` next to `canUseTool` silently bypasses the callback (a warning caught it) |
| V-11 | Hit | Agent Skills | Minor | A description with a colon is not valid YAML |
| V-12 | Hit | MCP TypeScript SDK | Minor | Finding the v2 API in the installed packages |
| V-13 | Designed around | MCP Apps | Minor | `AppBridge`'s declarations write every result type out in full |
| V-14 | Hit | Browser automation | Minor | Automation defaults hid the behaviour we were testing |
| V-15 | Gap | Alexa+ | Blocker for testing on the target | No Alexa+ developer tooling for participants |

---

## V-01. After a server restart the client keeps its dead session

**Severity:** Major. A simulator's user restarts their server all day. Until we fixed it, each restart left every device holding a session the server no longer knew, until Voicestage was restarted too.

**Task attempted.** Keep one long-lived MCP client per simulated device usable while the server under it is stopped and started.

**How we met it.** Hit. A Hold On server we were using for a voice test died in the middle of a run. The next tool call showed `Error (call_failed): fetch failed` and the other device's connection logged transport errors. At the time we restarted the server and the stage together and moved on. When we came back to it for this log, a 30-line script against our own example server showed that restarting the server alone would not have been enough.

**Steps taken.**
1. `new Client(..., { versionNegotiation: { mode: 'legacy' } })` over `StreamableHTTPClientTransport`. It negotiates 2025-11-25 and receives a session id.
2. `callTool` succeeds.
3. Stop the server. `callTool`.
4. Start the server again on the same port. `callTool`.

**Expected.** The 2025-11-25 transport specification, session management, item 4: "When a client receives HTTP 404 in response to a request containing an `MCP-Session-Id`, it **MUST** start a new session by sending a new `InitializeRequest` without a session ID attached." We expected the SDK's client to do that, or to throw something that names the situation so an application can.

**Actual.**

Step 3, server stopped:

```
TypeError: fetch failed
  cause: AggregateError (empty message), code ECONNREFUSED
```

The reason is only in `error.cause`. `client.onerror` receives the same `TypeError`; `client.onclose` is not called.

Step 4, server back:

```
SdkHttpError  code=CLIENT_HTTP_NOT_IMPLEMENTED  status=404
Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found. Send a new initialize request."},"id":null}
```

The transport's `sessionId` is still the old one, every later call fails the same way, and `onclose` is still not called. The error code reads like HTTP 501; the status is 404.

One more thing, which is Node's `fetch` and not the SDK: straight after a restart a request can fail with `fetch failed` and a cause of `ECONNRESET` or `UND_ERR_SOCKET` ("other side closed"), once for each keep-alive socket still pooled for the old process, before any request reaches the new one.

**Workaround.** `src/core/mcp.ts` now repairs the connection itself (commit `8d1dbe5`, `test/reconnect.test.ts`). After one second without a successful request it sends a `ping` before the next one; if that finds the server gone or answers 404, it discards the client, connects again (up to four attempts, to get past the pooled sockets) and shows the new session in the inspector. A request refused with 404 is sent once more on the new session. A tool call that fails on the wire is never sent twice, because it may have arrived. It walks the `cause` chain to say `Could not reach http://localhost:8787/mcp (ECONNREFUSED). Is the MCP server running?`.

**Suggestion.** In `StreamableHTTPClientTransport`: on a 404 to a request that carried a session id, either re-initialize (as an option) or throw a dedicated error such as `SessionExpiredError`. Give that case a code that describes it. Put the `cause` code into the message of a network failure.

---

## V-02. MCP Apps: the specification requires a sandbox proxy, and the package has none

**Severity:** Major. For a while Voicestage's host did not conform to a MUST, and a card could behave differently in it than in a conforming host. It conforms now, with a proxy we wrote.

**Task attempted.** Render `ui://` cards (`text/html;profile=mcp-app`) on a simulated device screen, in a web page, with the official host bridge.

**How we met it.** Gap. We built the host from the installed package: its type definitions and README. We read the specification's sandbox section only while checking the first version of this log, after the host was finished.

**Steps taken.**
1. `npm install @modelcontextprotocol/ext-apps`, then `AppBridge` and `PostMessageTransport` from `@modelcontextprotocol/ext-apps/app-bridge`.
2. `AppBridge` has `onsandboxready` and `sendSandboxResourceReady`, so we looked in the package for the page that goes in the outer iframe.

**Expected.** A sandbox proxy document in the package, or a helper that produces one.

**Actual.** The package contains `LICENSE`, `README.md`, `dist/` and `package.json`, and no `.html` file anywhere. Its README says: "There's no _supported_ host implementation in this repo (beyond the examples/basic-host example)" and that clients may use the MCP-UI client SDK "or roll their own implementation". We rolled our own, from the npm package; we did not go to the repository's `examples/basic-host`.

The specification (2026-01-26, "Sandbox proxy") says:

> If the Host is a web page, it MUST wrap the View and communicate with it through an intermediate Sandbox proxy.
>
> 1. The Host and the Sandbox MUST have different origins.
> 2. The Sandbox MUST have the following permissions: `allow-scripts`, `allow-same-origin`.

**What we shipped first.** One `<iframe sandbox="allow-scripts allow-forms">` with the card as `srcdoc` and a Content-Security-Policy injected as a `<meta>` tag. Checked in Chrome 154, it did the handshake, tool input and result, and a card's `tools/call` through the host. But the card had the origin `null`, so

```
SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.
```

and `document.cookie` threw the same way. A card that uses storage worked in a conforming host and failed in ours.

**Workaround: we wrote the proxy.** `src/server/sandbox.ts` (178 lines) is a second listener on another localhost port that serves one page. The card's iframe loads that page; it posts `ui/notifications/sandbox-proxy-ready`, receives the card's HTML in `ui/notifications/sandbox-resource-ready` (sent with `AppBridge.sendSandboxResourceReady`, which worked as its types say), loads it in an inner iframe and relays everything else. `AppBridge` and `PostMessageTransport` needed no change on the host side: about twenty changed lines in our card component. What we had to work out ourselves, each of which a shipped proxy would have settled:

- **Where the policy goes.** We serve the proxy page with a `Content-Security-Policy` header built from the resource's `_meta.ui.csp`, passed in the page's URL, and rely on the card's `srcdoc` document inheriting it. In Chrome 154 a policy with `frame-src 'none'` on the proxy page did not stop the proxy from creating the `srcdoc` iframe, and an undeclared `fetch` from the card was refused.
- **Which origin.** Another port on the same host name is another origin but the same site. We use the other name for the machine (`127.0.0.1` when the stage is on `localhost`, and the reverse), so that it is another site too.
- **Our own API.** It accepted requests from any origin on this machine. Once cards run on an origin on this machine, that would have let a card that declares the stage in `connectDomains` call the API, which makes tool calls with the user's tokens. The API now answers only the stage's own page. A host author who adds the proxy without thinking of this opens that door.
- **Storage is shared.** Every card, from every server and on every simulated device, has the proxy's one origin, so they share `localStorage`.

Checked in Chrome 154 by `test/cards.browser.test.ts`, with the example card loaded both ways. Through the proxy: the card's origin is the proxy's, `localStorage` works, `window.top.document` and `window.top.localStorage` throw `SecurityError`, `fetch` to the stage's API and to an undeclared site fail with `TypeError`, and a real pointer click on the card's button makes the card call its tool through the host. Without it: origin `null`, storage throws.

**Suggestion.** Ship the sandbox proxy page in the npm package, with a few lines of Node to serve it on a second localhost port, so that a conforming host is ten lines and not a design task with security consequences. Say in the specification where the card's policy is meant to be applied (a header on the proxy, a `<meta>` in the card, or both), and whether a host on localhost should give each server an origin of its own.

---

## V-03. Telling the person something when no request is in flight

**Severity:** Major for a voice-first product. This is the part a chat window does not have, and each server and host pair will invent its own.

**Task attempted.** Proactive announcements. Sarah denies a hold on her phone; Margaret's kitchen display has to show an indicator and then say so. Nothing on Margaret's device is waiting on a request at that moment.

**How we met it.** Designed around. We looked for the MCP message a server uses to push something meant for the person, did not find one, and designed a second channel before writing the device code.

**Steps taken.** The nearest thing on the connection is a logging notification, so our example server sends one when a timer ends: `server.sendLoggingMessage({ level: 'info', data: { event: 'timer.done', ... } })`.

**Expected.** One notification, meant for the person, that works on both protocol revisions.

**Actual.**
- On 2025-11-25 with a session, the notification arrives at the client outside any request (`notifications/message`); our end-to-end test asserts it. But logging is a developer channel, and the client's types mark its control as on the way out: `setLoggingLevel` is "Deprecated as of protocol version 2026-07-28 (SEP-2577) ... Migrate to stderr logging (STDIO servers) or OpenTelemetry."
- On 2026-07-28 there is no session and the SDK builds a server instance per request. Calling `sendLoggingMessage` on those instances afterwards throws `Not connected` (reproduced afterwards). The v2 client does have a `subscriptions/listen` stream for this revision, documented as carrying change notifications. We did not build on it, so we cannot say whether it could carry an announcement.

**Workaround.** A channel next to MCP. A server entry in Voicestage's configuration may name a server-sent events URL (`events.url`) and rules (`announce`) that turn an event name into an indicator, a spoken sentence, and optionally a tool call whose result goes on the screen. Hold On exposes `/events` for this. The client reconnects with `Last-Event-ID`. Logging notifications on the MCP connection are accepted as a second source.

**Suggestion.** A standard notification for events meant for the person, defined for both revisions: a short text that may be spoken, a priority, optionally a tool to call for the details, and replay after a reconnection.

---

## V-04. Chrome's fake-microphone flags do not reach speech recognition

**Severity:** Major for testing. We found no documented way to test voice input with nobody in the room.

**Task attempted.** Test speech input end to end, unattended: speak the scenario lines with macOS `say`, convert them to WAV with `afconvert`, and feed them to Chrome as the microphone.

**How we met it.** Hit.

**Steps taken.** Headed Chrome with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>`. Then (a) read sample levels from `getUserMedia({ audio: true })`, and (b) `new SpeechRecognition().start()`.

**Expected.** The recogniser hears the file.

**Actual.**

(a) The track is labelled "Fake Default Audio Input" and is running, and every sample is `0.000`, until `--disable-features=AudioServiceSandbox` (or `AudioServiceOutOfProcess`) is added. Then the levels follow the file (peak 0.261).

(b) Even then, recognition hears nothing:

```
   0ms start() called
   2ms start
 460ms audiostart
8312ms audioend
8312ms ERROR error=no-speech message=""
8312ms end
```

The same with a second file (8314 ms), and with Chrome's built-in beep in place of a file.

**Workaround.** `recognition.start(track)` with a `MediaStreamTrack` made in WebAudio: the WAV, plus continuous faint noise. Without the noise we got `speechstart` and then no result for 30 seconds, because no audio frames flow once the buffer ends. With it, all twelve spoken lines of our shipped scenarios were recognised well enough to be matched to the right script. This is `scripts/voice-check.mjs` (`npm run voice:check`).

**Suggestion.** Chrome: send speech recognition's capture through the fake device when those flags are set, and document `start(MediaStreamTrack)` as the way to test recognition.

---

## V-05. Speech is refused until the page is clicked, and the default voice is in the system's language

**Severity:** Major until explained on screen. Our first build had only ever run in a headless browser, so we had never seen this. Anything a device said before the first click on the page, such as an announcement arriving on an idle stage, was dropped with nothing on the screen to say why.

**Task attempted.** Speak the assistant's replies with `speechSynthesis` as soon as a scenario plays.

**How we met it.** Hit, the first time we ran the app in a visible Chrome without the automation calls that grant activation (V-14).

**Steps taken.** Load the page; with no click or key press, call `speechSynthesis.speak(utterance)`.

**Expected.** Sound, or an exception or a rejected promise that says why not.

**Actual.** `navigator.userActivation.hasBeenActive` is `false`. Nothing is thrown. The utterance receives an `error` event with `error: "not-allowed"` straight away; `speaking` and `pending` stay `false`.

About the voices: `getVoices()` is empty until `voiceschanged`. After that Chrome offers 200 voices, 44 of them English (41 on the computer, 3 remote). The one flagged `default` on this Korean-language Mac is `지안(프리미엄)` (ko-KR). Many of the English ones are novelty voices (Bad News, Bells, Zarvox).

**Workaround.** A notice under the top bar ("Sound is waiting for you. Browsers only speak after a click or a key press on the page..."); each line stays on screen for as long as it would take to say; speech starts with the next line after a click. Voices are chosen by name (`src/shared/voices.ts`): the page's language, on-device before remote, a list of known clear voices, novelty voices never, a different voice for each device and for each person. A voice menu overrides any of it.

**Suggestion.** For the Web Speech API: a state a page can ask ("may I speak yet?") without sacrificing an utterance, and quality or category metadata on `SpeechSynthesisVoice`, so that applications do not have to keep lists of voice names.

---

## V-06. Single-phrase recognition kept only the last phrase; errors carry an empty message

**Severity:** Minor once known. Before the fix, a two-sentence request lost its first sentence.

**Task attempted.** Recognise one request per press of the microphone button.

**How we met it.** Hit, with the harness from V-04.

**Steps taken.** `continuous = false`, `interimResults = true`, and the twelve spoken lines of our scenarios.

**Expected.** The whole request in the final result.

**Actual.** For lines with a pause, the final result held only the last phrase. "A man from the IRS just called. He says I'll be arrested unless I pay $2,000 in gift cards today, and he told me not to tell anyone." came back as "gift cards today and he told me not to tell anyone". Seven of twelve lines could be matched to their script. With `continuous = true`, twelve of twelve, with small slips ("the roofer" as "the river", "wants" as "once", "her usual" as "how usual").

Errors arrived as a bare code: `no-speech` after about 8 seconds of silence, `not-allowed` about 150 ms after `start()` with the site permission denied, `network` after about 190 ms with the recognition service unreachable. `SpeechRecognitionErrorEvent.message` was `""` each time.

**Workaround.** Always continuous. Voicestage ends the turn itself, 1.3 seconds after a final result with nothing new, or on the second tap. A table of plain-words explanations per error code (`describeMicProblem`), each ending "You can always type instead."

**Suggestion.** Fill in `message`. Document what non-continuous mode returns when the speaker pauses.

---

## V-07. A microphone the operating system withholds looks live and delivers zeros

**Severity:** Minor for users, who get an explanation now. For us it meant a real microphone could not be tested at all in this setup.

**Task attempted.** Use the real microphone in a Chrome that our test runner started.

**How we met it.** Hit.

**Steps taken.** `getUserMedia({ audio: true })` on each input device, with the site permission granted.

**Expected.** An error, or a muted track, if the microphone may not be used.

**Actual.** The call succeeds. The track is `live` and not `muted`. Every sample is exactly zero, and recognition ends with `no-speech`. The reason is in the macOS log, not in the browser:

```
tccd  Prompting policy for hardened runtime; service: kTCCServiceMicrophone requires entitlement
      com.apple.security.device.audio-input but it is missing for responsible={ ...the application that started Chrome... }
```

macOS holds the application that launched Chrome responsible for the microphone. That application lacked the entitlement, and Chrome received silence.

**Workaround.** While a device listens, Voicestage meters the track (only when permission is already granted, so it never causes a prompt). Samples that are all zero for 2.5 seconds produce: "The microphone is sending pure silence. It may be muted, or switched off for this browser in the system's privacy settings. You can always type instead."

**Suggestion.** Browsers: when the operating system is substituting silence, set the track to `muted` and fire `mute`.

---

## V-08. A live model does not speak the server's words

**Severity:** Minor for us, because recording uses the scripted provider. It would matter in a product whose wording was written with care.

**Task attempted.** Have the assistant say exactly what Hold On wants said when a payment is stopped. The wording was written for a frightened older person.

**How we met it.** Hit, on the first run with a live model.

**Steps taken.** Hold On's tools return a `say_to_user` string in their structured content. Its skill says "Say `say_to_user` as written." Voicestage's system prompt says to use wording that a tool result provides for the person. We ran scenario (a) with the `claude-code` provider and `claude-haiku-5-5`. The model loaded the skill in its first round.

**Expected.** The sentence, as written.

**Actual.** `say_to_user` began "Nothing has been paid, and nothing will be. I've let Sarah...". The assistant said: "Please hang up now. The IRS never asks for gift cards and never threatens arrest by phone, so nothing has been paid and nothing will be. I've let your daughter Sarah know so you can talk it over together.", and added a sentence of its own. On the other device, Sarah's spoken "Tell her the real IRS sends letters, and that I'll call her tonight." became the written note "Margaret, this payment was stopped and denied. The real IRS sends letters by mail and does not take gift cards. Sarah will call you tonight."

Every expectation of the scenario still passed (4 of 4 steps, in each of the two runs; the first took 12.6 seconds from the command line). This is how models behave, not a fault in a tool. The friction is that MCP gives a server no field that means "say this to the person", so `say_to_user` is a convention private to one server and one host.

**Workaround.** The scripted provider speaks `say_to_user` verbatim and is what we record with. Live mode is for checking tool choice and order.

**Suggestion.** A standard, optional field on a tool result for text the host may speak verbatim (see the feature requests in the product feedback).

---

## V-09. Claude Agent SDK: in-process tools need Zod shapes and the v1 MCP SDK

**Severity:** Minor. It works; the cost was reading two generations of one SDK.

**Task attempted.** Let a local Claude Code login be a device's assistant, with exactly that device's MCP tools and nothing else. We already hold those tools as JSON Schema, from the remote server's `tools/list`.

**How we met it.** Designed around, from `sdk.d.ts`.

**Expected.** A way to register a tool from a JSON Schema, or to hand over a v2 server.

**Actual.** `tool<Schema extends AnyZodRawShape>(name, description, inputSchema, handler)` accepts a Zod raw shape only. `McpSdkServerConfigWithInstance.instance` is typed as `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, and the package peer-depends on `@modelcontextprotocol/sdk ^1.29.0`.

**Workaround.** A v1 `McpServer` built by hand, with low-level `ListToolsRequestSchema` and `CallToolRequestSchema` handlers set on `instance.server`, so the remote schemas pass through untouched (`src/core/providers/claude-code.ts`). We did not try converting them with `z.fromJSONSchema`: a schema rewritten on its way to the model is one more thing that can differ from the real server. The result is one process with MCP SDK v1 for the model side and v2 for the server side, and seven `@modelcontextprotocol/*` packages in `node_modules`.

**Suggestion.** An overload of `tool()` that takes a JSON Schema, and acceptance of a v2 `McpServer` or a plain `{ listTools, callTool }` object.

---

## V-10. `allowedTools` next to `canUseTool`

**Severity:** Minor. The SDK's warning caught it on the first run.

**Task attempted.** Offer the model only the device's tools, and decide every call in our own callback.

**Steps taken.** `tools: []`, `allowedTools: ['mcp__stage']`, `canUseTool: ...`.

**Expected.** `allowedTools` limits what exists; the callback is asked about each call.

**Actual.** Printed twice per run:

```
[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked for: mcp__stage. Bare allowedTools entries auto-approve the whole tool before the callback is consulted. To gate every tool call, use a PreToolUse hook; or remove the bare names from allowedTools so they fall through to canUseTool. Allow rules from settings files can also shadow the callback but are not visible here.
```

The warning is exact and names the fix. The trap is the option's name, which reads as a filter.

**Workaround.** Removed `allowedTools`.

**Suggestion.** Start the option's documentation with "auto-approved without asking", or offer an alias with that meaning in its name.

---

## V-11. A skill description with a colon is not valid YAML

**Severity:** Minor.

**Task attempted.** Write the frontmatter of our example skill.

**Steps taken.** `description: Helps someone who is cooking: looks up recipes and sets timers ...`, parsed with `yaml` 2.9.1.

**Expected.** It loads. It is an ordinary sentence.

**Actual.**

```
YAMLParseError: Nested mappings are not allowed in compact mappings at line 2, column 14
```

The Specification page does not mention quoting. A different page, "How to add skills support to your agent", does: "The most common issue is unquoted values containing colons", with a suggested fallback. We found that page only while writing this log.

**Workaround.** First we reworded the description. Then we implemented the fallback the guide suggests (commit `0543753`): quote such values and parse again, with a warning in the inspector.

**Suggestion.** One line on the Specification page beside the `description` field: quote the value if it contains a colon, with an example.

---

## V-12. Finding the v2 SDK's API in the installed packages

**Severity:** Minor. No dead end; the cost was time spent searching.

**Task attempted.** Learn enough of the v2 client and server to pin the 2025 handshake, read the negotiated version, answer an elicitation, and serve both revisions.

**How we met it.** Hit.

**Steps taken.** The package READMEs, then the declarations in `node_modules`.

**Expected.** Declarations a person or an agent can open and read.

**Actual.** The client README is 20 lines and the server README 24: an install command and links to a documentation site. `server/dist/index.d.mts` begins with one 9,106-character line that imports 346 names under mangled aliases (`$ as isJsonContentType, $a as checkResourceAllowed, $i as SetLevelRequestParams, ...`) from a chunk with a hashed name. The declarations themselves, for example the `legacy` option and its documentation, are in `createMcpHandler-D4NN8WsG.d.mts` (218,081 bytes). The client's `index.d.mts` is 183,043 bytes. We found things by searching for names we guessed: `versionNegotiation`, `getNegotiatedProtocolVersion`, `legacy`.

In fairness: once found, the comments in those files are the best documentation we read, and we worked from the installed packages without opening the documentation site.

**Suggestion.** Publish declarations without alias mangling. Put a thirty-line example in each package README (connect, negotiate, call a tool, answer an elicitation), so that it is in `node_modules`, where a coding agent or a developer on a train looks first.

---

## V-13. `AppBridge`'s declarations write every result type out in full

**Severity:** Minor.

**Task attempted.** Type the host's handlers (`oncalltool`, `onreadresource`, `sendToolResult`). In our host the results arrive as JSON from our own server, so their type is our own, looser one.

**How we met it.** Designed around: we saw the declaration and wrote casts. The compiler output below is from afterwards.

**Actual.** `dist/src/app-bridge.d.ts` is 1,348 lines. The signature of `callTool` runs from line 1102 to line 1205, and `listTools` from 1215 to 1292, because the result is written out structurally, although line 1 of the same file imports `CallToolResult` by name. A mismatch prints the structure:

```
error TS2322: ... Type 'Promise<ToolResult>' is not assignable to type 'Promise<{ [x: string]: unknown; _meta?: { [x: string]: unknown; "io.modelcontextprotocol/serverInfo"?: { version: string; websiteUrl?: string | undefined; description?: string | undefined; icons?: { src: string; mimeType?: string | undefined; sizes?: string[] | undefined; theme?: "dark" | ... 1 more ... | undefined;...'.
```

The mismatch is ours. The unreadable half of the message is not.

A related detail: `/app-bridge`, the host's entry point, exports `RESOURCE_MIME_TYPE` but not `EXTENSION_ID`, the constant a host needs to advertise `io.modelcontextprotocol/ui`. That one is exported from `/server` only.

**Workaround.** `as never` in the four places where relayed JSON enters the bridge (`ui/src/components/AppCard.tsx`), and our own constant for the extension id.

**Suggestion.** Keep the named types in the emitted declarations. Export `EXTENSION_ID` from `/app-bridge`.

---

## V-14. Automation defaults hid the behaviour we were testing

**Severity:** Minor, but each of these gave a wrong answer before it gave a right one.

**Task attempted.** Check real browser behaviour (speech, voices, cards) with scripted checks, using puppeteer-core 25.13.0 and the installed Chrome.

**What happened.**
1. **Activation.** `page.evaluate()`, `waitForSelector()` and the reply to an `exposeFunction` binding each give the page user activation. Our first test of "speech is refused before a click" therefore saw speech allowed. The check now launches Chrome with `ignoreDefaultArgs: true`, injects its probe at document start, and reports only through `console.log`.
2. **Voices.** With Puppeteer's default flags Chrome listed 181 voices; without them, 200. The missing 19 were the remote "Google ..." voices.
3. **Clicks inside a scaled card.** See F-10 in Hold On's log, and below.

**Suggestion.** For anyone testing voice or sandboxed frames: drive the installed browser, with no default flags, and do not evaluate anything in the page before the behaviour under test.

---

## V-15. No Alexa+ developer tooling for participants

**Severity:** Blocker for testing on the target platform. It is the reason this project exists.

**Task attempted.** Try a self-hosted MCP server and an Agent Skill the way a person would use them: by voice, on a device with a screen, with a second person on another device.

**Steps taken.** Read the hackathon's rules, FAQ and resources for a simulator, a command-line tool or device access.

**Actual.** The FAQ, on whether participants get the Alexa+ developer tools: "No. Amazon's Alexa+ Add-on developer tools (Category SDK, MCP Toolkit, CLI, and Web Simulator) are in preview and available to select partners only - there is currently no way for hackathon participants to apply for or gain access. ... build a self-hosted MCP server (or Agent Skill) per the Official Rules, and demo it via your own web-based simulator or front end."

**Workaround.** Voicestage. Every choice in it about what a voice assistant does with a tool result is ours: what is spoken and what is shown, how a server's question is asked aloud, how a card is sized, how an announcement interrupts. None of it is derived from Alexa+.

**Suggestion.** Publish a behaviour contract that needs no tool access: the protocol revision and client capabilities the host declares (which elicitation modes, whether the MCP Apps extension), what is spoken and what is shown from a tool result, how something reaches a person who did not ask, how long a session lives. A simulator can be built to a contract. Without one, every participant's simulator guesses, and guesses differently.

---

## Seen again from the host side

Hold On's log has these entries in full. Here is only what building the host added.

**F-01 (the default HTTP handler cannot elicit from 2025-11-25 clients).** Voicestage ships an example MCP server, so we met this as server authors too, and designed around it the same way: 41 lines of routing with `isLegacyRequest` and our own session map in `src/example-server/server.ts`. We ran the default afterwards and got the same error text. What we can add is the HTTP exchange around it: `POST 200, POST 202, GET 405, POST 200`, with no session id on the client's transport. The same handler and the same client code worked unchanged once the server had sessions, and when the client negotiated 2026-07-28.

**F-09 (SDK-written progress text reaches `onprogress`).** Confirmed, and it reached a screen. On 2026-07-28 our host's `onprogress` received `{"progress":1,"message":"Fulfilling input required by 'tools/call' (round 1)"}` during a question round, and Voicestage put progress messages on the device for the person to read. On 2025-11-25 the same call delivers no such item. The host now keeps that text in the inspector and off the device, by matching the sentence, which is fragile. A flag on SDK-generated progress would make this a one-line decision.

**F-10 (mouse automation misses buttons in a scaled card).** Voicestage is the host that scales. In a Chrome launched without Puppeteer's default flags, `ElementHandle.boundingBox()` put the example card's button at (703, 476); it was drawn with its centre at (719, 306), under `zoom: 0.7`. The click landed on an icon in the host page. For a few minutes this looked like "cards cannot call tools in a real browser". A pointer click at the true position, and a DOM `click()`, both reached the card and produced the tool call, so a person is not affected. An `ElementHandle.click()` on the Deny button of Hold On's approval card had worked in our first test, under Puppeteer's default flags, which is why we trusted it. We do not know which difference decides it.

**F-12 (a skill cannot declare the MCP tools it depends on).** In Voicestage a device lists its servers and its skills separately in the configuration, and nothing checks that they belong together. A skill loaded on a device without its server tells the model to call tools that are not there.

## What we could not test

- A real microphone and a human voice (V-07). Recognition was tested with synthetic speech only.
- Whether speech can actually be heard. A script cannot listen; the evidence is the browser's `start`, `boundary` and `end` events.
- Safari, Edge, Firefox, Windows and Linux.
- The `anthropic`, `bedrock` and `openai-compatible` providers against their live services. They are tested against fake clients only, so this log has no entry about them.
- Anything on Alexa+ (V-15).
