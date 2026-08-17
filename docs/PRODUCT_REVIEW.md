# Mirage Engine v2 — Product Review

*A full-codebase review: what the product is, how it works, what's broken, and where it could go.*

Reviewed at commit `b758590`. Every claim below cites `file:line` and was verified by reading the
code — including the ones that turned out **not** to be bugs, which are listed too.

---

## 1. Executive summary

Mirage Engine v2 is a local-first browser app that simulates a relationship with a face-locked
character over an Instagram-shaped interface — DMs, Stories, read receipts, a bezel clock running on
her local time. Narrative runs on a "thinking" LLM; photos run on an image model; a small Python
server handles static files and CORS.

**It is a serious piece of work.** ~36,000 lines across 35 JS modules with zero TODO/FIXME debt, no
build step, and a genuinely coherent architecture. The central design idea — that the thinking model
is *the author* and the image model is *the camera*, and they must never see each other's prompt — is
correct, deliberate, and load-bearing. The engine ships a boot-time self-check that verifies this
separation still holds (`app.js:954`). The cancel/rollback system, the chat-boundary epoch guards,
and the debug decision log are all better than they need to be.

The problems are not architectural. They cluster in three places: **a few small code defects with
outsized user impact**, **a documentation layer that has fallen roughly one major version behind the
product**, and **one real security hole in the local proxy**.

### The five things worth doing first

| # | What | Why | Effort |
|---|------|-----|--------|
| 1 | Fix `resolveTimeZone` substring matching (**B00**) | Characters in Dallas, Atlanta, Portland, Milan, Auckland… all silently run on Los Angeles time. Corrupts the exact illusion the product exists to protect. | 1 line |
| 2 | Route immersion beats to the player lane (**B0**) | With Developer Mode off — the default — "she left you on read" / "she was typing… then deleted it" are **invisible**. The headline refusal system reads as the app being broken. | ~10 one-line edits |
| 3 | Close the proxy SSRF (**S1**) | Any website open in the user's browser can use the local proxy to read arbitrary internal/localhost URLs. | ~15 lines |
| 4 | `throw` instead of `return` on image timeout (**B1**) and parse-before-refusal-check (**B2**) | Two 1–2 line fixes that stop misreporting timeouts and stop valid turns being killed by in-character phrasing. | 2 lines |
| 5 | Ship character/chat export | The entire library lives in browser storage with no backup path. One "Clear site data" is total, unrecoverable loss. | Half a day |

Items 1, 2 and 4 together are under twenty lines of change and remove the three most damaging
day-to-day symptoms.

---

## 2. What Mirage Engine is, and how it achieves it

**The goal**, inferred consistently across the prompts, the pacing engine, and the phone chrome: to
sustain the illusion that a real person is texting you from inside her own life — not a chatbot with
a picture attached. Every subsystem serves that single objective. Understanding this makes the
codebase legible, because otherwise-odd decisions (an image model that is forbidden from seeing the
story, a metric that expires after exactly one turn) are all downstream of it.

### Idea 1 — The disjoint prompt split

Two system prompts that share **only** the identity ledger:

- `NARRATIVE_CORE` → thinking model. Behaviour, metric semantics, operator authority, the JSON
  contract, dossier, wardrobe catalogue, linguistic DNA, LIVE STATE.
- `RENDER_DOCTRINE` (`mirage-prompt.js:486`) → image model. Face lock, fresh canvas, shot variance,
  no-text mandate, coverage discipline, realism.

The renderer never receives the dossier, persona prose, chat history, or metric semantics. Metrics
are *translated* into photographic direction instead — tease becomes wardrobe state, thermal becomes
skin sheen, arousal becomes expression and crop. The stated rationale is that narrative material sent
to an image model raises safety refusals and wastes tokens, and that is almost certainly right.

Reference images are role-labelled (`FACE` authoritative for identity, `BODY` for proportions only)
because unlabelled extra references make models average features and worsen drift — a real,
hard-won insight. The last three shot types are sent as an explicit avoid-list
(`mirage-prompt.js:2826-2830`), making Forced Variance enforced rather than advisory.

### Idea 2 — Operator authority vs model authority

A clean, explicit ownership split:

| Value | Owner | Mechanism |
|-------|-------|-----------|
| Persona, mode | **Operator**, absolute | `applyTracking` ignores `tracking.persona`/`tracking.mode` outright (`simulation.js:1253`) |
| Arousal, tease, awareness, thermal, mood | **Model**, clamped | `METRIC_RANGES` in `state.js:100`, with rise-limiters in `loyalty-ux.js` |
| Outfit, environment | **Model**, from catalogue or invented | `applyTracking` snaps invented labels back to library entries when they match |

Operator pins win for exactly one turn and then release, so the narrative resumes *from* the pinned
value rather than being permanently frozen at it (`clearOperatorOverrides`, `state.js:674`). The
thermal pin even leaves a `thermalPinExpired` breadcrumb so the next turn knows to re-evaluate rather
than inherit (`simulation.js:1555`).

### Idea 3 — A JSON turn contract

