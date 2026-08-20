# Mirage Engine — tests

Three layers, briefed and built as three. A single "extensive test suite" produces
one sprawling brittle file; these have different rules and are meant to stay separate.

Everything runs with **no API key and no credits** — mock mode supplies the thinking
and image halves, and the real `mirage_server.py` serves the app so the proxy,
IndexedDB and module load order are all exercised for real.

## Two ways to run them

### 1. The button (no setup at all)

**Settings → Developer → Developer Mode → Open test runner…**

That opens a separate window with a Run all button, live pass/fail, expandable
failure detail, and Copy report / Download .txt / Download .json. Nothing to
install — it is just the app's own server serving another page.

Covers Layers 1 and 3, plus the live suite if you paste an API key. Layer 2 is
terminal-only (see below).

**Why it cannot hurt your library.** `localhost:8080` and `127.0.0.1:8080` are the
same server but *different storage origins* — a key written at one reads back as
`null` at the other, which was checked rather than assumed. The runner window opens
on whichever alias you are **not** browsing with, and the app under test runs in an
iframe beside it on that same alias. Wiping the sandbox between tests therefore
cannot reach your characters, chats or photos: they are on the other side of a
boundary the browser enforces. If the runner ever does land on your origin it
refuses to run and says so instead.

### 2. The terminal

The app needs only Python. **The terminal runner also needs Node.js** — that is the
one extra prerequisite, and only for this path. Install it from <https://nodejs.org>
(any current LTS), then:

```
cd tests
npm install                       # Playwright
npx playwright install chromium   # the browser it drives (~150 MB, once)
```

On Windows use the same commands in Command Prompt or PowerShell from the repo
folder. Python is found automatically (`py -3`, `python`, `python3` — whichever
answers first), and so is Chromium.

```
node run.js smoke            # Layer 1 — ~30s, the one to run constantly
node run.js record           # Layer 2 — compare against the committed baselines
node run.js record --update  # Layer 2 — re-record (deliberate act; read the diff)
node run.js failure          # Layer 3 — failure and edge cases
node run.js nodeonly         # the few that need a driver outside the page
node run.js all              # everything above, ~4 minutes
MIRAGE_API_KEY=... node run.js live   # calls a real provider; not part of `all`
```

The runner starts `mirage_server.py` itself and stops it afterwards. If Mirage is
already open it borrows that server and leaves it running, so you don't have to
close the app first.

Exit code is 0 unless something failed that was *not* expected to. A known-red
Layer 3 test does not fail the run.

What a healthy run ends with:

```
TOTAL: 48 passed, 3 known-red  (51 total)
```

### One definition, two runners

Layers 1 and 3 live in `suites/` as plain browser code. **Both** runners execute
them, and both do it by loading `ui/runner.html` — the button opens that page, and
the CLI opens the same page in Playwright and relays the results to the terminal.
`layer-browser.js` contains no assertions at all; it is a relay.

So a test cannot pass in one and fail in the other, and neither can quietly fall
behind. Adding a test means editing one file in `suites/` and nothing else.

---

## Layer 1 — Smoke

Boots, loads a character, runs a turn, saves, reloads, restores, and round-trips a
backup. The spine and nothing clever: if this is red the app is broken, not subtly
wrong.

It also asserts the **prompt split** directly — markers planted in the dossier and
the transcript must not appear in the image prompt. `app.js` has
`verifyPromptArchitecture()`, but that function only `console.log`s and asserts
nothing, so a test calling it would pass no matter what leaked.

## Layer 2 — Behaviour recording

Scripted sessions against mock mode, capturing every metric change, decision and
player-visible notice per turn. Those captures live in `baselines/` and are
committed.

**The rule for this layer is that whatever the app does today is correct.** These
are not claims about what the engine *should* do — that is Layer 3's job. They
exist so that when later phases restructure the contract, the wall, the event log
and the pacing split, anything that quietly changed shows up as a diff. Which is
why Phase 1 ran first: a baseline recorded over known bugs would have cemented them.

When a baseline breaks, the failure names the exact field that moved, e.g.
`changed.socialHold disappeared (was {from: null, to: "ditch"})`, and the full
capture is written next to the baseline as `<scenario>.actual.json`.

If the change was intended, re-record with `--update` and **read the diff before
committing it**. That is the only thing keeping this layer honest.

**This layer is terminal-only, and stays that way.** It reads and writes baseline
files on disk and its whole workflow is the `--update` diff. A browser cannot do
either. The runner window says so rather than pretending the button covers
everything.

### Determinism

The engine leans on randomness deliberately — delivery-style weights, every
`randBetween` in the pacing ladder, shot variance. Without a seed a baseline would
re-record noise every run. `lib/determinism.js` installs a seeded xorshift PRNG and
a monotonic fake clock, and the browser context is pinned to `en-US`/`UTC` so a
recording made on one machine matches one made on another.

All of that is installed **from the test side only**. The engine is not modified and
does not know it is being observed — a test hook inside the engine would be one more
thing that can drift from what actually ships.

## Layer 3 — Failure and edge cases

One targeted test per scenario, across six groups: bad model output, provider and
network, interruption, storage, time, and rules.

**The rule for this layer is the opposite of Layer 2's: assert the *intended*
behaviour, not today's.** Paths the engine still gets wrong are marked
`expectedRed` with the reason and the phase that owns the fix. A known-red test is
a tracked gap, not a broken suite. A known-red test that starts *passing* is
reported loudly — the gap closed and the marker should come off.

Currently red:

