# Working rules for this repo

Read this before reporting any change as done.

---

## 1. End every update response with the deploy banner

The operator runs `UPDATE MIRAGE.bat` and hard-reloads the browser. That is enough
for **most** changes. Two kinds of file are not, and silently shipping them has
already cost real debugging time — a stale server made the backup buttons look
broken for a whole session.

**Before writing the final response, run this:**

```bash
git diff --name-only <last-reported-commit>..HEAD
```

Then close the response with one of the banners below. Rules, without exception:

- It is the **last thing in the message.** Nothing after it — no sign-off, no
  "let me know if…", no further notes. The operator reads bottom-up for this.
- Always present, even when the answer is "nothing to do". Absence is
  indistinguishable from having forgotten.
- Copy the format verbatim: horizontal rule, `##` heading, emoji, bold. It has to
  survive being skimmed at the end of a long reply.
- If both a server change and an updater change apply, print **both** blocks,
  server first.

### A. `mirage_server.py` changed → restart

Python reads that file once at startup, so a running server keeps executing the old
code forever.

```markdown
---

## 🔴🔴 RESTART THE SERVER — THIS UPDATE CHANGES `mirage_server.py`

**Close the Mirage server window** (or run `STOP MIRAGE.bat`), then
**`START MIRAGE.bat`**.

Until you do, the running server is still the old one and this fix is not live.
```

### B. `UPDATE MIRAGE.bat` changed → note the one-run lag

The updater stages itself into `%TEMP%` and runs from there, so it *does* update
itself in a single pull. No second pull is needed to get the files — but the copy
doing the work is the old one.

```markdown
---

## 🟡🟡 THE UPDATER ITSELF CHANGED

The new files **are already in place — no second pull needed.** But the improved
script only takes effect **from the next time you run it.**
```

### C. Neither changed → say so, just as loudly

"No restart needed" is useful information, not filler: it tells the operator they
can skip a step they were braced for.

```markdown
---

## 🟢🟢 NO RESTART NEEDED

`UPDATE MIRAGE.bat` → **Ctrl+Shift+R** in the browser. That is all.

Nothing in this update touches `mirage_server.py` or `UPDATE MIRAGE.bat`.
```

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
