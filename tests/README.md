# Mirage Engine — tests

Three layers, briefed and built as three. A single "extensive test suite" produces
one sprawling brittle file; these have different rules and are meant to stay separate.

Everything runs with **no API key and no credits** — mock mode supplies the thinking
and image halves, and the real `mirage_server.py` serves the app so the proxy,
IndexedDB and module load order are all exercised for real.

## First-time setup

The app needs only Python. **The tests also need Node.js** — that is the one new
prerequisite. Install it from <https://nodejs.org> (any current LTS) if you don't
have it, then:

```
cd tests
npm install                    # Playwright
npx playwright install chromium   # the browser it drives (~150 MB, once)
```

On Windows use the same commands in Command Prompt or PowerShell from the repo
folder. Python is found automatically (`py -3`, `python`, `python3` — whichever
answers first), and so is Chromium.

## Running

```
node run.js smoke            # Layer 1 — ~30s, the one to run constantly
node run.js record           # Layer 2 — compare against the committed baselines
node run.js record --update  # Layer 2 — re-record (deliberate act; read the diff)
node run.js failure          # Layer 3 — failure and edge cases
node run.js all              # everything, ~4 minutes
```

The runner starts `mirage_server.py` itself and stops it afterwards. If Mirage is
already open it borrows that server and leaves it running, so you don't have to
close the app first.

Exit code is 0 unless something failed that was *not* expected to. A known-red
Layer 3 test does not fail the run.

What a healthy run ends with:

```
TOTAL: 44 passed, 3 known-red  (47 total)
```

---

## Layer 1 — Smoke

Boots, loads a character, runs a turn, saves, reloads, restores. The spine and
nothing clever: if this is red the app is broken, not subtly wrong.

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

---

## Layout

```
lib/server.js         start/stop mirage_server.py (reuses one already running)
lib/browser.js        launch Chromium, boot past the safety gates, seed a character,
                      run turns, stub the model's replies
lib/determinism.js    seeded PRNG + fake clock + recording normalization
lib/recorder.js       in-page instrumentation for Layer 2
lib/report.js         assertions, expectedRed, summaries
baselines/            committed Layer 2 captures
```

`lib/browser.js` filters the holiday-catalogue network failures out of error
capture — those are environmental (no outbound DNS in some environments), not
regressions.

## Three bugs these tests found

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