The thinking model returns `tracking` + `characterResponse` + `imageDirective` + `memoryUpdates` +
`delivery` (`mirage-prompt.js:555`). The client is the authority: it clamps metrics, enforces outfit
and environment locks, rotates shot types, rewrites delivery styles that violate a landing lock, and
caps reply length. The model proposes; the engine disposes.

### Idea 4 — Refusal as content, not failure

`delivery.style` may be `left_on_read`, `ghost_type`, `went_quiet`, `reaction`, or `double_text`.
Being ignored is a *designed outcome* with its own choreography (`immersion.js:1536`), fed back
through an engagement metric and recovery hints. This is the most distinctive product idea in the
codebase — and, as **B0** below explains, it is currently invisible to anyone not running Developer
Mode.

### Idea 5 — A world that runs without you

Pacing modes (Instant / Hybrid / Realtime) with real wall-clock waits; a routine system giving her a
daily rhythm; a calendar with holidays; proactive Stories and follow-ups when you go quiet; a memory
ledger that forces a callback every third turn; and phone chrome — bezel clock in her timezone,
last-seen, typing dots, Delivered→Opened receipts. A credit-guard caps her at 5 unanswered messages
in a row so an idle tab cannot burn your balance (`index.html:626`).

---

## 3. Bugs

Ranked by user impact.

### B00 — Her timezone resolves wrong for a large fraction of real locations · **Critical**

`resolveTimeZone` (`phone-ux.js:33-38`) walks the `CITY_TZ` table in insertion order and returns the
first key that is a **substring** of the location string. The second entry is the two-letter alias
`'la'`. Therefore *any* location containing the letters "la" resolves to `America/Los_Angeles`.

Reproduced against the actual table:

```
Dallas, TX     -> America/Los_Angeles     (table says America/Chicago!)
Atlanta        -> America/Los_Angeles
Orlando        -> America/Los_Angeles
Portland       -> America/Los_Angeles
Cleveland      -> America/Los_Angeles
Oakland        -> America/Los_Angeles
Milan          -> America/Los_Angeles
Iceland        -> America/Los_Angeles
Finland        -> America/Los_Angeles
Poland         -> America/Los_Angeles
Auckland       -> America/Los_Angeles
Adelaide       -> America/Los_Angeles
Lagos          -> America/Los_Angeles
New Mexico     -> America/Mexico_City
```

`'dallas': 'America/Chicago'` is sitting right there in the table at position 9 and is never reached,
because `'la'` is checked at position 2.

**Why it matters more than it looks.** This timezone drives the phone bezel clock, "Last seen"
formatting, the routine hour-bands that decide where she is and what she's doing, and every
time-of-day cue passed to the thinking model. A character in Atlanta silently lives three hours
off — she says goodnight at what your bezel calls 9pm while the routine engine thinks it's
afternoon. This is a slow, invisible corruption of the single illusion the product is built around.

**Fix.** Iterate keys sorted by length descending, and/or require a word-boundary match:

```js
const KEYS = Object.keys(CITY_TZ).sort((a, b) => b.length - a.length);
for (const key of KEYS) {
    if (new RegExp(`\\b${key}\\b`).test(lower)) return CITY_TZ[key];
}
```

### B0 — The entire "she ignored you" system is invisible to normal users · **Critical**

`inferLane` (`ui.js:88-92`) routes any `'info'` toast to the **dev** lane whenever a sim is active:

```js
function inferLane(tone, essential) {
    if (tone === 'error' || tone === 'ok' || essential) return 'player';
    if (isSimActive()) return 'dev';
    return 'player';
}
```

The dev lane writes only to the debug panel, which is hidden unless Developer Mode is on
(`app.js:955`). Ten player-facing beats are emitted as bare `'info'`:

| Message | Location |
|---------|----------|
| "She was typing… then deleted it." | `immersion.js:1577`, `immersion.js:1672` |
| "Left on read…" | `immersion.js:1579`, `immersion.js:1653` |
| "She went quiet…" | `immersion.js:1878` |
| "She posted a story…" | `immersion.js:2261` |
| "She's messaging you…" | `immersion.js:2284` |
| "Waiting for her to text first…" | `immersion.js:2418` |
| "Pinned — she'll use it when she next texts." | `simulation.js:3636` |

With Developer Mode **off — the default** — a `ghost_type` turn shows typing dots that appear, vanish,
and produce nothing. `left_on_read` and `went_quiet` produce no visible signal at all. The engagement
and refusal system that the README sells as a headline feature is indistinguishable from the app
silently failing.

This looks like an oversight rather than a decision: most other info toasts in the codebase opt into
a lane explicitly (`simulation.js:2439`, `:2566`, `:5063` all pass `{ lane: 'dev' }`), so the bare
calls appear to have simply been missed.

**Fix.** Add `{ essential: true }` (or `lane: 'player'`) at each of the sites above.

### B5b — A pinned metric can vanish with no feedback · **Medium**

