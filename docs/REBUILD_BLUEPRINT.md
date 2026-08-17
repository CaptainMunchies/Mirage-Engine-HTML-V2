# Mirage Engine — Rebuild Blueprint

*How I would build this project from scratch: what stays, what changes, what gets added, and the
order I'd do it in.*

Companion to `docs/PRODUCT_REVIEW.md`. That document assessed what exists. This one designs the
second build. Grounded throughout in measurements from the current codebase, so nothing here is
generic architecture advice.

---

## 0. The honest recommendation, up front

You asked how I'd build it again from scratch. This document answers that in full — a complete
target architecture, a build order, and the reasoning behind every choice.

**But the professional recommendation is: don't rewrite it.**

Mirage v2 is ~36,000 lines of *working, tuned* product. The single most valuable asset in it is not
the code — it's the prompt corpus in `mirage-prompt.js` and the injects scattered through
`commands.js`, which encode a great deal of hard-won knowledge about how these models actually
behave (label your reference images or the model averages faces; never send narrative to the image
model or safety refusals spike; a `/thermal` pin must expire after one turn or she freezes). That
knowledge is invisible in a spec and impossible to recover by rewriting. A from-scratch build that
restarts the prompts would regress in ways that only surface after hours of play.

So this blueprint is written to be consumed **two ways**:

- **§1–§9** describe the target architecture as if starting clean, which is what you asked for.
- **§11** describes how to reach that exact architecture *incrementally* from today's code, without
  a big-bang rewrite and without ever having a non-working app.

Both roads lead to the same destination. The second one is the one I'd actually take, and the
estimates below say why: a true rebuild is on the order of **3–4 months** of focused work with high
regression risk; the incremental path is roughly **6–8 weeks** of shippable increments with a safety
net at every step.

---

## 1. The vision any rebuild must preserve

Before deciding what changes, it's worth stating precisely what must not.

> **Sustain the illusion that a real person is texting you from inside her own life.**

Not "a chatbot with a picture attached." Every architectural decision below is justified by whether
it protects that illusion. Four properties fall out of it and are non-negotiable:

1. **Local-first.** No accounts, no cloud, no telemetry. The user's characters and chats are theirs,
   on their disk. Bring-your-own-key.
2. **The operator directs; the character is autonomous.** The user is not "prompting" — they are
   living inside a scene they can steer. Direction happens through commands that the character
   never sees as commands.
3. **The world runs without you.** She has a clock, a routine, a day. Closing the tab does not pause
   her life.
4. **Refusal is content.** Being left on read is a designed outcome, not a failure state.

Anything in this document that would compromise one of these is wrong, regardless of how good it
looks on an architecture diagram.

---

## 2. What stays exactly the same

These are the decisions the current build got right. A rebuild copies them deliberately.

| Kept | Why it survives |
|------|-----------------|
| **The disjoint prompt split** — thinking model is the author, image model is the camera, sharing only the identity ledger | The single best idea in the project. It reduces safety refusals, cuts tokens, and prevents narrative bleed into framing. Non-negotiable. |
| **Operator authority vs model authority** — persona and mode are client-owned and absolute; metrics are model-evolved but clamped; pins last exactly one turn then release | Correct division. The "pin expires and narrative resumes *from* it" detail is subtle and right. |
| **A structured turn contract** rather than free text | The client must be able to clamp, lock, rotate and override. That requires structure. |
| **Refusal-as-content** (`left_on_read`, `ghost_type`, `went_quiet`, `reaction`, `double_text`) | The most distinctive product idea in the codebase. |
| **The world-runs-without-you layer** — routine, calendar, proactive beats, phone chrome | This is what separates the product from a chat UI. |
| **Memory ledger with forced callbacks** | Right concept. (The eviction policy changes — see §7.) |
| **Bring-your-own-key, multi-provider** | Keeps the product free to run, and insulates it from any one provider's policy changes. |
| **Safety gates** — age, fiction/consent, upload interstitial | Correct, proportionate, and stored locally. Port as-is. |
| **The decision log** | Exceptional instrumentation. It gets *promoted* in the rebuild (§8), not replaced. |
| **Double-click to run** | A real feature. Whatever the build system, the shipped artifact must still start with one click and no install. |
| **The prompt corpus itself** | Ported near-verbatim, restructured into composable blocks. Not rewritten. |

