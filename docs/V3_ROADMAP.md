# Mirage Engine v3 — Roadmap

*The consolidated plan: what gets fixed, what gets restructured, and the order to do it in.*

Supersedes nothing — this sits on top of `docs/PRODUCT_REVIEW.md` (what's broken today),
`docs/REBUILD_BLUEPRINT.md` (the target architecture), and `docs/UI_DESIGN_DIRECTION.md` (the
interface brief, summarised in §3 below). Those remain the reference material. This is the decision
record and the sequence.

**Target:** a private tool for one user. Not a public release. That decision removes a lot from scope
and is worth stating up front, because it changes what "ready" means.

**Living document.** More will be added. The phase structure is designed so new work slots into a
phase rather than reshuffling the whole plan.

---

## 1. Scope decisions

Everything below was decided deliberately. The "out" column matters as much as the "in" column —
it's what stops v3 sprawling.

### In scope

| Item | Source | Why it made the cut |
|------|--------|---------------------|
| All correctness + security fixes | Review | Defects, not choices |
| Export / backup | Review D1 | No recovery path exists today |
| Test foundation — three layers | Conversation | Everything after depends on it |
| One reply format + response checking | Blueprint §3.3 | Two copies already drifted; silent "…" turns |
| AI reports intent | Blueprint §3.5 | Deletes ~150 lines of brittle keyword matching |
| The wall (engine ↔ UI boundary) | Blueprint §3.1 | Makes the UI overhaul safe to hand to an agent |
| Component gallery | Conversation | Agent workspace + review surface |
| UI overhaul — see §3 | UI brief | One thread instead of two; Immersion + Director modes; a large-screen layout the CSS has never had |
| Event log — *diary structure only* | Blueprint §3.2 | Consistency, structure, real undo |
| Split the waiting logic | Blueprint §3.4 | Skip Wait proves a wait *can* be skipped, not that its length was right — only the split makes that testable |
| Types — gradual, contract first | Blueprint §5.1 | Guardrails where an agent is most likely to slip |
| Memory ledger eviction fix | Blueprint §7.3 | Cheap; fixes a hole in a headline feature |

### Out of scope, and why

| Item | Reason |
|------|--------|
| **Branching conversations** | The event log makes it nearly free, but it's a product feature nobody asked for. Structure is the goal, not the feature. |
| **Entity graph, operator photos, phone realism, voice notes, relationship arc, local models, character bundles, daily log** | Real ideas, parked for v3.1+. v3 is foundation. |
| **Full TypeScript conversion** | Weeks of churn with nothing visible. Gradual gets most of the protection at a fraction of the disruption. |
| **From-scratch rebuild** | Rejected in the blueprint and reaffirmed. The prompt corpus is the asset; the machinery gets improved around it. |
| **Cross-platform launchers, public docs, licensing, onboarding polish, demo character** | Private tool. Drops out entirely. |

---

## 2. The sequence

Seven phases. Each ends with a working app. The ordering is not arbitrary — four constraints drive it:

1. **Bugs are fixed before behaviour is recorded**, or the recording cements the bugs.
2. **The wall exists before the UI overhaul**, or an agent redesigning the screen can silently change
   how she behaves.
3. **The event log comes after the wall**, deliberately — because the wall means the UI is fed a
   description of what to show, and where that description *comes from* becomes swappable underneath.
   The UI never notices the change. This is what lets the UI overhaul happen without waiting weeks
   for the biggest structural change to land.
4. **The pacing split goes last**, because it is the most delicate area in the codebase and it
   benefits from a mature test suite catching any regression it introduces.

---

### Phase 1 — Critical fixes · ~4–5 days

Everything here is a defect with a known fix and a known location. Finding IDs refer to
`docs/PRODUCT_REVIEW.md`; §5 tracks every one of them to completion.

#### 1a — Defects that change behaviour

| ID | Fix | What breaks today |
|----|-----|-------------------|
| **B00** | **Timezone matching** (`phone-ux.js:33-38`) | Dallas, Atlanta, Portland, Cleveland, Oakland, Milan, Iceland, Poland, Auckland, Adelaide, Lagos all silently run on Los Angeles time. Her clock, her routine, and every time-of-day cue are hours off. One line. |
| **B0** | **Immersion beats invisible** (`ui.js:88-92` + 10 call sites) | With Developer Mode off — the default — "left on read", "she went quiet", "she was typing… then deleted it" all route to a hidden debug panel. The refusal system looks like the app crashing. |
| **B5b** | **Pinned metric vanishes silently** (`simulation.js:3633-3638`) | Same root cause as B0, distinct symptom: the ghost-hold branch returns *before* the command bubble is appended at `:3854`, so `/arousal 80` during a ditch hold changes a HUD number and produces no chat entry, no toast, and no hint the pin was deferred. |
| **B1** | **Image timeout misreported** (`api.js:340`) | `return` where it should be `throw`. Every timeout is reported as "no image came back" and the useful message is discarded. |
| **B2** | **Refusal check before parse** (`api.js:163`) | A valid reply containing in-character phrasing like "i'm unable to even" is misread as a provider refusal and can fail the turn. Parse first, check second. |
| **B3** | **Cancel leaks shot-variance state** (`simulation.js:2264` vs `:46-95`) | `recordShotType` fires before image generation, but the checkpoint snapshots neither `shotHistory`, `lastShotType`, `goonLookHistory` nor `lastGoonCombo`. Cancelling leaves a phantom entry in the 3-deep avoid-list, distorting the next photo's framing. Add the four fields. *(Superseded by Phase 6, but that's ~10 weeks out and this misframes photos now.)* |
| **B7** | **Input ceiling silently exceeded** (`mirage-prompt.js:3483-3510`) | `fitInputBudget` only ever trims history, never the system prompt. When the system prompt alone exceeds the budget, `roomChars` floors at 80 and the "Max thinking prompt per turn" setting quietly fails to cap anything. |
| **S1** | **Proxy SSRF** (`mirage_server.py:304`) | Any website open in the browser can use the local helper to read internal/localhost URLs and read the response back. Session token + host allowlist + drop the wildcard CORS. |
| **S2** | **API keys in URL query strings** (`api.js:357`, `:686`, `:695`) | Keys land in history, proxy logs and referrers. The image path already does this correctly with the `x-goog-api-key` header — match it. |
| **D1** | **Export / backup** | No recovery path exists at all. One `.mirage` bundle: character, chats, anchors, photo library. |
| **D3** | **Unhandled rejection on delete** (`profile-store.js:172-177`) | Two `async` cleanups wrapped in a *synchronous* `try/catch`, which cannot catch a promise rejection. A failed IndexedDB delete surfaces as an unhandled rejection instead of being swallowed. Use `.catch()` as the codebase does elsewhere. |
| **B5** | **Launcher pins Python 3.11** | `py -3.11` dies instantly on any other version, then the browser opens a dead port with no error. Add fallbacks and fail loudly. |
| **B8** | **`STOP MIRAGE` kills any process on 8080** | It `taskkill`s whoever owns the port without checking it's Mirage. |
| **N4** | **Legacy migration overwrites all chats** (`chat-store.js:44-88`) | `migrateLegacyOnce` builds a *fresh* `{ characters: {} }` from the legacy `mirage_v2_sessions` key and `writeStore`s it — discarding whatever `mirage_v2_chats` currently holds. It runs on **every** `readStore()`, and it is only safe because it deletes the legacy key afterwards. If that key ever reappears — a restored backup, a synced profile, a partial import — the very next read silently destroys every chat. **This matters specifically because Phase 1 builds import.** Make it merge, and gate it on the target being empty. |

