#!/usr/bin/env node
/**
 * Mirage Engine test runner.
 *
 *   node run.js smoke              Layer 1 only — the fast one
 *   node run.js record             Layer 2 — compare against the committed baseline
 *   node run.js record --update    Layer 2 — re-record the baseline (deliberate act)
 *   node run.js failure            Layer 3 — failure and edge cases
 *   node run.js nodeonly           the handful that need a driver outside the page
 *   node run.js all                everything
 *
 * Layers 1 and 3 are the *same* tests the in-app runner fires: they live in
 * `tests/suites/` as plain browser code, and both runners execute them through
 * `tests/ui/runner.html`. There is one definition, so the terminal and the button
 * cannot drift apart.
 *
 * Exit code is 0 unless something failed that was not expected to. A known-red
 * Layer 3 test does not fail the run: it is a tracked gap, not a broken suite.
 */
const { startServer } = require('./lib/server');
const { printSummary, C } = require('./lib/report');

const LAYERS = {
    smoke: () => ({ run: (o) => require('./layer-browser').smoke(o) }),
    record: () => require('./layer2-record'),
    failure: () => ({ run: (o) => require('./layer-browser').failure(o) }),
    nodeonly: () => require('./layer-nodeonly')
};

async function main() {
    const [, , rawLayer = 'all', ...flags] = process.argv;
    const layer = String(rawLayer).toLowerCase();
    const update = flags.includes('--update');

    const names = layer === 'all' ? Object.keys(LAYERS) : [layer];
    for (const n of names) {
        if (!LAYERS[n]) {
            console.error(`Unknown layer "${n}". Use: ${Object.keys(LAYERS).join(', ')}, or all.`);
            process.exit(2);
        }
    }

    console.log(`${C.bold}Mirage Engine — test run${C.off}`);
    const server = await startServer();
    console.log(`${C.dim}server: ${server.origin}${server.borrowed ? ' (already running — borrowed)' : ''}${C.off}\n`);

    const totals = { total: 0, pass: 0, fail: 0, red: 0, fixed: 0 };
    try {
        for (const name of names) {
            const mod = LAYERS[name]();
            const s = await mod.run({ origin: server.origin, update });
            for (const k of Object.keys(totals)) totals[k] += s[k] || 0;
            if (names.length > 1) console.log('');
        }
    } finally {
        await server.stop();
    }

    if (names.length > 1) printSummary('TOTAL', totals);

    if (totals.fail > 0) {
        console.log(`\n${C.red}${totals.fail} unexpected failure(s).${C.off}`);
        process.exit(1);
    }
    if (totals.fixed > 0) {
        console.log(`\n${C.yellow}${totals.fixed} known-red test(s) now pass — remove their expectedRed markers.${C.off}`);
    }
    if (totals.red > 0) {
        console.log(`${C.dim}${totals.red} known-red test(s) still red; each names the phase that closes it.${C.off}`);
    }
    process.exit(0);
}

main().catch(err => {
    console.error(`\n${C.red}Runner crashed:${C.off}`, err);
    process.exit(2);
});