---

## 3. The five structural changes

Everything else in this document is detail. These five are the rebuild.

### 3.1 A headless engine core, with the UI as a subscriber

**Today:** `simulation.js` is 5,182 lines containing the turn pipeline *and* **106 direct DOM
calls**. The engine cannot run without a browser, cannot be tested without a browser, and cannot be
reasoned about without holding the DOM in your head.

**Instead:** `core/` is pure TypeScript with zero DOM access and zero browser globals. It receives
capabilities through injected ports (`ThinkingProvider`, `ImageProvider`, `Storage`, `Clock`,
`Random`, `Scheduler`). It emits events. The UI subscribes and renders.

**What this unlocks** — and each of these is currently impossible:
- Run a full chat in a terminal or a test with no browser.
- Golden-transcript regression tests over the prompt corpus.
- Deterministic replay of a bug from a seed plus an event log.
- A second frontend later (desktop shell, phone) without touching engine logic.

This is the change that makes the other four possible.

### 3.2 Event-sourced state instead of a mutable session bag

**Today:** `EngineState.session` holds **55 fields**, plus **22 distinct `_xThisTurn` temporary
flags** that are set at the top of a turn and manually cleared in a `finally` block
(`simulation.js:4504-4530`). Because state is mutated in place, undoing a turn requires manually
snapshotting it — which is exactly what `captureTurnCheckpoint` does across ~30 fields
(`simulation.js:46-95`), and exactly why it **misses `shotHistory` / `lastShotType` / `goonLookHistory`**
(review finding B3). The bug is not an oversight so much as an inevitability: any hand-maintained
snapshot of a 55-field bag will drift.

**Instead:** an append-only event log per chat. State is a fold over events.

```
{ t, seq, type: 'user.message',    text }
{ t, seq, type: 'model.turn',      contract }
{ t, seq, type: 'metric.clamped',  key, from, to, reason: 'rise_limit' }
{ t, seq, type: 'outfit.locked',   label, proposed }
{ t, seq, type: 'shot.recorded',   shotType, crop, angle }
{ t, seq, type: 'image.generated', blobId }
{ t, seq, type: 'delivery.planned',style, schedule }
```

**What falls out for free:**
- **Cancel** = discard events after a marker. No snapshot, no drift, no B3.
- **Branch / replay** = fork the log at any point. The "what if I'd said something else" feature
  becomes nearly trivial instead of a rewrite.
- **The debug decision log** stops being a *separate* system (`pushDecision`) maintained in parallel
  with `session.uiLog` and `session.history` — all three unify into one log with different views.
- **Time-travel debugging** and reproducible bug reports.
- **Persistence** becomes appending, not rewriting a whole JSON blob into localStorage every turn.

The `_xThisTurn` flags disappear entirely: per-turn context becomes an argument passed down the
pipeline, not mutable state that must be remembered to clear.

### 3.3 Contract-first: one schema, generated prompts, validated responses

**Today:** the turn schema exists as **two hand-maintained prose copies** — `PHASE2_TURN`
(`mirage-prompt.js:559`) and `PHASE2_JSON_SCHEMA` (`mirage-prompt.js:695`) — which have already
drifted (review finding I10). Responses are never validated: `parsed.characterResponse ||
parsed.response || '…'` (`simulation.js:4248`) means a structurally valid but wrong response
silently becomes a "…" bubble.

**Instead:** define the contract once as a schema object (Zod or equivalent). Derive three things
from that single definition:

1. **TypeScript types** for the whole engine — the contract is the spine of the app and is currently
   untyped end to end.
2. **The prompt rendering**, at every density level. Compact and verbose become two *renderers* over
   one schema, so a new field cannot be added to one and forgotten in the other.
3. **Runtime validation**, with field-level errors that feed a targeted repair-retry: *"your JSON was
   missing `characterResponse`"* — reusing the retry machinery that already exists
   (`simulation.js:4148`).

Provider JSON-mode schemas can be generated from the same source where supported.

### 3.4 Pacing that *plans* instead of *sleeps*

