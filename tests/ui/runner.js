/**
 * The runner window's UI.
 *
 * Three jobs, in the order they matter: fire a run in one click, show what failed
 * without hunting, and get the failures out of the browser as text you can paste.
 * Everything else — how tests execute, how the sandbox is wiped — lives in engine.js.
 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const els = {
        runAll: $('btnRunAll'), runSmoke: $('btnRunSmoke'), runFailure: $('btnRunFailure'),
        rerunFailed: $('btnRerunFailed'), cancel: $('btnCancel'),
        summary: $('summary'), cPass: $('cPass'), cFail: $('cFail'), cRed: $('cRed'),
        cFixed: $('cFixed'), pillFixed: $('pillFixed'), cMeta: $('cMeta'),
        onlyProblems: $('onlyProblems'),
        copy: $('btnCopy'), download: $('btnDownload'), downloadJson: $('btnDownloadJson'),
        progressWrap: $('progressWrap'), progressBar: $('progressBar'), progressLabel: $('progressLabel'),
        results: $('results'), empty: $('emptyState'),
        originLabel: $('originLabel'), sandboxOrigin: $('sandboxOrigin'),
        sandboxPane: $('sandboxPane'), sandboxHost: $('sandboxHost'), toggleSandbox: $('btnToggleSandbox'),
        warning: $('originWarning'), warningText: $('originWarningText'),
        liveProvider: $('liveProvider'), liveKey: $('liveKey'), liveBudget: $('liveBudget'),
        liveImages: $('liveImages'), liveEstimate: $('liveEstimate'), runLive: $('btnRunLive')
    };

    els.originLabel.textContent = location.origin;
    els.sandboxOrigin.textContent = location.origin;

    // ------------------------------------------------------- the safety check

    // The app hands us the origin it is running on. If it matches ours, the sandbox
    // and the real library share a storage origin and a run would wipe real data.
    // That is the one condition under which this window must refuse to work.
    const from = new URLSearchParams(location.search).get('from');
    let blocked = false;
    if (from && from === location.origin) {
        blocked = true;
        els.warningText.textContent =
            `This window opened on ${location.origin}, the same origin as the app that opened it. `
            + 'The sandbox would share storage with your real characters and chats, and a run wipes '
            + 'the sandbox. Close this and open the runner from the app again — it is meant to land '
            + 'on the other host alias (localhost vs 127.0.0.1).';
        els.warning.hidden = false;
        [els.runAll, els.runSmoke, els.runFailure, els.rerunFailed].forEach(b => { b.disabled = true; });
    }

    // --------------------------------------------------------------- rendering

    let lastSnapshot = null;
    const expanded = new Set();

    function key(r) { return `${r.suite}::${r.name}`; }

    function render(snap) {
        lastSnapshot = snap;

        els.summary.hidden = snap.total === 0 && !snap.running;
        els.empty.hidden = snap.total > 0 || snap.running;

        els.cPass.textContent = snap.counts.pass;
        els.cFail.textContent = snap.counts.fail;
        els.cRed.textContent = snap.counts.red;
        els.cFixed.textContent = snap.counts.fixed;
        els.pillFixed.hidden = snap.counts.fixed === 0;
        const R = MirageBudget.round;
        const spend = snap.budget
            ? ` · ${R(snap.budget.spent)} / ${snap.budget.budget} cr spent`
                + ` (${snap.budget.turns} turns, ${snap.budget.images} images)`
            : '';
        const stoppedEarly = !snap.running && snap.planned > snap.ran
            ? ` · stopped early, ${snap.planned - snap.ran} not run`
            : '';
        els.cMeta.textContent = (snap.durationMs != null
            ? `${snap.total} tests in ${(snap.durationMs / 1000).toFixed(1)}s`
            : (snap.running ? '' : `${snap.total} tests`)) + stoppedEarly + spend;

        els.progressWrap.hidden = !snap.running;
        els.cancel.hidden = !snap.running;
        [els.runAll, els.runSmoke, els.runFailure].forEach(b => { b.disabled = snap.running || blocked; });
        els.rerunFailed.disabled = snap.running || blocked
            || !snap.results.some(r => r.status === 'fail');

        if (snap.running) {
            const pct = snap.planned ? Math.round((snap.done / snap.planned) * 100) : 0;
            els.progressBar.style.width = `${pct}%`;
            els.progressLabel.textContent = snap.current
                ? `${snap.done}/${snap.planned} — ${snap.current.name}`
                : `${snap.done}/${snap.planned}`;
        }

        const onlyProblems = els.onlyProblems.checked;
        const visible = snap.results.filter(r => !onlyProblems
            || r.status === 'fail' || r.status === 'red' || r.status === 'fixed'
            || r.status === 'skipped');
        // Skipped rows are seeded up front so you can see immediately what the
        // budget excluded, but they belong below the results, not above them.
        const rows = [
            ...visible.filter(r => r.status !== 'skipped'),
            ...visible.filter(r => r.status === 'skipped')
        ];

        const frag = document.createDocumentFragment();
        let suite = null, group = null;
        for (const r of rows) {
            if (r.suiteTitle !== suite) {
                suite = r.suiteTitle; group = null;
                frag.appendChild(el('div', 'suite-head', suite));
            }
            if (r.group && r.group !== group) {
                group = r.group;
                frag.appendChild(el('div', 'group-head', `— ${group} —`));
            }
            frag.appendChild(rowFor(r));
            if (expanded.has(key(r))) frag.appendChild(detailFor(r));
        }
        els.results.replaceChildren(frag);
    }

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    const TAG = { pass: 'pass', fail: 'FAIL', red: 'red', fixed: 'FIXED', skipped: 'skip' };

    function rowFor(r) {
        const interesting = r.status !== 'pass';
        const row = el('div', `row row-${r.status}${interesting ? ' clickable' : ''}`);
        row.appendChild(el('span', `tag tag-${r.status}`, TAG[r.status]));
        row.appendChild(el('span', 'row-name', r.name));
        row.appendChild(el('span', 'row-time', `${r.durationMs}ms`));
        if (interesting) {
            row.addEventListener('click', () => {
                const k = key(r);
                if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
                render(lastSnapshot);
            });
        }
        return row;
    }

    function detailFor(r) {
        const d = el('div', 'detail');
        if (r.status === 'red') {
            d.appendChild(el('span', 'known', `Known gap: ${r.expectedRed}\n\n`));
        }
        if (r.status === 'fixed') {
            d.appendChild(el('span', 'known',
                `This was expected to fail and now passes.\nWas: ${r.expectedRed}\n\nRemove the expectedRed marker.\n\n`));
        }
        if (r.failures.length) d.appendChild(document.createTextNode(r.failures.join('\n')));
        if (r.status === 'fail' && r.sandboxErrors.length) {
            d.appendChild(el('span', 'console',
                `--- sandbox console (last 12) ---\n${r.sandboxErrors.slice(-12).join('\n')}`));
        }
        return d;
    }

    MirageRunner.onChange(render);

    // ----------------------------------------------------------------- actions

    async function start(opts) {
        if (blocked) return;
        expanded.clear();
        try {
            const snap = await MirageRunner.run(opts);
            // Open every problem automatically — the whole point is not having to hunt.
            snap.results.filter(r => r.status !== 'pass').forEach(r => expanded.add(key(r)));
            render(snap);
        } catch (err) {
            alert(`The run could not start: ${err.message}`);
        }
    }

    els.runAll.addEventListener('click', () => start({}));
    els.runSmoke.addEventListener('click', () => start({ suiteIds: ['smoke'] }));
    els.runFailure.addEventListener('click', () => start({ suiteIds: ['failure'] }));
    els.rerunFailed.addEventListener('click', () => {
        const only = (lastSnapshot?.results || []).filter(r => r.status === 'fail').map(key);
        if (only.length) start({ only });
    });
    els.cancel.addEventListener('click', () => MirageRunner.cancel());
    els.onlyProblems.addEventListener('change', () => render(lastSnapshot || MirageRunner.snapshot()));

    // ------------------------------------------------------------------- live

    /**
     * Read the live settings. The cap is clamped here *and* in the budget module —
     * a `max` attribute is a suggestion, and this one is a limit on real money.
     */
    function readLive() {
        const key = (els.liveKey.value || '').trim();
        if (!key) return null;
        const budget = MirageBudget.clampBudget(els.liveBudget.value);
        if (String(budget) !== String(els.liveBudget.value)) els.liveBudget.value = budget;
        return {
            provider: els.liveProvider.value === 'kie' ? 'kie' : 'google',
            apiKey: key,
            budget,
            useImages: !!els.liveImages.checked
        };
    }

    /** What the current settings would admit, priced before anything is spent. */
    function refreshEstimate() {
        const live = readLive();
        // Left enabled without a key on purpose: a greyed-out button explains
        // nothing. Clicking it says what is missing and puts the cursor there.
        els.runLive.disabled = blocked || (lastSnapshot?.running ?? false);
        if (!live) {
            els.liveEstimate.textContent = 'No key yet — nothing will run.';
            return;
        }

        const tests = MirageTests.allSuites()
            .filter(s => s.id === 'live')
            .flatMap(s => s.tests
                .filter(x => x.live && (!x.needsImages || live.useImages))
                .map(test => ({ suite: s, test })));

        // Priced against the sandbox's model registry — which is the app's own, so
        // the number here is the number the run will use.
        const win = MirageRunner.frame?.contentWindow;
        if (!win?.MirageModels) {
            els.liveEstimate.textContent = `${tests.length} live test(s) · run once to price them`;
            return;
        }
        // Priced against exactly the config the run will use — including the pinned
        // image model — so the preview cannot promise a number the run then misses.
        const price = MirageBudget.priceModels(win, MirageRunner.liveConfigPatch(live));
        const plan = MirageBudget.plan(tests, price, live.budget);
        const R = MirageBudget.round;
        els.liveEstimate.textContent =
            `${plan.admitted.length} of ${tests.length} tests fit · ~${R(plan.committed)} of ${live.budget} cr`
            + (live.useImages ? ` · image ~${R(price.perImage)} cr (${price.imageLabel})` : '')
            + (plan.skipped.length ? ` · ${plan.skipped.length} skipped` : '');
    }

    [els.liveKey, els.liveBudget, els.liveProvider].forEach(e =>
        e.addEventListener('input', refreshEstimate));
    els.liveImages.addEventListener('change', refreshEstimate);
    els.liveBudget.addEventListener('blur', refreshEstimate);

    els.runLive.addEventListener('click', async () => {
        const live = readLive();
        if (!live) {
            alert(
                'No API key.\n\n'
                + 'Paste your '
                + (els.liveProvider.value === 'kie' ? 'kie.ai' : 'Google AI')
                + ' key into the API key box first — the live tests call your real provider '
                + 'and cannot do anything without it.\n\n'
                + 'The key is never saved: it is wiped when the run finishes.'
            );
            els.liveKey.focus();
            return;
        }
        const R = MirageBudget.round;
        const what = live.useImages
            ? `up to ${live.budget} credits, including one real image`
            : `up to ${live.budget} credits`;
        if (!confirm(
            `This calls your ${live.provider === 'kie' ? 'kie.ai' : 'Google'} account and spends ${what}.\n\n`
            + 'Tests run highest-value first and stop when the cap is reached. Continue?'
        )) return;
        void R;
        await start({ suiteIds: ['live'], live });
        // The field is cleared as soon as the run is over; the engine also scrubs it
        // from the sandbox's stored config.
        els.liveKey.value = '';
        refreshEstimate();
    });

    // ----------------------------------------------------------------- export

    function flash(btn, text) {
        const was = btn.textContent;
        btn.textContent = text;
        setTimeout(() => { btn.textContent = was; }, 1400);
    }

    els.copy.addEventListener('click', async () => {
        const text = MirageRunner.textReport(lastSnapshot || MirageRunner.snapshot());
        try {
            await navigator.clipboard.writeText(text);
            flash(els.copy, 'Copied');
        } catch (_) {
            // Clipboard access can be refused; a selectable prompt still gets the
            // text out, which is the point.
            window.prompt('Copy the report:', text);
        }
    });

    function save(text, ext, type) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mirage-test-report-${stamp}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    els.download.addEventListener('click', () => {
        save(MirageRunner.textReport(lastSnapshot || MirageRunner.snapshot()), 'txt', 'text/plain');
    });
    els.downloadJson.addEventListener('click', () => {
        save(MirageRunner.jsonReport(lastSnapshot || MirageRunner.snapshot()), 'json', 'application/json');
    });

    // ---------------------------------------------------------------- sandbox

    let sandboxShown = true;
    els.toggleSandbox.addEventListener('click', () => {
        sandboxShown = !sandboxShown;
        // Parked offscreen rather than unmounted: removing the iframe would kill the
        // sandbox mid-run.
        els.sandboxHost.classList.toggle('sandbox-parked', !sandboxShown);
        els.sandboxPane.style.width = sandboxShown ? '' : 'auto';
        els.sandboxPane.classList.toggle('collapsed', !sandboxShown);
        els.toggleSandbox.textContent = sandboxShown ? 'Hide' : 'Show';
    });

    render(MirageRunner.snapshot());

    // Never start with a key in the box. Browsers restore form state on reload and
    // Firefox will autofill a saved credential into a password field regardless of
    // autocomplete hints — which reads as "a key was supplied" when none was, and
    // fires a run against a password.
    els.liveKey.value = '';
    refreshEstimate();

    // Boot the sandbox straight away, so the pane is not an empty box and — more
    // usefully — so live tests can be priced against the real model registry before
    // you commit any money to a run.
    if (!blocked) {
        MirageRunner.bootSandbox({ wipe: true })
            .then(refreshEstimate)
            .catch(() => { /* the first real run will report it properly */ });
    }
})();