#### 1b — Cleanups, minutes each

Small, zero-risk, and worth doing while the file is open — several are booby-traps an agent could
find and start using.

| ID | Cleanup |
|----|---------|
| **I2** | Stale V1 architecture note (`index.html:88`) claims the master prompt goes to **both** models — the opposite of the truth, and it's the first architectural claim a new user reads |
| **I6** | Header still reads "Standalone · Google AI" (`index.html:15`) while the app runs on kie |
| **I9** | "30-photo ingest limit" on Face Lock (`index.html:163`) vs "max 20" on Media Upload (`:106`) |
| **B4** | `GOON_STACK_TIP` (`errors.js:7-10`) tells Google-provider users to select Grok and Seedream, which exist only in the kie registry. Branch the copy on the active provider |
| **B6** | Unreachable branch — `errors.js:131` tests `empty response`, already caught at `:90` |
| **I13** | Deck's Change Outfit requires an argument the typed command treats as optional, and empty submit bare-`return`s with no feedback (`control-deck.js:25`, `:184`) |
| **I14** | `MirageSessionStore` (`chat-store.js:979`) — a legacy alias defined and referenced nowhere |
| **I11** | 12 `@deprecated` shims across 8 modules kept "for stray callers" — verify no callers, delete |
| **I15** | Two export conventions coexist: 27 modules use `global.X =`, 9 use `window.X =` inside the same IIFE. Pick one |
| — | `clearPhoneFeed` (`simulation.js:1587`) wipes the feed without resetting `session.presence`, so any path clearing it mid-typing leaves the header stuck on "typing…" |
| — | Dead `#phoneStatus` fallback branch (`phone-ux.js:237`, `:248`) for markup that no longer exists |
| — | **Three browser-local time fallbacks** that would silently compute *her* hour and weekday in the *operator's* timezone if ever reached: the weekday fallback (`phone-ux.js:262`), the routine clock fallback (`routine.js:55-62`), and the sim-date fallback (`calendar.js:687-694`). All three are dead today because `MirageCalendar.getSimDateParts` and `MiragePhoneUX.getZonedParts` are both exported — but a script that fails to load leaves the app running on a silently wrong clock rather than erroring. Same family as B00; delete the fallbacks or make them throw |
| — | `MirageMemoryLedger.resolve` (`memory-ledger.js:66-75`) matches on `includes()` with whatever string the model supplies — a generic `resolve` op can close the wrong item. Require an id or an exact match |
| — | kie polling (`kie-api.js:10`, `:702`) uses a flat 2.5s interval with no backoff — up to ~120 proxied round-trips per image — and `console.log`s every poll |
| **N1** | **All three IndexedDB stores cache a rejected open** (`image-store.js:13-27`, `anchor-store.js:16-31`, `media-library.js:20-35`). `dbPromise` is assigned the promise before it settles, so if `indexedDB.open` ever fails — private-browsing mode, storage pressure, a corrupted profile — the rejected promise is cached for the rest of the session. Every later image save, anchor read and photo load fails permanently, with no retry short of a page reload. Null `dbPromise` in the error path |
| **N2** | **No `onblocked` handler on any IDB open.** Harmless today because all three databases sit at version 1 — but the migration work this roadmap plans *requires* bumping a version, and at that point a second open tab blocks the upgrade, `openDb()` never settles, and every awaiting operation hangs silently with no error. Add the handler before the first migration, not after |
| **N3** | **Destructive deletes sit behind a native `confirm()`** (`characters-ui.js:301`, `chats-ui.js:185`, `user-profiles-ui.js:154`, `setup-profile.js:359`). Deleting a character permanently destroys its chats, anchors and photo library, and until export ships in Phase 1 there is no recovery from a misclick. Also the only unstyled dialogs in an app that otherwise uses custom modals — fold into the Phase 5 overhaul |