**Today:** the delivery pipeline `await`s real wall-clock timers inside the turn
(`immersion.js:1536-1701`), coordinated by **seven interlocking pieces of mutable module state** —
`deliveryGen`, `sleepWaiters`, `skippableWallWait`, `skippableWallWaitSeq`, `proactiveTimer`,
`proactivePending`, `pendingDelivery`. Correctness depends on generation counters checked in the
right places. It works, but it is the hardest code in the project to modify safely, and it is
untestable without waiting in real time. It also produced a latent trap: `clearSkippableWallWait({
fire: true })` calls an `onFire` callback that **neither producer ever stores** (review §7).

**Instead:** split *decision* from *execution*.

- `pacing/planner.ts` — **pure**. Input: contract, session state, pacing mode, presence. Output: a
  `DeliverySchedule` — an ordered list of `{ atOffsetMs, effect }` steps (`seen`, `typing.start`,
  `typing.stop`, `emit.message`, `emit.reaction`, `withhold`). No timers, no awaits, no DOM.
- `runtime/scheduler.ts` — executes a schedule against a `Clock` port. One cancellation token. In
  tests, a fake clock runs a ten-minute realtime sequence in microseconds.

Pacing logic becomes unit-testable, and "does Realtime mode do the right thing?" becomes an
assertion instead of a ten-minute manual session.

### 3.5 The model reports intent; the client enforces it

**Today:** `commands.js` carries ~150 lines of bilingual Hebrew/English regex trying to detect
whether the user asked for an outfit change, a place change, a mirror shot, a close-up, a body part
(`commands.js:173-339`) — *and then* also instructs the model to make the same determination
(`commands.js:597`). Two authorities on one question, with the brittle one running first and setting
locks. Every new phrasing, and every new language, is a maintenance event.

**Instead:** invert it. Add an `interpretation` block to the turn contract:

```jsonc
"interpretation": {
  "askedForPhoto": true,
  "askedForOutfitChange": false,
  "askedToMove": false,
  "requestedFraming": "extreme_closeup" | "mirror_back" | "full_body" | null,
  "requestedSubject": "feet" | null
}
```

The model — which already reads the message in any language — reports what it understood. The client
then applies exactly the same locks it applies today, but driven by a structured signal instead of a
regex guess. Deterministic slash commands stay client-parsed, because those genuinely are
deterministic.

This deletes the entire regex NLU layer, makes the app language-agnostic by construction rather than
by maintenance, and makes the intent visible in the decision log for debugging.

---

## 4. Reference architecture

```
mirage/
├── core/                        # pure TS · no DOM · no browser globals · fully testable
│   ├── contract/
│   │   ├── schema.ts            # THE turn contract (single source of truth)
│   │   ├── render.ts            # schema → prompt text, per density
│   │   └── validate.ts          # response → typed contract | field errors
│   ├── engine/
│   │   ├── pipeline.ts          # orchestrates one turn end-to-end
│   │   ├── events.ts            # event types + the fold (reducer)
│   │   ├── metrics.ts           # clamps, rise limiters, pin expiry
│   │   └── locks.ts             # outfit / env / shot-variance enforcement
│   ├── director/
│   │   ├── commands.ts          # slash-command parsing (deterministic only)
│   │   └── injects.ts           # command → director inject blocks
│   ├── prompt/
│   │   ├── blocks.ts            # composable prompt blocks w/ priority + token cost
│   │   ├── budget.ts            # priority-aware allocator (replaces blind truncation)
│   │   ├── narrative.ts         # NARRATIVE_CORE  (ported corpus)
│   │   └── render-doctrine.ts   # RENDER_DOCTRINE (ported corpus)
│   ├── world/
│   │   ├── clock.ts             # SimClock: now / advance / timezone
│   │   ├── routine.ts           # daily rhythm, hour bands
│   │   ├── calendar.ts          # holidays, weekday, special days
│   │   └── entities.ts          # NEW — people in her life (§7.1)
│   ├── memory/
│   │   └── ledger.ts            # sticky facts + callbacks + ranked eviction
│   └── pacing/
│       └── planner.ts           # pure: contract → DeliverySchedule
│
├── ports/                       # interfaces only — the seam between core and world
│   ├── thinking-provider.ts
│   ├── image-provider.ts
│   ├── storage.ts
│   ├── clock.ts
│   ├── random.ts                # seeded — determinism
│   └── scheduler.ts
│
├── adapters/                    # implementations of the ports
│   ├── providers/
│   │   ├── google.ts  kie.ts  anthropic.ts  openai.ts  ollama.ts
│   │   └── registry.ts          # declared capabilities per model
│   ├── storage/idb.ts           # ONE database, versioned, migrations
│   ├── runtime/{clock,scheduler,random}.ts
│   └── mock/                    # deterministic providers for tests + offline dev
│
├── ui/                          # every DOM concern lives here and nowhere else
│   ├── views/{setup,simulation,characters,chats,settings}
│   ├── components/{phone,chat,control-deck,hud,debug}
│   └── store.ts                 # subscribes to engine events, renders
│
├── cli/
│   └── play.ts                  # headless chat runner — used by tests and for debugging
│
├── server/
│   └── mirage_server.py         # static + proxy, tokened, host-allowlisted
│
└── tests/
    ├── unit/                    # reducers, clamps, budget, routine bands, clock
    ├── contract/                # schema round-trips
    └── golden/                  # scripted transcripts over recorded provider responses
```