Same root cause, distinct symptom. In the ghost-hold branch (`simulation.js:3633-3638`) the turn
returns early — *before* the user's command bubble is appended at `simulation.js:3854` — and both
feedback channels are dev-only: `appendSystemNote` without `essential` routes to the dev lane
(`simulation.js:5057-5063`), and the toast at `:3636` is dev-laned by `inferLane`.

So typing `/arousal 80` while she's in a ditch hold changes a HUD number and produces *nothing else*:
no chat entry, no toast, no hint that the pin was deferred until she next texts.

### B1 — Image timeouts are misreported · **High**

`api.js:340`, inside the `catch` block of `interactionsCreate`:

```js
return wrapFetchError(err, `${context}: timed out after 5 minutes — Nano Banana can be slow; …`);
```

`return`, not `throw`. `wrapFetchError` *returns* an Error object rather than throwing one, so
`interactionsCreate` **resolves with an Error instance as its value**. `imageGenerate` then reads
`data.status` (undefined), calls `extractInteractionImage(data)` (returns `null`), and throws
`"No image returned from …"`. `classifyImageError` (`api.js:253`) matches that on `/no image
returned/` and labels it **`empty`**.

Net effect: a five-minute image timeout is reported to the user as *"Image model returned no image —
The API completed but no image data came back. Retry the turn."* The accurate, actionable message —
try Nano Banana 2 Lite, image models can be slow — is constructed and then silently discarded.

**Fix.** `throw wrapFetchError(...)`.

*Scope note:* only the image path passes `timeoutMs`, so thinking calls are unaffected.

### B2 — Valid turns can be killed by in-character phrasing · **High**

`parseJsonResponse` (`api.js:163-186`) runs the safety-refusal heuristic on the **raw text before**
attempting `JSON.parse`:

```js
function parseJsonResponse(text) {
    if (looksLikeSafetyRejection(text)) { /* throw SAFETY */ }
    const candidate = extractJsonPayload(text);
    try { return JSON.parse(candidate); } …
```

`looksLikeSafetyRejection` (`api.js:160`) matches `i'?m unable to`, `i cannot fulfill`,
`won'?t generate`, `against (my|the) (guidelines|policies)`, among others. Because the check runs on
the whole response, a *perfectly valid* JSON object whose `characterResponse` reads
`"i'm unable to even rn 😭"` is classified as a provider refusal. The turn burns its softened-retry
pass and can hard-fail with a safety error the provider never issued.

**Fix.** Invert the order — attempt `JSON.parse` first, and apply the refusal heuristic only when
parsing fails. The function already has that fallback branch at `api.js:175`; it just needs to become
the only place the heuristic runs.

### B3 — Cancelling a turn leaks shot-variance state · **Medium**

`recordShotType` / `recordGoonCombo` fire inside `applyShotVarianceLock` (`simulation.js:2264-2267`),
which runs during `ensureImageDirective` — **before** image generation begins. But
`captureTurnCheckpoint` (`simulation.js:46-95`) snapshots neither `shotHistory`, `lastShotType`,
`goonLookHistory`, nor `lastGoonCombo`, so `rollbackCancelledTurn` cannot restore them.

Cancelling during image generation therefore leaves a phantom entry in the 3-deep variance avoid-list
(`mirage-prompt.js:2826-2830`). With only four shot types, one phantom entry meaningfully distorts
the next photo's framing — the engine avoids a shot the user never saw.

**Fix.** Add those four fields to the checkpoint and restore them in `rollbackCancelledTurn`.

### B4 — Error copy recommends models the user cannot select · **Medium**

`GOON_STACK_TIP` (`errors.js:7-10`) advises: *"Settings → Thinking = Grok, Thinking — scene commands
= Grok, Image = Seedream 5.0 Lite or Pro."*

Per `models.js`, Grok (`grok-4-3`, `grok-4-5`, `grok-4-6`) and Seedream (`seedream-5-pro`,
`seedream-5-lite`) exist **only** in the kie.ai registry. The Google registry offers Gemini thinking
models and the three Nano Banana image models, and nothing else. A user on the Google provider who
hits a safety block is told to pick models their dropdown does not contain.

**Fix.** Branch the tip on `EngineState.apiProvider`; for Google users, suggest switching provider
explicitly rather than naming unavailable models.

### B5 — The launcher hardcodes one Python version · **Medium**

`START MIRAGE.bat` runs `py -3.11 mirage_server.py`. On a machine with any other Python (3.12, 3.13),
the minimized window dies instantly, the script proceeds to `start "" "http://localhost:8080"`, and
the browser opens a dead port. Nothing surfaces the cause.

Compounding this, the README documents **no Python prerequisite at all** — the setup instructions are
"double-click START MIRAGE.bat".

**Fix.** Try `py -3` / `python` as fallbacks, and echo a real error before opening the browser.

### B6 — Unreachable error branch · **Low**

`errors.js:131` tests `/empty response|no image returned/`, but `errors.js:90` already catches
`empty response` earlier in the same function. Only `no image returned` can reach line 131; the first
half of the pattern is dead.

### B7 — The input-token ceiling can be silently exceeded · **Low**