**Done when:** a character in Atlanta shows Atlanta time · a `ghost_type` turn visibly explains itself
with Developer Mode off · a pin during a ghost hold says so · a timeout says "timed out" · the proxy
rejects an unknown host and requires a token · no API key appears in a URL · a character survives a
cleared browser · every row in 1b is gone.

---

### Phase 2 — Test foundation · ~1–1.5 weeks

Three distinct layers. Briefed as three, not one — a single "extensive test suite" instruction
produces one sprawling brittle file.

**Layer 1 — Smoke.** Boots, loads a character, runs a turn, saves, reloads. Under a minute. Runs
constantly.

**Layer 2 — Behaviour recording.** Scripted sessions run against the existing mock mode
(`mock-api.js` — deterministic, no API cost, already cycles delivery styles). Capture every metric
change, lock, and decision. That capture becomes the baseline. Rule for this layer: **whatever the
app does today is correct** — which is exactly why Phase 1 comes first.

**Layer 3 — Failure and edge cases.** Targeted, one per scenario. Rule for this layer: assert the
*intended* behaviour, not today's. Several of these paths are currently wrong and the tests should
fail until they're fixed.

The failure surface, all testable with no API:

- **Bad model output** — malformed JSON; valid JSON missing `characterResponse`; refusal prose; metrics out of range; model trying to change persona or mode; missing image directive when one is required; a withhold style on a turn that must deliver
- **Provider / network** — invalid key; rate limit; server error; image timeout; safety block; empty image; proxy not running
- **Interruption** — cancel during thinking; cancel during image; chat switched mid-turn; refresh mid-turn; two turns fired at once
- **Storage** — quota exceeded; IndexedDB unavailable; corrupt saved chat; character deleted mid-session
- **Time** — unknown location; DST boundary; midnight rollover; two-day absence; jump landing on the wrong day
- **Rules** — unknown command; bad argument; empty message; reply hitting the character cap; the 5-unanswered credit guard; ledger past 8 items; awakening at 100; thermal pin expiry; outfit lock vs change request; no face reference; body reference on a single-image model

**Done when:** the three layers run on demand, the recording is committed as the baseline, and the
failure suite has known-red tests for the paths Phase 1 didn't cover.

---

### Phase 3 — The contract · ~1.5 weeks

Small, high-leverage, and it protects everything built afterwards.

**One reply format.** The structure the AI must follow is currently written out twice — a long
version and a short version for lower token budgets — and they have already drifted. Define it once;
generate both renderings from that single definition. Neither can drift again.

**Check every reply.** Nothing currently verifies the AI filled in what it was asked for. A reply
missing `characterResponse` silently becomes "…". Validate each response; on a missing or malformed
field, retry with a specific note naming what was wrong — reusing the retry path that already exists.

**Types on the contract.** This is where the gradual typing starts, because the reply format is the
highest-traffic and most breakable surface in the app, and the place an agent is most likely to
misspell something invisibly. Other files get typed only as they're touched.

**Clean JSON in the example (B9).** The schema shown to the model contains `//` comment lines
(`mirage-prompt.js:574-576`, `:710`) inside a structure introduced by *"Return ONLY valid JSON"*.
Demonstrating comment syntax invites the model to echo it, which `JSON.parse` rejects and
`extractJsonPayload`'s brace-matching won't rescue. The generated rendering emits clean JSON with the
notes outside the code block.

**AI reports intent.** Delete the ~150 lines of Hebrew/English keyword matching that guesses whether
the user asked for an outfit change, a move, a mirror shot, or a close-up. Add an `interpretation`
block to the reply format instead — the AI says what it understood, and the client applies exactly
the same locks it applies today. Works in any language, with no keyword list to maintain.
Deterministic slash commands stay client-parsed.

**Done when:** the format exists in one place; a deliberately malformed reply triggers a visible
retry rather than "…"; the keyword-matching module is deleted and the intent tests pass.

---

### Phase 4 — The wall and the gallery · ~1.5–2 weeks

The real start of the UI overhaul.

**The wall.** All screen code moves behind one boundary with exactly two crossings:

- **Engine → UI:** a plain description of what should be on screen — messages, metrics, phone state,
  whether a wait is running, whether the last image failed and why.
- **UI → Engine:** what the user did — sent this text, clicked cancel, picked this persona, switched
  chat.

No shared mutable state; the UI never reaches in. After this, an agent working on the UI *cannot*
change how she behaves — the worst outcome is that it looks wrong.

**Make it mechanical.** An automated check that fails when UI code reaches through the wall. With an
AI agent this is not optional — an agent will comply until it gets stuck, then quietly reach through.
A convention in a document does not survive that; a failing check does.

**The gallery.** One page rendering every UI state from fake data — the full inventory is in §3, and
it covers thread states, operator states, setup states, and each of those in both modes. Today,
seeing states like "blocked by safety filter" or "credit guard fired" means playing until you hit
them and spending credits. This makes them one click each.