### Turn data flow

```
user input
    ↓
director/commands ──── deterministic slash command? ──→ inject blocks
    ↓
prompt/blocks + budget ──→ system prompt + user parts        [NARRATIVE only]
    ↓
ThinkingProvider.generate()                                   ← port
    ↓
contract/validate ──── invalid? ──→ targeted repair-retry
    ↓
engine/pipeline
    ├─ metrics.clamp + pin expiry        → metric.* events
    ├─ locks (outfit / env / variance)   → lock.* events
    ├─ interpretation → framing locks    → intent.* events   [§3.5]
    ├─ memory.ledger.apply               → memory.* events
    └─ world.routine.stamp               → world.* events
    ↓
pacing/planner ──→ DeliverySchedule (pure)                    [§3.4]
    ↓
image needed?  → prompt/render-doctrine → ImageProvider       [RENDER only — disjoint]
    ↓
scheduler executes schedule ──→ emits events over time        ← port
    ↓
UI store folds events ──→ renders phone, chat, HUD, debug trace
```

The two prompt paths never touch. That property is enforced by module boundaries rather than by
convention plus a boot-time assertion — `render-doctrine.ts` simply cannot import from `narrative.ts`
or from anything holding chat history, and a lint rule makes that a build error rather than a runtime
warning.

---

## 5. Subsystem decisions

### 5.1 Language and build

**Choice: TypeScript, bundled with Vite/esbuild to a single JS file plus one CSS file. Zero runtime
dependencies. Still double-click-to-run.**

The current no-build constraint was a deliberate simplicity choice and it has genuine merit — but at
36k lines with an untyped JSON contract flowing through ten modules, it now costs more than it saves.
A misspelled `imageDirective.outfitDetail` is silent today; the review found a dead global
(`MirageSessionStore`), two export conventions, and 12 deprecated shims that types and a linter would
have surfaced immediately.

The property worth protecting is not "no build step" — it's **"the user double-clicks one file and it
works."** A bundler preserves that completely: ship `index.html` + `mirage.js` + `mirage.css`, still
served by the same Python script. Development gets types, HMR, and a test runner; the shipped artifact
gets *simpler*, not more complex (one script tag instead of 35, which also retires the manual `?v=199`
cache-busting ritual).

*Rejected:* staying on vanilla JS (the contract needs types); a heavy SPA framework (see 5.7).

### 5.2 The turn contract

Single Zod schema. Types, prompt renderings, and validation all derive from it. Contract versioning
from day one: `contractVersion` on every stored turn, so a schema change can migrate old chats
instead of breaking them.

Notably, the JSON example shown to the model stops containing `//` comments (review B9) — the
renderer emits clean JSON, and the explanatory notes sit outside the code block where they cannot be
echoed back into a parse failure.

### 5.3 Storage

**One IndexedDB database**, versioned, with an explicit migration array. Stores: `characters`,
`chats`, `events`, `blobs` (images, anchors, media library), `settings`.

localStorage keeps only what must be readable synchronously at boot: the active theme, the safety-gate
acknowledgements, and a pointer to the last session. Everything else moves to IDB. This retires the
5 MB cliff, the storage-full modal's whole reason for existing, and the D2 atomicity problem — one
database means a character delete is one transaction.