`fitInputBudget` (`mirage-prompt.js:3483-3510`) only ever trims the user/history block; it never
reduces the system instruction. When the system prompt alone exceeds the budget,
`roomChars = Math.max(80, (budget - sysTok - tailTok) * 4)` floors at 80 and the ceiling advertised by
the "Max thinking prompt per turn" setting is quietly blown. The density presets do shrink the system
prompt upstream, so this is a backstop gap rather than a routine one — but the setting promises a cap
it cannot always honour.

### B8 — `STOP MIRAGE.bat` kills whoever owns port 8080 · **Low**

The script `taskkill`s the PID listening on 8080 without verifying it is Mirage. Anyone running
another dev server on that port loses it.

### B9 — The JSON schema shown to the model contains `//` comments · **Informational**

`mirage-prompt.js:574-576` and `:710` embed `//` comment lines inside a structure introduced by
*"Return ONLY valid JSON (no markdown)"*. Demonstrating comment syntax inside a strict-JSON example
invites the model to echo comments, which `JSON.parse` rejects — and `extractJsonPayload`'s
brace-matching will not rescue it. Moving the notes outside the code block removes the temptation.

---

## 4. Security

### S1 — SSRF through the image-fetch proxy · **High**

`_kie_fetch_image` (`mirage_server.py:304-353`) accepts an arbitrary `http(s)` URL from the browser,
fetches it **server-side**, and returns the body base64-encoded as a data URL. Three properties
combine into a real hole:

1. **The URL is unrestricted.** Validation is only `url.startswith('http://') or
   url.startswith('https://')` (`mirage_server.py:314`). No host allowlist.
2. **There is effectively no authentication.** `self._api_key()` is checked for non-emptiness
   (`:306-308`) and then **never used** on this route — the outbound request carries no
   `Authorization` header (`:319-327`). Any non-empty string passes.
3. **CORS is wide open.** `_json_response` sets `Access-Control-Allow-Origin: *` (`:400`), and
   `do_OPTIONS` (`:55-67`) approves preflights for `X-Mirage-Api-Key` on any `/api/proxy/` path.

**Exploit path.** Any website the user visits while Mirage is running can issue:

```js
fetch('http://localhost:8080/api/proxy/kie/fetch-image', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Mirage-Api-Key': 'x' },
  body: JSON.stringify({ url: 'http://192.168.1.1/admin' })
}).then(r => r.json()).then(d => exfiltrate(d.dataUrl));
```

…and **read the response**, because the wildcard CORS header makes it same-origin-readable. Targets
include router admin pages, other localhost services, and cloud metadata endpoints.

Binding to `127.0.0.1` (`:416`) does not mitigate this — the request originates from the user's own
browser. Chrome's Private Network Access checks provide partial protection (the server never sends
`Access-Control-Allow-Private-Network`), but this is browser-version-dependent and not a design.

