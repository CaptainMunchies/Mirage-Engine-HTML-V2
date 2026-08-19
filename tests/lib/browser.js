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

const fs = require('fs');

/**
 * Which Chromium to drive.
 *
 * Normally none: Playwright downloads its own on `npm install` and finds it itself,
 * which is what happens on a developer machine. An explicit path is only needed in
 * environments that pre-install a browser and block the download (CI images, some
 * sandboxes), so it is used when MIRAGE_CHROME is set or when that pre-installed
 * copy is actually present.
 */
function resolveChromePath() {
    if (process.env.MIRAGE_CHROME) return process.env.MIRAGE_CHROME;
    const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    try {
        if (fs.existsSync(preinstalled)) return preinstalled;
    } catch { /* fall through to Playwright's own */ }
    return null;
}

const CHROME_PATH = resolveChromePath();

const ENV_NOISE = /date\.nager\.at|hebcal\.com|ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Failed to load resource/;

const SAFETY_SEED = {
    ageGate: { verified: true, dob: '1990-01-01' },
    fictionConsent: { accepted: true, version: 1 }
};

async function launchBrowser() {
    try {
        return await chromium.launch(CHROME_PATH ? { executablePath: CHROME_PATH } : {});
    } catch (err) {
        throw new Error(
            `Could not launch Chromium: ${err.message}\n`
            + 'If this says the browser is missing, run:  npx playwright install chromium'
        );
    }
}

/**
 * @param {import('playwright').Browser} browser
 * @param {{origin: string, config?: object, deterministic?: boolean, seed?: number}} opts
 */
async function openApp(browser, { origin, config = {}, deterministic = false, seed } = {}) {
    const context = await browser.newContext({
        acceptDownloads: true,
        // Pinned so a recording made on one machine matches one made on another:
        // chat labels and any bare toLocaleString go through these.
        ...(deterministic ? { locale: 'en-US', timezoneId: 'UTC' } : {})
    });
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

/**
 * Make the thinking model return exactly this on the next turn.
 *
 * Wraps MirageMockAPI.mockThinkingGenerate, which is what api.js dispatches to when
 * mock thinking is on. Injecting here rather than at the fetch layer means the reply
 * travels the same parse → classify → applyTracking path a real one would.
 *
 * @param {string|null} raw the literal text the "model" returns; null restores the mock
 * @param {{times?: number, throws?: {message: string, code?: string}}} [opts]
 */
async function stubThinking(page, raw, opts = {}) {
    await page.evaluate(([body, o]) => {
        const M = MirageMockAPI;
        if (!M.__realThinking) M.__realThinking = M.mockThinkingGenerate;
        if (body === null && !o.throws) {
            M.mockThinkingGenerate = M.__realThinking;
            return;
        }
        let left = o.times ?? Infinity;
        M.mockThinkingGenerate = async function (args) {
            if (left <= 0) return M.__realThinking.call(this, args);
            left -= 1;
            if (o.throws) {
                const err = new Error(o.throws.message);
                if (o.throws.code) err.code = o.throws.code;
                if (o.throws.name) err.name = o.throws.name;
                throw err;
            }
            return body;
        };
    }, [raw, opts]);
}

/** Same idea for the image half. */
async function stubImage(page, { throws = null, dataUrl = null } = {}) {
    await page.evaluate(([o]) => {
        const M = MirageMockAPI;
        if (!M.__realImage) M.__realImage = M.mockImageGenerate;
        if (!o.throws && !o.dataUrl) {
            M.mockImageGenerate = M.__realImage;
            return;
        }
        M.mockImageGenerate = async function () {
            if (o.throws) {
                const err = new Error(o.throws.message);
                if (o.throws.code) err.code = o.throws.code;
                if (o.throws.name) err.name = o.throws.name;
                throw err;
            }
            return o.dataUrl;
        };
    }, [{ throws, dataUrl }]);
}

/** A well-formed turn payload, with fields overridden for a specific test. */
function turnPayload(over = {}) {
    return JSON.stringify({
        tracking: {
            persona: 'Standard', mode: 'DM', outfit: 'casual day look', env: 'her place',
            arousal: 30, tease: 0, awareness: 20, thermal: 'Normal',
            mood: 'Warm', moodIntensity: 1, engagement: 60,
            ...(over.tracking || {})
        },
        characterResponse: 'hey you',
        delivery: { style: 'normal', ...(over.delivery || {}) },
        ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'tracking' && k !== 'delivery'))
    });
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

module.exports = {
    launchBrowser, openApp, seedCharacter, runTurn,
    stubThinking, stubImage, turnPayload,
    CHROME_PATH, ENV_NOISE
};