Its value is fourfold: design decisions get made looking at the whole product at once; the agent can
verify its own work without playing or spending; rarely-seen states stop being the ugliest ones; and
a redesign gets reviewed in five minutes instead of an hour.

**Done when:** the boundary check fails on a deliberate violation; the gallery renders every state
listed above; the Phase 2 recording still passes unchanged.

---

### Phase 5 — UI overhaul · agent-driven

The goal all of this was protecting. **The design brief is §3** — the premise (it's the operator's
phone), the one-thread unification, the two modes, the layout tiers, the live-state restructure and
the setup previews. Phase 5 is the execution of that brief.

**How to brief the agent:**
- Point it at the gallery as its workspace.
- Scope it to the UI folder. Explicitly: *do not modify anything outside it.*
- Require the behaviour recording to pass before and after. Identical means nothing broke.
- Have it work state by state through the gallery, not screen by screen through the app.

**How to review:** open the gallery. Every state, one page. If the recording is unchanged, the
redesign touched only appearance — which is the entire point of Phases 2 and 4.

**Done when:** the redesign is complete, the recording is byte-identical, and the boundary check
never fired.

---

### Phase 6 — Event log and memory · ~2–4 weeks

Deliberately last. Behind the wall, this is invisible to the UI.

**The diary.** Replace the single mutable scoreboard — 55 fields, plus 22 temporary per-turn flags
cleared by hand — with an append-only log. State becomes a fold over that log.

What it buys: consistent structure instead of scattered mutation; real undo (discard events after a
marker, rather than the current 30-field manual snapshot that already misses `shotHistory` and causes
the cancel bug); the debug log stops being a third parallel system alongside `history` and `uiLog`;
and the 22 per-turn flags disappear, becoming arguments passed down the pipeline.

**Explicitly not building:** branching conversations. The log makes it nearly free, and it stays
unbuilt anyway. Structure is the goal.

**Memory fix.** The ledger currently holds 8 items and evicts by age alone, so eight trivial facts
push out an unresolved promise. The callback picker already ranks by kind — eviction should too.
Evict resolved first, then by rank, raise the cap, surface only the top few per turn.

**Done when:** the fold is the source of truth; `captureTurnCheckpoint` and its manual snapshot are
deleted; cancel is exact; a promise survives eight newer trivial facts.

---

### Phase 7 — Pacing split · ~1 week

Last, and deliberately so. This is the most delicate area in the codebase, and it should not be
touched until the test suite is mature enough to catch what it breaks.

Today the delivery pipeline waits on real timers *inside* the turn, coordinated by seven interlocking
pieces of module state — `deliveryGen`, `sleepWaiters`, `skippableWallWait`, `skippableWallWaitSeq`,
`proactiveTimer`, `proactivePending`, `pendingDelivery`. Correctness depends on generation counters
being checked in exactly the right places. It works, but it is the hardest code in the project to
change safely.

Split the decision from the execution:

- **Planner — pure.** Takes the reply, her state, the pacing mode, and how present the user is.
  Returns a schedule: an ordered list of *"after this long, do this"* — show Seen, start typing, stop
  typing, send, withhold. No timers, no waiting, nothing touching the screen.
- **Scheduler.** Executes a schedule against the clock, with a single cancellation point.

**Why it earns its place, given Skip Wait already exists.** Skip Wait proves a wait *can* be skipped.
It does not prove the wait was the *right length*, and it needs a human to click it — an automated
test can't. With the split, *"in Realtime, with cold engagement and a left-on-read reply, the
schedule should be X"* becomes an assertion that runs instantly. Every combination of delivery style
and pacing mode gets verified in a fraction of a second, including the ones that currently take ten
real minutes to observe once.

**Done when:** the planner is pure and covered for every style × mode combination; the scheduler is
the only place in the codebase where a timer exists; the behaviour recording is unchanged.

---

## 3. UI direction — the brief for Phases 4 and 5

Full detail in `docs/UI_DESIGN_DIRECTION.md`. The decisions and the load-bearing structure are
recorded here because they define what Phase 4 builds and what Phase 5 aims at.

### The premise

**The phone on screen is the user's phone. Not hers.** You are holding your own device and texting
her through it. The frame, status bar and home indicator are *your device*; the thread header —
avatar, name, "online" — is *her*; her photos arrive in *your* thread; her Stories are something
*you view*. The existing code already agrees (`phoneHeaderName` is her name, `phonePresence` is her
status); the redesign makes it consistent.

One consequence to resolve alongside the Phase 1 timezone fix: the bezel clock currently shows
**her** timezone (`phone-ux.js:236-250`) on what is conceptually **your** device. If the phone is
yours, your status bar shows your time, and her local time becomes conversational context — *last
seen 3h ago · it's 6am there*. That gap between two clocks is content the current design discards.

### Decisions

| Question | Decision |
|----------|----------|
| Default posture | **Switchable** — Immersion and Director modes |
| Wide screens | **Form + live preview** — the extra space does real work |
| Hebrew / RTL | **Messages only** — bubbles handle RTL, chrome stays English/LTR |
| Debug placement | **Inline**, below the deck — restructured, not relocated |

### The core structural change: one thread

The conversation currently exists **twice** — the phone has its own scrolling feed of images and
captions, the chat log beside it has its own feed of text, commands and notices. They scroll
independently and neither is complete alone.

