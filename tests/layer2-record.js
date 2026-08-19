/**
 * LAYER 2 — Behaviour recording
 *
 * Scripted sessions run against mock mode. Every metric change, lock and decision is
 * captured, and that capture is the baseline.
 *
 * The rule for this layer is: **whatever the app does today is correct.** These are
 * not assertions about what the engine *should* do — that is Layer 3's job. They
 * exist so that when Phases 3 through 7 restructure the contract, the wall, the event
 * log and the pacing split, any behaviour that quietly changed shows up as a diff.
 * Which is exactly why Phase 1 ran first: a baseline recorded over known bugs would
 * cement them.
 *
 * Update a baseline only when the change was intended:  node run.js record --update
 * and read the diff before committing it.
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser, openApp, seedCharacter, runTurn } = require('./lib/browser');
const { normalize } = require('./lib/determinism');
const { installRecorder, closeTurn } = require('./lib/recorder');
const { Suite, printSummary, C } = require('./lib/report');

const BASELINE_DIR = path.join(__dirname, 'baselines');

/**
 * Each scenario is a named list of steps. A step is either a string (an operator
 * message) or a function given the page, for anything that needs setup.
 */
const SCENARIOS = [
    {
        name: 'plain-conversation',
        why: 'The ordinary path: eight turns of nothing special. Catches drift in the '
            + 'delivery ladder, metric evolution and the shot-variance rotation.',
        steps: [
            'hey', 'what are you up to', 'send me a pic',
            'you look good', 'what are you wearing', 'come over',
            'i missed you today', 'talk to me'
        ]
    },
    {
        name: 'operator-commands',
        why: 'Operator authority: persona and mode are client-owned and absolute, '
            + 'metric pins last one turn, directives move the clock and the scene.',
        steps: [
            'hey',
            '/persona Goon',
            '/arousal 80',
            '/mode STORY',
            '/next scene',
            '/change outfit black slip dress',
            '/time pass 3 hours',
            'still up?'
        ]
    },
    {
        name: 'cold-engagement-withholds',
        why: 'The refusal system. Held at low engagement so ghost_type, left_on_read '
            + 'and went_quiet are all reachable, recording what the operator is shown.',
        setup: async (page) => {
            await page.evaluate(() => { EngineState.session.engagement = 12; });
        },
        beforeEachTurn: async (page) => {
            // resolveStyle recovers engagement as turns land; pin it so the withhold
            // branch stays reachable for the whole scenario.
            await page.evaluate(() => { EngineState.session.engagement = 12; });
        },
        steps: ['hey', 'you there', 'answer me', 'seriously?', 'ok fine', 'hello?', 'come on', 'please']
    },
    {
        name: 'memory-ledger',
        why: 'The ledger is what makes callbacks feel sticky. Records what gets added, '
            + 'what survives eviction at the 8-item cap, and what a resolve closes.',
        setup: async (page) => {
            await page.evaluate(() => {
                const s = EngineState.session;
                MirageMemoryLedger.add(s, { kind: 'promise', text: 'she promised to send a photo tonight' });
                MirageMemoryLedger.add(s, { kind: 'tension', text: 'he did not reply for a whole day' });
                MirageMemoryLedger.add(s, { kind: 'plan', text: 'they plan to meet on friday evening' });
            });
        },
        steps: ['hey', 'about friday', 'you still owe me a photo', 'did you forget', 'so?', 'ok']
    }
];

async function recordScenario(browser, origin, scenario) {
    const { page, context, errors } = await openApp(browser, { origin, deterministic: true });
    try {
        await seedCharacter(page);
        await installRecorder(page);
        await page.evaluate(() => MirageMockAPI.resetDeliveryCycle());
        if (scenario.setup) await scenario.setup(page);

        const turns = [];
        for (const step of scenario.steps) {
            if (scenario.beforeEachTurn) await scenario.beforeEachTurn(page);
            await runTurn(page, step);
            const t = await closeTurn(page, step);
            turns.push({
                input: step,
                changed: t.changed,
                decisions: t.decisions,
                notices: t.notices
            });
        }

        return {
            scenario: scenario.name,
            why: scenario.why,
            turns: normalize(turns),
            pageErrors: errors
        };
    } finally {
        await context.close();
    }
}

const clip = (v, n = 220) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s == null ? String(v) : (s.length > n ? `${s.slice(0, n)}…` : s);
};

