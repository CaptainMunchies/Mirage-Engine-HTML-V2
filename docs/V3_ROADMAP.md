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
| Types — gradual, contract first | Blueprint §5.1 | Guardrails where an agent is most likely to slip. The bundler that comes with it collapses 35 script tags into one and **retires the manual `?v=` cache-busting ritual** |
| Memory ledger eviction fix | Blueprint §7.3 | Cheap; fixes a hole in a headline feature |
| Provider capability interface | Blueprint §5.4 | A real port with declared capabilities (`maxReferenceImages`, aspect ratios, latency) instead of branching on provider name. The idea already half-exists as `maxCharacterRefs` / `supportsMultiReference`; formalising it makes B4 structural rather than a copy fix, puts the B1 timeout bug in one adapter with one test, and turns "add a provider" into writing one file |

### Out of scope, and why

| Item | Reason |
|------|--------|
| **Branching conversations** | The event log makes it nearly free, but it's a product feature nobody asked for. Structure is the goal, not the feature. |
| **Entity graph, operator photos, phone realism, voice notes, relationship arc, local models, character bundles, daily log** | Real ideas, parked for v3.1+. v3 is foundation. |
| **Full TypeScript conversion** | Weeks of churn with nothing visible. Gradual gets most of the protection at a fraction of the disruption. |
| **From-scratch rebuild** | Rejected in the blueprint and reaffirmed. The prompt corpus is the asset; the machinery gets improved around it. |
| **Cross-platform launchers, public docs, licensing, onboarding polish, demo character** | Private tool. Drops out entirely. The app stays Windows-only; a `.sh` launcher only matters if the audience changes. |

### Guardrails — decisions already made, not to be relitigated

Carried from the blueprint. These are the tempting mistakes, and an agent working in this codebase
should be told them explicitly.

- **No accounts, no cloud sync, no server-side state.** Local-first is a product feature, not a
  limitation to grow out of. (Future idea 4 in §8 would invert this — deliberately, and with eyes open.)
- **No telemetry.** Given the subject matter, the correct amount of data collection is zero.
- **No microservices, no Docker, no containers.** The app must stay double-clickable.
- **Never rewrite the prompt corpus.** Port it. It is the most valuable and least reproducible asset
  in the project, and the reason a from-scratch rebuild was rejected.
- **No "AI agent framework" dependency.** The orchestration here is a well-understood pipeline, not
  an agent loop. A framework would add abstraction and remove control over exactly the things that
  matter — prompt assembly and token budget.
- **Keep Python for the local server.** Requiring a Node install would be a real regression in setup.
- **No premature multi-character group chats.** It multiplies contract, pacing and persona complexity
  while the one-on-one illusion still has headroom.
- **No streaming responses.** The turn is atomic — the client must validate, clamp and possibly
  repair the whole contract before anything is shown. Streaming fights the architecture for a
  cosmetic gain, and the typing indicator already covers the latency perceptually.

### What is already good — do not "improve" these

An agent doing Phase 5 needs this list as much as the defect list.