Unify into a single thread containing her messages, her photos inline, your messages, and Story
cards. Everything else — typed commands, system notices, decisions, errors — becomes **operator
annotation** living outside the fiction. This frees the entire second column and lets the phone grow
to a size where the photo is finally the largest element on screen rather than a 320px thumbnail.

**Errors leave the thread.** The safety-filter block currently renders inside the conversation as a
large red panel with a wall of remediation text — an operator concern injected into the fiction, and
the most immersion-breaking thing in the current UI. It becomes a compact dismissible banner outside
the phone.

### Two modes

The toggle changes **the chrome around the thread, not the thread itself** — same components, same
data, different surroundings. That constraint is what stops "switchable" becoming two half-designed
interfaces.

- **Immersion** — full-height phone, the unified thread, composer at its base. No metric strip, no
  deck, no debug. Typing `/` still opens the full command autocomplete. Operator notices appear as
  quiet toasts outside the phone frame.
- **Director** — the phone stays large and gains rails: live state left, control deck and the
  command reference right, operator log and debug below. All collapsible.

Director mode also fixes a stranded feature: the command reference currently lives on the Standby
screen, shown *before* you play and unavailable *while* you play.

### The missing large-screen mode

The stylesheet has **twelve media queries and not one `min-width`**. It knows how to shrink and has
never been told what earns extra room, so on any large display it leaves it empty at any zoom.
Panels are hard-capped at `640px` / `720px`, the phone at `320px` inside a `minmax(280px, 340px)`
column — roughly **59% of the content area unused** on a 1920px screen, and the gap widens with the
monitor because the console takes `1fr` while the phone never grows.

| Tier | Width | Setup screens | Simulation |
|------|-------|---------------|------------|
| Compact | < 900px | Single column, full width | Phone full width, rails become sheets |
| Standard | 900–1300 | Single column, wider measure | Phone + one rail |
| Wide | 1300–1800 | **Two columns — form + preview** | Phone + both rails |
| Full | > 1800px | Two columns, larger preview | Phone larger, rails comfortable |

Cap the outer container near 1900–2000px so it doesn't sprawl on ultrawide. The rule: **extra space
goes to the photo and the preview, never to margins.**

### Live state

Ten values currently sit in one line at identical weight, reading as a status bar. Restructure by
**who owns each** — a distinction the engine already makes: operator-owned and absolute (persona,
mode); model-evolved and clamped (arousal, tease, awareness, thermal, mood, engagement); scene
(outfit, environment). Then add what's missing — **what changed this turn and why**, which the engine
already computes and emits to the decision log. Pinned values need a visible chip with one-click
release; today a pin looks identical to a model choice and expires silently.

### Setup screens

Two columns above 1300px — controls left, live preview right. Media Upload gets a large ingest grid;
Profile gets her character card as she'll appear; Protocol previews the opening beat.

**Face Lock is the biggest single win:** it currently renders all photos **twice on one page**, once
for face and once for body. One grid with a face/body toggle, both locked references shown large in
the preview, roughly halves that screen.

### Debug restructure

The DEV log turn cards are the best information design in the app and should be **promoted**, not
replaced — reuse that pattern for the operator log. Fix the five raw dumps trapped in ~130px scroll
boxes: give them real height or expand-to-full, group them behind one collapsed "Raw" section, keep
the structured panels expanded, and add section navigation.

### What the gallery must render

This brief defines the Phase 4 gallery contents:

- **Thread** — empty · first turn · text-only · with photo · Story · double text · reaction · left on
  read · went quiet · typing-then-deleted · wait running · failed image · safety block · Hebrew,
  English and mixed messages
- **Operator** — pin active · pin expired · outfit lock held · shot rotated · awakening stages 1–4 ·
  credit guard fired · clock resume · proxy down · storage full · no face locked
- **Setup** — every step empty and populated · face/body locked or not · 0, 1, 19, 20 photos ·
  saved / draft / editing
- **Both modes** — every state above in Immersion *and* Director

### Preserved

The stepper (and its collapse to numbers on the sim screen), the Protocol cards, the phone chrome,
the debug turn cards, the Standby reference content (relocated, not rewritten), and the deck's
persona / thermal / directives taxonomy.

---

## 4. Definition of done for v3

v3 ships when all of these are true:

- [ ] A character in any real city keeps correct local time
- [ ] Every immersion beat is visible with Developer Mode off
- [ ] The local proxy rejects unknown hosts and requires a session token
- [ ] A character can be exported and restored into a cleared browser
- [ ] Smoke, behaviour recording, and failure suite all run on demand and pass
- [ ] The reply format exists in exactly one place, and every response is checked
- [ ] The keyword-matching intent module is deleted
- [ ] UI code cannot reach through the wall — enforced automatically, not by convention
- [ ] The gallery renders every UI state listed in §3
- [ ] The conversation exists once, not twice — photos and text in one thread
- [ ] Errors and operator notices render outside the fiction, never inside the thread
- [ ] Immersion and Director modes both work, sharing one thread and one component set
- [ ] The layout uses the space on a wide monitor instead of capping at 640px
- [ ] Her Hebrew messages render correctly right-to-left
- [ ] The UI overhaul is complete with an unchanged behaviour recording
- [ ] State is a fold over the event log; the manual snapshot is gone
- [ ] The memory ledger keeps promises over trivia
- [ ] Pacing decisions are testable without waiting in real time; timers exist in one place only
- [ ] It still starts with one double-click

**Rough total: 10–14 weeks**, and the app works at every point along the way. No phase requires the
previous one to be finished perfectly — only finished enough that its tests pass.