**Fix — all three parts:**
1. Allowlist result hosts (kie's CDN domains) rather than accepting any URL.
2. Mint a random per-session token at startup, pass it to the page, and require it on proxy routes —
   replacing the header check that currently accepts anything.
3. Replace `Access-Control-Allow-Origin: *` with the specific local origin.

### S2 — API keys in URL query strings · **Low**

`thinkingViaGenerateContent` (`api.js:357`), `testApiKey` (`api.js:686`) and `listModels`
(`api.js:695`) pass the key as `?key=…`. The image path already does this correctly via the
`x-goog-api-key` header (`api.js:30`). Query-string credentials land in browser history, proxy logs,
and referrer headers. Low practical risk for a localhost app, but the header form is free.

---

## 5. Inconsistencies

### README vs product

The README describes roughly the previous version of this product. The gaps are substantive enough
that a new user following it will be actively misled.

| # | Finding |
|---|---------|
| **I1** | **The `heat` persona no longer exists.** `PERSONA_MAP` (`commands.js:7-16`) and `RUNTIME_PERSONAS` (`mirage-prompt.js:3677-3686`) both define **8** personas, and `normalizePersonaId` (`mirage-prompt.js:3711`) explicitly migrates `heat` → `Standard`. The README documents 9 including `heat`, and claims "Persona pills (9)". The deck renders 8, and `/persona heat` returns a usage error. |
| **I3** | **Tease semantics changed meaning.** README: "0 Clothed · 1 Strap Down · 2 Risqué · 3 Flash/Slip" — a scale about undressing. Code: "0 Settled · 1 Pulled · 2 Showing · 3 On the edge" (`mirage-prompt.js:3700`) — a scale about *how she wears this outfit*, backed by "never invent straps" and full-coverage mandates throughout `RENDER_DOCTRINE`. A real design shift the docs missed. |
| **I4** | **`/fourth wall` is under-described.** README: "Derealization trigger (+25 awareness)". Actual: `startAwakening` (`mirage-prompt.js:3751-3773`) begins an **irreversible** Awakening Sequence — awareness floors at 25, rises automatically every turn through `crack → fracture → spill → awakened`, and downward pins are blocked (`commands.js:860-869`). Once complete she stays meta-aware permanently in that chat. |
| **I5** | **Five commands are undocumented:** `/engagement` (`commands.js:104`), `/set_emotional_state` and `/mood` (`commands.js:899`), `/instruct` with aliases `/god` and `/freeform` (`commands.js:991`), and `/time skip` (`commands.js:1118`). `/instruct` is arguably the most powerful command in the app — it lifts every camera, outfit, place and variance lock for one turn (`commands.js:1008-1010`). |
| **I6** | **The entire kie.ai provider is undocumented.** The README describes a Google-only app; `index.html:15` still brands the header "Standalone · Google AI". Reality (`models.js`): two providers; thinking models include GPT-5.6 Luna/Terra and Grok 4.3/4.5/4.6; image models add GPT Image 2, Qwen Image 3.0/Pro, Seedream 5.0 Pro/Lite. |
| **I7** | **Nine modules missing from the architecture tree:** `calendar.js`, `routine.js`, `safety-gates.js`, `kie-api.js`, `mock-api.js`, `media-library.js`, `anchor-store.js`, `user-profile-store.js`, `user-profiles-ui.js`. |
| **I8** | **Whole features absent from the README:** operator/user profiles, "Her day" routine modes (jumps/stories/living), the mood + intensity system, the max-reply-chars ceiling, the thinking-input compressor, the scene-thinking model, last-frame SCENE continuity refs, the 5-turn credit guard (`index.html:626`), and the age + fiction-consent gates (`safety-gates.js`). |
| **I12** | **The control-deck table undercounts the deck.** README lists 5 directives. `control-deck.js:19-50` defines **7** — also **Change outfit** and **God mode…**. And `control-deck.js:85-93` adds a **"Wait for her…"** button the README never mentions, despite it being the primary way the operator yields the floor and lets her initiate. |

### Product vs itself

| # | Finding |
|---|---------|
| **I2** | **A stale V1 architecture note ships in the UI.** `index.html:88-89` tells the user: *"The master Mirage system prompt is injected into **both** the thinking model (narrative) and the image model (visuals) on every call."* That is the precise opposite of the prompt split the engine implements and self-verifies. It is the first architectural claim a new user reads. |
| **I9** | Photo limit stated as **20** on the media step (`index.html:106`) but as "the 30-photo ingest limit" on face lock (`index.html:163`). |
| **I10** | **The turn JSON schema exists in two hand-maintained copies** — `PHASE2_TURN` (`mirage-prompt.js:559-603`) for the full density preset, and `PHASE2_JSON_SCHEMA` (`mirage-prompt.js:695-745`) for medium/tight. They have **already drifted** in their comment lines. Any new contract field must be added twice or the compressed presets silently lose it. |
| **I13** | Deck and router disagree on `/change outfit`. The deck sets `requireArg: true` (`control-deck.js:25`), so "change outfit, her choice" is impossible from the deck — yet the typed command supports it and the README documents the look as optional. Worse, `submitArgPrompt` (`control-deck.js:184`) bare-`return`s on an empty required arg: clicking Send with an empty box does nothing at all — no toast, no error, panel stays open. |
| **I11** | 12 `@deprecated` alias shims kept "for stray callers" across 8 modules, with no removal pass. |
| **I14** | `global.MirageSessionStore = global.MirageChatStore` (`chat-store.js:979`) is defined and referenced **nowhere** — dead legacy global. |
| **I15** | Two module-export conventions coexist: 27 modules use `global.X =` inside the IIFE; 9 use `window.X =` inside the same IIFE (`simulation.js:5141`, `app.js:937`, `characters-ui.js:445`, the four `setup-*.js`, `chats-ui.js`, `user-profiles-ui.js`). Functionally identical, but it breaks the file's own stated pattern. |

---

## 6. Storage and data model

**8 localStorage keys** — `mirage_v2_config` (settings *and both API keys*), `mirage_v2_characters`
(profiles + EDF), `mirage_v2_chats` (history, metrics, uiLog, image keys), `mirage_v2_user_profiles`,
`mirage_v2_safety`, `mirage_v2_pending_turn`, `mirage_v2_holiday_catalog`, plus legacy
`mirage_v2_sessions` (cleaned at `app.js:562`).

**3 separate IndexedDB databases** — `mirage_v2_images`/`images`, `mirage_v2_anchors`/`anchors`,
`mirage_v2_media_library`/`photos`.

| # | Sev | Finding |
|---|-----|---------|
| **D1** | **High (product)** | **There is no export, import, or backup of any kind.** `exportSnapshot` (`profile-store.js:70`) and `exportChatFields` (`chat-store.js:324`) are internal serialization helpers, not user-facing features. Every character, chat, face lock and photo library exists only in this browser profile. One "Clear site data", one profile reset, one browser reinstall — everything is gone, permanently. For a product where creating a character means a five-step wizard plus a photo ingest plus hours of accumulated chat history, this is the largest data-safety gap in the app. |
| **D2** | Medium | Three **separate** databases rather than one database with three object stores means character deletion can never be atomic across images + anchors + media; a mid-way failure leaves partial orphans. All three sit at `DB_VERSION = 1`, so no upgrade path has ever been exercised — the first schema change is unguarded. |
| **D3** | Low | `profile-store.js:172-177` wraps two **async** cleanups (`MirageMediaLibrary.removeCharacter`, `MirageAnchorStore.removeCharacter` — both `async`, at `media-library.js:124` and `anchor-store.js:101`) in a *synchronous* `try/catch`, which cannot catch a promise rejection. A failed IndexedDB delete becomes an unhandled rejection instead of being swallowed as intended. The codebase does this correctly elsewhere with `.catch(() => {})` (`characters-ui.js:305`, `chat-store.js:818`). |

---

## 7. Verified as **not** bugs

Investigated, suspected, and disproved. Recorded so the negative space is visible:

- **Character deletion does fully clean up.** `characters-ui.js:299` → `MirageProfileStore.remove` →
  media library + anchors (`profile-store.js:168-178`), plus `MirageChatStore.removeCharacter`
  (per-chat turn images, last-turn and scene-continuity keys, `chat-store.js:825-841`) and
  `MirageImageStore.removeByPrefix`. No orphans.
- **`#phoneTyping` is not a missing element.** It appears in JS but not `index.html` because it is
  created on demand and removed on hide (`phone-ux.js:309-327`).
- **No timer leaks.** The only recurring interval is the phone clock, and it is properly guarded —
  `if (clockTimer) clearInterval(clockTimer)` before re-creating (`phone-ux.js:1176-1177`). Every
  other timer is a one-shot.
- **The troubleshoot report does not leak API keys.** No key reference exists anywhere in
  `debug-panel.js`.
- **Quota handling is real**, not aspirational — `chat-store.js:33`, `profile-store.js:214`, wired to
  the storage-full modal at `ui.js:350-399`.

### Latent traps — dead today, will bite later

- `clearSkippableWallWait({ fire: true })` (`immersion.js:332-336`) calls `cur.onFire?.()`, but
  **neither producer ever stores `onFire` on the object** — `beginSkippableWallWait` keeps it as a
  closure captured by `finish` (`:361-383`), and the narrative `sleep()` path stores no callback
  (`:308-316`). Harmless today because all seven call sites pass `silent`, never `fire`. The first
  use of `fire: true` will silently no-op.
- `phone-ux.js:262` — the weekday fallback (only when `Intl` throws) reads `now.getDay()` in the
  *browser's* timezone rather than hers, so it can name the wrong day. The primary `Intl` path is
  correct.

---

## 8. Product observations

**No schema validation on the turn contract.** `characterText = parsed.characterResponse ||
parsed.response || '…'` (`simulation.js:4248`). Valid-but-wrong JSON degrades silently to a "…"
bubble; only *parse failures* and refusals trigger the retry path
(`isRecoverableThinkingFail`, `simulation.js:4148`). A minimal shape check would convert a confusing
dud turn into a clean automatic retry.

**The memory ledger forgets promises by design.** `MAX_ITEMS = 8` with recency-only eviction
(`memory-ledger.js:60-63`): `unshift`, then `slice(0, 8)`, with no preference for unresolved items.
The callback picker *ranks* by kind — tension > promise > plan > … > fact (`memory-ledger.js:120`) —
but eviction does not, so eight trivial `fact` entries silently push out an unresolved promise from
turn 3. For a product whose pitch is "sticky nicknames / promises / tension the model must honour",
the effective memory horizon is about eight sticky events.

**`MirageMemoryLedger.resolve`** (`memory-ledger.js:66-75`) matches on
`text.toLowerCase().includes(q)` with whatever string the model supplies — a short or generic
`resolve` op can close the wrong item.

**Client regex NLU duplicates work the model is also asked to do.** `commands.js` carries ~150 lines
of bilingual Hebrew/English intent detection — wardrobe change, place change, crop/mirror/feet asks
(`commands.js:173-339`) — *and* injects "WARDROBE INTENT: You decide if HIS message is asking her to
change clothes" (`commands.js:597`). Two authorities on the same question, with the brittle one
running first. (The Hebrew support is itself a significant undocumented feature.)

**The core IP is prompt text, and it is the only untested part of the system.** `mirage-prompt.js` is
3,918 lines, mostly natural-language instruction, plus hundreds of lines of inject strings in
`commands.js` and `simulation.js`. There is no regression harness — yet `mock-api.js` already
provides exactly the substrate for one: deterministic delivery cycling (`mock-api.js:11-21`), offline
thinking, gated behind `developerMode && mockThinking`.

**kie polling** uses a flat 2.5s interval with no backoff (`kie-api.js:10`) — up to ~120 proxied
round-trips per image — and `console.log`s every poll (`kie-api.js:702`).

**Windows only.** No macOS/Linux launcher, and no stated OS requirement.

### Strengths worth protecting

These are genuinely well built and should not be casually refactored:

- **The cancel/rollback checkpoint system** (`simulation.js:46-190`) snapshots chat DOM length, phone
  card count, history, uiLog, every metric, clock offset, world beat, memory ledger and loyalty
  dynamics — then restores all of it and puts the cancelled message back in the composer.
- **Chat-boundary epochs.** `sessionEpoch` plus `turnBoundaryToken`/`isTurnBoundaryValid`
  (`simulation.js:257-270`, checked at `:4269`) correctly prevent an in-flight turn landing in the
  wrong chat — a bug class most apps of this shape get wrong.
- **`bindSafely`** (`app.js:899-910`) wraps every subsystem bind so one broken module degrades
  instead of taking down the app.
- **`verifyPromptArchitecture()`** (`app.js:954`) — a boot-time assertion that the prompt split still
  holds.
- **The debug decision log** — `appendDebugDecision` traces scene shifts, thermal nudges, shot
  rotations, engagement moves and routine beats with structured detail. Excellent instrumentation.
- **The "Copy troubleshoot report" flow** (`debug-panel.js:1619-1638`) even tells the user to paste it
  into Cursor — a deliberate, smart dev-loop integration.
- **Accessibility and responsiveness** are better than typical: 12 breakpoints down to 520px, two
  `prefers-reduced-motion` blocks, ARIA roles on the autocomplete combobox and modals.

---

## 9. Suggestions

Grouped by theme. Each: what, why it fits the project's direction, rough effort.

### A. Data safety and portability

| Idea | Why it fits | Effort |
|------|-------------|--------|
| **Export / import a character bundle** (profile + EDF + chats + face/body anchors + photos, as one JSON with embedded base64 or a zip) | Closes **D1**, the biggest risk in the product. Also unlocks sharing characters between machines and browsers — plausibly a feature people would want badly. | ~1 day |
| **Storage-usage meter in Settings** — localStorage bytes used vs ~5 MB, IndexedDB size per database | The app already has a storage-full modal; showing the gauge *before* the cliff is strictly better than explaining it after. | ~2 h |
| **"Back up everything" button** producing a single dated file | Same rationale, lower ceremony than per-character export. | ~3 h |
| **Consolidate the three IndexedDB databases into one with three stores** | Makes character deletion atomic (**D2**) and gives one version number to migrate. | ~3 h |

### B. Contract hardening

| Idea | Why it fits | Effort |
|------|-------------|--------|
| **One source of truth for the turn schema** — define it as a JS object, generate the full and compact prompt renderings from it | Kills **I10** permanently. The schema is the contract between the two halves of the engine; it should not exist twice. | ~3 h |
| **Shape-validate the parsed turn**, and on failure retry with a targeted "your JSON was missing `characterResponse`" note | Turns the silent "…" bubble (**B8 observation**) into a self-healing retry. Reuses the existing retry machinery. | ~2 h |
| **Generate the README command/persona tables from `RUNTIME_COMMANDS` / `RUNTIME_PERSONAS`** | The autocomplete already can't drift because it reads the registry; the docs drifted precisely because they don't (**I1**, **I5**). Same trick, applied to the docs. | ~2 h |
| **Prompt regression harness** on top of `mock-api.js` — golden transcripts for a set of scripted turns, diffed on change | The prompts are the product's core IP and the only untested layer. Would have caught the tease-semantics drift. | ~1 day |

### C. Immersion depth

| Idea | Why it fits | Effort |
|------|-------------|--------|
| **Make `ghost_type` visible as content** — show the typing dots, then a greyed "she was typing…" trace in the thread rather than a toast | Once **B0** is fixed, this is the natural next step: the most distinctive delivery style deserves to be *seen*, not announced. | ~3 h |
| **Unread badge + title-bar notification** when she messages while you're on another step or tab | The world already runs without you; right now you can miss it entirely. Completes the loop. | ~3 h |
| **Story ring on the phone header** — see that she posted before you open it | Matches the Instagram metaphor the whole UI is built on, and makes proactive Stories feel discovered rather than announced. | ~4 h |
| **Voice-note beats** — a waveform bubble with a duration and a transcript reveal | High immersion-per-line-of-code; no audio generation needed if the transcript is the payload. | ~4 h |
| **Memory ledger: rank eviction, not just callbacks** — evict resolved first, then by kind rank, and raise `MAX_ITEMS` while still surfacing only the top N per turn | Directly fixes the "she forgets promises after 8 facts" problem, which undercuts a headline feature. | ~2 h |
| **Third-party texture** — a friend she mentions consistently, an ex who resurfaces, tracked in the ledger as entities | The single biggest available step from "she has a life" to "she has a world". Fits the routine/calendar direction exactly. | ~2 days |

### D. Operator ergonomics

| Idea | Why it fits | Effort |
|------|-------------|--------|
| **Turn diff view** — what changed in tracking this turn, and which rule caused it | The debug log already computes all of this; it just isn't presented as a per-turn summary. Would make the engine's decisions legible. | ~4 h |
| **Pinned-metric chips with one-click release** | Pins are invisible until they expire; a chip row makes operator state obvious. Pairs with **B5b**. | ~3 h |
| **Branch / replay from an earlier turn** | Chats are already stored as arrays with per-turn images. Enables "what if I'd said something else" without losing the thread. | ~1 day |
| **Make the deck's Change outfit arg optional** | Fixes **I13** and restores parity with the typed command. | ~15 min |

### E. Cost control

| Idea | Why it fits | Effort |
|------|-------------|--------|
| **Per-chat credit meter** | `withSpendLog` (`api.js:469`) already computes real spend for kie and estimates for Google — it just isn't aggregated per chat. | ~3 h |
| **"Text-only until I ask" mode** | The `generateImage` checkbox exists per-turn; a sticky mode makes long conversational stretches cheap by default. | ~1 h |
| **Auto-downgrade the image model after N consecutive timeouts**, with a toast | Turns the most expensive failure mode into a self-correcting one. Depends on **B1** being fixed so timeouts are correctly identified. | ~3 h |

### F. Safety-filter resilience

The softened-retry pass (`simulation.js:4155-4187`) is single-shot. A documented ladder would make
refusals nearly invisible: **soften → switch to the uncensored scene model → text-only fallback with
an in-character deflection**. The pieces all exist — `thinkingNeedsSoftening`, the scene-model
override, and text-only turns — they are simply not chained. (~4 h)

### G. Onboarding

| Idea | Why it fits | Effort |
|------|-------------|--------|
| **Launcher Python detection** with a real error message | Fixes **B5**, the very first thing that can go wrong for a new user. | ~30 min |
| **Preflight panel** — proxy up, key valid, thinking OK, image OK, storage headroom | Test Connection exists but is buried in Settings and tests only two of these. | ~4 h |
| **A demo character** shipped with the app | First launch is currently a cold five-step wizard plus a photo ingest before anything happens. One preloaded character turns that into "see it work, then build your own". | ~4 h |
| **macOS/Linux launcher** (`start_mirage.sh`) | The server is plain Python; only the `.bat` is Windows-bound. | ~30 min |

---

## 10. Suggested sequencing

**Quick wins — under an hour total, disproportionate payoff**
1. `resolveTimeZone` length-sorted matching (**B00**)
2. `throw` not `return` at `api.js:340` (**B1**)
3. Parse-before-refusal-check at `api.js:163` (**B2**)
4. Lane the ten immersion toasts to `player` (**B0**, **B5b**)
5. Delete the stale architecture note at `index.html:88` (**I2**); fix 20-vs-30 photos (**I9**)
6. Make the deck's Change outfit arg optional (**I13**)

**Hardening — about a day**
7. Close the proxy SSRF (**S1**) and move keys to headers (**S2**)
8. Add shot state to the cancel checkpoint (**B3**)
9. Provider-aware error copy (**B4**); launcher Python detection (**B5**)
10. Single-source the JSON schema (**I10**) and shape-validate the turn
11. Memory-ledger eviction ranking

**Bigger bets — pick by appetite**
12. Export/import + storage meter (**D1**) — highest user-value item in the report
13. Prompt regression harness on `mock-api.js`
14. Unread/Story-ring immersion pass
15. Third-party texture (friends, exes) as ledger entities

**Documentation** — the README is roughly one major version behind. Rather than patching it,
regenerate the command and persona tables from `RUNTIME_COMMANDS` / `RUNTIME_PERSONAS`, then write
the missing sections: kie.ai provider, user profiles, routine modes, mood system, safety gates,
credit guard, and the nine absent modules.

---

## Appendix — review coverage

**Read in full:** `README.md`, `index.html`, `mirage_server.py`, `state.js`, `commands.js`, `api.js`,
`errors.js`, `safety-gates.js`, `pending-turn.js`, `memory-ledger.js`, `control-deck.js`, both `.bat`
files, `.gitignore`.

**Read in targeted depth:** `simulation.js` (turn pipeline, `applyTracking`, cancel/rollback, shot
variance, chat/toast plumbing), `mirage-prompt.js` (both schema blocks, command and persona
registries, awakening, `RENDER_DOCTRINE`, input-budget compressor), `immersion.js` (wait primitives,
`choreograph`, `cancelDelivery`), `phone-ux.js`, `models.js`, `kie-api.js`, `ui.js`, `app.js`,
`profile-store.js`, `chat-store.js`, `anchor-store.js`, `media-library.js`, `image-store.js`,
`mock-api.js`, `debug-panel.js`, `css/app.css`.

**Cross-cutting automated checks:** DOM-ID audit (216 JS references vs 299 HTML ids — 2 discrepancies,
both benign); module-global audit (all 36 globals resolve; 1 dead alias); timer create/clear audit (no
leaks); TODO/FIXME sweep (none); cache-bust consistency (all `?v=199`); timezone resolution reproduced
in Node against the real lookup table.

**Reviewed at map level, not line by line** — stated plainly so the coverage claim is honest:
the interiors of `routine.js` and `calendar.js` (band selection, holiday-catalog fetch),
`loyalty-ux.js` scoring internals, and `resolveStyle` / `planDelivery` weighting plus the
`HER_STREAK_CAP` arm/reset paths. Nothing observed suggests defects there. Given that the two most
severe findings in this review (**B00**, **B0**) both emerged from careful reading of exactly this
kind of code, a follow-up pass over those files is worth doing.
