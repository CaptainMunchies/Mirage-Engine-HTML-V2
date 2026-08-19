/**
 * The tests a browser cannot run on itself.
 *
 * Everything else moved into `tests/suites/`, where the in-app runner and the CLI
 * share one definition. What is left here needs a driver *outside* the page:
 * reading back a file the browser saved, and starting from a genuinely cold browser
 * profile rather than a wiped origin.
 *
 * Kept deliberately small. Anything that can be written as a shared suite should be.
 */
const fs = require('fs');
const { launchBrowser, openApp, seedCharacter, runTurn } = require('./lib/browser');
const { Suite, printSummary } = require('./lib/report');

async function run({ origin }) {
    const suite = new Suite('Node-only — needs a driver outside the page');
    const browser = await launchBrowser();

    try {
        await suite.test('a backup downloads as a file that imports cleanly', async (t) => {
            // The in-page suite covers build → import. This covers the part only a
            // real driver can see: that what lands on disk is what import reads.
            const { page, context } = await openApp(browser, { origin });
            await seedCharacter(page);
            await runTurn(page, 'save me to disk');

            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 20000 }),
                page.evaluate(() => MirageBackup.exportEverything({}))
            ]);

            const path = await download.path();
            t.ok(path, 'the export produced no file');
            const raw = fs.readFileSync(path, 'utf8');
            t.ok(raw.length > 100, `the backup file was ${raw.length} bytes`);

            let bundle = null;
            try { bundle = JSON.parse(raw); }
            catch (e) { t.fail(`the backup file is not valid JSON: ${e.message}`); }

            if (bundle) {
                t.equal(bundle.format, 'mirage-engine-backup', 'wrong format marker');
                t.equal(bundle.characters?.length, 1, 'the file did not contain the character');
                t.notOk(raw.includes('mirage_v2_config'),
                    'the downloaded file carried the config key, which holds both API keys');

                // Restore it into a browser profile that has never seen this app.
                const fresh = await openApp(browser, { origin: origin.replace('localhost', '127.0.0.1') });
                const res = await fresh.page.evaluate(async (b) => {
                    const out = await MirageBackup.importBundle(b);
                    return { imported: out.imported, characters: MirageProfileStore.list().length };
                }, bundle);
                t.equal(res.imported, 1, 'the downloaded file did not restore');
                t.equal(res.characters, 1, 'the restored character is not in the library');
                await fresh.context.close();
            }

            await context.close();
        });

        await suite.test('a cold browser profile boots to a clean first launch', async (t) => {
            // A wiped origin and a never-used browser profile are not the same thing;
            // this is the only place the genuinely-first-run path is exercised.
            const context = await browser.newContext();
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });
            const state = await page.evaluate(() => ({
                gate: !document.getElementById('ageGateOverlay')?.hidden,
                characters: localStorage.getItem('mirage_v2_characters')
            }));
            t.ok(state.gate, 'the age gate did not block a first launch');
            t.equal(state.characters, null, 'a cold profile already had characters');
            t.deepEqual(errors, [], 'page errors on a cold first launch');
            await context.close();
        });
    } finally {
        await browser.close();
    }

    const s = suite.summary();
    printSummary(suite.name, s);
    return s;
}

module.exports = { run };