---

## 5. Review coverage — every finding tracked

Every finding from `docs/PRODUCT_REVIEW.md`, and where it lands. Nothing is silently dropped; items
deliberately not being fixed say so and say why.

| ID | Finding | Lands in |
|----|---------|----------|
| B00 | Timezone substring matching | **Phase 1a** |
| B0 | Immersion beats routed to hidden debug lane | **Phase 1a** |
| B5b | Pinned metric vanishes during a ghost hold | **Phase 1a** |
| B1 | Image timeout misreported as "no image" | **Phase 1a** |
| B2 | Refusal heuristic runs before JSON parse | **Phase 1a** |
| B3 | Cancel leaks shot-variance state | **Phase 1a** (superseded by Phase 6) |
| B4 | Error copy names models the provider lacks | **Phase 1b** |
| B5 | Launcher pins Python 3.11 | **Phase 1a** |
| B6 | Unreachable branch in `errors.js` | **Phase 1b** |
| B7 | Input-token ceiling silently exceeded | **Phase 1a** |
| B8 | `STOP MIRAGE` kills any process on 8080 | **Phase 1a** |
| B9 | `//` comments in the JSON example shown to the model | **Phase 3** |
| S1 | Proxy SSRF + wildcard CORS | **Phase 1a** |
| S2 | API keys in URL query strings | **Phase 1a** |
| D1 | No export, import or backup | **Phase 1a** |
| D2 | Three separate IndexedDB databases, no migration path | **Parked** — see §6 |
| D3 | Async cleanup in a synchronous `try/catch` | **Phase 1a** |
| I2 | Stale V1 architecture note in the UI | **Phase 1b** |
| I6 | Header reads "Google AI" while running on kie | **Phase 1b** (app copy only — README half is out of scope) |
| I9 | 20-vs-30 photo limit mismatch | **Phase 1b** |
| I10 | Turn schema exists in two drifting copies | **Phase 3** |
| I11 | 12 `@deprecated` shims | **Phase 1b** |
| I13 | Deck vs router disagree on Change Outfit | **Phase 1b** |
| I14 | `MirageSessionStore` dead global | **Phase 1b** |
| I15 | Two module-export conventions | **Phase 1b** |
| — | `clearPhoneFeed` doesn't reset presence | **Phase 1b** |
| — | Dead `#phoneStatus` fallback | **Phase 1b** |
| — | Weekday fallback uses the browser's timezone | **Phase 1b** |
| — | `resolve()` greedy substring match | **Phase 1b** |
| — | kie polling: no backoff, logs every poll | **Phase 1b** |
| — | No schema validation on the turn contract | **Phase 3** |
| — | Client regex NLU duplicates the model's job | **Phase 3** |
| — | Prompt corpus has no regression protection | **Phase 2** |
| — | Memory ledger evicts by recency only | **Phase 6** |
| N1 | All three IndexedDB stores cache a rejected open | **Phase 1b** |
| N2 | No `onblocked` handler on IDB open — activated by the planned migration work | **Phase 1b** |
| N3 | Destructive deletes behind a native `confirm()`, no undo, no backup yet | **Phase 1b** + Phase 5 |
| N4 | **Legacy chat migration overwrites instead of merging** — see below | **Phase 1a** |
| I1, I3, I4, I5, I7, I8, I12 | README drift — dead `heat` persona, changed tease scale, mis-described `/fourth wall`, five undocumented commands, the whole kie provider, nine missing modules, undercounted control deck | **Not scheduled** — you chose "list it in the report". See §6, item 3 |

**Also verified as *not* bugs**, so nobody re-investigates them: character deletion cleans up fully
(`profile-store.js:168-178`); `#phoneTyping` is created on demand, not missing; there are no timer
leaks; the troubleshoot report contains no API key; quota handling is real and wired to the
storage-full modal.

---

## 6. Open decisions

Things that need your call rather than a default. Listed so they don't get made by accident.

**1 — The bezel clock.** The status bar currently shows *her* timezone on what is conceptually
*your* device (§3). Recommendation is to split them, so your status bar shows your time and her
local time becomes conversational context — *last seen 3h ago · it's 6am there*. Not yet confirmed,
and it touches the Phase 1 timezone fix.

**2 — The three modals.** Settings, Characters and Saved Chats were never screenshotted and are not
covered by the UI brief. There's also no persistent sense of *which* chat you're in — thread
switching lives behind a modal. Whether these are in scope for Phase 5 is undecided.

**3 — The README.** You chose "list it in the report", which was right at the time. The argument has
since changed: an AI agent doing Phase 5 will read the README, and it currently documents a persona
that doesn't exist, a tease scale that means something else, and a Google-only app. Wrong docs
actively mislead an agent. Worth revisiting on those grounds alone.

**4 — Storage consolidation (D2).** Parked. But Phase 1 builds export/import, and designing that
bundle against three separate databases versus one materially changes the work. If consolidation is
ever happening, doing it *before* export is much cheaper than after.

**5 — The app phones two third parties.** `calendar.js:570` and `:579` fetch the holiday catalogue
from **`www.hebcal.com`** and **`date.nager.at`** directly from the browser, on boot, outside the
local proxy. The hebcal call sends `geo=none`, but the nager call includes a **country code derived
from her profile location**. Those are the only two outbound hosts in the app that have nothing to do
with an AI provider.

