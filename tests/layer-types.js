/**
 * The type check, as a test layer.
 *
 * The app stays no-build: nothing here compiles or bundles anything. `tsc --noEmit`
 * reads the same .js files the browser loads, and the types live in JSDoc comments
 * the browser ignores. Delete this directory and the app is unchanged.
 *
 * It is a layer rather than a separate command because a check nobody runs is a
 * comment. `tests/tsconfig.json` carries the allowlist of files that are clean, and
 * that list is what grows — see roadmap Phase 3, "other files get typed only as
 * they're touched".
 *
 * What it catches is narrow on purpose: a misspelled contract field. Every other
 * kind of finding was turned off after measuring them, because 178 "parameter
 * implicitly has an any type" findings on one file bury the one that matters.
 */
const path = require('path');
const { execFile } = require('child_process');
const { Suite, printSummary } = require('./lib/report');

const TESTS_DIR = __dirname;
const TSC = path.join(TESTS_DIR, 'node_modules', '.bin', 'tsc');

function runTsc() {
    return new Promise((resolve) => {
        execFile(
            TSC,
            ['-p', path.join(TESTS_DIR, 'tsconfig.json')],
            { cwd: TESTS_DIR, timeout: 180000 },
            (err, stdout, stderr) => {
                resolve({
                    // tsc exits non-zero when it reports errors, which is not a crash.
                    failed: !!err,
                    output: `${stdout || ''}${stderr || ''}`.trim(),
                    missing: !!(err && err.code === 'ENOENT')
                });
            }
        );
    });
}

async function run() {
    const suite = new Suite('Types — the turn contract, checked');

    await suite.test('the typed files have no type errors', async (t) => {
        const { failed, output, missing } = await runTsc();

        if (missing) {
            t.fail('tsc is not installed — run `npm install` in tests/');
            return;
        }

        const errors = output.split('\n').filter(l => /error TS\d+:/.test(l));
        if (errors.length) {
            // Name them. "3 type errors" sends someone to re-run the tool; the
            // actual lines are the finding.
            t.fail(`${errors.length} type error(s):\n        ${errors.join('\n        ')}`);
            return;
        }
        t.ok(!failed, `tsc failed without reporting an error:\n${output}`);
    });

    const s = suite.summary();
    printSummary('Types', s);
    return s;
}

module.exports = { run };
