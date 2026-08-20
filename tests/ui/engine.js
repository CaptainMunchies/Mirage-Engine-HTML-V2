/**
 * The runner engine — sandbox lifecycle + execution.
 *
 * This is the part the UI and the Node CLI share. The UI wraps it in buttons; Node
 * opens this same page in Playwright and calls the same functions. Neither knows
 * anything about individual tests.
 *
 * ## Why an iframe on the other host alias
 *
 * The app under test needs to be wiped repeatedly — cleared localStorage, deleted
 * IndexedDB databases, fresh characters. Doing that to the app you actually use
 * would destroy your library.
 *
 * `localhost:8080` and `127.0.0.1:8080` are the same server but *different storage
 * origins*. Verified, not assumed: a key written at one reads back as `null` at the
 * other. So the runner page is served from whichever alias you are **not** browsing
 * with, and the sandbox iframe is same-origin with the runner. The parent can reach
 * into the iframe freely; your real data is on the other side of an origin boundary
 * the browser enforces.
 */
(function (global) {
    'use strict';

    const SANDBOX_URL = '/index.html';
    const IDB_NAMES = ['mirage_v2_images', 'mirage_v2_anchors', 'mirage_v2_media_library'];
    const LS_PREFIX = 'mirage_v2_';

    // The holiday catalogue reaches the public internet. Those failures are
    // environmental, not regressions.
    const ENV_NOISE = /date\.nager\.at|hebcal\.com|ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Failed to load resource/;

    const SAFETY_SEED = {
        ageGate: { verified: true, dob: '1990-01-01' },
        fictionConsent: { accepted: true, version: 1 }
    };

    const BASE_CONFIG = {
        // Mock thinking needs Developer Mode; Instant pacing keeps turns from
        // wall-waiting for minutes. Tests that need other pacing override it.
        developerMode: true,
        mockThinking: true,
        mockImages: true,
        pacingMode: 'instant'
    };

    // ------------------------------------------------------------------ state

    let frame = null;
    let sandboxErrors = [];
    let currentConfig = { ...BASE_CONFIG };
    let cancelled = false;

    const state = {
        running: false,
        startedAt: null,
        finishedAt: null,
        results: [],       // one entry per finished test
        current: null,     // {suite, name} while a test is in flight
        planned: 0
    };

    const listeners = new Set();
    function emit() { listeners.forEach(fn => { try { fn(snapshot()); } catch (_) { /* a broken listener is not a test failure */ } }); }
    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

    // ---------------------------------------------------------------- sandbox

    /**
     * Remove only Mirage's own keys. The runner page shares this origin's
     * localStorage with the sandbox, so a blanket clear() would be indiscriminate —
     * and this documents exactly what a wipe destroys.
     */
    function clearMirageLocalStorage() {
        const doomed = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(LS_PREFIX)) doomed.push(k);
        }
        doomed.forEach(k => localStorage.removeItem(k));
        return doomed.length;
    }

    function deleteDatabase(name) {
        return new Promise(resolve => {
            let done = false;
            const finish = (how) => { if (!done) { done = true; resolve(how); } };
            let req;
            try { req = indexedDB.deleteDatabase(name); }
            catch (_) { return finish('threw'); }
            req.onsuccess = () => finish('deleted');
            req.onerror = () => finish('error');
            // A blocked delete means a connection is still open somewhere. The
            // iframe is torn down before this runs, so it should not happen — but
            // hanging forever on it would be worse than carrying on.
            req.onblocked = () => finish('blocked');
            setTimeout(() => finish('timeout'), 5000);
        });
    }

    async function wipeSandboxStorage() {
        destroyFrame();
        clearMirageLocalStorage();
        for (const n of IDB_NAMES) await deleteDatabase(n);
    }

    function destroyFrame() {
        if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
        frame = null;
    }

    function watchErrors(win) {
        const note = (s) => { if (!ENV_NOISE.test(s)) sandboxErrors.push(s); };
        win.addEventListener('error', e => note(`error: ${e.message}`));
        win.addEventListener('unhandledrejection', e => {
            note(`unhandledrejection: ${e.reason?.message || e.reason}`);
        });
        const realError = win.console.error;
        win.console.error = function (...args) {
            note(`console: ${args.map(a => (a && a.message) || String(a)).join(' ')}`);
            return realError.apply(this, args);
        };
    }

    /**
     * Boot the sandbox. `wipe` decides whether this is a fresh install or the
     * reload-and-restore path; `config` is merged over the defaults for this boot
     * and every boot after it, until the next call changes it.
     */
    async function bootSandbox({ wipe = false, config = null } = {}) {
        if (config) currentConfig = { ...BASE_CONFIG, ...config };
        if (wipe) {
            await wipeSandboxStorage();
            sandboxErrors = [];
        } else {
            destroyFrame();
        }

        // Seeded from the parent, which shares this origin — so it is in place
        // before the app's safety gates run, and init() does not stall waiting for
        // a click that headless has nobody to make.
        localStorage.setItem('mirage_v2_safety', JSON.stringify(SAFETY_SEED));
        localStorage.setItem('mirage_v2_config', JSON.stringify(currentConfig));

        frame = document.createElement('iframe');
        frame.id = 'sandboxFrame';
        frame.title = 'Mirage sandbox under test';
        frame.src = SANDBOX_URL;
        (document.getElementById('sandboxHost') || document.body).appendChild(frame);

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the sandbox did not load in 30s')), 30000);
            frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
            frame.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the sandbox failed to load')); }, { once: true });
        });

        const win = frame.contentWindow;
        watchErrors(win);

        // init() is async and binds subsystems only after the safety gates resolve.
        const deadline = Date.now() + 20000;
        while (typeof win.MirageApp === 'undefined') {
            if (Date.now() > deadline) throw new Error('the app never published MirageApp — it failed to boot');
            await new Promise(r => setTimeout(r, 50));
        }
        return win;
    }

    // -------------------------------------------------------------- execution

    function selectTests({ suiteIds = null, only = null, live = null } = {}) {
        const picked = [];
        for (const s of MirageTests.allSuites()) {
            if (suiteIds && !suiteIds.includes(s.id)) continue;
            for (const test of s.tests) {
                if (test.nodeOnly && !global.__MIRAGE_NODE__) continue;
                // A live test never runs by accident: it needs a key, and an image
                // test needs the checkbox on top of that.
                if (test.live && !live) continue;
                if (test.needsImages && !live?.useImages) continue;
                if (only && !only.includes(`${s.id}::${test.name}`)) continue;
                picked.push({ suite: s, test });
            }
        }
        return picked;
    }

    function classify(r) {
        if (!r.failures.length && !r.expectedRed) return 'pass';
        if (!r.failures.length && r.expectedRed) return 'fixed';
        if (r.failures.length && r.expectedRed) return 'red';
        return 'fail';
    }

    function snapshot() {
        const counts = { pass: 0, fail: 0, red: 0, fixed: 0 };
        state.results.forEach(r => { counts[r.status] += 1; });
        return {
            running: state.running,
            planned: state.planned,
            done: state.results.length,
            current: state.current,
            results: state.results.slice(),
            budget: state.budget ? { ...state.budget } : null,
            counts,
            total: state.results.length,
            startedAt: state.startedAt,
            finishedAt: state.finishedAt,
            durationMs: state.finishedAt && state.startedAt ? state.finishedAt - state.startedAt : null
        };
    }

    /**
     * Run a selection of tests. Resolves with the final snapshot.
     *
     * Each test gets a context bound to a live sandbox; tests that need a clean
     * install call ctx.reset() themselves, so a test which only reads state can run
     * against whatever the previous one left — which is what makes the smoke layer
     * fast.
     */
    async function run(opts = {}) {
        if (state.running) throw new Error('a run is already in progress');

        const live = opts.live || null;
        let picked = selectTests({ ...opts, live });

        cancelled = false;
        state.running = true;
        state.startedAt = Date.now();
        state.finishedAt = null;
        state.results = [];
        state.current = null;
        state.budget = null;
        state.planned = picked.length;
        emit();

        let ctx = null;
        let money = null;
        try {
            // Live tests need the key in the sandbox's config before the app boots,
            // since that is where api.js reads it from. The sandbox is a separate
            // storage origin, so this never touches the config of the app you use —
            // and it is wiped again in the finally below regardless of outcome.
            const bootConfig = { ...(opts.config || {}) };
            if (live) {
                Object.assign(bootConfig, liveConfigPatch(live));
            }

            const win = await bootSandbox({ wipe: true, config: bootConfig });

            // Price the plan against the models actually configured, then drop what
            // the budget cannot cover — before a single credit is spent.
            let plan = null;
            if (live) {
                const price = MirageBudget.priceModels(win, liveConfigPatch(live));
                plan = MirageBudget.plan(
                    picked.filter(p => p.test.live).map(p => ({ suite: p.suite, test: p.test })),
                    price,
                    live.budget
                );
                const admitted = new Set(plan.admitted.map(a => `${a.suite.id}::${a.test.name}`));
                picked = picked.filter(p => !p.test.live || admitted.has(`${p.suite.id}::${p.test.name}`));
                state.planned = picked.length;

                state.budget = {
                    budget: live.budget, price,
                    committed: plan.committed,
                    skipped: plan.skipped.map(s => ({ name: s.test.name, reason: s.reason })),
                    spent: 0, turns: 0, images: 0
                };

                money = MirageBudget.meter(win, price, live.budget, () => { cancelled = true; });
                emit();
            }

            ctx = MirageTests.makeContext({
                win,
                reload: (o) => bootSandbox({
                    ...o,
                    config: o?.config || (live ? liveConfigPatch(live) : null)
                }),
                errors: () => sandboxErrors.slice(),
                config: () => ({ ...currentConfig })
            });

            // Live tests need the real key and a wipe that keeps it.
            ctx.liveConfig = () => (live ? liveConfigPatch(live) : null);
            ctx.resetLive = async () => {
                if (!live) return ctx.reset();
                const patch = liveConfigPatch(live);
                const next = await bootSandbox({ wipe: true, config: patch });
                ctx._rebind(next);
                if (money) {
                    // Carry the totals forward: a reboot hands us a new MirageAPI to
                    // wrap, and starting the meter from zero would quietly void the cap.
                    const carried = money.state;
                    money.release();
                    money = MirageBudget.meter(
                        next, MirageBudget.priceModels(next, patch), live.budget,
                        () => { cancelled = true; }, carried
                    );
                }
                captureRawPayloads(next);
                return next;
            };
            if (live) captureRawPayloads(win);

            for (const { suite, test } of picked) {
                if (cancelled) break;
                state.current = { suite: suite.id, suiteTitle: suite.title, name: test.name };
                emit();

                const failures = [];
                const t = MirageTests.makeAssertions(failures);
                const startedAt = Date.now();
                try {
                    await test.run(ctx, t);
                } catch (err) {
                    failures.push(`threw: ${err && err.message ? err.message : String(err)}`);
                }

                const result = {
                    suite: suite.id,
                    suiteTitle: suite.title,
                    name: test.name,
                    group: test.group || '',
                    expectedRed: test.expectedRed || null,
                    failures,
                    durationMs: Date.now() - startedAt,
                    // Errors the sandbox logged while this test ran, so a failure
                    // comes with the console output that explains it.
                    sandboxErrors: sandboxErrors.slice()
                };
                result.status = classify(result);
                if (money) {
                    result.creditsSoFar = money.spent();
                    state.budget.spent = money.spent();
                    state.budget.turns = money.state.turns;
                    state.budget.images = money.state.images;
                }
                state.results.push(result);
                state.current = null;
                emit();
            }
        } catch (err) {
            state.results.push({
                suite: 'runner', suiteTitle: 'Runner', name: 'the run could not start',
                group: '', expectedRed: null, status: 'fail',
                failures: [`threw: ${err && err.message ? err.message : String(err)}`],
                durationMs: 0, sandboxErrors: sandboxErrors.slice()
            });
        } finally {
            money?.release();
            // The key never outlives the run. It was only ever in the sandbox
            // origin, but leaving a key sitting in localStorage because a test threw
            // is not a defensible default.
            if (live) forgetLiveKey();
            state.running = false;
            state.current = null;
            state.finishedAt = Date.now();
            // Leave the sandbox up: after a failing run the first thing you want is
            // to look at what it left on screen.
            emit();
        }
        return snapshot();
    }

    /** Config the sandbox needs to talk to a real provider. */
    function liveConfigPatch(live) {
        return {
            ...BASE_CONFIG,
            mockThinking: false,
            mockImages: !live.useImages,
            developerMode: true,
            pacingMode: 'instant',
            provider: live.provider,
            apiKey: live.provider === 'kie' ? '' : live.apiKey,
            kieApiKey: live.provider === 'kie' ? live.apiKey : '',
            ...(live.thinkingModel ? { thinkingModel: live.thinkingModel } : {}),
            ...(live.imageModel ? { imageModel: live.imageModel } : {})
        };
    }

    /** Scrub the key out of the sandbox origin once the run is over. */
    function forgetLiveKey() {
        try {
            const raw = localStorage.getItem('mirage_v2_config');
            if (!raw) return;
            const cfg = JSON.parse(raw);
            delete cfg.apiKey;
            delete cfg.kieApiKey;
            localStorage.setItem('mirage_v2_config', JSON.stringify(cfg));
            currentConfig = { ...currentConfig, apiKey: '', kieApiKey: '' };
        } catch (_) { /* best effort — the origin is a sandbox either way */ }
    }

    /**
     * Keep the last raw thinking payload so a contract test can inspect exactly what
     * the model said, before the engine repaired or clamped anything.
     */
    function captureRawPayloads(win) {
        const API = win.MirageAPI;
        if (!API || API.__rawCaptured) return;
        API.__rawCaptured = true;
        const real = API.thinkingGenerate;
        API.thinkingGenerate = async function (...args) {
            const out = await real.apply(this, args);
            try { win.__liveRaw = typeof out === 'string' ? out : JSON.stringify(out); } catch (_) {}
            return out;
        };
    }

    function cancel() { cancelled = true; }

    // ----------------------------------------------------------------- report

    /** A plain-text report — the thing you paste into an issue or hand to a model. */
    function textReport(snap = snapshot()) {
        const lines = [];
        const stamp = new Date(snap.startedAt || Date.now()).toISOString();
        lines.push('MIRAGE ENGINE — TEST REPORT');
        lines.push(`run at:   ${stamp}`);
        lines.push(`origin:   ${location.origin}  (sandbox; your app runs on the other alias)`);
        lines.push(`browser:  ${navigator.userAgent}`);
        lines.push(`duration: ${snap.durationMs != null ? (snap.durationMs / 1000).toFixed(1) + 's' : '—'}`);
        lines.push('');
        lines.push(`RESULT: ${snap.counts.pass} passed, ${snap.counts.fail} failed, `
            + `${snap.counts.red} known-red, ${snap.counts.fixed} newly fixed  (${snap.total} total)`);

        if (snap.budget) {
            const R = MirageBudget.round;
            const b = snap.budget;
            lines.push('');
            lines.push(`SPEND:  ~${R(b.spent)} of ${b.budget} credits`
                + `  (${b.turns} thinking turns, ${b.images} images)`);
            lines.push(`        priced at ~${R(b.price.perTurn)} cr/turn (${b.price.thinkingLabel}), `
                + `~${R(b.price.perImage)} cr/image (${b.price.imageLabel})`);
            if (b.skipped.length) {
                lines.push('        not run, budget too small:');
                b.skipped.forEach(s => lines.push(`          - ${s.name} — ${s.reason}`));
            }
        }
        lines.push('');

        const bySuite = new Map();
        snap.results.forEach(r => {
            if (!bySuite.has(r.suiteTitle)) bySuite.set(r.suiteTitle, []);
            bySuite.get(r.suiteTitle).push(r);
        });

        for (const [title, rows] of bySuite) {
            lines.push('='.repeat(70));
            lines.push(title);
            lines.push('='.repeat(70));
            let group = null;
            for (const r of rows) {
                if (r.group && r.group !== group) { group = r.group; lines.push(`\n— ${group} —`); }
                const tag = { pass: 'pass ', fail: 'FAIL ', red: 'red  ', fixed: 'FIXED' }[r.status];
                lines.push(`  ${tag} ${r.name}  (${r.durationMs}ms)`);
                if (r.status === 'red') lines.push(`        known: ${r.expectedRed}`);
                if (r.status === 'fixed') {
                    lines.push(`        was expected to fail: ${r.expectedRed}`);
                    lines.push('        remove the expectedRed marker');
                }
                r.failures.forEach(f => lines.push(`        ${f}`));
                if (r.status === 'fail' && r.sandboxErrors.length) {
                    lines.push('        --- sandbox console ---');
                    r.sandboxErrors.slice(-12).forEach(e => lines.push(`        ${e}`));
                }
            }
            lines.push('');
        }

        if (snap.counts.fail === 0 && snap.counts.fixed === 0) {
            lines.push('No unexpected failures.');
        }
        return lines.join('\n');
    }

    function jsonReport(snap = snapshot()) {
        return JSON.stringify({
            runAt: new Date(snap.startedAt || Date.now()).toISOString(),
            origin: location.origin,
            userAgent: navigator.userAgent,
            durationMs: snap.durationMs,
            counts: snap.counts,
            total: snap.total,
            results: snap.results
        }, null, 2);
    }

    global.MirageRunner = {
        run, cancel, snapshot, onChange, bootSandbox,
        textReport, jsonReport,
        get frame() { return frame; },
        BASE_CONFIG
    };
})(window);