**Export/import is built on day one, not added later.** A `.mirage` bundle (JSON manifest + blobs)
containing a character, its chats, its anchors and its photo library. This is the single highest-value
missing feature in the current product (review D1), and retrofitting it is much harder than designing
for it — the schema needs stable IDs and no ambient coupling to browser state.

### 5.4 Providers

A real interface with declared capabilities, rather than branching on provider name:

```ts
interface ImageProvider {
  readonly id: string;
  readonly capabilities: {
    maxReferenceImages: number;
    supportsRoleLabels: boolean;
    aspectRatios: string[];
    typicalLatencyMs: number;
  };
  generate(req: ImageRequest, signal: AbortSignal): Promise<ImageResult>;
}
```

The engine adapts to declared capability instead of hardcoding model knowledge. The current build
already has the *idea* (`maxCharacterRefs`, `supportsMultiReference` in `models.js`) — formalizing it
means adding Anthropic, OpenAI, or a local Ollama model becomes writing one adapter, not threading a
new branch through `api.js`.

Two direct consequences for review findings: provider-aware error copy (B4 — never again recommend
Grok to a Google user) becomes structural rather than a copy fix, and the timeout classification bug
(B1) lives in one adapter with one test.

### 5.5 The clock and the timezone

A `SimClock` port with `now()`, `advance(ms)`, and `timezone`. Real time plus offset in production; a
fake in tests. All time reads go through it — no scattered `Date.now() + clockOffsetMs`.

**The timezone is chosen once, at character creation, and stored as an IANA identifier on the
character record.** A searchable dropdown of real zones (`Intl.supportedValuesOf('timeZone')`),
optionally pre-filtered by a city search.

This deletes the entire bug class behind review finding **B00** — the substring-matching `CITY_TZ`
table that silently routes Dallas, Atlanta, Portland, Milan and Auckland to Los Angeles. There is no
runtime guessing to get wrong. A free-text location field can still exist for *narrative flavour*; it
just stops being load-bearing for time.

### 5.6 The local server

Keep Python and keep it tiny — it is genuinely one of the nicer decisions in the project (no Node
install required to run the app). Three changes, all from review §4:

1. **Mint a random session token at startup**, inject it into the served page, require it on proxy
   routes. Replaces the current check that accepts any non-empty string.
2. **Host-allowlist the image fetch route.** Today it will fetch any URL and hand back the body.
3. **Replace `Access-Control-Allow-Origin: *`** with the specific local origin.

Also: detect the Python version properly and fail loudly instead of `py -3.11` silently dying and
opening a browser to a dead port (B5), and ship a `.sh` alongside the `.bat`.

The proxy also becomes *optional* — where a provider allows direct browser calls, the adapter skips
it, so a proxy outage degrades rather than blocks.

### 5.7 The UI layer

**Deliberately the least opinionated choice in this document.** The UI is not where the project's
difficulty lives — the current vanilla implementation is decent, responsive (12 breakpoints), and
accessible (ARIA roles, two `prefers-reduced-motion` blocks). The engine separation is the win; the
view technology is close to irrelevant.

If picking fresh: something small and reactive — Lit or Preact with signals — because the UI becomes
a pure function of the folded event log, and a diffing renderer expresses that naturally. But porting
the existing DOM code largely as-is behind the new event subscription is a legitimate choice, and
cheaper.

What *does* change: the UI never mutates engine state. It dispatches intents and renders events.
That's what kills bugs like B0 (immersion beats routed to a debug-only lane) — presentation lanes
become a rendering decision over a typed event, not a `toast(msg, 'info')` call whose destination
depends on a global sim-active check three modules away.

---

## 6. Testing and observability

The current project has **no automated tests**, and its most valuable asset — the prompt corpus — is
the least protected part of it. This is the largest process gap, and the rebuild fixes it from turn
one.

| Layer | What it covers | Speed |
|-------|----------------|-------|
| **Unit** | Metric clamps, rise limiters, pin expiry, budget allocator, routine bands, clock math, ledger eviction | ms |
| **Contract** | Schema round-trips; malformed-response repair paths | ms |
| **Pacing** | Planner output for every style × pacing mode, against a fake clock | ms |
| **Golden transcripts** | Scripted user inputs + *recorded* provider responses → assert on the resulting event log | seconds |
| **Live smoke** | A handful of real API calls, run manually before a release | minutes |