- **The cancel/rollback checkpoint system** — snapshots chat DOM, phone cards, history, uiLog, every
  metric, clock offset, world beat, memory ledger and loyalty dynamics, then restores all of it and
  returns the cancelled message to the composer. (It has one gap, B3 — fix that, don't replace it.)
- **Chat-boundary epochs** — `sessionEpoch` plus the boundary tokens correctly stop an in-flight turn
  landing in the wrong chat, a bug class most apps of this shape get wrong.
- **`bindSafely`** (`app.js:899-910`) — wraps every subsystem bind so one broken module degrades
  instead of taking down the app.
- **`verifyPromptArchitecture()`** (`app.js:954`) — a boot-time assertion that the prompt split still
  holds. Phase 4's wall should make this a build-time lint rule rather than removing it.
- **The debug turn cards** — the best information design in the app; promoted in §3, not replaced.
- **The "Copy troubleshoot report" flow** — it even tells you to paste into Cursor. A deliberate,
  smart dev-loop integration worth keeping as the agent workflow evolves.
- **Accessibility and responsiveness** — 12 breakpoints down to 520px, two `prefers-reduced-motion`
  blocks, ARIA roles on the autocomplete combobox and modals. Better than typical; don't regress it
  during the overhaul.
- **The stepper**, the Protocol cards, the phone chrome, and the deck's persona/thermal/directives
  taxonomy — all listed in §3 as preserved.
- **The delivery planner's defensive layers** (`immersion.js:926-1214`) — `resolveNarrativeTimeSkip`'s
  refusal to snap a soft band into an apparent clock rewind, and `resolveStyle`'s repeated
  `mustDeliver` clamps (it re-clamps after the presence conversions specifically because those can
  reintroduce a withhold). Both read as over-cautious until you notice each guard is defending a real
  failure the author already hit. Phase 7 splits this code; it should not simplify these away.

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

> **Status: 1a and 1b are both done** — shipped on `claude/mirage-v3`, one commit per finding, each with the
> verification in its message. Every fix was checked by driving the real code in a headless browser
> rather than by inspection: the timezone resolver against all 23 previously-broken locations, the
> refusal beats by running turns through the mock until `ghost_type`, `left_on_read` and `went_quiet`
> each rolled, the SSRF fix against a live server with 12 attack probes, and the backup by exporting a
> full character, opening a fresh browser profile, and restoring it.
>
> **1b is done too**, in seven commits. Two items were deliberately scoped: the native
> `confirm()` dialogs now say exactly what a delete destroys and point at Export, but
> *replacing* them with styled modals stays a Phase 5 item; and the kie poll backoff could
> not be exercised end-to-end here, since that path needs a live kie key. Everything else
> was verified by running it.

#### 1a — Defects that change behaviour

| ID | Fix | What breaks today |
|----|-----|-------------------|
| **B00** | **Timezone matching** (`phone-ux.js:33-38`) | Dallas, Atlanta, Portland, Cleveland, Oakland, Milan, Iceland, Poland, Auckland, Adelaide, Lagos all silently run on Los Angeles time. Her clock, her routine, and every time-of-day cue are hours off. **Two fixes, pick deliberately:** the one-line patch is to iterate the city table longest-key-first and match on word boundaries. The *proper* fix from the blueprint is to **store an IANA zone on the character record at creation**, chosen from a searchable list — then there is no runtime guessing left to get wrong, and the whole bug class disappears rather than being patched. The second also removes the three dead browser-local fallbacks below from ever mattering. |
| **B0** | **Immersion beats invisible** (`ui.js:88-92` + 10 call sites) | With Developer Mode off — the default — "left on read", "she went quiet", "she was typing… then deleted it" all route to a hidden debug panel. The refusal system looks like the app crashing. **Found while fixing this:** the instant/hybrid withhold block (`immersion.js:1591-1604`) had **no `went_quiet` branch at all** — that style produced no bubble, no receipt and no notice on any pacing mode, so the beat was invisible even *with* Developer Mode on. Counted as an eleventh site. |
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
| **N5** | **The body reference leaks between characters — and is saved onto the wrong one** (`characters-ui.js:104-135`) | `startNewCharacterDraft` calls `clearMasterFace()` but **never `clearBodyReference()`**, and `resetSimulationRuntime` doesn't touch it either — the only callers of `clearBodyReference` are Face Lock's explicit Clear button, its two error paths, and `resetSession()`. So starting a new character draft carries the *previous* character's body reference forward, it is used as the BODY proportions ref for image generation, and because `exportSnapshot` reads `state.masterBodyFile` at save time (`profile-store.js:94`) **it gets written onto the new character**. Cross-character contamination that persists to disk. |
| **N4** | **Legacy migration overwrites all chats** (`chat-store.js:44-88`) | `migrateLegacyOnce` builds a *fresh* `{ characters: {} }` from the legacy `mirage_v2_sessions` key and `writeStore`s it — discarding whatever `mirage_v2_chats` currently holds. It runs on **every** `readStore()`, and it is only safe because it deletes the legacy key afterwards. If that key ever reappears — a restored backup, a synced profile, a partial import — the very next read silently destroys every chat. **This matters specifically because Phase 1 builds import.** Make it merge, and gate it on the target being empty. |
| **N12** | **Hybrid never waits on the *model's* time jumps — half the mode's advertised behaviour is dead code** (`immersion.js:1282-1288` vs `:1337`, `:1401`) | The Settings option reads "Hybrid — fast texts, wait on time jumps" (`index.html:890`), and the module's own JSDoc says the same (`:215-219`). `planDelivery` computes `narrativeWaitMs = toRealWaitMs(timeSkipMs)` whenever pacing is hybrid **or** realtime — then hybrid unconditionally falls into the instant-like branch (`turnInstantLike = pacing !== 'realtime'`), which returns `narrativeWaitMs: 0` on both of its exits. The value is computed and thrown away every hybrid turn. `choreograph` (`:1541`) additionally gates on `!plan.instant`, so it is dead twice over. The inline comment at `:1336` — "narrativeWaitMs may still be > 0 for time jumps" — asserts the opposite of what the code does. **Half the feature does work:** operator-commanded skips (Time pass…, Jump to…, world skips) arm a real wall wait through `simulation.js:2572-2590`, which is why this has never looked completely broken. What silently does nothing is `delivery.timeSkipSec` — the model's own authored jumps, the ones that come with "she's been gone three hours" narration. Decide which is intended and make code, comment, JSDoc and Settings copy agree; if hybrid *should* wait, the fix is to compute the wait before the instant-like branch and let that branch return it. |
| **N14** | **`lastTimeSkipMs` is never consumed on ditch-hold or streak-cap turns** (`immersion.js:2446-2459`) | `onTurnSettled` zeroes the post-skip flag — but only after two early returns: `if (isDitchHold()) return;` and `if (sheIsAtStreakCap() \|\| isUnresponsiveCap()) { … return; }`. Land a ≥20-minute skip into either state and the flag stays set indefinitely. Downstream that flag is not cosmetic: `planDelivery:1237` reads it as `landingAfterJump` and force-softens presence to **warm** — so she can never go cold again — and `mirage-prompt.js` keeps injecting `OUTFIT STALE` and `ENV: 3 hours passed — she SHOULD have left this room` on every subsequent turn, pushing a wardrobe and location change that already happened. Clear the flag before the early returns, or make it a timestamp that expires rather than a sticky number. |

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
| **N6** | `openSessionChoice` (`characters-ui.js:198-206`) reads `latest.protocol` and `latest.lastTurn` **before** its own `disabled = !latest` null check three lines later. Safe today only because the one caller checks `chatCount > 0` first — a second caller throws a `TypeError` |
| **N7** | Saving a character writes localStorage **twice** (`characters-ui.js:332-357`) — `saveWithAnchors`, then a second `save` carrying the media-library metadata. If the second write hits the quota ceiling the anchors persist but the metadata doesn't, leaving a half-saved character. Make it one atomic write; it matters more once import exists |
| **N8** | Face Lock lets you pick a **body reference the active setting silently ignores**. With reference mode on "Face only", `effectiveReferenceMode()` discards the choice at generation time with no indication — the hint text states the requirement but nothing enforces or reflects it |
| **N9** | `protocolBadge` is interpolated into `innerHTML` **unescaped** (`chats-ui.js:84`) inside a template that carefully escapes the label and preview either side of it. Not exploitable today (protocol and mode are client-owned enums), but the inconsistency is worth closing while the file is open |
| **N10** | Photos are identified by `file.name` (`setup-face.js:161`, `:212`, `:328`). Two images with the same filename — `IMG_0001.jpg` being the obvious case — collide in selection state and in the `querySelector` lookup at `:129` |
| **N11** | `restoreChatUi()` is async and called without `await` or `.catch` after deleting the active chat (`chats-ui.js:196`). Same family as D3 |
| — | The saved-chats list reports `history.length` as "turns" (`chats-ui.js:84`), but history is capped at 100 — so every long chat reads "100 turns" forever |
| **N13** | **Hebrew typo makes one question word unmatchable** (`immersion.js:917`). `lastUserNeedsReply` tests `/(איפה\|למה\|מתי\|מה\s\|מי\s\|איך\|הייכן)/` — `הייכן` has a doubled yod and is not a word; the formal "where" is `היכן`. Impact is bounded because line 912 already returns true on any `?`, so this only matters for a question typed without one — but that is exactly the case the Hebrew branch exists to catch, and the consequence is that she is allowed to ghost a direct question. Same line: `מה\s` requires trailing whitespace, so a message *ending* in `מה` never matches either |
| **N15** | Redundant condition (`immersion.js:1059`): `if (coldEng \|\| coolEng)` where `coldEng` (engagement ≤ 25) already implies `coolEng` (≤ 45). Harmless, but it reads as if two bands are being handled when one is |
| **N17** | **The mock's delivery cycle is dead in Instant and Hybrid** (`mock-api.js:209-215`). `nextDeliveryStyle()` opens with `if (!S().realTimeChat) return 'normal'`, and `realTimeChat` is a *derived* flag — `state.js:391`, `:571` recompute it as `pacingMode === 'realtime'` — so outside Realtime the mock never advances `DELIVERY_CYCLE` and every mocked turn is `normal`. Verified at runtime: with `pacingMode: 'instant'` the flag reads `false` no matter what is written to config. Harmless in play, but **Phase 2 depends on the mock being the deterministic substrate** for golden transcripts, and today it cannot exercise a single withhold style in the two modes you actually use. Gate it on `getPacingMode()`, or better, on an explicit "cycle delivery styles" dev switch independent of pacing |
| **N16** | **`delivery.style: 'slow'` is inert whenever she's warm** (`immersion.js:1412-1457`). The delay ladder checks presence *before* style, so `hot` and `warm` claim the reply before `else if (style === 'slow')` is ever reached. `hot` is fine — `resolveStyle:1154` explicitly vetoes `slow` at hot presence. `warm` is not vetoed, so a model-authored "take your time replying" turn gets the normal 2–22s warm pre-read and is indistinguishable from `normal`. Either veto `slow` at warm too, or let style win over presence for the styles the model explicitly asked for |

**Done when:** a character in Atlanta shows Atlanta time · a `ghost_type` turn visibly explains itself
with Developer Mode off · a pin during a ghost hold says so · a timeout says "timed out" · the proxy
rejects an unknown host and requires a token · no API key appears in a URL · a character survives a
cleared browser · Hybrid does what its own Settings line claims about time jumps · she can go cold
again after a skip · every row in 1b is gone.

---

### Phase 2 — Test foundation · ~1–1.5 weeks

> **Status: done.** Lives in `tests/`, with its own `package.json` so the app stays no-build.
> 51 offline tests: 11 smoke, 4 recorded scenarios, 34 failure cases, 2 node-only — 48 green
> and 3 known-red, each naming the phase that closes it, and reproducible run to run. Plus 12
> live tests that call a real provider, never part of `all` and never run without a key.
> `tests/README.md` carries the operating instructions.
>
> Building it found three defects that reading had not: **N18** (server restart refused for a
> full minute), **N19** (the model can override operator-owned mode) and **N20** (a full disk
> silently stopped saving turns). N18 and N20 are fixed; N19 is one of the known-red tests.
>
> **Two ways to fire it.** *Settings → Developer → Open test runner…* opens a runner window with
> a Run all button, live results, expandable failures and copy/download report — no Node, no
> install. `node run.js smoke | record | failure | nodeonly | all` does the same from a terminal,
> plus Layer 2, which stays terminal-only because it reads and writes baseline files on disk.
>
> Layers 1 and 3 are defined **once**, in `tests/suites/`, as plain browser code, and both
> runners execute them through the same `tests/ui/runner.html`. `layer-browser.js` contains no
> assertions — it is a relay. The button and the terminal cannot drift apart.
>
> **Why the runner cannot touch your library.** `localhost:8080` and `127.0.0.1:8080` are the
> same server but different storage origins — verified empirically, not assumed. The runner opens
> on whichever alias you are not browsing with and drives a sandbox iframe beside it, so wiping
> the sandbox between tests is unreachable from your real characters, chats and photos. If it
> ever lands on your own origin it refuses to run.

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
failure suite has known-red tests for the paths Phase 1 didn't cover. — **All three met.**

**But the failure surface above is not fully covered, and the suite should not pretend otherwise.**
Twelve of the scenarios listed were never written. Recorded here rather than quietly dropped:

| Group | Not covered |
|---|---|
| Bad model output | missing `imageDirective` when one is required *(covered live, not offline)* |
| Provider / network | invalid key · rate limit (429) · server error (500) · empty image · proxy not running |
| Interruption | cancel during **image** generation · refresh mid-turn (the `mirage_v2_pending_turn` restore path) |
| Storage | character deleted mid-session |
| Time | two-day absence · a jump landing on the wrong day |
| Rules | the 5-unanswered credit guard · thermal pin expiry · outfit lock vs change request · body reference on a single-reference model |

The refresh-mid-turn gap is the most valuable of these: `pending-turn.js` exists precisely for it
and has no test at all. Phase 3 should close that one at minimum.

Two notes for whoever runs this next. The determinism layer (seeded PRNG, fake clock, pinned
locale and timezone) is installed *from the test side only*: the engine is not modified and does
not know it is being observed, because a test hook inside the engine is one more thing that can
drift from what ships. And Layer 2's value depends entirely on reading the diff before running
`--update` — a baseline re-recorded without looking is worse than no baseline, because it
converts a caught regression into a committed one.

A third note, added when the suite moved into the app. The original harness waited on
`isTurnInProgress()` — the *hard* busy flag — and then slept a flat 80ms. That flag goes false
while the delivery choreography is still typing her reply into the thread, so the wait was a race
the tests happened to keep winning while each one had a browser page to itself. Running them
back to back in one window lost it, and a good engine failed a good test. The shared harness waits
on `isEngineBusy()` — which covers choreography, pending holds and wall waits — then requires two
consecutive quiet samples. Worth stating because a flaky test is worse than a red one: a red test
tells you something; a flaky one teaches you to ignore the suite.

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

**The agent may not be the one who wrote this.** The overhaul will likely be driven from Cursor
(Grok 4.6 built v2 there), not from the conversation that produced these documents. That has two
consequences worth planning for: an agent in Cursor reads **repo files**, not chat history — so this
roadmap, the UI brief and the README are its actual context — and it will read the README, which
currently documents a persona that no longer exists, a tease scale that means something else, and a
Google-only app. That is the strongest argument for open decision 3.

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

**Both halves need a clock they don't own.** Introduce a small clock port — `now()`, `advance(ms)`,
`timezone` — backed by real time plus the session offset in production and by a controllable fake in
tests. Today time is read directly all over the codebase as `Date.now() + clockOffsetMs`, which is
why pacing can only be verified by waiting in real time, and it's the same scattered-time-reads
problem that produced B00 and the three dead browser-local fallbacks. The fake clock is also what
Phase 2's pacing tests need in order to run instantly, so this lands naturally alongside the split.

**Why it earns its place, given Skip Wait already exists.** Skip Wait proves a wait *can* be skipped.
It does not prove the wait was the *right length*, and it needs a human to click it — an automated
test can't. With the split, *"in Realtime, with cold engagement and a left-on-read reply, the
schedule should be X"* becomes an assertion that runs instantly. Every combination of delivery style
and pacing mode gets verified in a fraction of a second, including the ones that currently take ten
real minutes to observe once.

**N12 is the argument for this phase, in one finding.** Hybrid computes a wall wait for the model's
time jumps and then returns zero — the mode does half of what Settings says it does, and has since it
shipped. Nothing threw, nothing logged, and no amount of playing the app surfaces it, because the
only symptom is a wait that doesn't happen. A pure planner makes that assertable in one line:
*"hybrid + `timeSkipSec: 7200` → schedule contains a wait"*. Fix N12 in Phase 1 as a behaviour bug,
then let Phase 7 make the whole class of it impossible to reintroduce.

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

Every finding from `docs/PRODUCT_REVIEW.md`, plus the N-series found in the follow-up reading passes,
and where each lands. Nothing is silently dropped; items deliberately not being fixed say so and say
why.

| ID | Finding | Lands in |
|----|---------|----------|
| B00 | Timezone substring matching | **Phase 1a — done** |
| B0 | Immersion beats routed to hidden debug lane | **Phase 1a — done** |
| B5b | Pinned metric vanishes during a ghost hold | **Phase 1a — done** |
| B1 | Image timeout misreported as "no image" | **Phase 1a — done** |
| B2 | Refusal heuristic runs before JSON parse | **Phase 1a — done** |
| B3 | Cancel leaks shot-variance state | **Phase 1a — done** |
| B4 | Error copy names models the provider lacks | **Phase 1b — done** |
| B5 | Launcher pins Python 3.11 | **Phase 1a — done** |
| B6 | Unreachable branch in `errors.js` | **Phase 1b — done** |
| B7 | Input-token ceiling silently exceeded | **Phase 1a — done** |
| B8 | `STOP MIRAGE` kills any process on 8080 | **Phase 1a — done** |
| B9 | `//` comments in the JSON example shown to the model | **Phase 3** |
| S1 | Proxy SSRF + wildcard CORS | **Phase 1a — done** |
| S2 | API keys in URL query strings | **Phase 1a — done** |
| D1 | No export, import or backup | **Phase 1a — done** |
| D2 | Three separate IndexedDB databases, no migration path | **Parked** — see §6 |
| D3 | Async cleanup in a synchronous `try/catch` | **Phase 1a — done** |
| I2 | Stale V1 architecture note in the UI | **Phase 1b — done** |
| I6 | Header reads "Google AI" while running on kie | **Phase 1b** (app copy only — README half is out of scope) |
| I9 | 20-vs-30 photo limit mismatch | **Phase 1b — done** |
| I10 | Turn schema exists in two drifting copies | **Phase 3** |
| I11 | 12 `@deprecated` shims | **Phase 1b — done** |
| I13 | Deck vs router disagree on Change Outfit | **Phase 1b — done** |
| I14 | `MirageSessionStore` dead global | **Phase 1b — done** |
| I15 | Two module-export conventions | **Phase 1b — done** |
| — | `clearPhoneFeed` doesn't reset presence | **Phase 1b — done** |
| — | Dead `#phoneStatus` fallback | **Phase 1b — done** |
| — | Weekday fallback uses the browser's timezone | **Phase 1b — done** |
| — | `resolve()` greedy substring match | **Phase 1b — done** |
| — | kie polling: no backoff, logs every poll | **Phase 1b — done** |
| — | No schema validation on the turn contract | **Phase 3** |
| — | Client regex NLU duplicates the model's job | **Phase 3** |
| — | Prompt corpus has no regression protection | **Phase 2** |
| — | Memory ledger evicts by recency only | **Phase 6** |
| N1 | All three IndexedDB stores cache a rejected open | **Phase 1b — done** |
| N2 | No `onblocked` handler on IDB open — activated by the planned migration work | **Phase 1b — done** |
| N3 | Destructive deletes behind a native `confirm()`, no undo, no backup yet | **Phase 1b — done** (styled modals stay Phase 5) |
| N4 | **Legacy chat migration overwrites instead of merging** | **Phase 1a — done** |
| N5 | **Body reference leaks between characters and is saved onto the wrong one** | **Phase 1a — done** |
| N6 | `openSessionChoice` dereferences before its own null check | **Phase 1b — done** |
| N7 | Character save writes localStorage twice — partial-save risk on quota | **Phase 1b — done** |
| N8 | Body reference selectable while the setting silently ignores it | **Phase 1b — done** (styled modals stay Phase 5) |
| N9 | `protocolBadge` unescaped in `innerHTML` | **Phase 1b — done** |
| N10 | Photos identified by filename — duplicates collide | **Phase 1b — done** |
| N11 | `restoreChatUi()` unawaited after deleting the active chat | **Phase 1b — done** |
| N12 | **Hybrid never wall-waits on model-authored time jumps — computed then discarded** | **Phase 1a — done** |
| N13 | Hebrew `הייכן` typo — the formal "where" can never match | **Phase 1b — done** |
| N14 | **`lastTimeSkipMs` never cleared on ditch-hold / streak-cap turns — presence stuck warm, stale prompt injects** | **Phase 1a — done** |
| N15 | Redundant `coldEng \|\| coolEng` | **Phase 1b — done** |
| N16 | `delivery.style: 'slow'` inert at warm presence | **Phase 1b — done** |
| N17 | **Mock delivery cycle dead outside Realtime — blocks Phase 2's deterministic transcripts** | **Phase 1b — done** |
| N18 | **Restarting the server failed for a full minute** — `mirage_server.py` set `allow_reuse_address = False`, so a rebind was refused for the whole `TIME_WAIT` window while `bind_server` gave up after 5s. Stop-then-start simply failed. It bought nothing: on Linux `SO_REUSEADDR` does not permit two listeners on one port, so an already-running Mirage is still detected | **Phase 2 — done** |
| N19 | **The model can put the app into Story mode on its own.** `applyTracking` states persona and mode are client-owned and deliberately ignores them — then `simulation.js:4374` honours `tracking.mode === 'STORY'` anyway, flipping the session and the card chrome. Operator authority is a §1 guardrail, and this is the one place a model decision overrides it | **Phase 3** (known-red test exists) |
| N20 | **A full disk stopped saving turns silently.** `saveActiveChat` is `async`, and 7 call sites wrapped it in a *synchronous* `try/catch`, which cannot catch a rejection — so a quota failure became an unhandled rejection and the storage-full dialog the review verified as "real and wired" was unreachable from those paths. Same shape as D3, which the review caught in only one of its instances | **Phase 2 — done** |
| N21 | **The browser served months-old app code and nothing said so.** `mirage_server.py` sent static files with only `Last-Modified` and no `Cache-Control`, so Chrome applied heuristic freshness and reused cached JS for days without making a request. The `?v=` query on every script tag was the intended defence, but it is a hand-maintained constant that **had not changed since the project was imported** — so every edit from Phase 1a onward shipped under a cache key the browser already had an answer for. `index.html` carries no version query, so it revalidated and the *new markup* appeared over *old modules*: the Data & backup card rendered and its buttons did nothing, because the cached `app.js` predated the code that binds them. Nothing errored. Fixed by sending `Cache-Control: no-cache` on non-API responses (still 304s off local disk, so it stays fast) and bumping `?v=` to 200 once to flush caches already poisoned. Smoke test added | **Phase 2 — done** |
| I1, I3, I4, I5, I7, I8, I12 | README drift — dead `heat` persona, changed tease scale, mis-described `/fourth wall`, five undocumented commands, the whole kie provider, nine missing modules, undercounted control deck | **Not scheduled** — you chose "list it in the report". See §6, item 3 |

### Review depth — stated honestly

Not every file was read to the same standard, and the difference matters when judging how complete
this list is.

**Read line by line:** `index.html`, `mirage_server.py`, `state.js`, `commands.js`, `api.js`,
`errors.js`, `safety-gates.js`, `pending-turn.js`, `memory-ledger.js`, `control-deck.js`,
`image-store.js`, `setup-face.js`, `characters-ui.js`, `chats-ui.js`, both `.bat` files — plus the
turn pipeline, `applyTracking`, cancel/rollback, shot variance and chat/toast plumbing in
`simulation.js`; the schema blocks, registries, awakening, `RENDER_DOCTRINE` and budget compressor in
`mirage-prompt.js`; the wait primitives, `choreograph`, `cancelDelivery`, `onTurnSettled` and the full
delivery planner — `lastUserNeedsReply`, `resolveNarrativeTimeSkip`, `resolveStyle`, `planDelivery` —
in `immersion.js`; and the clock/timezone paths in `phone-ux.js`.

**Scanned by pattern, not read in full:** `setup-media.js`, `setup-protocol.js`, most of
`setup-profile.js`, `user-profiles-ui.js`, `user-profile-store.js`, `debug-panel.js`, and the bulk of
`chat-store.js`, `loyalty-ux.js`, `calendar.js` and `routine.js` — roughly **3,500 lines**.

Nothing observed suggests defects in the scanned set, but "scanned" is not "reviewed". Every deep
finding in this document — B00, B0, N4, N5, N12, N14 — came from reading, not scanning, so the honest
expectation is that more remain in those files. **Phase 2's failure-case suite is the instrument that
finds them**, because it executes those paths rather than relying on anyone reading well.

That prediction held. Building Phase 2 surfaced three defects no amount of reading had caught —
N18 (server restart), N19 (the model overriding operator-owned mode) and N20 (silent save failure on
a full disk) — two of them found by tests written to assert intended behaviour rather than to
describe current behaviour.

**The delivery-planner pass is now closed.** The earlier version of this document flagged
`resolveStyle` / `planDelivery` as the highest-risk unread code in the project, on the reasoning that
the two deepest bugs in the review (B00, B0) both came from exactly this kind of quiet-logic reading.
That pass has been done: it returned N12–N16, of which **N12 and N14 are real behaviour defects** —
one mode doing half of what it advertises, and a flag that never clears in two states. Both would have
been effectively unfindable by playing the app, since neither throws, logs, or looks wrong on any
single turn. The rest of `immersion.js` — `resolveNarrativeTimeSkip`'s clock-rewind guards in
particular, and `resolveStyle`'s layered `mustDeliver` clamps — is careful, defensive, well-commented
code, and is called out in §1 as work not to undo.

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

There's a second reason to decide now: characters, chats and settings all live in **localStorage,
which is capped around 5 MB per origin**. The app already ships a "Browser storage is full" modal
because that ceiling gets hit in practice. Consolidating into IndexedDB — which has no comparable
cliff — retires that failure mode entirely rather than continuing to explain it to the user. A
storage-usage meter would also stop the cliff being a surprise.

**5 — There is no plain-language version of any of this.** All four documents are written for
someone comfortable with the codebase. You've said directly that the technical register is hard to
follow, and v2 was built by an agent rather than by hand — so the person who has to act on this plan
is not the person who wrote the code. A one-page plain-English summary — what's broken, what it costs
you in play, what happens in what order — would make the plan usable without a translator, including
by you in three months. Cheap to write, and the only artefact here that survives handing the project
to anyone else.

**6 — The app phones two third parties.** `calendar.js:570` and `:579` fetch the holiday catalogue
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
| 1 | **10** · Random invented outfit (**25%**) | **Trivial** | A weighted roll in `applyOutfitChangeRequest`; `formatOutfitLibraryHint` already handles library-vs-invent |
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
| 13 | **16** · Group chat with multiple AIs | **Very high** | The only idea here that breaks a core assumption: one chat = one character. Touches the store schema, the turn contract, the HUD, memory scoping and the whole delivery pipeline |
| 14 | **4** · Stripe credits + app server | **Hardest** | Not a feature — a different product with a different risk profile |

> **Idea 3 (PC UI overhaul) isn't listed** — it's already v3 Phase 5, briefed in §3.

### The easy tier

**10 · Random invented outfit.** On `/change outfit`, sometimes ignore the library and invent.
**Decided: 25% chance of triggering.** That is a constant in the engine, not a Settings slider —
tunable pacing knobs are what turn a character into a control panel, and 25% is frequent enough to
surprise without making the library feel pointless.

*Still unspecified, and worth pinning before anyone builds it:* should an invented look be constrained
by her established style, season and place, or genuinely free — an unanchored invention can drift
off-character. And **should an invented outfit be remembered** and added to the library so it can
recur? Without that she wears something once and never again, which is exactly the kind of small
unrealism this engine otherwise works hard to avoid. My read: constrain it to her style and the
current season/place, and *do* write it back to the library, so the 25% roll grows her wardrobe over
time instead of producing one-offs.

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

**16 · Group chat with multiple AIs.** A thread with you and two or more characters in it, each with
her own face, persona and metrics. Ranked second-hardest, and it's the only idea in this list that
breaks a **founding assumption of the data model**: today a chat belongs to exactly one character —
`mirage_v2_chats` is keyed by character, `charKey()` resolves one identity, the HUD shows one set of
metrics, and one turn produces one reply from one person. Group chat makes every one of those plural.

*What it actually requires, in rough order of pain:*

- **The store schema.** A chat needs a participant list rather than an owner. Every read path that
  assumes `characterKey(state)` has to be found and changed — and this is exactly the kind of sweeping
  change that N4's overwrite-on-migrate bug turns into data loss, so it must land after that is fixed.
- **The turn contract.** Two viable designs, and they produce different products. **One director call**
  authoring every participant is cheaper and gives genuinely good banter, because one model sees the
  whole room — but it collapses the disjoint identity ledgers into one prompt, which is the thing §1
  guards most carefully. **N independent calls**, one per character, keeps each identity and her own
  arousal/tease/engagement intact and is far truer to the engine's design — but costs N× per turn, and
  they can't hear each other inside a single turn without a second pass. My read: N calls with a
  cheap second "reaction" pass, because per-character metric authority is the thing that makes these
  characters feel like people rather than voices.
- **Photos.** Each character has her own face lock and anchor set, and multi-subject identity is where
  current image models are weakest. The honest v1 is that **photos stay single-subject** — whoever is
  posting — and a genuine group selfie is its own hard feature, closer to idea 7 in difficulty than to
  anything here.
- **Pacing.** Two characters replying means two independent delivery schedules interleaving in one
  thread. Today there is exactly one, coordinated by seven pieces of module state. **This is dramatically
  cheaper after Phase 7's planner/scheduler split** — a pure planner run per participant, one scheduler
  merging their schedules. Before that split it is close to unbuildable without breaking delivery.
- **Memory scoping.** A character must not know something she wasn't present for. That means a shared
  thread memory *plus* a per-character ledger, and a rule about which one a callback may draw from.

*Unspecified, and these change the whole shape:* Is it one group thread, or you texting two people in
separate threads who know about each other? Do they speak to each other unprompted, or only when
addressed? Does each keep her own engagement toward **you**, and can one of them resent the other for
your attention — because that, rather than the logistics, is probably the actual product idea here,
and it argues strongly for the per-character-metrics design over the single-director one.

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
