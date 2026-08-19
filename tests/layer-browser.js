/**
 * Drive the browser-native suites from Node.
 *
 * The tests themselves live in `tests/suites/`, are plain browser code, and are
 * executed by `tests/ui/runner.html`. This file does not contain a single
 * assertion — it opens that same runner page in Playwright, tells it to run, and
 * relays the results to the terminal.
 *
 * That indirection is the whole point: the button in the app and `node run.js`
 * execute byte-identical test code in a byte-identical sandbox. A test cannot pass
 * in one and fail in the other, and neither can silently fall behind the other.
 */
const { launchBrowser } = require('./lib/browser');
const { printSummary, C } = require('./lib/report');

const RUNNER_PATH = '/tests/ui/runner.html';

/**
 * The runner is served from 127.0.0.1 while the app's own origin is localhost, so
 * the sandbox is storage-isolated exactly as it is in the app. Playwright contexts
 * start empty anyway — this keeps the two paths identical rather than special-casing
 * the one that happens to be safe.
 */
function runnerUrl(origin) {
    const appOrigin = origin;
    const runnerOrigin = origin.replace('localhost', '127.0.0.1');
    return `${runnerOrigin}${RUNNER_PATH}?from=${encodeURIComponent(appOrigin)}`;
}

const TAG = {
    pass: `  ${C.green}pass${C.off} `,
    fail: `  ${C.red}FAIL${C.off} `,
    red: `  ${C.yellow}red${C.off}  `,
    fixed: `  ${C.yellow}FIXED${C.off}`
};

function printResult(r) {
    console.log(`${TAG[r.status]} ${r.name}`);
    if (r.status === 'red') {
        console.log(`        ${C.dim}(known: ${r.expectedRed})${C.off}`);
        r.failures.forEach(f => console.log(`        ${C.dim}${f}${C.off}`));
    } else if (r.status === 'fixed') {
        console.log(`        ${C.dim}was expected to fail: ${r.expectedRed}${C.off}`);
        console.log(`        ${C.dim}remove the expectedRed marker${C.off}`);
    } else if (r.status === 'fail') {
        r.failures.forEach(f => console.log(`        ${f}`));
        r.sandboxErrors.slice(-6).forEach(e => console.log(`        ${C.dim}${e}${C.off}`));
    }
}

/**
 * @param {{origin: string, suiteIds?: string[]}} opts
 */
async function run({ origin, suiteIds = null }) {
    const browser = await launchBrowser();
    let snap;

    try {
        const context = await browser.newContext({ acceptDownloads: true });
        const page = await context.newPage();

        // Lets the suites opt tests in that only a real browser driver can do.
        await page.addInitScript(() => { window.__MIRAGE_NODE__ = true; });

        const bootErrors = [];
        page.on('pageerror', e => bootErrors.push(`pageerror: ${e.message}`));

        await page.goto(runnerUrl(origin), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof window.MirageRunner !== 'undefined', null, { timeout: 20000 });

        const blocked = await page.evaluate(() => !document.getElementById('originWarning').hidden);
        if (blocked) {
            throw new Error('the runner refused to start — its sandbox shares an origin with the app');
        }

        // Kick the run off without awaiting it, so results can be printed as they
        // land rather than in one dump at the end.
        await page.evaluate((ids) => {
            window.__runPromise = MirageRunner.run(ids ? { suiteIds: ids } : {});
        }, suiteIds);

        let printed = 0;
        let suiteShown = null;
        let groupShown = null;
        for (;;) {
            const s = await page.evaluate(() => MirageRunner.snapshot());
            while (printed < s.results.length) {
                const r = s.results[printed++];
                if (r.suiteTitle !== suiteShown) {
                    suiteShown = r.suiteTitle;
                    groupShown = null;
                    console.log(`\n${C.bold}${suiteShown}${C.off}`);
                }
                if (r.group && r.group !== groupShown) {
                    groupShown = r.group;
                    console.log(`\n  ${C.dim}— ${groupShown} —${C.off}`);
                }
                printResult(r);
            }
            if (!s.running) { snap = s; break; }
            await new Promise(r => setTimeout(r, 150));
        }

        await page.evaluate(() => window.__runPromise);
        if (bootErrors.length) {
            console.log(`\n  ${C.dim}runner page errors: ${bootErrors.join('; ')}${C.off}`);
        }
        await context.close();
    } finally {
        await browser.close();
    }

    const s = {
        total: snap.total,
        pass: snap.counts.pass,
        fail: snap.counts.fail,
        red: snap.counts.red,
        fixed: snap.counts.fixed
    };
    printSummary(suiteIds ? suiteIds.join(' + ') : 'Browser suites', s);
    return s;
}

module.exports = {
    run,
    smoke: (o) => run({ ...o, suiteIds: ['smoke'] }),
    failure: (o) => run({ ...o, suiteIds: ['failure'] })
};
