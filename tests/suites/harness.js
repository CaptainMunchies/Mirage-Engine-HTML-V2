/**
 * MIRAGE TESTS — shared suite harness
 *
 * Tests are written once, here, as plain browser code. Two runners execute them:
 * the in-app UI (tests/ui/runner.html) and the Node CLI (tests/run.js). One suite
 * definition, so the terminal and the button can never drift apart.
 *
 * Every test receives:
 *   ctx — the sandboxed app: its window, plus reset / seed / runTurn / stub helpers
 *   t   — assertions; a test fails by recording, not by throwing
 *
 * The sandbox is a full copy of the app in an iframe, served from the *other* host
 * alias (127.0.0.1 when you are on localhost, and vice versa). The runner page is
 * served from that same alias, so it can reach into the iframe freely — while your
 * real characters, chats and photos, which live on the alias you actually browse
 * with, are a different storage origin and cannot be touched. That isolation was
 * verified empirically, not assumed: a key written at localhost:8080 reads back as
 * null at 127.0.0.1:8080.
 */
(function (global) {
    'use strict';

    const suites = [];

    /**
     * @param {string} id
     * @param {string} title
     * @param {{name: string, group?: string, expectedRed?: string,
     *          nodeOnly?: boolean, live?: boolean, needsImages?: boolean,
     *          priority?: 1|2|3, turns?: number, images?: number,
     *          run: (ctx, t) => Promise<void>}[]} tests
     *
     * `live` marks a test that spends real API credits. Those carry a `priority`
     * (1 = run first) and a rough shape of what they cost — `turns` thinking calls
     * and `images` image calls — which the runner prices against the models you
     * actually have configured, then admits in priority order until the budget is
     * gone. `needsImages` additionally requires the image checkbox.
     */
    function suite(id, title, tests) {
        suites.push({ id, title, tests });
    }

    function allSuites() {
        return suites;
    }

    // ------------------------------------------------------------------ assertions

    function makeAssertions(failures) {
        const clip = (v, n = 200) => {
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            return s == null ? String(v) : (s.length > n ? `${s.slice(0, n)}…` : s);
        };
        const fail = (msg) => failures.push(String(msg));
        return {
            fail,
            ok: (cond, msg) => { if (!cond) fail(msg || 'expected truthy'); },
            notOk: (cond, msg) => { if (cond) fail(msg || 'expected falsy'); },
            equal: (a, b, msg) => {
                if (a !== b) fail(`${msg || 'not equal'} — expected ${clip(b)}, got ${clip(a)}`);
            },
            deepEqual: (a, b, msg) => {
                if (JSON.stringify(a) !== JSON.stringify(b)) {
                    fail(`${msg || 'not deep-equal'} — expected ${clip(b)}, got ${clip(a)}`);
                }
            },
            match: (actual, re, msg) => {
                if (!re.test(String(actual ?? ''))) {
                    fail(`${msg || 'no match'} — ${re} did not match ${clip(String(actual ?? ''))}`);
                }
            },
            noMatch: (actual, re, msg) => {
                if (re.test(String(actual ?? ''))) {
                    fail(`${msg || 'unexpected match'} — ${re} matched ${clip(String(actual ?? ''))}`);
                }
            },
            between: (actual, min, max, msg) => {
                const n = Number(actual);
                if (!(n >= min && n <= max)) fail(`${msg || 'out of range'} — ${n} not in [${min}, ${max}]`);
            }
        };
    }

    // ------------------------------------------------------------------ context

    const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    /**
     * Build the per-test context around a live sandbox window.
     *
     * `reload` is supplied by the runner: it must wipe nothing, re-seed the safety
     * gates and config, boot the app again and resolve with the new window. Both
     * runners drive the same iframe, so there is one implementation, but keeping it
     * injected means a runner can change *how* it boots without touching the tests.
     *
     * `errors` reports what the sandbox logged since the last reset — uncaught
     * exceptions, unhandled rejections and console.error, minus environmental noise.
     */
    function makeContext({ win, reload, errors = () => [], config = () => ({}) }) {
        const ctx = {
            get win() { return win; },
            get doc() { return win.document; },

            /** Swap in a new sandbox window after a reload. */
            _rebind(nextWin) { win = nextWin; },

            /** Whatever the sandbox has logged as an error since the last reset. */
            errors,

            /** Reboot the sandbox with these config keys merged over the defaults. */
            async withConfig(over) {
                const next = await reload({ config: over, wipe: true });
                ctx._rebind(next);
                win = next;
                return win;
            },

            file(name = 'face.png', type = 'image/png') {
                const bin = win.atob(TINY_PNG);
                const bytes = new win.Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return new win.File([bytes], name, { type });
            },

            /** Wipe the sandbox back to a fresh install and boot it again. */
            async reset() {
                const next = await reload({ wipe: true });
                ctx._rebind(next);
                win = next;
                return win;
            },

            /** Boot the app again without wiping — the reload-and-restore path. */
            async reload() {
                const next = await reload({ wipe: false });
                ctx._rebind(next);
                win = next;
                return win;
            },

            /** The config the sandbox boots with, for tests that need to read it. */
            config,

            /** A playable character and a live chat, without the five-step wizard. */
            async seedCharacter(over = {}) {
                const W = win;
                const S = W.EngineState;
                S.profile = {
                    name: 'Nadia', age: '24', archetype: 'Photographer',
                    relationship: 'Girlfriend', location: 'Dallas, TX',
                    timezone: 'America/Chicago', personality: 'Direct, warm',
                    loyalty: 'Medium (Balanced)', ...over
                };
                S.edf = { VISUAL_ANCHORS: { MASTER_FACE_REF: 'face.png' } };
                S.setMasterFace(ctx.file('face.png'));

                const id = W.MirageProfileStore.makeId();
                S.activeCharacterId = id;
                S.activeCharacterLabel = S.profile.name;
                await W.MirageProfileStore.saveWithAnchors({
                    id, label: S.profile.name,
                    snapshot: W.MirageProfileStore.exportSnapshot(S), state: S
                });
                W.MirageChatStore.createChat(S, { resetMetrics: true });
                S.session.phase = 'active';
                W.MirageSimulation.onEnter?.();
                W.MirageMockAPI.resetDeliveryCycle?.();
                ctx.watchToasts();
                return id;
            },

            /**
             * Run one turn and wait for it to actually settle.
             *
             * `isTurnInProgress` is the *hard* busy flag — thinking, image, finalize.
             * It goes false while the delivery choreography is still typing her reply
             * into the thread, so waiting on it and then sleeping a fixed 80ms is a
             * race: under load the assertion reads an empty history and the test
             * fails for no reason. `isEngineBusy` is the flag that also covers
             * choreography, pending holds and wall waits, so that is what to wait on,
             * followed by a short quiet period for the final commit and save.
             */
            async runTurn(text) {
                await win.MirageSimulation.executeTurn(text);

                const deadline = Date.now() + 30000;
                const busy = () => (win.MirageSimulation.isEngineBusy?.()
                    ?? win.MirageSimulation.isTurnInProgress?.());
                while (busy() && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 40));
                }

                // Two consecutive quiet samples: the thread and the history both have
                // to stop moving before a test is allowed to look at them.
                let stable = 0, last = '';
                while (stable < 2 && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 60));
                    const s = win.EngineState.session || {};
                    const now = `${win.document.querySelectorAll('#chatLog > *').length}/`
                        + `${s.history?.length ?? 0}/${busy() ? 1 : 0}`;
                    stable = (now === last && !busy()) ? stable + 1 : 0;
                    last = now;
                }
            },

            /** Record the toasts the operator is shown, alongside the chat log. */
            watchToasts() {
                const W = win;
                if (W.__toastsWatched) return;
                W.__toastsWatched = true;
                W.__toasts = [];
                const real = W.MirageUI.toast;
                W.MirageUI.toast = function (msg, type, opts) {
                    const o = opts && typeof opts === 'object' ? opts : null;
                    const player = type === 'error' || type === 'ok'
                        || !!o?.essential || o?.lane === 'player';
                    W.__toasts.push({
                        lane: o?.lane === 'dev' ? 'dev' : (player ? 'player' : 'inferred'),
                        text: String(msg)
                    });
                    return real.apply(this, arguments);
                };
            },

            /**
             * What the operator can actually see. `text` spans the chat log *and* the
             * player-lane toasts: a rejected command reports through a toast and puts
             * nothing in the thread, so reading only the thread makes correct
             * behaviour look like silence.
             */
            visible() {
                const W = win;
                const nodes = [...W.document.querySelectorAll('#chatLog > *')];
                const s = W.EngineState.session || {};
                const toasts = W.__toasts || [];
                return {
                    entries: nodes.length,
                    toasts,
                    text: [
                        ...nodes.map(n => (n.textContent || '').replace(/\s+/g, ' ').trim()),
                        ...toasts.filter(x => x.lane !== 'dev').map(x => x.text)
                    ].join('\n'),
                    lastAi: s.history?.[s.history.length - 1]?.ai ?? null,
                    historyLength: s.history?.length ?? 0,
                    arousal: s.arousal, tease: s.tease, awareness: s.awareness,
                    engagement: s.engagement, persona: s.persona, mode: s.mode,
                    thermal: s.thermal, outfit: s.outfit, env: s.env,
                    awakeningActive: !!s.awakeningActive, awakeningStage: s.awakeningStage,
                    ledger: (s.memoryLedger || []).map(i => ({
                        kind: i.kind, text: i.text, resolved: !!i.resolved
                    }))
                };
            },

            /** A well-formed turn payload with fields overridden for one test. */
            turnPayload(over = {}) {
                const { tracking, delivery, ...rest } = over;
                return JSON.stringify({
                    tracking: {
                        persona: 'Standard', mode: 'DM', outfit: 'casual day look',
                        env: 'her place', arousal: 30, tease: 0, awareness: 20,
                        thermal: 'Normal', mood: 'Warm', moodIntensity: 1,
                        engagement: 60, ...(tracking || {})
                    },
                    characterResponse: 'hey you',
                    delivery: { style: 'normal', ...(delivery || {}) },
                    ...rest
                });
            },

            /**
             * Make the thinking model return exactly this. Injecting at the mock
             * rather than at fetch means the reply travels the same parse →
             * classify → applyTracking path a real one would.
             */
            stubThinking(raw, opts = {}) {
                const M = win.MirageMockAPI;
                if (!M.__realThinking) M.__realThinking = M.mockThinkingGenerate;
                if (raw === null && !opts.throws) {
                    M.mockThinkingGenerate = M.__realThinking;
                    return;
                }
                let left = opts.times == null ? Infinity : opts.times;
                M.mockThinkingGenerate = async function (args) {
                    if (left <= 0) return M.__realThinking.call(this, args);
                    left -= 1;
                    if (opts.throws) {
                        const err = new Error(opts.throws.message);
                        if (opts.throws.code) err.code = opts.throws.code;
                        if (opts.throws.name) err.name = opts.throws.name;
                        throw err;
                    }
                    return raw;
                };
            },

            /** Same idea for the image half. */
            stubImage({ throws = null, dataUrl = null } = {}) {
                const M = win.MirageMockAPI;
                if (!M.__realImage) M.__realImage = M.mockImageGenerate;
                if (!throws && !dataUrl) {
                    M.mockImageGenerate = M.__realImage;
                    return;
                }
                M.mockImageGenerate = async function () {
                    if (throws) {
                        const err = new Error(throws.message);
                        if (throws.code) err.code = throws.code;
                        if (throws.name) err.name = throws.name;
                        throw err;
                    }
                    return dataUrl;
                };
            },

            sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
        };
        return ctx;
    }

    global.MirageTests = { suite, allSuites, makeAssertions, makeContext, TINY_PNG };
})(typeof window !== 'undefined' ? window : globalThis);
