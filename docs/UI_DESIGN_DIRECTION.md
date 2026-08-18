# Mirage Engine — UI Design Direction

*The design brief for the v3 interface overhaul. Decisions, structure, and what an agent needs to
build from.*

Companion to `docs/V3_ROADMAP.md` (Phase 4 builds the wall and gallery; Phase 5 is this work).
This document is the design input to both — it defines what the gallery must render and what the
overhaul is aiming at.

---

## 1. The premise

**The phone on screen is the user's phone.** Not hers. You are holding your own device and texting
her through it.

This is the single most important framing in the document, and getting it backwards changes every
subsequent decision. It means:

- The phone frame, status bar, and home indicator are **your device**.
- The thread header — avatar, name, "online" / "last seen" — is **her**, the person you're talking to.
- Her photos **arrive in your thread**, as messages.
- Her Stories are something **you view**, not a parallel feed you own.
- The conversation is a DM thread you are *inside*, not a window onto her life.

The existing implementation already agrees with this (`phoneHeaderName` holds her name,
`phonePresence` holds her status). The redesign makes it explicit and consistent.

### One consequence worth deciding

The bezel status-bar clock currently renders **her** timezone
(`resolveTimeZone(profile.location)` → `phone-ux.js:236-250`) on what is conceptually **your**
device. If the phone is yours, your status bar shows your time, and *her* local time becomes
conversational context instead — "last seen 3h ago", "it's 6am there", "she's probably asleep".

That gap between the two clocks is content the current design discards by collapsing them into one.
Recommendation: **status bar shows the operator's local time; her local time is surfaced in the
thread header and in the metrics.** This pairs naturally with the Phase 1 timezone fix, which is
what finally makes her clock trustworthy.

---

## 2. Decisions taken

| Question | Decision |
|----------|----------|
| Default posture | **Switchable** — Immersion and Director modes |
| Wide screens | **Form + live preview** — the extra space does real work |
| Hebrew / RTL | **Messages only** — bubbles handle RTL; chrome stays English/LTR |
| Debug placement | **Inline**, below the deck, restructured rather than relocated |

---

## 3. The core structural change: one thread

Today the conversation exists **twice**. The phone has its own scrolling feed of images and
captions; the chat log beside it has its own scrolling feed of text, commands and system notices.
They scroll independently and neither is complete alone.

**Unify them.** One thread, inside the phone, containing:

- her messages
- her photos, inline, where they actually happened
- your messages
- Story posts, as viewable cards in the thread

Everything else — slash commands you typed, system notices, decisions, errors — is **operator
annotation**, and belongs to the operator layer, not the fiction. In Director mode it appears
alongside the thread. In Immersion mode it's collapsed away.

This one change makes almost everything else affordable. It frees the entire second column, removes
the need to scan two histories to understand one conversation, and lets the phone grow to a size
where the photo — the thing the whole engine exists to produce — is actually the largest element
on screen.

### Errors leave the thread

The safety-filter block currently renders **inside the conversation** as a large red panel with a
wall of remediation text. That is an operator concern injected into the fiction, and it's the single
most immersion-breaking thing in the current UI.

Errors move to the operator layer: a compact, dismissible banner outside the phone, with the detail
available on expand. In the thread itself, a failed turn shows as nothing more than a subtle
"couldn't send" affordance.

---

## 4. Two modes

The toggle changes **the chrome around the thread, not the thread itself**. Same components, same
data, different surroundings. This is deliberate — it's what stops "switchable" from becoming two
half-designed interfaces.

### Immersion mode

The phone is large and centred. You are looking at your device.

- Full-height phone, sized to the viewport rather than capped at 320px
- The unified thread fills it
- Composer at the bottom of the phone, where a messaging app puts it
- No metric strip, no control deck, no debug
- A single slim status line outside the phone — her presence, and whether a wait is running
- **Commands still work**: typing `/` in the composer opens the same autocomplete
- Operator notices appear as quiet toasts outside the phone frame, never in the thread

### Director mode

The phone stays large — it does not shrink back to a thumbnail — and gains instrumentation around it.

- **Phone**: centre, still the dominant element
- **Left rail**: live state — metrics with change indicators (§6)
- **Right rail**: control deck (persona, thermal, directives) and the command reference
- **Below**: the operator log — commands, system notices, decisions — and the debug panel
- Everything collapsible; the rails remember their state

### What this fixes

The command reference is currently stranded on the Standby screen: three genuinely good columns of
commands, personas and metric meanings, shown *before* you play and unavailable *while* you play.
In Director mode it lives in the right rail, where it's needed.

---

## 5. The layout system

The stylesheet currently has **twelve media queries and every one is `max-width`**. There is no
`min-width` rule anywhere. The layout knows how to shrink and has no instruction for what to do with
extra room — so on any large display it simply leaves it empty, at any zoom level.

Panels are hard-capped at `max-width: 640px` (`.panel`) and `720px` (`.panel-wide`), and the phone at
`max-width: 320px` inside a `minmax(280px, 340px)` column. On a 1920px screen that leaves roughly
59% of the content area unused; the wider the monitor, the wider the gap, because the console beside
the phone takes `1fr` and the phone never grows.

**This needs growth behaviour it has never had.** Proposed tiers:

| Tier | Width | Setup screens | Simulation |
|------|-------|---------------|------------|
| Compact | < 900px | Single column, full width | Phone full width, rails become sheets |
| Standard | 900–1300px | Single column, wider measure | Phone + one rail |
| Wide | 1300–1800px | **Two columns — form + preview** | Phone + both rails |
| Full | > 1800px | Two columns, larger preview | Phone larger, rails comfortable |

