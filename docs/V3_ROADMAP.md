# Mirage Engine v3 — Roadmap

*The consolidated plan: what gets fixed, what gets restructured, and the order to do it in.*

Supersedes nothing — this sits on top of `docs/PRODUCT_REVIEW.md` (what's broken today) and
`docs/REBUILD_BLUEPRINT.md` (the target architecture). Those remain the reference material. This is
the decision record and the sequence.

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

### Phase 1 — Critical fixes · ~3–4 days

Everything here is a defect with a known fix and a known location.

| Fix | What breaks today |
|-----|-------------------|
| **Timezone matching** (`phone-ux.js:33-38`) | Dallas, Atlanta, Portland, Cleveland, Oakland, Milan, Iceland, Poland, Auckland, Adelaide, Lagos all silently run on Los Angeles time. Her clock, her routine, and every time-of-day cue are hours off. One line. |
| **Immersion beats invisible** (`ui.js:88-92` + 10 call sites) | With Developer Mode off — the default — "left on read", "she went quiet", and "she was typing… then deleted it" are routed to a hidden debug panel. The refusal system looks like the app crashing. |
| **Image timeout misreported** (`api.js:340`) | `return` where it should be `throw`. Every image timeout is reported as "no image came back", and the useful message is discarded. |
| **Refusal check before parse** (`api.js:163`) | A valid reply containing in-character phrasing like "i'm unable to even" is misread as a provider refusal and can fail the turn. Parse first, check second. |
| **Proxy SSRF** (`mirage_server.py:304`) | Any website open in the browser can use the local helper to read internal/localhost URLs and read the response back. Session token + host allowlist + drop the wildcard CORS. |
| **Export / backup** | No recovery path exists. One `.mirage` bundle: character, chats, anchors, photo library. |
| **Dead `fire` option in the wait code** (`immersion.js:332-336`) | `clearSkippableWallWait({ fire: true })` calls an `onFire` callback that neither producer ever stores, so it silently does nothing. Dormant today because no call site uses it — but it is precisely the kind of booby-trap an agent finds and starts using. Delete the parameter. |

Also worth taking while in here — each is minutes: the stale V1 architecture note in `index.html:88`
(claims both models get the same prompt, which is the opposite of the truth), the 20-vs-30 photo
mismatch, the impossible Grok/Seedream advice shown to Google users, and the deck's Change Outfit
requiring an argument the typed command treats as optional.

**Done when:** a character in Atlanta shows Atlanta time; a `ghost_type` turn visibly explains itself
with Developer Mode off; a timeout says "timed out"; the proxy rejects an unknown host; a character
can be exported and re-imported into a cleared browser.

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

**The gallery.** One page rendering every UI state from fake data: image blocked, left on read, went
quiet, storage full, credit guard fired, awakening stages, no face locked, proxy down, empty chat.
Today, seeing those states means playing until you hit them and spending credits. This makes them one
click each.

Its value is fourfold: design decisions get made looking at the whole product at once; the agent can
verify its own work without playing or spending; rarely-seen states stop being the ugliest ones; and
a redesign gets reviewed in five minutes instead of an hour.

**Done when:** the boundary check fails on a deliberate violation; the gallery renders every state
listed above; the Phase 2 recording still passes unchanged.

---

### Phase 5 — UI overhaul · agent-driven

The goal all of this was protecting.

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

## 3. Definition of done for v3

v3 ships when all of these are true:

- [ ] A character in any real city keeps correct local time
- [ ] Every immersion beat is visible with Developer Mode off
- [ ] The local proxy rejects unknown hosts and requires a session token
- [ ] A character can be exported and restored into a cleared browser
- [ ] Smoke, behaviour recording, and failure suite all run on demand and pass
- [ ] The reply format exists in exactly one place, and every response is checked
- [ ] The keyword-matching intent module is deleted
- [ ] UI code cannot reach through the wall — enforced automatically, not by convention
- [ ] The gallery renders every UI state
- [ ] The UI overhaul is complete with an unchanged behaviour recording
- [ ] State is a fold over the event log; the manual snapshot is gone
- [ ] The memory ledger keeps promises over trivia
- [ ] Pacing decisions are testable without waiting in real time; timers exist in one place only
- [ ] It still starts with one double-click

**Rough total: 10–14 weeks**, and the app works at every point along the way. No phase requires the
previous one to be finished perfectly — only finished enough that its tests pass.

---

## 4. Parked for v3.1 and beyond

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

## 5. Risks

| Risk | Mitigation |
|------|------------|
| The agent quietly changes behaviour during the UI overhaul | The wall makes it structurally hard; the recording makes it immediately visible |
| Phase 2 cements current bugs as "correct" | Phase 1 runs first, and Layer 3 asserts intended behaviour rather than today's |
| The event log becomes over-engineered | Keep the vocabulary small; it *replaces* three existing systems rather than adding a fourth. Branching stays unbuilt. |
| Prompt behaviour regresses during restructuring | The corpus is ported, never rewritten; the recording catches drift |
| Gradual typing stalls half-done | That's an acceptable resting state by design — the contract is typed, which is where the value is |
| The pacing split breaks delivery in subtle ways | It runs last, against a mature suite; the planner is pure and exhaustively covered before the scheduler replaces the old path |
| Scope creep from the parked list | Nothing in §4 starts until §3 is fully checked off |
| Losing double-click-to-run | Explicit acceptance criterion, checked every phase |