It isn't a bug — it degrades correctly offline (abort timeout, caught in `app.js`) — but it's an
undocumented fact about an app whose premise is local-first with no cloud, and given the subject
matter any outbound request deserves a deliberate decision rather than a default. Options: bundle a
static holiday table offline, make the fetch opt-in, route it through the local proxy, or accept it
knowingly.

---

## 7. Parked for v3.1 and beyond

Not rejected. Sequenced.

**Product:** entity graph (friends, an ex, a boss she remembers consistently); operator-sent photos;
her phone feeling real (battery, calls, face-down at dinner); genuine multi-day absence; voice notes;
relationship arc as an explicit progression; a daily log of what she actually did.

**Technical:** branching conversations; wider TypeScript coverage;
consolidating the three databases into one; local model support via Ollama; per-chat credit metering;
the safety-filter fallback ladder.

**Only if the audience changes:** cross-platform launchers, real documentation, licensing, onboarding
polish, a demo character.

---

## 8. Future ideas — beyond v3

All out of scope for v3. Recorded here so the thinking isn't lost, ranked easiest to hardest, with
what each actually requires and where the vision needs pinning down before anyone builds it.

**Ranking is by implementation difficulty, not value.** Several of the easiest are among the most
valuable — the engine is well-factored in exactly the places these ideas touch.

| # | Idea | Difficulty | Why |
|---|------|-----------|-----|
| 1 | **10** · Random invented outfit (~20–30%) | **Trivial** | A coin flip in `applyOutfitChangeRequest`; `formatOutfitLibraryHint` already handles library-vs-invent |
| 2 | **13** · New shot types | **Easy** | `SHOT_TYPES` / `CROP_TYPES` are plain arrays; `goonFrame` is the precedent for a richer vocabulary |
| 3 | **9** · "Let AI decide your response" | **Easy** | One extra thinking call written as the operator; the operator profile already exists |
| 4 | **5** · TTS for chat messages | **Easy–Medium** | Browser `SpeechSynthesis` is free and instant; an API is needed only if Hebrew quality matters |
| 5 | **14/15** · Expressive, "knowing" faces | **Easy to build, hard to perfect** | Zero infrastructure — pure render vocabulary. All the cost is iteration |
| 6 | **12** · Queen persona | **Low–Medium** | Persona system is well-factored; needs its own frame vocabulary like Goon has |
| 7 | **11** · Comedian persona | **Low–Medium** | Same, plus an optional joke corpus that may not be needed at all |
| 8 | **1** · News access | **Medium** | RSS + cache + a relevance filter + a proxy route |
| 9 | **2** · Phone UI | **Medium–High** | Much cheaper after v3's wall — but needs a reachable server (see 4) |
| 10 | **6** · Voice clone + voice notes | **High** | API is easy; the setup step, storage, consent and cost control are the work |
| 11 | **7** · Video generation | **High** | Cost and latency, and face consistency across motion is the weakest part of current models |
| 12 | **8** · Messenger bot | **High** | Needs a server, and platform content policy is the real blocker |
| 13 | **4** · Stripe credits + app server | **Hardest** | Not a feature — a different product with a different risk profile |

> **Idea 3 (PC UI overhaul) isn't listed** — it's already v3 Phase 5, briefed in §3.

### The easy tier

**10 · Random invented outfit.** On `/change outfit`, sometimes ignore the library and invent.
*Unspecified:* should the chance be tunable? Should an invented look be constrained by her established
style, season and place, or genuinely free — an unanchored invention can drift off-character. And
**should an invented outfit be remembered** and added to the library so it can recur? Without that she
wears something once and never again, which is exactly the kind of small unrealism this engine
otherwise works hard to avoid.

**13 · New shot types** — body-only with lower face, body in mirror, POV from her eyes looking down
with body in frame. *Unspecified:* are these new **shotTypes** or new **crops**? "POV looking down
including body" is close to the existing POV shotType with a Torso/Full crop, so it may only need
better direction rather than a new enum value. Worth deciding deliberately, because there are only
four shot types today and adding more changes how the variance rotation behaves — more types means
better variance, which is a real side benefit.

**9 · "Let AI decide your response."** One thinking call that writes as the operator, using the
operator profile and recent history. *Unspecified:* does it **send immediately or fill the box for
editing**? Editing is safer and probably more fun. Should it use a cheaper model? And the stronger
product is likely **two or three options to pick from** rather than one auto-send — same call, much
better feel.

**5 · TTS.** *Genuinely ambiguous as written* — "TTS for user-side chat messages" reads either as
*speak her messages, on the client* or *speak the user's own messages*, which is unusual. Assuming
the former: browser `SpeechSynthesis` is free, instant, and needs no server, but its **Hebrew voices
are poor**, so Hebrew probably forces an API and a per-message cost. *Also unspecified:* autoplay or
tap-to-play, and whether the voice is per-character.

**14/15 · Expressive, knowing faces.** The most interesting idea on the list, and the cheapest to
attempt. The insight is right: a face has dozens of muscles and real expressions aren't "sad" or
"angry" — they carry layered intent, and that's what makes the reference images land.

Operationally this is *pure render vocabulary*. The contract already has an `expression` field and
`RENDER_DOCTRINE` already mandates readable affect; what's missing is the language. Image models
respond well to **muscle-level specifics** — asymmetric lip corner, lowered upper lids, direct eye
contact held a beat too long, brow micro-position — and badly to abstract emotional labels. So the
work is a curated expression vocabulary, most likely a mapping layer that expands a simple label the
thinking model picks into muscle-level direction for the renderer.

