# Working rules for this repo

Read this before reporting any change as done.

---

## 1. Announce loudly when an update needs more than a pull

The operator runs `UPDATE MIRAGE.bat` and hard-reloads the browser. That is enough
for **most** changes. Two kinds of file are not, and silently shipping them has
already cost real debugging time — a stale server made the backup buttons look
broken for a whole session.

**Before writing the final response, run this:**

```bash
git diff --name-only <last-reported-commit>..HEAD
```

If the list contains either file below, the response **must** open with the
instruction, in bold, not bury it at the end.

### `mirage_server.py` → the server must be restarted

Python reads it once at startup. A running server keeps executing the old code
forever. Say:

> **Restart the server** — close the Mirage server window (or `STOP MIRAGE.bat`),
> then `START MIRAGE.bat`. This update changes `mirage_server.py`, and the running
> server is still the old one until you do.

`UPDATE MIRAGE.bat` prints its own banner for this too, but say it in chat as well.
The operator should not have to notice a banner.

### `UPDATE MIRAGE.bat` → the new behaviour lags one run

The updater stages itself into `%TEMP%` and runs from there, so it *does* update
itself in a single pull — no second pull is needed to get the files. But the copy
doing the work is the old one, so **any improvement to the updater only takes
effect from the next run**. Say that plainly rather than implying a double-pull.

### When neither changed

Say so. "No server restart needed this time" is useful information, not filler —
it tells the operator they can skip a step they were braced for.

---

## 2. Never touch `main`

All work goes to **`claude/mirage-v3`**. `main` is not to be committed to, pushed
to, or merged into — **only** when the operator personally says so, in their own
words. A passing test suite is not permission.

---

## 3. Cache-busting is handled by the server, not by `?v=`

`mirage_server.py` sends `Cache-Control: no-cache` on non-API responses, so edited
JS/CSS is picked up on a normal reload. The `?v=NNN` query on every script tag in
`index.html` is legacy and no longer needs bumping per change — it sat unchanged
from the initial import while dozens of files were edited underneath it, which is
exactly the bug the header now prevents. Do not reintroduce a hand-maintained
version constant.

---

## 4. Tests

```
node tests/run.js all      # offline: 48 passed, 3 known-red, 51 total
node tests/run.js smoke    # ~30s, run constantly
```

Or in the app: **Settings → Developer → Developer Mode → Open test runner…**

- Layers 1 and 3 are defined once in `tests/suites/` and executed by both the
  runner window and the CLI. Add a test there, nowhere else.
- Layer 2 (baselines) is terminal-only. Read the diff before `--update`.
- Live tests spend real credits, are never part of `all`, and never run without a
  key. Cap defaults to 25, hard maximum 50.
- Three Layer 3 tests are `expectedRed` on purpose; each names the phase that
  closes it. A known-red test that starts passing is reported loudly.

**A flaky test is worse than a red one.** If a test fails intermittently, root-cause
it — do not re-run until it goes green.

---

## 5. Reporting

State what was verified and what was not. This project runs on Windows; this
environment is Linux, so Windows batch behaviour and the Windows Chromium path
cannot be executed here. Say so rather than implying they were checked.
