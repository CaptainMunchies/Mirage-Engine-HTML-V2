# Mirage Engine v2

Standalone browser app for hyper-immersive character simulation. Requires a [Google AI Studio API key](https://aistudio.google.com/apikey).

## Run locally

**Do not** open `index.html` directly — browsers block Google API calls from `file://`.

1. Double-click **`START MIRAGE.bat`** in this folder (starts `localhost:8080` + image proxy)
2. Configure **Settings** → API key, models, optional Developer Mode
3. **Begin Setup** or load a saved character from Welcome / Characters

To stop: **`STOP MIRAGE.bat`**

## User flow

| Path | Steps |
|------|--------|
| **New character** | Media → Face Lock → Profile → Protocol → Standby → **Launch Simulation** (fresh chat) |
| **Saved character** | Load → choose **New simulation** or **Continue chat** |
| **During active sim** | Sidebar steps unlock for **review** (sim state preserved). Step **6** or header **Simulation** returns to chat |

### Standby vs saved chats

- **Launch Simulation** — always starts a **new chat** with the protocol selected on step 4
- **Continue saved chat** — restores that chat’s protocol, history, metrics, and recent images

## Simulation features

- Turn engine: thinking model → metrics → optional image → phone mockup + chat
- **Generate image this turn** checkbox — text-only turns when unchecked
- **Cancel** during generation; **Retry face** (Face Recovery) and **Retry Last Image** (exact same last prompt; needs ≥1 sent image)
- Story protocols (B1/B2/B3) auto-generate first story on launch
- Reply to a story → auto **DM** mode + selfie framing
- Multi-chat per character (IndexedDB images, configurable keep count in Settings)
- God-mode commands with **autocomplete** in the chat bar, plus a **control deck** below the input
- Engagement HUD — she can be reluctant, refuse or ignore you; the app surfaces a recovery hint
- **Phone realism** — bezel clock from her profile location, Active now / Last seen, typing dots, Delivered→Opened receipts
- **Memory ledger** — sticky nicknames / promises / tension the model must honour; every 3 turns a callback note forces a natural reference

### Chat bar

The message input always sits directly beneath the chat history; the control deck is below it. Typing `/` opens an autocomplete list of every runtime command, built from `MiragePrompt.RUNTIME_COMMANDS` so it cannot drift from what the router accepts. Enum commands expand into ready-to-send rows (`/persona gf`, `/thermal sweaty`); commands taking free text insert a trailing space for the argument. Arrow keys move, Enter or Tab completes, Escape closes. Once the text is already a complete command the list closes so Enter sends on the first press.

### Control deck

State controls mutate the session and reach the model in the **LIVE STATE** block on the next message. Directives send a turn immediately. Numeric metrics are intentionally not in the deck — they are text commands.

| Control | Type | Effect |
|---------|------|--------|
| Persona pills (9) | State | Sticky persona |
| Thermal pills — Normal / Sweaty / Overheating | State | Pins thermal for the next turn |
| Next scene · Fit check · Fourth wall | Directive | Fires the turn on click |
| Time pass… · Jump to… | Directive | Reveals an argument field, then fires the turn |

Anything queued for the next turn is listed at the bottom of the deck.

Mode is not an operator control. It follows the protocol and the narrative: story protocols open in `STORY`, replying to a story switches to `DM`, and `/story` forces a broadcast turn.

### Operator authority

| Value | Owner |
|-------|-------|
| Persona, mode | **Operator.** Sticky and absolute — `tracking.persona` / `tracking.mode` from the model are ignored. Each turn opens with a full `PERSONA LOCK` (vibe / speech / behavior / forbid from the master prompt). Persona is first priority; loyalty, arousal, compliance and other metrics only layer on top and cannot refuse or mute it |
| Arousal, tease, awareness, thermal | **Model**, evolved narratively and clamped to `METRIC_RANGES` — unless the operator pinned one, in which case the pin wins for that turn and is then cleared so the narrative resumes from it |
| Outfit, environment | **Model**, chosen from the wardrobe catalogue / environment atlas |

## Commands

| Command | Effect |
|---------|--------|
| `/persona [mode]` | Sticky persona: standard, gf, heat, secret, wasted, goon, drama, rage, psycho |
| `/story` | Force Instagram Story mode — wide framing, broadcast tone |
| `/next scene` | Hard time-skip; cuts stale loops |
| `/time pass [duration]` | Time skip of a stated length, summarised in character voice |
| `/jump [scenario]` | Teleport the narrative to a scenario you describe |
| `/fit check` | Outfit showcase turn |
| `/change outfit [look]` | Force a wardrobe change (optional look description) |
| `/fourth wall` | Derealization trigger (+25 awareness) |
| `/arousal [0-100]` | Pin arousal |
| `/tease [0-3]` | Pin tease — 0 Clothed · 1 Strap Down · 2 Risqué · 3 Flash/Slip |
| `/awareness [0-100]` | Pin awareness without the fourth-wall narrative beat |
| `/thermal [normal\|sweaty\|overheating]` | Pin exertion — drives sweat sheen and flush |
| `/skip wait` | Skip the current wall-clock wait and continue |

Arousal, tease and awareness are command-only — they have no deck control. An unrecognised slash command returns an error instead of being forwarded to the model as dialogue.

## Settings

| Option | Purpose |
|--------|---------|
| Developer Mode | Debug panel (live state, last image prompt, decisions) |
| Max real wait | Caps Hybrid/Realtime wall waits (default 10 min; Settings → Developer) |
| Silence before follow-up | Minutes of quiet after her message before ditch / follow-up / Story (Developer) |
| Proactively generate stories | Allow unsolicited Story posts from waits / skips (Developer) |
| Pacing mode | Instant (default) / Hybrid / Realtime |
| Chat resume — images to keep | Latest N turn images per chat in IndexedDB (default 3) |
| Image reference mode | **Face + body** sends a second labelled reference for build and proportions; **Face only** sends the face alone. Degrades to face-only when the image model takes a single reference or no body reference is stored |
| Save / download images | Optional extra copies (Downloads and/or gallery) |

The optional body reference is uploaded on the **Face Lock** step and saved with the character alongside the master face.

## Model configuration

### Thinking models (Gemini 3+)

Most Gemini 3 models use `POST /v1beta/models/{id}:generateContent` (browser-safe). Some routes use `/interactions` — see `js/models.js`.

Legacy 2.5 models use `generateContent` as fallback.

### Image models (Nano Banana)

Uses `POST /v1beta/interactions` via **local proxy** (`mirage_server.py`) for CORS.

| Product | API Model ID |
|---------|----------------|
| Nano Banana Pro ★ | `gemini-3-pro-image` |
| Nano Banana 2 | `gemini-3.1-flash-image` |
| Nano Banana 2 Lite | `gemini-3.1-flash-lite-image` |

Use **Settings → Test Connection** to verify key, thinking, and image (image test may take up to 5 min).

## Architecture

```
v2/js/
├── mirage-prompt.js    # Split prompts + EDF readers + metric→visual mapping
├── models.js           # Model registry + routing
├── state.js            # EngineState + config localStorage
├── api.js              # Google AI layer (generateContent + interactions)
├── errors.js           # User-facing turn error messages
├── ui.js
├── image-store.js      # IndexedDB generated images
├── chat-store.js       # Multi-chat persistence per character
├── pending-turn.js     # Resume in-flight turns after refresh
├── commands.js         # God-mode command router
├── loyalty-ux.js       # Compliance resolution + refusal / stale-loop hints
├── phone-ux.js         # Bezel clock, last-seen, typing, read/unread receipts
├── memory-ledger.js    # Sticky continuity facts + callback injector
├── immersion.js        # Real-time delays, social texture, proactive turns
├── control-deck.js     # Persona / thermal / directive UI below the chat input
├── command-autocomplete.js # "/" command autocomplete in the chat bar
├── debug-panel.js      # Developer debug panel
├── profile-store.js    # Character library
├── setup-*.js          # Wizard steps 1–5
├── simulation.js       # Active sim turn engine
├── chats-ui.js / characters-ui.js
└── app.js              # Bootstrap + stepper navigation
```

### Prompt split

The thinking model is the author; the image model is the camera. They get **disjoint** system prompts and share only the identity ledger.

| Prompt | Model | Carries |
|--------|-------|---------|
| `NARRATIVE_CORE` | Thinking | Behaviour, metric semantics, operator authority, command hierarchy, JSON contract — plus dossier, identity ledger, wardrobe catalogue, linguistic DNA and LIVE STATE |
| `RENDER_DOCTRINE` | Image | Face lock, fresh canvas, variance, no-text mandate, coverage discipline, realism — plus the identity ledger and visual state |

The renderer deliberately never receives the narrative core, the dossier, persona prose, chat history or metric semantics: sending explicit narrative material to the image model raised safety-filter refusals and wasted tokens. Metrics still reach it, translated into photographic direction — tease → wardrobe state, thermal → skin sheen, arousal → expression and crop.

Reference images are role-labelled in the prompt (**FACE** authoritative for identity, **BODY** proportions only) because unlabelled extra references make the model average features and worsen drift. The last three shot types are sent as an avoid-list so Forced Variance is enforced rather than advisory.

## Development status

| Segment | Status |
|---------|--------|
| 0 — Foundation, API, models | ✅ |
| 1 — Media upload | ✅ |
| 2 — Face lock | ✅ |
| 3 — Profile + character library | ✅ |
| 4 — Protocols + standby | ✅ |
| 5 — (merged into 4) | ✅ |
| 6 — Active simulation | ✅ |
| 7 — Commands, director logic, loyalty/refusal UX | ✅ |
| 8 — Debug panel | ✅ |
| 9 — Persistence & resume | ✅ |
| 10 — Polish (cancel, retry, stepper, text-only) | ✅ partial |
| 11 — Ship (README, errors, onboarding) | ✅ partial |
| 12 — Prompt split, control deck, operator authority | ✅ |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| API calls fail on open | Use `START MIRAGE.bat`, not file:// |
| Invalid JSON in chat | Retry turn; enable Developer Mode → Debug panel |
| Image timeout | Cancel, **Retry face**, or **Retry Last Image**; try a faster image model |
| API key rejected | Settings → verify key → Test Connection |
| Rate limit | Wait, then retry |

## Cache busting

After updates, hard refresh (`Ctrl+F5`) or bump `?v=` in `index.html` script tags.
test sync