*Unspecified, and it matters:* does the **thinking** model choose the nuance, or does the **render**
side expand a simple label? The second is more reliable — the thinking model is already carrying a
lot, and a mapping table is tunable in one place. Is SOTA capable? Largely yes, via that vocabulary;
it will not come from asking for "a knowing look."

### The persona tier

**12 · Queen.** Elegance and power; pose, styling and psychology all regal. The persona system takes
this cleanly — a `PERSONA_BEHAVIORS` entry plus a persona-specific frame vocabulary, exactly the
pattern `goonFace`/`goonFrame` already establishes.

*Unspecified, and these produce very different characters:* is the power **psychological** (dismissive,
commanding, you are beneath her) or **aesthetic** (composed, untouchable, elevated)? The reference
images read as controlled elegance rather than cruelty. Also: does Queen change how the metrics
behave — does she refuse more, does engagement mean something different — or is she purely a
speech-and-image overlay like the others?

**11 · Comedian.** *Question the premise:* the "huge database of jokes" is probably unnecessary — the
model already knows jokes. A corpus earns its place only for **Hebrew humour and local references**
the model handles poorly. Also worth defining what funny means here: witty banter, bits, self-aware
riffing? A persona that *delivers jokes* gets tiring fast; one that is *situationally* funny is much
better and is a prompt problem, not a database problem.

### The infrastructure tier

**1 · News access.** RSS is free and simple; a news API is easy but keyed; scraping is fragile.
Route through the local proxy for CORS, cache aggressively, and budget the tokens.

*Unspecified, and it's the whole design:* **how does she come to know?** Does she "see" news the way a
person does — scrolling her feed, so it arrives with her mood and her opinions attached — or is it
ambient knowledge she can be asked about? Those are very different characters. Also: a relevance
filter matters more than the feed, because she should mention what *this* character would actually
mention, not recite headlines. And should news move her **mood**? Something happening in her city
plausibly should.

**2 · Phone UI.** Much cheaper once v3's wall exists — it becomes a second UI over the same engine
rather than a rewrite. *The real blocker isn't UI:* the engine is local-first behind a `localhost`
Python proxy, and a phone can't reach that unless it's on the same network or the app moves to a
server. **This idea quietly depends on idea 4.** Worth confronting early. *Also unspecified:* same
app made responsive, or a separate build? Does it install as a PWA?

**6 · Voice clone + voice notes.** The API call is the easy part. The work is a new setup step for the
reference sample, audio blob storage, a player in the thread, and per-generation cost. Hebrew is the
real constraint — fewer providers do it well.

*Unspecified:* where does the reference voice come from? Uploading a real person's voice raises the
same consent question the face already has, so the upload gate would need extending — worth deciding
before building, not after. And a genuinely interesting product question: **does she speak her written
message verbatim, or does the model write a separate spoken line?** Real people phrase voice notes
completely differently from texts, and the second option is far more convincing.

**7 · Video generation.** Several video models are reachable through the existing provider layer. The
blocker is not the API — it's that **face consistency across motion is the weakest part of current
models**, and face lock is this product's founding promise. A video that drifts off her face damages
the illusion more than no video at all.

*Unspecified:* what is the video *for* — a Story clip, a reply, a voice note with picture? How long?
Does it replace the still or sit alongside it? Recommend prototyping identity fidelity **before**
committing any product design to it.

**8 · Messenger bot.** Telegram is the only realistic starting point: free Bot API, trivial webhooks.
WhatsApp needs the Business API, Meta approval and per-message fees; Messenger needs a Page and app
review. All three require a publicly reachable server.

*The blocker worth stating plainly:* **all three platforms have content policies this app's output
would violate**, and enforcement is account-level. This isn't a technical risk, it's a "the account
gets banned" risk, and it should be weighed before any engineering. *Also unspecified:* does the bot
replace the web UI or mirror it, and does state sync both ways?

**4 · Stripe credits + app server.** Ranked hardest because it isn't a feature — it's a different
product. It needs accounts, auth, payments, a server-side key vault, usage metering, fraud handling,
refunds, terms, and real age verification.

*Two things worth confronting before this is ever scheduled.* First, **it inverts the local-first
principle** in §1 of this roadmap — user data and keys move to a server, and the privacy posture
flips. That may be the right trade, but it should be a conscious one rather than a consequence.
Second, and more practically: **if you hold the provider API keys, the provider's content policy
applies to you, not to your users.** For this content category that is a material risk and it is the
single biggest reason to think hard before going down this road.

---

## 9. Risks

| Risk | Mitigation |
|------|------------|
| The agent quietly changes behaviour during the UI overhaul | The wall makes it structurally hard; the recording makes it immediately visible |
| Phase 2 cements current bugs as "correct" | Phase 1 runs first, and Layer 3 asserts intended behaviour rather than today's |
| The event log becomes over-engineered | Keep the vocabulary small; it *replaces* three existing systems rather than adding a fourth. Branching stays unbuilt. |
| Prompt behaviour regresses during restructuring | The corpus is ported, never rewritten; the recording catches drift |
| Gradual typing stalls half-done | That's an acceptable resting state by design — the contract is typed, which is where the value is |
| The pacing split breaks delivery in subtle ways | It runs last, against a mature suite; the planner is pure and exhaustively covered before the scheduler replaces the old path |
| Scope creep from the parked list | Nothing in §7 or §8 starts until §4 is fully checked off |
| Losing double-click-to-run | Explicit acceptance criterion, checked every phase |