**Golden transcripts are the important one.** Record a real session's provider responses once, then
replay them forever. Any change to prompt assembly, clamping, or locks shows up as a diff in the
event log. That is the test that would have caught the tease-semantics drift (review I3) and the
schema divergence (I10) the moment they happened.

Determinism is the prerequisite, which is why `Random` is a port with a seeded implementation. A bug
report becomes *seed + event log* — fully reproducible.

**Observability:** the existing decision log gets promoted into a proper trace view. Because the event
log already records every clamp, lock, rotation and rejection with its reason, "why did she do that?"
becomes a UI over data the engine emits anyway — and the per-turn diff view suggested in the review
(`what changed in tracking this turn, and which rule caused it`) is a rendering, not a feature.

---

## 7. What I'd add that doesn't exist today

Ordered by immersion-per-unit-effort. All four vision properties in §1 are preserved by every item
here.

### 7.1 An entity graph — the people in her life

The single biggest available step from *"she has a life"* to *"she has a world."*

Today everything is one-on-one; other people exist only as passing mentions the model invents and
forgets. Instead: first-class entity records — name, relationship, a few traits, current standing.
Her best friend, her ex, her boss, her sister. The ledger references entities by ID rather than
storing loose text. Entities can appear in Stories, cause plans, create conflicts, and be asked about.

This is cheap on top of event sourcing and transforms long-run continuity. It is also the natural home
for the "consequence memory" idea — a promise involving an entity, with a deadline she actually checks.

### 7.2 A daily log / world state

An append-only record of what actually happened in her day: ate, trained, worked, argued, went out.
Cheap once events exist. Feeds continuity far better than the current outfit+env pair, and makes
"what did you do today?" answerable *consistently* rather than freshly invented each time.

### 7.3 Memory ledger with ranked eviction

Fixes a real design flaw found in the review: today `MAX_ITEMS = 8` evicts purely by recency
(`memory-ledger.js:60-63`), so eight trivial facts silently push out an unresolved promise. The
callback picker already ranks by kind — eviction should too. Evict resolved first, then by kind rank
(tension > promise > plan > nickname > preference > fact), raise the cap, and surface only the top N
per turn.

### 7.4 Relationship arc as an explicit state machine

Engagement today is a scalar that rises and decays. An explicit arc — *stranger → talking → close →
together → strained → estranged* — with defined transitions gives long chats shape and gives the model
a much stronger steer than a number. It also makes the difficulty setting meaningful over weeks rather
than minutes.

### 7.5 Operator-sent photos

You send her a photo; she reacts to it. Requires a vision-capable thinking model, which several
configured providers already are. Very high immersion return, and it makes the relationship
bidirectional for the first time.

### 7.6 Her phone is real

The bezel already draws a battery and signal bars that mean nothing. Make them mean something: she
can be low on battery, on a call, at dinner with her phone face-down. Behaviour with a *visible cause*
reads as a person; behaviour without one reads as randomness.

### 7.7 Genuine multi-day absence

The clock-resume modal currently treats a long absence as a problem to reconcile. Invert it: come back
after two days and there are Stories waiting, an unanswered question, a shift in mood. The
infrastructure (routine, proactive beats, sim clock) already exists; only the framing changes.

### 7.8 Voice notes

A waveform bubble with a duration and a tap-to-reveal transcript. No audio generation required — the
transcript is the payload. Cheap, and a large perceived-realism jump.

### 7.9 Local model support

An Ollama adapter. Aligned with local-first, removes per-turn cost entirely for users who want that,
and insulates against provider policy changes — which, for this product category, is a strategic risk
worth hedging.

### 7.10 Character bundles as a shareable format

Export a character *without* the operator's chat history. Makes characters shareable and gives the
project a natural community artifact — while keeping private data private by construction.

---

## 8. Tech stack, with rejected alternatives