/**
 * Report the exact field that moved, not the whole turn.
 *
 * A turn's `changed` map is large and mostly identical between runs; dumping it
 * whole buries the one key that actually differs, which is the only thing worth
 * reading when a baseline breaks.
 */
function describeDelta(label, before, after) {
    const lines = [];
    const bothObjects = before && after
        && typeof before === 'object' && typeof after === 'object'
        && !Array.isArray(before) && !Array.isArray(after);

    if (bothObjects) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        for (const k of keys) {
            const x = JSON.stringify(before[k]);
            const y = JSON.stringify(after[k]);
            if (x === y) continue;
            if (x === undefined) lines.push(`${label}.${k} appeared: ${clip(y)}`);
            else if (y === undefined) lines.push(`${label}.${k} disappeared (was ${clip(x)})`);
            else lines.push(`${label}.${k}\n            baseline: ${clip(x)}\n            now:      ${clip(y)}`);
        }
        if (lines.length) return lines;
    }

    // Arrays of decisions/notices: report the first index that differs.
    if (Array.isArray(before) && Array.isArray(after)) {
        const n = Math.max(before.length, after.length);
        for (let i = 0; i < n; i++) {
            const x = JSON.stringify(before[i]);
            const y = JSON.stringify(after[i]);
            if (x === y) continue;
            lines.push(`${label}[${i}]\n            baseline: ${clip(x)}\n            now:      ${clip(y)}`);
            if (lines.length >= 3) break;
        }
        if (before.length !== after.length) {
            lines.unshift(`${label} length: baseline ${before.length}, now ${after.length}`);
        }
        if (lines.length) return lines;
    }

    return [`${label}\n            baseline: ${clip(before)}\n            now:      ${clip(after)}`];
}

/** Locate the first meaningful difference so a diff is readable, not a wall of JSON. */
function firstDifference(baseline, current) {
    const a = baseline.turns || [];
    const b = current.turns || [];
    if (a.length !== b.length) {
        return `turn count changed: baseline ${a.length}, now ${b.length}`;
    }
    for (let i = 0; i < a.length; i++) {
        for (const key of ['changed', 'decisions', 'notices']) {
            if (JSON.stringify(a[i][key]) === JSON.stringify(b[i][key])) continue;
            const deltas = describeDelta(key, a[i][key], b[i][key]);
            return `turn ${i + 1} ("${a[i].input}")\n          `
                + deltas.slice(0, 4).map(d => `• ${d}`).join('\n          ')
                + (deltas.length > 4 ? `\n          … and ${deltas.length - 4} more field(s)` : '');
        }
    }
    return 'contents differ but no per-turn field did — check the envelope';
}

async function run({ origin, update = false }) {
    const suite = new Suite('Layer 2 — Behaviour recording');
    fs.mkdirSync(BASELINE_DIR, { recursive: true });

    if (update) {
        console.log(`  ${C.yellow}--update: re-recording baselines. Read the diff before committing.${C.off}`);
    }

    const browser = await launchBrowser();
    try {
        for (const scenario of SCENARIOS) {
            const file = path.join(BASELINE_DIR, `${scenario.name}.json`);
            await suite.test(`${scenario.name} matches its baseline`, async (t) => {
                const current = await recordScenario(browser, origin, scenario);
                t.deepEqual(current.pageErrors, [], 'page errors during the recording');

                const body = JSON.stringify(current, null, 2) + '\n';
                if (update || !fs.existsSync(file)) {
                    fs.writeFileSync(file, body);
                    if (!update) {
                        t.fail(`no baseline existed — one was written to baselines/${scenario.name}.json. `
                            + 'Review it and commit it; this test passes from the next run.');
                    }
                    return;
                }

                const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (JSON.stringify(baseline.turns) !== JSON.stringify(current.turns)) {
                    fs.writeFileSync(file.replace(/\.json$/, '.actual.json'), body);
                    t.fail(
                        `behaviour changed against the baseline.\n        ${firstDifference(baseline, current)}\n`
                        + `        full capture written to baselines/${scenario.name}.actual.json\n`
                        + '        if the change was intended: node run.js record --update'
                    );
                }
            });
        }
    } finally {
        await browser.close();
    }

    const s = suite.summary();
    printSummary(suite.name, s);
    return s;
}

module.exports = { run, SCENARIOS };
