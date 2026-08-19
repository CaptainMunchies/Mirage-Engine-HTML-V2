/**
 * Boot the app in Chromium, ready to drive.
 *
 * Two things every suite needs and neither should have to remember:
 *   - the age + fiction consent gates block init() until satisfied, so a fresh
 *     profile stalls forever headless. They are pre-seeded here.
 *   - the holiday catalogue reaches the public internet. Those failures are
 *     environmental, not regressions, so they are filtered out of error capture.
 */
const { chromium } = require('playwright');
const { determinismScript } = require('./determinism');

// Pre-installed by the environment; a version-matched download is not available here.
const CHROME_PATH = process.env.MIRAGE_CHROME
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const ENV_NOISE = /date\.nager\.at|hebcal\.com|ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Failed to load resource/;

const SAFETY_SEED = {
    ageGate: { verified: true, dob: '1990-01-01' },
    fictionConsent: { accepted: true, version: 1 }
};

async function launchBrowser() {
    return chromium.launch({ executablePath: CHROME_PATH });
}

/**
 * @param {import('playwright').Browser} browser
 * @param {{origin: string, config?: object, deterministic?: boolean, seed?: number}} opts
 */
async function openApp(browser, { origin, config = {}, deterministic = false, seed } = {}) {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    const errors = [];
    const note = (s) => { if (!ENV_NOISE.test(s)) errors.push(s); };
    page.on('pageerror', e => note(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') note(`console: ${m.text()}`); });
    page.on('requestfailed', r => note(`requestfailed: ${r.url()}`));

    if (deterministic) {
        await page.addInitScript(determinismScript(seed != null ? { seed } : {}));
    }

    const cfg = {
        // Mock thinking needs Developer Mode; Instant pacing keeps turns from
        // wall-waiting for minutes. Suites that need other pacing override it.
        developerMode: true,
        mockThinking: true,
        mockImages: true,
        pacingMode: 'instant',
        ...config
    };
    await page.addInitScript(([safety, conf]) => {
        localStorage.setItem('mirage_v2_safety', JSON.stringify(safety));
        localStorage.setItem('mirage_v2_config', JSON.stringify(conf));
    }, [SAFETY_SEED, cfg]);

    await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
    // init() is async and binds subsystems after the safety gates resolve.
    await page.waitForFunction(() => typeof window.MirageApp !== 'undefined', null, { timeout: 15000 });

    return { context, page, errors };
}

/**
 * Put a playable character and a live chat in place without clicking through the
 * five-step wizard. Returns the character id.
 */
async function seedCharacter(page, overrides = {}) {
    return page.evaluate(async (over) => {
        const S = EngineState;
        const png = (name) => {
            const bin = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new File([bytes], name, { type: 'image/png' });
        };

        S.profile = {
            name: 'Nadia',
            age: '24',
            archetype: 'Photographer',
            relationship: 'Girlfriend',
            location: 'Dallas, TX',
            timezone: 'America/Chicago',
            personality: 'Direct, warm',
            loyalty: 'Medium (Balanced)',
            ...over
        };
        S.edf = { VISUAL_ANCHORS: { MASTER_FACE_REF: 'face.png' } };
        S.setMasterFace(png('face.png'));

        const id = MirageProfileStore.makeId();
        S.activeCharacterId = id;
        S.activeCharacterLabel = S.profile.name;
        await MirageProfileStore.saveWithAnchors({
            id,
            label: S.profile.name,
            snapshot: MirageProfileStore.exportSnapshot(S),
            state: S
        });

        MirageChatStore.createChat(S, { resetMetrics: true });
        S.session.phase = 'active';
        MirageSimulation.onEnter?.();
        return id;
    }, overrides);
}

/** Run one turn and wait for it to fully settle. */
async function runTurn(page, text) {
    await page.evaluate(async (t) => {
        await MirageSimulation.executeTurn(t);
    }, text);
    await page.waitForFunction(
        () => !MirageSimulation.isTurnInProgress?.(),
        null,
        { timeout: 30000 }
    ).catch(() => {});
    await page.waitForTimeout(80);
}

module.exports = { launchBrowser, openApp, seedCharacter, runTurn, CHROME_PATH, ENV_NOISE };