| Decision | Choice | Rejected | Why |
|----------|--------|----------|-----|
| Language | TypeScript | Vanilla JS (status quo) | The contract is the app's spine and is untyped end to end today |
| Build | Vite / esbuild → single bundle | No build step | Preserves double-click-to-run while retiring 35 script tags and manual cache-busting |
| Validation | Zod (or equivalent) | Hand-written checks | One schema → types + prompt + validation |
| State | Event-sourced log + fold | Mutable session object | Cancel, branch, replay, and the debug trace all fall out free |
| Storage | One IndexedDB DB, versioned | localStorage + 3 IDB DBs | Retires the 5 MB cliff and makes deletes atomic |
| UI | Lit / Preact signals — *or port existing DOM* | Heavy SPA framework | Low-stakes; the engine split is the real win |
| Server | Python, tokened + allowlisted | Node; no server | No extra install; fixes the SSRF properly |
| Tests | Vitest + golden transcripts | None (status quo) | The prompt corpus is the crown jewel and is currently unprotected |
| Determinism | Seeded `Random` port | `Math.random()` everywhere | Reproducible bugs and testable pacing |

---

## 9. Build order — if genuinely starting from scratch

Each phase ends with something runnable. Nothing is built that cannot be demonstrated.

| Phase | Deliverable | Why here |
|-------|-------------|----------|
| **0. Contract + ports** | `schema.ts`, port interfaces, mock providers, seeded RNG, fake clock | Everything downstream depends on the contract. Written first, on purpose. |
| **1. Headless engine** | Turn pipeline, event log, metrics, locks, memory — plus `cli/play.ts` | **Play the game in a terminal before any UI exists.** This is the forcing function that keeps the engine pure; if it needs the DOM, you find out immediately. |
| **2. Prompt corpus port** | `narrative.ts`, `render-doctrine.ts`, blocks + budget allocator | Port the existing text near-verbatim. Golden transcripts recorded here become the safety net for everything after. |
| **3. Real providers** | Google + kie adapters against the port interface | First real turns end to end. |
| **4. Storage + export** | One IDB database, migrations, `.mirage` bundles | Before any real user data exists, so migration is never retrofitted. |
| **5. UI** | Phone, chat, HUD, control deck, debug trace | Subscribes to events. By now the engine is fully tested. |
| **6. Setup wizard** | Media → face → profile → protocol | Deliberately late: it produces data the engine consumes, so the consumer should be settled first. |
| **7. Pacing + scheduler** | Planner + scheduler split, all three modes | Needs a working UI to feel, and a fake clock to test. |
| **8. World layer** | Routine, calendar, entities, daily log | The immersion layer, on solid foundations. |
| **9. Polish** | Safety gates, onboarding, demo character, preflight panel | Shipping concerns. |

Two ordering choices are deliberate and worth calling out. **The CLI comes before the UI** — it is the
only reliable way to keep an engine headless. **The setup wizard comes late** — building the data
producer before the data consumer is how you end up with a character schema that fits the wizard's UI
rather than the engine's needs, which is a mistake that is expensive to undo.

**Honest estimate:** 3–4 months of focused solo work with AI assistance. The long pole is not code
volume — it is re-tuning behaviour that is currently tuned, because the prompt corpus interacts with
the engine in ways no spec captures.

---

## 10. What I would deliberately *not* do

Stated explicitly, because these are the tempting mistakes.

- **No accounts, no cloud sync, no server-side state.** Local-first is a product feature, not a
  limitation to grow out of.
- **No telemetry.** Given the subject matter, the correct amount of data collection is zero.
- **No microservices, no Docker, no containers.** The app must stay double-clickable.
- **No rewriting the prompt corpus.** Port it. It is the most valuable and least reproducible asset in
  the project.
- **No "AI agent framework" dependency.** The orchestration here is a well-understood pipeline, not an
  agent loop. A framework would add abstraction and remove control over exactly the things that
  matter — prompt assembly and token budget.
- **No abandoning the Python server for Node.** Requiring a Node install would be a real regression in
  the setup experience.
- **No premature multi-character group chats.** Tempting, but it multiplies contract, pacing and
  persona complexity while the one-on-one illusion still has significant headroom.
- **No streaming responses.** The turn is atomic — the client must validate, clamp and possibly
  repair the whole contract before anything is shown. Streaming would fight the architecture for a
  cosmetic gain, and the typing indicator already covers the latency perceptually.

---

## 11. The route I would actually take

The same architecture, reached incrementally. Every phase ships, and the app works at every commit.

**Phase 0 — Build the safety net first (1 week).**
Add a test runner and record golden transcripts *against the current app* using the existing
`mock-api.js`, which already provides deterministic delivery cycling and offline thinking. This
captures today's behaviour as executable specification **before** anything moves. Nothing else in this
plan is safe without it.

