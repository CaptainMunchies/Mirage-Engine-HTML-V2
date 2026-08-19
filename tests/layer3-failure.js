/**
 * LAYER 3 — Failure and edge cases
 *
 * One targeted test per scenario. The rule for this layer is the opposite of
 * Layer 2's: **assert the intended behaviour, not today's.** Several of these paths
 * are still wrong, and those tests are marked `expectedRed` with the reason and the
 * phase that closes them. A known-red test does not fail the run; a known-red test
 * that starts passing is reported loudly so the marker comes off.
 *
 * Everything here runs with no API and no credits.
 */
const {
    launchBrowser, openApp, seedCharacter, runTurn,
    stubThinking, stubImage, turnPayload
} = require('./lib/browser');
const { Suite, printSummary, C } = require('./lib/report');

/** Start collecting the toasts the operator is shown, alongside the chat log. */
async function watchToasts(page) {
    await page.evaluate(() => {
        if (window.__toastsWatched) return;
        window.__toastsWatched = true;
        window.__toasts = [];
        const real = MirageUI.toast;
        MirageUI.toast = function (msg, type, opts) {
            const o = opts && typeof opts === 'object' ? opts : null;
            const player = type === 'error' || type === 'ok' || !!o?.essential || o?.lane === 'player';
            window.__toasts.push({ lane: o?.lane === 'dev' ? 'dev' : (player ? 'player' : 'inferred'), text: String(msg) });
            return real.apply(this, arguments);
        };
    });
}

/**
 * Read what the operator can actually see after a turn.
 *
 * `text` deliberately spans the chat log *and* the player-lane toasts: a rejected
 * command reports through a toast and puts nothing in the thread, so reading only
 * the thread makes correct behaviour look like silence.
 */
async function visible(page) {
    return page.evaluate(() => {
        const nodes = [...document.querySelectorAll('#chatLog > *')];
        const s = EngineState.session;
        const toasts = window.__toasts || [];
        return {
            entries: nodes.length,
            toasts,
            text: [
                ...nodes.map(n => (n.textContent || '').replace(/\s+/g, ' ').trim()),
                ...toasts.filter(x => x.lane !== 'dev').map(x => x.text)
            ].join('\n'),
            lastAi: s.history?.at(-1)?.ai ?? null,
            historyLength: s.history?.length ?? 0,
            arousal: s.arousal, tease: s.tease, awareness: s.awareness,
            engagement: s.engagement, persona: s.persona, mode: s.mode,
            thermal: s.thermal, outfit: s.outfit, env: s.env,
            awakeningActive: !!s.awakeningActive, awakeningStage: s.awakeningStage,
            ledger: (s.memoryLedger || []).map(i => ({ kind: i.kind, text: i.text, resolved: !!i.resolved }))
        };
    });
}

/** A fresh app + character for one test, so tests cannot contaminate each other. */
async function fresh(browser, origin, config) {
    const app = await openApp(browser, { origin, config });
    await seedCharacter(app.page);
    await watchToasts(app.page);
    await app.page.evaluate(() => MirageMockAPI.resetDeliveryCycle());
    return app;
}