| Test | Why | Owner |
|------|-----|-------|
| valid JSON with no `characterResponse` is a failed turn | `parsed.characterResponse \|\| parsed.response \|\| '…'` degrades a wrong payload to a silent ellipsis | Phase 3 |
| the model cannot change mode | `applyTracking` ignores `tracking.mode` as client-owned, then `simulation.js:4374` honours it anyway (N19) | Phase 3 |
| a promise survives ledger overflow | the ledger evicts by recency only, so trivia pushes out an open promise (the callback picker ranks by kind; eviction does not) | Phase 6 |

## Live — the questions only a real provider can answer

Everything above runs on mock mode, which always returns well-formed JSON. That is
exactly why it cannot tell you the thing that actually breaks in production: **the
real model's output stops matching the turn contract.** Prompt drift, a model
version bump, a provider changing its response shape — invisible offline, fatal in
play.

Open the **Live API tests** panel in the runner window, paste a key, set a cap, run.
Or from a terminal:

```
MIRAGE_API_KEY=your-key node run.js live
MIRAGE_API_KEY=... MIRAGE_PROVIDER=kie MIRAGE_BUDGET=40 MIRAGE_LIVE_IMAGES=1 node run.js live
```

Live tests are **never part of `all`** and never run without a key.

### The budget

Default cap **25 credits**, hard maximum **50**, enforced in `ui/budget.js` rather
than by the input's `max` attribute — an attribute is a suggestion, and this is a
limit on real money. Tests are priced against the models you actually have
configured, sorted by priority, and admitted only while the whole cost still fits.
A test that does not fit is skipped whole, never truncated: half a test tells you
nothing and still costs money. Spend is metered on *dispatch* — a failed call still
billed — and a run stops the moment real spend passes the cap.

Where a model quotes a price range, the **upper** bound is used. Starting a test on
the assumption that it gets the cheap end is how a cap gets exceeded.

Rough shape, so the ordering is not mysterious: a thinking turn is ~6k in / 500 out,
which is a fraction of one credit. A single image is 4–27. **The cap barely
constrains the thinking tests and almost entirely governs whether an image runs.**
With the default Google models the full live suite including one image costs about
10 credits.

### Images: what this can and cannot tell you

The image test is deliberately **one image**, and deliberately not a judgement of
what came back. No automated test can tell you whether it looks like her, whether
the outfit is right, or whether the crop works — that is yours to judge, and it is
the part that actually matters for this product.

What it *can* tell you is that every link in a long, intricate chain still holds:
the face reference is attached to the request, the prompt carries the render
doctrine, the provider accepts it, the job poller finishes, the SSRF-guarded proxy
fetches the result, the bytes decode, and the feed renders them. That chain is the
least-tested code in the app and mock mode exercises none of it.

Most of its assertions are on **what we send**, not what comes back — the request is
deterministic and free to inspect, while the image is stochastic and a test that
asserts on it would be flaky. More images buy almost no extra information, which is
why the budget never scales this past one.

## Node-only

Two tests need a driver outside the page and cannot be written as shared suites:
reading back a backup file the browser actually downloaded, and booting from a
genuinely cold browser profile rather than a wiped origin. Deliberately kept to
that — anything expressible as a shared suite belongs in `suites/`.

---

## Layout

```
suites/harness.js     the shared harness: assertions + the sandbox context
suites/smoke.js       Layer 1, plain browser code
suites/failure.js     Layer 3, plain browser code
suites/live.js        Live provider tests, priced and priority-ordered
ui/runner.html        the runner window — and what the CLI drives too
ui/engine.js          sandbox lifecycle + execution + report building
ui/budget.js          credit pricing, the hard cap, and the spend meter
ui/runner.js          the window's buttons and rendering
layer-browser.js      relays a runner-page run to the terminal (no assertions)
layer2-record.js      Layer 2 — terminal-only
layer-nodeonly.js     the two tests that need a driver outside the page
lib/server.js         start/stop mirage_server.py (reuses one already running)
lib/browser.js        launch Chromium, boot past the safety gates, seed, run turns
lib/determinism.js    seeded PRNG + fake clock + recording normalization
lib/recorder.js       in-page instrumentation for Layer 2
lib/report.js         assertions, expectedRed, summaries
baselines/            committed Layer 2 captures
```

Holiday-catalogue network failures are filtered out of error capture in both
runners — those are environmental (no outbound DNS in some environments), not
regressions.

## Bugs these tests found

Worth recording, because it is the argument for the layer split:

- **N18** — `mirage_server.py` set `allow_reuse_address = False`, so restarting the
  server was refused for the whole `TIME_WAIT` window while `bind_server` gave up
  after 5s. Stop-then-start simply failed, for no benefit.
- **N19** — the model can put the app into Story mode by putting `mode: "STORY"` in
  its tracking block, overriding an operator-owned field. Found by a Layer 3 test
  written to assert the invariant rather than to describe behaviour.
- **N20** — `saveActiveChat` is `async`, and seven call sites wrapped it in a
  *synchronous* `try/catch`, which cannot catch a rejection. A full disk meant turns
  silently stopped persisting and the storage-full dialog was unreachable.

And one bug in the tests themselves, worth the same treatment: the original harness
waited on `isTurnInProgress()` — the *hard* busy flag — then slept a flat 80ms.
That flag goes false while the delivery choreography is still typing her reply into
the thread, so under load an assertion could read an empty history and fail a
perfectly good engine. The shared harness waits on `isEngineBusy()` (which covers
choreography, holds and wall waits) and then requires two consecutive quiet samples.
A flaky test is worse than a red one.