**Phase 1 — Extract pure logic (1–2 weeks).**
Move metric clamping, rise limiters, routine bands, calendar, memory ledger and prompt blocks into a
`core/` directory as pure functions with unit tests. No behaviour change; the existing modules call
into them. TypeScript can be introduced here file by file (`allowJs`, `checkJs`) without a big-bang
conversion.

**Phase 2 — Contract-first (1 week).**
Introduce the schema as the single source of truth; generate both prompt densities from it; add
validation with repair-retry. Deletes I10 permanently and closes the silent-"…" gap.

**Phase 3 — Events alongside state (1–2 weeks).**
Start *emitting* events from the existing pipeline while the mutable session remains authoritative.
Build the trace view on those events. Zero risk — the event log is initially read-only instrumentation
that happens to also be excellent debugging.

**Phase 4 — Flip the source of truth (1–2 weeks).**
Make the fold over events authoritative; delete `captureTurnCheckpoint` and its 30-field snapshot
(B3 disappears); the 22 `_xThisTurn` flags become pipeline arguments.

**Phase 5 — Storage consolidation + export (1 week).**
One IDB database with migrations, `.mirage` bundles, storage meter. Ships the highest-value missing
user feature (D1).

**Phase 6 — Provider interface (1 week).**
Formalize the port, port Google and kie behind it, then add one new provider to prove the seam.

**Phase 7 — Pacing planner/scheduler split (1 week).**
The last and most delicate extraction, done once the golden transcripts are mature enough to catch
regressions in it.

**Total: roughly 6–8 weeks of incremental, always-shippable work** — versus 3–4 months and a
behaviour-regression cliff for a true rewrite. Same destination, materially lower risk.

The review's quick-wins list (B00, B0, B1, B2, S1) should be done *before* Phase 0 — they are under a
day of work combined, and there is no reason for users to live with them while this is underway.

---

## 12. Risks

| Risk | Mitigation |
|------|------------|
| **Prompt regression during restructuring** — the corpus is tuned in ways no spec captures | Golden transcripts recorded in Phase 0, before any change; port text verbatim rather than rewriting |
| **Event-sourcing over-engineering** — a log that is more ceremony than the app needs | Keep the event vocabulary small and concrete; the log replaces three existing systems (`history`, `uiLog`, decision log) rather than adding a fourth |
| **TypeScript conversion stalling halfway** | Incremental `allowJs` migration, file by file, never a big-bang branch |
| **Losing the "double-click and it runs" property** | Treat it as an explicit acceptance test on every release, not an aspiration |
| **Scope creep from §7** | Nothing in §7 starts until §11 Phase 5. The foundation earns the features. |
| **The rebuild never finishing** — the classic outcome | This is precisely why §11 exists and why §9 is presented second |

---

## Appendix — decision summary

| Area | Today | Rebuild | Driver |
|------|-------|---------|--------|
| Engine/UI | 5,182-line module with 106 DOM calls | Headless core; UI subscribes | Testability, replay |
| State | 55-field mutable bag + 22 per-turn flags | Event log + fold | Cancel/branch free; kills B3 |
| Contract | Two prose copies, no validation | One schema → types, prompts, validation | Kills I10 + silent "…" |
| Pacing | 7 interlocking mutable timer vars | Pure planner + scheduler port | Determinism; kills the `onFire` trap |
| Intent | ~150 lines bilingual regex + model also asked | Model reports `interpretation`; client enforces | Language-agnostic by construction |
| Timezone | Substring match on a city table | IANA zone stored on the character | Kills B00's entire class |
| Storage | 8 localStorage keys + 3 IDB DBs | One IDB DB, versioned, `.mirage` export | Kills the 5 MB cliff; ships D1 |
| Providers | Two modules with name branching | Port + capability-declaring adapters | Kills B4; new providers are one file |
| Types | None | TypeScript throughout | The contract is the spine |
| Tests | None | Unit + contract + golden transcripts | Protects the crown jewels |
| Feedback lanes | `toast()` destination inferred globally | Typed events rendered by the UI | Kills B0 |
| Prompts | `NARRATIVE_CORE` / `RENDER_DOCTRINE` split | **Unchanged** — enforced by module boundaries | Best idea in the project |