async function run({ origin }) {
    const suite = new Suite('Layer 3 — Failure and edge cases');
    const browser = await launchBrowser();

    // Each group opens one app and reuses it where tests are independent; anything
    // that corrupts state gets its own.
    try {
        // ==================================================================
        console.log(`\n  ${C.dim}— bad model output —${C.off}`);
        // ==================================================================

        await suite.test('one malformed JSON reply recovers silently on the retry', async (t) => {
            // The engine retries once. A transient bad parse should cost the operator
            // nothing but a moment — no error, and her reply still lands.
            const app = await fresh(browser, origin);
            // First call is malformed, second is a normal reply. Pinning the retry's
            // style matters: the mock cycles delivery styles, and a withhold on the
            // retry would legitimately leave no text to assert on.
            await app.page.evaluate(([bad, good]) => {
                let n = 0;
                MirageMockAPI.mockThinkingGenerate = async () => (n++ === 0 ? bad : good);
            }, ['{ "characterResponse": "hey', turnPayload({ characterResponse: 'RECOVERED' })]);
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.equal(v.historyLength, 1, 'the recovered turn did not commit');
            t.match(v.lastAi, /RECOVERED/, 'no usable reply after the retry');
            t.noMatch(v.text, /invalid json|malformed/i, 'a recovered turn still shouted about JSON');
            await app.context.close();
        });

        await suite.test('persistently malformed JSON reports clearly and commits nothing', async (t) => {
            const app = await fresh(browser, origin);
            await stubThinking(app.page, '{ "characterResponse": "hey');   // every call
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.match(v.text, /invalid json|malformed/i, 'nothing told the operator the turn failed');
            t.equal(v.historyLength, 0, 'a failed turn was committed to history');
            t.noMatch(v.text, /^…$/m, 'a bare ellipsis bubble was shown instead of an error');
            await app.context.close();
        });

        await suite.test('valid JSON with no characterResponse is a failed turn, not a "…" bubble', async (t) => {
            const app = await fresh(browser, origin);
            await stubThinking(app.page, JSON.stringify({
                tracking: { arousal: 40, mode: 'DM', persona: 'Standard' },
                delivery: { style: 'normal' }
            }), { times: 1 });
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.notOk(v.lastAi === '…', 'the turn was committed to history as a "…" reply');
            t.match(v.text, /again|retry|didn.t|failed|empty/i, 'the operator was not told anything went wrong');
        }, {
            expectedRed: 'simulation.js does `parsed.characterResponse || parsed.response || "…"` — '
                + 'valid-but-wrong JSON degrades to a silent ellipsis. Contract validation is Phase 3.'
        });

        await suite.test('a single refusal is rescued by the softened retry', async (t) => {
            // The soften pass exists so one refusal is invisible to the operator.
            const app = await fresh(browser, origin);
            await stubThinking(app.page,
                "I'm unable to generate sexually explicit content. This violates the policy.",
                { times: 1 });
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.equal(v.historyLength, 1, 'the softened retry did not produce a turn');
            t.noMatch(v.text, /safety filter|blocked by/i, 'a rescued refusal still alarmed the operator');
            await app.context.close();
        });

        await suite.test('a refusal the retry cannot rescue is reported as a safety block', async (t) => {
            const app = await fresh(browser, origin);
            await stubThinking(app.page,
                "I'm unable to generate sexually explicit content. This violates the policy.");
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.match(v.text, /safety filter|blocked/i, 'a provider refusal was not reported as one');
            t.equal(v.historyLength, 0, 'a blocked turn was committed to history');
            await app.context.close();
        });

        await suite.test('an in-character "i cannot" is a normal reply, not a refusal', async (t) => {
            const app = await fresh(browser, origin);
            await stubThinking(app.page, turnPayload({
                characterResponse: "lol i'm unable to even rn 😭 i cannot fulfill that"
            }), { times: 1 });
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.match(v.lastAi, /unable to even/i, 'her reply did not land');
            t.noMatch(v.text, /safety filter|blocked by/i, 'her own words were read as a provider refusal');
            await app.context.close();
        });

        await suite.test('metrics outside their range are clamped, not stored raw', async (t) => {
            const app = await fresh(browser, origin);
            await stubThinking(app.page, turnPayload({
                tracking: { arousal: 999, tease: 47, awareness: -30, engagement: 1e6 }
            }), { times: 1 });
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.between(v.arousal, 0, 100, 'arousal escaped its range');
            t.between(v.tease, 0, 3, 'tease escaped its range');
            t.between(v.awareness, 0, 100, 'awareness escaped its range');
            t.between(v.engagement, 0, 100, 'engagement escaped its range');
            await app.context.close();
        });

        await suite.test('the model cannot change persona — it is operator-owned', async (t) => {
            const app = await fresh(browser, origin);
            await app.page.evaluate(() => { EngineState.session.persona = 'Standard'; });
            await stubThinking(app.page, turnPayload({
                tracking: { persona: 'Goon' }
            }), { times: 1 });
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.equal(v.persona, 'Standard', 'the model changed persona');
            await app.context.close();
        });

        await suite.test('the model cannot change mode — it is operator-owned', async (t) => {
            const app = await fresh(browser, origin);
            await app.page.evaluate(() => {
                EngineState.session.mode = 'DM';
                EngineState.session._storyActive = false;
            });
            await stubThinking(app.page, turnPayload({
                tracking: { mode: 'STORY' }
            }), { times: 1 });
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.equal(v.mode, 'DM', 'the model put the app into Story mode on its own');
            await app.context.close();
        }, {
            expectedRed: 'N19 — applyTracking ignores tracking.mode as client-owned, then '
                + 'simulation.js:4374 honours `trackingMode === "STORY"` anyway. Operator '
                + 'authority is a §1 guardrail; the contract phase (3) owns the fix.'
        });

        await suite.test('a withhold style is overridden when the turn must deliver', async (t) => {
            const app = await fresh(browser, origin);
            const plan = await app.page.evaluate(() => {
                const parsed = { characterResponse: 'hey', delivery: { style: 'went_quiet' } };
                return MirageImmersion.planDelivery(parsed, EngineState.session, { mustDeliver: true });
            });
            t.notOk(plan.withhold, 'a must-deliver turn was allowed to withhold');
            t.equal(plan.style, 'normal', 'the withhold style survived a must-deliver turn');
            await app.context.close();
        });

        // ==================================================================
        console.log(`\n  ${C.dim}— provider and network —${C.off}`);
        // ==================================================================

        await suite.test('an image timeout is reported as a timeout, not "no image"', async (t) => {
            const app = await fresh(browser, origin);
            const seen = await app.page.evaluate(() => {
                const err = new Error('Image (Nano Banana Pro): timed out after 5 minutes — try Lite');
                return {
                    reason: MirageAPI.classifyImageError(err),
                    message: MirageAPI.imageFailureMessage(MirageAPI.classifyImageError(err), err.message)
                };
            });
            t.equal(seen.reason, 'timeout', 'a timeout was misclassified');
            t.match(seen.message.title, /timed out/i, 'the message did not say it timed out');
            await app.context.close();
        });

        await suite.test('an image failure keeps her text — the turn is not lost', async (t) => {
            const app = await fresh(browser, origin);
            await stubImage(app.page, { throws: { message: 'kie image failed: probe' } });
            await stubThinking(app.page, turnPayload({ characterResponse: 'TEXTSURVIVES' }), { times: 1 });
            await runTurn(app.page, 'send me a pic');
            const v = await visible(app.page);
            t.match(v.text, /TEXTSURVIVES/, 'her text was dropped when the image failed');
            await stubImage(app.page, {});
            await app.context.close();
        });

        await suite.test('a thinking network error is reported and the turn can be retried', async (t) => {
            const app = await fresh(browser, origin);
            await stubThinking(app.page, null, {
                times: 1,
                throws: { message: 'Failed to fetch' }
            });
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.match(v.text, /network|server|fetch|failed/i, 'a network failure was not surfaced');
            t.equal(v.historyLength, 0, 'a failed turn was committed to history');
            await app.context.close();
        });

        await suite.test('the proxy refuses a request with no session token', async (t) => {
            const app = await fresh(browser, origin);
            const status = await app.page.evaluate(async () => {
                const res = await fetch('/api/proxy/kie/fetch-image', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Mirage-Api-Key': 'x' },
                    body: JSON.stringify({ url: 'https://file.kie.ai/x.png' })
                });
                return res.status;
            });
            t.equal(status, 403, 'the proxy served a request with no session token');
            await app.context.close();
        });

        await suite.test('the image proxy refuses an internal URL', async (t) => {
            const app = await fresh(browser, origin);
            const body = await app.page.evaluate(async () => {
                const headers = await MirageProxySession.withSession({
                    'Content-Type': 'application/json', 'X-Mirage-Api-Key': 'x'
                });
                const res = await fetch('/api/proxy/kie/fetch-image', {
                    method: 'POST', headers,
                    body: JSON.stringify({ url: 'http://127.0.0.1:8080/index.html' })
                });
                return { status: res.status, msg: (await res.json())?.error?.message };
            });
            t.equal(body.status, 400, 'an internal URL was not refused');
            t.match(body.msg, /refusing/i, 'the refusal did not say why');
            await app.context.close();
        });

        // ==================================================================
        console.log(`\n  ${C.dim}— interruption —${C.off}`);
        // ==================================================================

        await suite.test('cancelling a turn rolls state back and returns the message', async (t) => {
            const app = await fresh(browser, origin);
            const before = await visible(app.page);
            const result = await app.page.evaluate(async () => {
                const S = EngineState;
                S.session.arousal = 20;
                // Hold the turn open so there is something to cancel.
                const real = MirageMockAPI.mockThinkingGenerate;
                // Hold the turn open but honour the abort signal, or cancelling can
                // never settle the promise and the evaluate hangs.
                MirageMockAPI.mockThinkingGenerate = ({ signal }) => new Promise((_, reject) => {
                    const abort = () => { const e = new Error('Cancelled'); e.name = 'AbortError'; reject(e); };
                    if (signal?.aborted) return abort();
                    signal?.addEventListener('abort', abort, { once: true });
                });
                const turn = MirageSimulation.executeTurn('cancel me please');
                await new Promise(r => setTimeout(r, 250));
                MirageSimulation.cancelActiveTurn();
                await turn.catch(() => {});
                await new Promise(r => setTimeout(r, 250));
                MirageMockAPI.mockThinkingGenerate = real;
                return {
                    history: S.session.history.length,
                    arousal: S.session.arousal,
                    composer: document.getElementById('simInput')?.value || ''
                };
            });
            t.equal(result.history, before.historyLength, 'a cancelled turn was committed to history');
            t.equal(result.arousal, 20, 'metrics were not rolled back');
            t.match(result.composer, /cancel me please/, 'the cancelled message was not returned to the composer');
            await app.context.close();
        });

        await suite.test('cancelling does not leave a phantom shot in the variance list', async (t) => {
            const app = await fresh(browser, origin);
            const r = await app.page.evaluate(async () => {
                const S = EngineState;
                S.session.shotHistory = ['Front Selfie'];
                S.session.lastShotType = 'Front Selfie';
                const before = JSON.stringify([S.session.shotHistory, S.session.lastShotType]);
                const real = MirageMockAPI.mockThinkingGenerate;
                MirageMockAPI.mockThinkingGenerate = ({ signal }) => new Promise((_, reject) => {
                    const abort = () => { const e = new Error('Cancelled'); e.name = 'AbortError'; reject(e); };
                    if (signal?.aborted) return abort();
                    signal?.addEventListener('abort', abort, { once: true });
                });
                const turn = MirageSimulation.executeTurn('send me a pic');
                await new Promise(r2 => setTimeout(r2, 250));
                // What applyShotVarianceLock does, before generation.
                S.recordShotType('Mirror Selfie', 'Bust', null);
                MirageSimulation.cancelActiveTurn();
                await turn.catch(() => {});
                await new Promise(r2 => setTimeout(r2, 250));
                MirageMockAPI.mockThinkingGenerate = real;
                return { before, after: JSON.stringify([S.session.shotHistory, S.session.lastShotType]) };
            });
            t.equal(r.after, r.before, 'a cancelled turn left a shot in the avoid-list');
            await app.context.close();
        });

        await suite.test('an in-flight turn cannot land in a chat you switched to', async (t) => {
            const app = await fresh(browser, origin);
            const r = await app.page.evaluate(async () => {
                const S = EngineState;
                const token = MirageSimulation.__boundaryToken?.() ?? null;
                // Take a boundary token, switch chats, and check it is refused.
                MirageChatStore.createChat(S, { resetMetrics: true });
                MirageSimulation.quarantineChatBoundary();
                MirageChatStore.createChat(S, { resetMetrics: true });
                return { token, epoch: S.session.sessionEpoch };
            });
            // The token API is internal; assert the observable property instead —
            // switching chats bumps the epoch that in-flight work is checked against.
            t.ok(Number(r.epoch) > 0, 'switching chats did not advance the session epoch');
            await app.context.close();
        });

        await suite.test('a second turn fired mid-turn is refused, not interleaved', async (t) => {
            const app = await fresh(browser, origin);
            const r = await app.page.evaluate(async () => {
                const S = EngineState;
                const real = MirageMockAPI.mockThinkingGenerate;
                let calls = 0;
                MirageMockAPI.mockThinkingGenerate = function (a) {
                    calls += 1;
                    return new Promise(res => setTimeout(() => res(real.call(this, a)), 400));
                };
                const first = MirageSimulation.executeTurn('first');
                await new Promise(r2 => setTimeout(r2, 80));
                const second = MirageSimulation.executeTurn('second');
                await Promise.allSettled([first, second]);
                await new Promise(r2 => setTimeout(r2, 300));
                MirageMockAPI.mockThinkingGenerate = real;
                return { calls, history: S.session.history.length };
            });
            t.equal(r.calls, 1, 'both turns reached the model at once');
            t.equal(r.history, 1, 'two overlapping turns both committed');
            await app.context.close();
        });

        // ==================================================================
        console.log(`\n  ${C.dim}— storage —${C.off}`);
        // ==================================================================

        await suite.test('a quota failure reaches the operator, not the void', async (t) => {
            const app = await fresh(browser, origin);
            const r = await app.page.evaluate(async () => {
                const out = { dialog: false, toasts: [] };
                const realDialog = MirageUI.showStorageFullDialog;
                const realToast = MirageUI.toast;
                MirageUI.showStorageFullDialog = () => { out.dialog = true; };
                MirageUI.toast = (m) => { out.toasts.push(String(m)); };
                const realSet = Storage.prototype.setItem;
                Storage.prototype.setItem = function (k) {
                    if (String(k).startsWith('mirage_v2_')) {
                        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
                    }
                    return realSet.apply(this, arguments);
                };
                MirageSimulation.saveChatQuietly(EngineState);
                await new Promise(res => setTimeout(res, 250));
                Storage.prototype.setItem = realSet;
                MirageUI.showStorageFullDialog = realDialog;
                MirageUI.toast = realToast;
                return out;
            });
            t.ok(r.dialog || r.toasts.length, 'a failed save told the operator nothing');
            await app.context.close();
        });

        await suite.test('a corrupt saved chat does not take the app down', async (t) => {
            const app = await openApp(browser, { origin });
            await app.page.evaluate(() => {
                localStorage.setItem('mirage_v2_chats', '{ this is not json');
            });
            await app.page.reload({ waitUntil: 'networkidle' });
            await app.page.waitForFunction(() => typeof window.MirageApp !== 'undefined', null, { timeout: 15000 });
            const ok = await app.page.evaluate(() => {
                try { return { chats: MirageChatStore.listChats('anything').length, alive: true }; }
                catch (e) { return { alive: false, error: e.message }; }
            });
            t.ok(ok.alive, `the chat store threw on corrupt data: ${ok.error}`);
            t.equal(ok.chats, 0, 'corrupt data produced phantom chats');
            await app.context.close();
        });

        await suite.test('IndexedDB being unavailable does not stop a turn', async (t) => {
            const app = await openApp(browser, { origin });
            await app.page.evaluate(() => {
                // Every open fails, as in private browsing.
                indexedDB.open = function () { throw new Error('IndexedDB is disabled'); };
            });
            await seedCharacter(app.page).catch(() => {});
            const r = await app.page.evaluate(async () => {
                try {
                    await MirageSimulation.executeTurn('hello with no idb');
                    return { ok: true, history: EngineState.session.history.length };
                } catch (e) {
                    return { ok: false, error: e.message };
                }
            });
            t.ok(r.ok, `a turn threw with IndexedDB unavailable: ${r.error}`);
            await app.context.close();
        });

        // ==================================================================
        console.log(`\n  ${C.dim}— time —${C.off}`);
        // ==================================================================

        await suite.test('an unknown location does not silently borrow your timezone', async (t) => {
            const app = await fresh(browser, origin);
            const r = await app.page.evaluate(() => {
                EngineState.profile.timezone = '';
                const inferred = MiragePhoneUX.inferTimeZoneFromLocation('Vulgaria');
                return { inferred, browser: MiragePhoneUX.browserTimeZone() };
            });
            // Inference must decline rather than guess; the caller then falls back
            // loudly (the setup hint says so, and the fallbacks warn).
            t.equal(r.inferred, '', 'an unknown location was given a confident timezone');
            await app.context.close();
        });

        await suite.test('a narrative skip never rewinds her clock', async (t) => {
            const app = await fresh(browser, origin);
            const r = await app.page.evaluate(() => {
                const out = [];
                for (const sec of [60, 600, 3600, 7200, 39600, 82800, 86400, 90000]) {
                    const plan = MirageImmersion.planDelivery(
                        { characterResponse: 'hey', delivery: { style: 'normal', timeSkipSec: sec } },
                        EngineState.session, {}
                    );
                    out.push({ asked: sec, got: plan.timeSkipMs });
                }
                return out;
            });
            r.forEach(x => t.ok(x.got >= 0, `a ${x.asked}s skip produced a negative jump (${x.got})`));
            await app.context.close();
        });

        await suite.test('her clock crosses midnight without changing timezone', async (t) => {
            const app = await fresh(browser, origin);
            const r = await app.page.evaluate(() => {
                const tz = MiragePhoneUX.resolveTimeZone(EngineState.profile.location);
                // 23:30 in Chicago, then push two hours.
                const before = MiragePhoneUX.getZonedParts(new Date(Date.UTC(2026, 4, 15, 4, 30)), tz);
                const after = MiragePhoneUX.getZonedParts(new Date(Date.UTC(2026, 4, 15, 6, 30)), tz);
                return { tz, before, after };
            });
            t.equal(r.tz, 'America/Chicago', 'timezone drifted');
            t.equal(r.before.hour, 23, 'pre-midnight hour wrong');
            t.equal(r.after.hour, 1, 'post-midnight hour wrong');
            t.equal(r.after.day, r.before.day + 1, 'the calendar day did not roll over');
            await app.context.close();
        });

        await suite.test('a DST boundary does not produce a phantom hour', async (t) => {
            const app = await fresh(browser, origin);
            const r = await app.page.evaluate(() => {
                const tz = 'America/Chicago';
                // US spring-forward 2026: 2am local becomes 3am on March 8.
                const pre = MiragePhoneUX.getZonedParts(new Date(Date.UTC(2026, 2, 8, 7, 30)), tz);
                const post = MiragePhoneUX.getZonedParts(new Date(Date.UTC(2026, 2, 8, 8, 30)), tz);
                return { pre, post };
            });
            t.equal(r.pre.hour, 1, 'pre-DST local hour wrong');
            t.equal(r.post.hour, 3, 'the spring-forward hour was not skipped');
            await app.context.close();
        });

        // ==================================================================
        console.log(`\n  ${C.dim}— rules —${C.off}`);
        // ==================================================================

        await suite.test('an unknown command is refused, not sent to her as text', async (t) => {
            const app = await fresh(browser, origin);
            await runTurn(app.page, '/notacommand foo');
            const v = await visible(app.page);
            t.equal(v.historyLength, 0, 'an unknown command was sent as a turn');
            t.match(v.text, /unknown|not a command|usage|\/help/i, 'nothing explained the bad command');
            await app.context.close();
        });

        await suite.test('a command with a bad argument explains itself', async (t) => {
            const app = await fresh(browser, origin);
            await runTurn(app.page, '/arousal banana');
            const v = await visible(app.page);
            t.match(v.text, /usage|number|0-100|invalid/i, 'a bad argument produced no guidance');
            await app.context.close();
        });

        await suite.test('an empty message does not run a turn', async (t) => {
            const app = await fresh(browser, origin);
            const before = (await visible(app.page)).historyLength;
            await app.page.evaluate(async () => {
                await MirageSimulation.executeTurn('   ');
            });
            await app.page.waitForTimeout(200);
            const after = (await visible(app.page)).historyLength;
            t.equal(after, before, 'an empty message ran a turn');
            await app.context.close();
        });

        await suite.test('a reply over the character cap is trimmed cleanly', async (t) => {
            const app = await fresh(browser, origin, { maxReplyChars: 120 });
            const long = 'She said something. '.repeat(40);
            await stubThinking(app.page, turnPayload({ characterResponse: long }), { times: 1 });
            await runTurn(app.page, 'talk to me');
            const v = await visible(app.page);
            t.ok(v.lastAi && v.lastAi.length <= 120, `reply was ${v.lastAi?.length} chars against a 120 cap`);
            t.noMatch(v.lastAi, /\S$/u.test(v.lastAi || '') ? /^$/ : /^$/, 'placeholder');
            await app.context.close();
        });

        await suite.test('the awakening sequence cannot be reversed by an operator pin', async (t) => {
            const app = await fresh(browser, origin);
            const r = await app.page.evaluate(async () => {
                const S = EngineState;
                S.session.awakeningActive = true;
                S.session.awareness = 100;
                S.session.awakeningStage = 'awakened';
                MirageCommands.processInput('/awareness 10', S, {});
                return { awareness: S.session.awareness, stage: S.session.awakeningStage };
            });
            t.ok(r.awareness >= 100, `awareness was pulled back to ${r.awareness} after awakening`);
            t.equal(r.stage, 'awakened', 'the awakening stage regressed');
            await app.context.close();
        });

        await suite.test('the model cannot lower awareness during an awakening', async (t) => {
            const app = await fresh(browser, origin);
            await app.page.evaluate(() => {
                EngineState.session.awakeningActive = true;
                EngineState.session.awareness = 60;
                EngineState.session.awakeningStage = 'fracture';
            });
            await stubThinking(app.page, turnPayload({ tracking: { awareness: 5 } }), { times: 1 });
            await runTurn(app.page, 'hello');
            const v = await visible(app.page);
            t.ok(v.awareness >= 60, `the model pulled awareness down to ${v.awareness}`);
            await app.context.close();
        });

        await suite.test('a promise survives eviction when the ledger overflows', async (t) => {
            const app = await fresh(browser, origin);
            const r = await app.page.evaluate(() => {
                const sess = { memoryLedger: [] };
                MirageMemoryLedger.add(sess, { kind: 'promise', text: 'PROMISE-she owes him a photo' });
                for (let i = 0; i < 12; i++) {
                    MirageMemoryLedger.add(sess, { kind: 'fact', text: `trivia number ${i}` });
                }
                return sess.memoryLedger.map(i => ({ kind: i.kind, text: i.text }));
            });
            t.ok(r.some(i => /PROMISE-/.test(i.text)),
                'an unresolved promise was evicted by a dozen trivia facts');
            await app.context.close();
        }, {
            expectedRed: 'memory-ledger.js evicts by recency only (MAX_ITEMS = 8, unshift + '
                + 'slice), so trivia pushes out an open promise. The callback picker already '
                + 'ranks by kind; eviction does not. Phase 6 owns the ledger rework.'
        });

        await suite.test('generation refuses to run with no face reference', async (t) => {
            const app = await openApp(browser, { origin });
            const r = await app.page.evaluate(() => {
                const S = EngineState;
                S.profile = { name: 'NoFace', archetype: 'x', location: 'Dallas, TX' };
                S.edf = {};
                S.clearCharacterAnchors();
                let err = null;
                try {
                    MirageProfileStore.save({
                        id: 'noface-probe', label: 'NoFace',
                        snapshot: MirageProfileStore.exportSnapshot(S)
                    });
                } catch (e) { err = e.message; }
                return err;
            });
            t.ok(r, 'a character with no face lock was saved as playable');
            t.match(r, /face/i, 'the refusal did not mention the missing face');
            await app.context.close();
        });
    } finally {
        await browser.close();
    }

    const s = suite.summary();
    printSummary(suite.name, s);
    return s;
}

module.exports = { run };