Cap the *outer* container around 1900–2000px so it doesn't sprawl on ultrawide, but let the phone and
the preview panes grow within it. The rule to hold onto: **extra space goes to the photo and the
preview, not to margins.**

---

## 6. Live state — the metrics

Ten values currently sit in one line at identical visual weight: persona, mode, arousal, tease,
awareness, thermal, mood, outfit, environment, engagement. It reads as a status bar. It is in fact
the highest-value information in the app, and it's carrying three different kinds of thing at once.

Restructure by **who owns each value** — which is a distinction the engine already makes:

- **Operator-owned and absolute** — persona, mode. These are locks. Show them as such.
- **Model-evolved, clamped** — arousal, tease, awareness, thermal, mood, engagement. These drift.
- **Scene** — outfit, environment. These are labels with real prose behind them.

Then add the thing that's missing entirely: **what changed this turn, and why.** The engine already
computes it — every clamp, lock, rotation and rejection is emitted to the decision log with a reason.
Surfacing a delta beside each value ("engagement 85 → 88", "outfit lock kept", "thermal nudged") turns
a status bar into an explanation.

**Pinned values must read as pinned.** When you pin a metric it currently looks identical to one the
model chose, and it silently expires after a turn. Pins need a visible chip with a one-click release.

---

## 7. Setup screens — form + live preview

Two columns above 1300px: controls left, a live preview right that shows the consequence of what
you're editing.

| Screen | Left | Right (preview) |
|--------|------|-----------------|
| **Media Upload** | Constraints, dropzone, counters | The ingest grid, large — currently cramped into a narrow column |
| **Face Lock** | The photo grid, **once** | The locked face large, plus the body reference beside it |
| **Profile** | The form | Her character card as she'll appear — avatar from the locked face, name, archetype, relationship, and her local time |
| **Protocol** | The four cards | What the opening beat will be, given the current protocol and her clock |
| **Standby** | Already three columns — keep | — |

**Face Lock is the biggest win here.** It currently renders all nineteen photos **twice** on one
page — once to pick a face, once to pick a body — which is why that screen scrolls forever. One grid
with a face/body target toggle, and both locked references shown large in the preview pane, roughly
halves the page.

---

## 8. Hebrew / RTL — messages only

Scope: her message bubbles render correctly right-to-left. All UI chrome, labels and controls stay
English and LTR.

What that requires:

- `dir="auto"` on bubble text so each message picks its own direction
- Bubble alignment, timestamps and read receipts positioned per direction
- Mixed Hebrew/English strings handled without punctuation jumping to the wrong end
- Emoji and Latin fragments inside Hebrew text staying put

Not in scope: mirroring the layout, translating labels, RTL for the control deck or debug.

---

## 9. Debug — inline, restructured

Stays where it is, below the deck. The problem isn't location, it's structure.

**What's already good and should be promoted:** the DEV log turn cards are the best information
design in the app — turn number, timestamp, event count, the message, tag chips, then event rows
with sim time, type, and credit cost. That pattern is worth reusing elsewhere, including in the
operator log.

**What needs fixing:**

- The raw dumps — immersion snapshot, last turn, session JSON, EDF, last image prompt — sit in ~130px
  scroll boxes that are painful to read. Give them real height, or an expand-to-full control.
- Five raw JSON panels stacked vertically is a lot of page. Group them behind one "Raw" section.
- The structured panels (session strip, presence, clocks, delivery pipeline) are genuinely useful and
  should stay expanded by default; the raw dumps should be collapsed by default.
- Section navigation within debug, so it's reachable without scrolling past everything.

---

## 10. What the gallery must cover

This design work defines the Phase 4 gallery. Every state below needs a fake-data rendering, because
several are hard or expensive to reach by playing:

**Thread states** — empty chat · first turn · text-only reply · reply with photo · Story post ·
double text · reaction · left on read · went quiet · typing then deleted · a wait running · failed
image · blocked by safety filter · her message in Hebrew, in English, and mixed

**Operator states** — pinned metric active · pin expired · outfit lock held · shot rotated ·
awakening stages 1–4 · credit guard fired · clock resume offered · proxy down · storage full ·
no face locked

**Setup states** — every step, empty and populated · face locked / not locked · body reference
present / absent · 0, 1, 19 and 20 photos · character saved / draft / editing

**Both modes** — every one of the above in Immersion and Director.

---

## 11. What is preserved

Not everything needs changing, and these are good:

- **The stepper** — clear, numbered, and collapsing to numbers on the simulation screen is a nice touch
- **The Protocol cards** — clean, well-differentiated, correct use of selection state
- **The phone chrome** — bezel, status bar, signal and battery, presence line all read convincingly
- **The debug turn cards** — promoted, not replaced
- **The Standby reference content** — relocated into Director mode, not rewritten
- **The control deck's grouping** — persona / thermal / directives is the right taxonomy

---

## 12. Sequencing note

This is Phase 5 in the roadmap and it depends on Phase 4. The order matters more than usual here
because an agent is doing the work:

1. **The wall** must exist first, or an agent restyling a bubble is editing the same file that decides
   whether she leaves you on read.
2. **The gallery** must exist first, or the agent has no way to see the states it's designing and no
   way for you to review them.
3. **The behaviour recording** must be green before and after, which is what makes a sweeping visual
   change safe to accept.

Designing now is correct and useful — it defines what the gallery needs. Building now is not.
