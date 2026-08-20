/**
 * Credit budgeting for the live suite.
 *
 * Two jobs, and the second is the one that matters:
 *
 *   1. Price each live test against the models you actually have configured.
 *   2. Refuse to start anything the remaining budget cannot pay for — and keep
 *      refusing as real spend accumulates, so an under-estimate cannot overrun.
 *
 * The cap is clamped in code, not in the input's `max` attribute, because an
 * attribute is a suggestion and this is a limit on somebody's money.
 */
(function (global) {
    'use strict';

    const DEFAULT_BUDGET = 25;
    const ABSOLUTE_MAX = 50;
    const MIN_BUDGET = 1;

    /** Whatever the box says, this is what the runner will actually honour. */
    function clampBudget(raw) {
        const n = Math.floor(Number(raw));
        if (!Number.isFinite(n)) return DEFAULT_BUDGET;
        return Math.min(ABSOLUTE_MAX, Math.max(MIN_BUDGET, n));
    }

    /**
     * Credits per thinking turn and per image for the models in this config.
     * Falls back to deliberately *pessimistic* numbers when a model has no pricing
     * entry — guessing low here spends money that was not authorised.
     */
    function priceModels(win, cfg) {
        const M = win.MirageModels;
        const provider = M.normalizeProvider(cfg.provider || 'google');

        let perTurn = 1;          // pessimistic default
        let perImage = ABSOLUTE_MAX;  // pessimistic enough to refuse rather than guess
        let thinkingLabel = cfg.thinkingModel || '(default)';
        let imageLabel = cfg.imageModel || '(default)';

        try {
            const meta = M.getThinkingModel(cfg.thinkingModel, provider);
            const est = M.thinkingTurnEstimate?.(meta);
            if (Number.isFinite(Number(est?.credits))) perTurn = Number(est.credits);
            if (meta?.label) thinkingLabel = meta.label;
        } catch (_) { /* keep the pessimistic default */ }

        try {
            const meta = M.getImageModel(cfg.imageModel, provider);
            const est = M.imageTurnEstimate?.(meta);
            // Use the *upper* bound where a model quotes a range: a test must not
            // start on the assumption it gets the cheap end.
            const hi = Number(meta?.pricing?.perImageCreditsMax);
            const mid = Number(est?.credits);
            if (Number.isFinite(hi)) perImage = hi;
            else if (Number.isFinite(mid)) perImage = mid;
            if (meta?.label) imageLabel = meta.label;
        } catch (_) { /* keep the pessimistic default */ }

        return { perTurn, perImage, thinkingLabel, imageLabel, provider };
    }

    function estimateFor(test, price) {
        const turns = Number(test.turns) || 0;
        const images = Number(test.images) || 0;
        return turns * price.perTurn + images * price.perImage;
    }

    /**
     * Decide what runs. Priority order first, declaration order within a priority,
     * and a test is admitted only if the whole budget can still cover it.
     *
     * A test that does not fit is *skipped, not truncated* — half a test tells you
     * nothing and still costs money.
     */
    function plan(tests, price, budget) {
        const ranked = tests
            .map((entry, i) => ({ ...entry, _i: i }))
            .sort((a, b) => (a.test.priority || 9) - (b.test.priority || 9) || a._i - b._i);

        const admitted = [];
        const skipped = [];
        let committed = 0;

        for (const entry of ranked) {
            const cost = estimateFor(entry.test, price);
            if (committed + cost > budget) {
                skipped.push({
                    ...entry,
                    cost,
                    reason: cost > budget
                        ? `needs ~${round(cost)} cr, more than the whole ${budget} cr budget`
                        : `needs ~${round(cost)} cr, only ${round(budget - committed)} cr left`
                });
                continue;
            }
            committed += cost;
            admitted.push({ ...entry, cost });
        }

        // Some tests cost nothing because they read what a paid test already
        // fetched. Admitting one whose provider is gone produces a failure that
        // looks like a defect and is really a budget outcome — so drop dependents
        // too, and say why. Looped, because a dependency can itself be dropped.
        for (;;) {
            const names = new Set(admitted.map(a => a.test.name));
            const orphan = admitted.find(a => a.test.dependsOn && !names.has(a.test.dependsOn));
            if (!orphan) break;
            admitted.splice(admitted.indexOf(orphan), 1);
            committed -= orphan.cost;
            skipped.push({
                ...orphan,
                reason: `needs "${orphan.test.dependsOn}", which the budget could not run`
            });
        }

        return { admitted, skipped, committed, budget };
    }

    function round(n) {
        const v = Number(n) || 0;
        if (v >= 10) return String(Math.round(v));
        if (v >= 1) return v.toFixed(1).replace(/\.0$/, '');
        return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    }

    /**
     * Tracks what has actually been spent, by counting real calls rather than
     * trusting the plan. Wraps the two generate functions in the sandbox.
     *
     * `onOverrun` fires the moment real spend passes the budget, so a run can stop
     * mid-flight instead of discovering it afterwards.
     */
    function meter(win, price, budget, onOverrun, carried = null) {
        // `carried` continues a previous meter's totals. A live test may reboot the
        // sandbox mid-run, which hands us a fresh MirageAPI to wrap — without this,
        // spend would silently reset to zero and the cap would stop meaning anything.
        const state = carried || { turns: 0, images: 0, credits: 0, stopped: false };
        const API = win.MirageAPI;
        const realThinking = API.thinkingGenerate;
        const realImage = API.imageGenerate;

        /**
         * Refuse the call *before* it is made, rather than charging it and noticing
         * afterwards. Noticing afterwards is not a cap: a single image is several
         * credits, so one call past the line overshoots by all of it. Observed in a
         * real run — 30 credits spent against a 25 cap.
         */
        const guard = (amount, kind) => {
            if (state.credits + amount <= budget) return;
            state.stopped = true;
            try { onOverrun?.(state); } catch (_) { /* reporting must not throw here */ }
            const err = new Error(
                `Maximum credits reached — this run's ${budget} credit cap is spent `
                + `(~${round(state.credits)} used). The next ${kind} would cost about `
                + `${round(amount)} more, so it was not sent.`
            );
            err.code = 'MIRAGE_BUDGET_EXCEEDED';
            throw err;
        };

        const charge = (amount, kind) => {
            state.credits += amount;
            state[kind] += 1;
        };

        /**
         * Bill only what actually leaves the browser.
         *
         * MirageAPI.thinkingGenerate and imageGenerate both short-circuit to the
         * mock *inside* the function (api.js:581, api.js:650) when mock mode is on.
         * Wrapping the outer function therefore counts calls the provider never
         * saw. Observed: a run reported 6 images and ~45 credits when every one of
         * them was served by the mock and the real cost was about 4 credits — and
         * the phantom spend tripped the cap, skipping three tests there was budget
         * for. Over-reporting is the safe direction for money and the wrong
         * direction for everything else.
         */
        const mockedImages = () => !!win.MirageMockAPI?.isActiveImages?.();
        const mockedThinking = () => !!win.MirageMockAPI?.isActiveThinking?.();

        API.thinkingGenerate = function (opts, ...rest) {
            if (mockedThinking() && !opts?.forceReal) return realThinking.call(this, opts, ...rest);
            // Charged on dispatch, not on success: a call that fails still billed.
            guard(price.perTurn, 'thinking turn');
            charge(price.perTurn, 'turns');
            return realThinking.call(this, opts, ...rest);
        };
        API.imageGenerate = function (opts, ...rest) {
            if (mockedImages() && !opts?.forceReal) return realImage.call(this, opts, ...rest);
            guard(price.perImage, 'image');
            charge(price.perImage, 'images');
            return realImage.call(this, opts, ...rest);
        };

        return {
            state,
            spent: () => state.credits,
            release() {
                API.thinkingGenerate = realThinking;
                API.imageGenerate = realImage;
            }
        };
    }

    global.MirageBudget = {
        DEFAULT_BUDGET, ABSOLUTE_MAX, MIN_BUDGET,
        clampBudget, priceModels, estimateFor, plan, meter, round
    };
})(window);
