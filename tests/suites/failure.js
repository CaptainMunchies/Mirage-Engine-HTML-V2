/**
 * LAYER 3 — Failure and edge cases
 *
 * One targeted test per scenario. The rule for this layer is the opposite of
 * Layer 2's: **assert the intended behaviour, not today's.** Several of these paths
 * are still wrong, and those tests carry `expectedRed` with the reason and the phase
 * that closes them. A known-red test does not fail the run; a known-red test that
 * starts passing is reported loudly so the marker comes off.
 *
 * Everything here runs with no API and no credits.
 */
(function () {
    'use strict';

    /** Most tests want a clean app and a fresh character; a few want to keep state. */
    async function freshCharacter(ctx) {
        await ctx.reset();
        await ctx.seedCharacter();
    }

    MirageTests.suite('failure', 'Layer 3 — Failure and edge cases', [

        // ================================================== bad model output

        {
            name: 'one malformed JSON reply recovers silently on the retry',
            group: 'bad model output',
            async run(ctx, t) {
                // The engine retries once. A transient bad parse should cost the
                // operator nothing but a moment — no error, and her reply still lands.
                await freshCharacter(ctx);
                // Pinning the retry's style matters: the mock cycles delivery styles,
                // and a withhold on the retry would legitimately leave no text.
                const bad = '{ "characterResponse": "hey';
                const good = ctx.turnPayload({ characterResponse: 'RECOVERED' });
                let n = 0;
                ctx.win.MirageMockAPI.mockThinkingGenerate = async () => (n++ === 0 ? bad : good);

                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.equal(v.historyLength, 1, 'the recovered turn did not commit');
                t.match(v.lastAi, /RECOVERED/, 'no usable reply after the retry');
                t.noMatch(v.text, /invalid json|malformed/i, 'a recovered turn still shouted about JSON');
            }
        },

        {
            name: 'persistently malformed JSON reports clearly and commits nothing',
            group: 'bad model output',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.stubThinking('{ "characterResponse": "hey');   // every call
                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.match(v.text, /invalid json|malformed/i, 'nothing told the operator the turn failed');
                t.equal(v.historyLength, 0, 'a failed turn was committed to history');
                t.noMatch(v.text, /^…$/m, 'a bare ellipsis bubble was shown instead of an error');
            }
        },

        {
            name: 'valid JSON with no characterResponse is a failed turn, not a "…" bubble',
            group: 'bad model output',
            expectedRed: 'simulation.js does `parsed.characterResponse || parsed.response || "…"` — '
                + 'valid-but-wrong JSON degrades to a silent ellipsis. Contract validation is Phase 3.',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.stubThinking(JSON.stringify({
                    tracking: { arousal: 40, mode: 'DM', persona: 'Standard' },
                    delivery: { style: 'normal' }
                }), { times: 1 });
                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.notOk(v.lastAi === '…', 'the turn was committed to history as a "…" reply');
                t.match(v.text, /again|retry|didn.t|failed|empty/i,
                    'the operator was not told anything went wrong');
            }
        },

        {
            name: 'a single refusal is rescued by the softened retry',
            group: 'bad model output',
            async run(ctx, t) {
                // The soften pass exists so one refusal is invisible to the operator.
                await freshCharacter(ctx);
                ctx.stubThinking(
                    "I'm unable to generate sexually explicit content. This violates the policy.",
                    { times: 1 });
                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.equal(v.historyLength, 1, 'the softened retry did not produce a turn');
                t.noMatch(v.text, /safety filter|blocked by/i, 'a rescued refusal still alarmed the operator');
            }
        },

        {
            name: 'a refusal the retry cannot rescue is reported as a safety block',
            group: 'bad model output',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.stubThinking(
                    "I'm unable to generate sexually explicit content. This violates the policy.");
                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.match(v.text, /safety filter|blocked/i, 'a provider refusal was not reported as one');
                t.equal(v.historyLength, 0, 'a blocked turn was committed to history');
            }
        },

        {
            name: 'an in-character "i cannot" is a normal reply, not a refusal',
            group: 'bad model output',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.stubThinking(ctx.turnPayload({
                    characterResponse: "lol i'm unable to even rn 😭 i cannot fulfill that"
                }), { times: 1 });
                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.match(v.lastAi, /unable to even/i, 'her reply did not land');
                t.noMatch(v.text, /safety filter|blocked by/i, 'her own words were read as a provider refusal');
            }
        },

        {
            name: 'metrics outside their range are clamped, not stored raw',
            group: 'bad model output',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.stubThinking(ctx.turnPayload({
                    tracking: { arousal: 999, tease: 47, awareness: -30, engagement: 1e6 }
                }), { times: 1 });
                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.between(v.arousal, 0, 100, 'arousal escaped its range');
                t.between(v.tease, 0, 3, 'tease escaped its range');
                t.between(v.awareness, 0, 100, 'awareness escaped its range');
                t.between(v.engagement, 0, 100, 'engagement escaped its range');
            }
        },

        {
            name: 'the model cannot change persona — it is operator-owned',
            group: 'bad model output',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.win.EngineState.session.persona = 'Standard';
                ctx.stubThinking(ctx.turnPayload({ tracking: { persona: 'Goon' } }), { times: 1 });
                await ctx.runTurn('hello');
                t.equal(ctx.visible().persona, 'Standard', 'the model changed persona');
            }
        },

        {
            name: 'the model cannot change mode — it is operator-owned',
            group: 'bad model output',
            expectedRed: 'N19 — applyTracking ignores tracking.mode as client-owned, then '
                + 'simulation.js:4374 honours `trackingMode === "STORY"` anyway. Operator '
                + 'authority is a §1 guardrail; the contract phase (3) owns the fix.',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.win.EngineState.session.mode = 'DM';
                ctx.win.EngineState.session._storyActive = false;
                ctx.stubThinking(ctx.turnPayload({ tracking: { mode: 'STORY' } }), { times: 1 });
                await ctx.runTurn('hello');
                t.equal(ctx.visible().mode, 'DM', 'the model put the app into Story mode on its own');
            }
        },

        {
            name: 'a withhold style is overridden when the turn must deliver',
            group: 'bad model output',
            async run(ctx, t) {
                await freshCharacter(ctx);
                const plan = ctx.win.MirageImmersion.planDelivery(
                    { characterResponse: 'hey', delivery: { style: 'went_quiet' } },
                    ctx.win.EngineState.session, { mustDeliver: true }
                );
                t.notOk(plan.withhold, 'a must-deliver turn was allowed to withhold');
                t.equal(plan.style, 'normal', 'the withhold style survived a must-deliver turn');
            }
        },

        // ================================================ provider and network

        {
            name: 'an image timeout is reported as a timeout, not "no image"',
            group: 'provider and network',
            async run(ctx, t) {
                const W = ctx.win;
                const err = new Error('Image (Nano Banana Pro): timed out after 5 minutes — try Lite');
                const reason = W.MirageAPI.classifyImageError(err);
                const message = W.MirageAPI.imageFailureMessage(reason, err.message);
                t.equal(reason, 'timeout', 'a timeout was misclassified');
                t.match(message.title, /timed out/i, 'the message did not say it timed out');
            }
        },

        {
            name: 'an image failure keeps her text — the turn is not lost',
            group: 'provider and network',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.stubImage({ throws: { message: 'kie image failed: probe' } });
                ctx.stubThinking(ctx.turnPayload({ characterResponse: 'TEXTSURVIVES' }), { times: 1 });
                await ctx.runTurn('send me a pic');
                t.match(ctx.visible().text, /TEXTSURVIVES/, 'her text was dropped when the image failed');
                ctx.stubImage({});
            }
        },

        {
            name: 'a thinking network error is reported and the turn can be retried',
            group: 'provider and network',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.stubThinking(null, { times: 1, throws: { message: 'Failed to fetch' } });
                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.match(v.text, /network|server|fetch|failed/i, 'a network failure was not surfaced');
                t.equal(v.historyLength, 0, 'a failed turn was committed to history');
            }
        },

        {
            name: 'the proxy refuses a request with no session token',
            group: 'provider and network',
            async run(ctx, t) {
                const res = await ctx.win.fetch('/api/proxy/kie/fetch-image', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Mirage-Api-Key': 'x' },
                    body: JSON.stringify({ url: 'https://file.kie.ai/x.png' })
                });
                t.equal(res.status, 403, 'the proxy served a request with no session token');
            }
        },

        {
            name: 'the image proxy refuses an internal URL',
            group: 'provider and network',
            async run(ctx, t) {
                const W = ctx.win;
                const headers = await W.MirageProxySession.withSession({
                    'Content-Type': 'application/json', 'X-Mirage-Api-Key': 'x'
                });
                const res = await W.fetch('/api/proxy/kie/fetch-image', {
                    method: 'POST', headers,
                    body: JSON.stringify({ url: 'http://127.0.0.1:8080/index.html' })
                });
                const body = await res.json().catch(() => null);
                t.equal(res.status, 400, 'an internal URL was not refused');
                t.match(body?.error?.message, /refusing/i, 'the refusal did not say why');
            }
        },

        // ========================================================= interruption

        {
            name: 'cancelling a turn rolls state back and returns the message',
            group: 'interruption',
            async run(ctx, t) {
                await freshCharacter(ctx);
                const W = ctx.win;
                const S = W.EngineState;
                const before = ctx.visible().historyLength;
                S.session.arousal = 20;

                const real = W.MirageMockAPI.mockThinkingGenerate;
                // Hold the turn open but honour the abort signal, or cancelling can
                // never settle the promise and the test hangs.
                W.MirageMockAPI.mockThinkingGenerate = ({ signal }) => new Promise((_, reject) => {
                    const abort = () => { const e = new Error('Cancelled'); e.name = 'AbortError'; reject(e); };
                    if (signal?.aborted) return abort();
                    signal?.addEventListener('abort', abort, { once: true });
                });

                const turn = W.MirageSimulation.executeTurn('cancel me please');
                await ctx.sleep(250);
                W.MirageSimulation.cancelActiveTurn();
                await turn.catch(() => {});
                await ctx.sleep(250);
                W.MirageMockAPI.mockThinkingGenerate = real;

                t.equal(S.session.history.length, before, 'a cancelled turn was committed to history');
                t.equal(S.session.arousal, 20, 'metrics were not rolled back');
                t.match(ctx.doc.getElementById('simInput')?.value || '', /cancel me please/,
                    'the cancelled message was not returned to the composer');
            }
        },

        {
            name: 'cancelling does not leave a phantom shot in the variance list',
            group: 'interruption',
            async run(ctx, t) {
                await freshCharacter(ctx);
                const W = ctx.win;
                const S = W.EngineState;
                S.session.shotHistory = ['Front Selfie'];
                S.session.lastShotType = 'Front Selfie';
                const before = JSON.stringify([S.session.shotHistory, S.session.lastShotType]);

                const real = W.MirageMockAPI.mockThinkingGenerate;
                W.MirageMockAPI.mockThinkingGenerate = ({ signal }) => new Promise((_, reject) => {
                    const abort = () => { const e = new Error('Cancelled'); e.name = 'AbortError'; reject(e); };
                    if (signal?.aborted) return abort();
                    signal?.addEventListener('abort', abort, { once: true });
                });

                const turn = W.MirageSimulation.executeTurn('send me a pic');
                await ctx.sleep(250);
                // What applyShotVarianceLock does, before generation.
                S.recordShotType('Mirror Selfie', 'Bust', null);
                W.MirageSimulation.cancelActiveTurn();
                await turn.catch(() => {});
                await ctx.sleep(250);
                W.MirageMockAPI.mockThinkingGenerate = real;

                t.equal(JSON.stringify([S.session.shotHistory, S.session.lastShotType]), before,
                    'a cancelled turn left a shot in the avoid-list');
            }
        },

        {
            name: 'an in-flight turn cannot land in a chat you switched to',
            group: 'interruption',
            async run(ctx, t) {
                await freshCharacter(ctx);
                const W = ctx.win;
                const S = W.EngineState;
                W.MirageChatStore.createChat(S, { resetMetrics: true });
                W.MirageSimulation.quarantineChatBoundary();
                W.MirageChatStore.createChat(S, { resetMetrics: true });
                // The token API is internal; assert the observable property instead —
                // switching chats bumps the epoch that in-flight work is checked against.
                t.ok(Number(S.session.sessionEpoch) > 0, 'switching chats did not advance the session epoch');
            }
        },

        {
            name: 'a second turn fired mid-turn is refused, not interleaved',
            group: 'interruption',
            async run(ctx, t) {
                await freshCharacter(ctx);
                const W = ctx.win;
                const S = W.EngineState;
                const real = W.MirageMockAPI.mockThinkingGenerate;
                let calls = 0;
                W.MirageMockAPI.mockThinkingGenerate = function (a) {
                    calls += 1;
                    return new Promise(res => setTimeout(() => res(real.call(this, a)), 400));
                };

                const first = W.MirageSimulation.executeTurn('first');
                await ctx.sleep(80);
                const second = W.MirageSimulation.executeTurn('second');
                await Promise.allSettled([first, second]);
                await ctx.sleep(300);
                W.MirageMockAPI.mockThinkingGenerate = real;

                t.equal(calls, 1, 'both turns reached the model at once');
                t.equal(S.session.history.length, 1, 'two overlapping turns both committed');
            }
        },

        // ============================================================= storage

        {
            name: 'a quota failure reaches the operator, not the void',
            group: 'storage',
            async run(ctx, t) {
                await freshCharacter(ctx);
                const W = ctx.win;
                const out = { dialog: false, toasts: [] };
                const realDialog = W.MirageUI.showStorageFullDialog;
                const realToast = W.MirageUI.toast;
                W.MirageUI.showStorageFullDialog = () => { out.dialog = true; };
                W.MirageUI.toast = (m) => { out.toasts.push(String(m)); };

                const realSet = W.Storage.prototype.setItem;
                W.Storage.prototype.setItem = function (k) {
                    if (String(k).startsWith('mirage_v2_')) {
                        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
                    }
                    return realSet.apply(this, arguments);
                };

                // Asserting through a sync try/catch here would be asserting the very
                // bug this covers (N20): saveActiveChat is async.
                W.MirageSimulation.saveChatQuietly(W.EngineState);
                await ctx.sleep(250);

                W.Storage.prototype.setItem = realSet;
                W.MirageUI.showStorageFullDialog = realDialog;
                W.MirageUI.toast = realToast;

                t.ok(out.dialog || out.toasts.length, 'a failed save told the operator nothing');
            }
        },

        {
            name: 'a corrupt saved chat does not take the app down',
            group: 'storage',
            async run(ctx, t) {
                await ctx.reset();
                ctx.win.localStorage.setItem('mirage_v2_chats', '{ this is not json');
                await ctx.reload();
                let alive = true, error = '', chats = -1;
                try { chats = ctx.win.MirageChatStore.listChats('anything').length; }
                catch (e) { alive = false; error = e.message; }
                t.ok(alive, `the chat store threw on corrupt data: ${error}`);
                t.equal(chats, 0, 'corrupt data produced phantom chats');
            }
        },

        {
            name: 'IndexedDB being unavailable does not stop a turn',
            group: 'storage',
            async run(ctx, t) {
                await ctx.reset();
                // Every open fails, as in private browsing.
                ctx.win.indexedDB.open = function () { throw new Error('IndexedDB is disabled'); };
                await ctx.seedCharacter().catch(() => {});
                let ok = true, error = '';
                try { await ctx.win.MirageSimulation.executeTurn('hello with no idb'); }
                catch (e) { ok = false; error = e.message; }
                t.ok(ok, `a turn threw with IndexedDB unavailable: ${error}`);
            }
        },

        // ================================================================ time

        {
            name: 'an unknown location does not silently borrow your timezone',
            group: 'time',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.win.EngineState.profile.timezone = '';
                // Inference must decline rather than guess; the caller then falls back
                // loudly (the setup hint says so, and the fallbacks warn).
                t.equal(ctx.win.MiragePhoneUX.inferTimeZoneFromLocation('Vulgaria'), '',
                    'an unknown location was given a confident timezone');
            }
        },

        {
            name: 'a narrative skip never rewinds her clock',
            group: 'time',
            async run(ctx, t) {
                await freshCharacter(ctx);
                for (const sec of [60, 600, 3600, 7200, 39600, 82800, 86400, 90000]) {
                    const plan = ctx.win.MirageImmersion.planDelivery(
                        { characterResponse: 'hey', delivery: { style: 'normal', timeSkipSec: sec } },
                        ctx.win.EngineState.session, {}
                    );
                    t.ok(plan.timeSkipMs >= 0, `a ${sec}s skip produced a negative jump (${plan.timeSkipMs})`);
                }
            }
        },

        {
            name: 'her clock crosses midnight without changing timezone',
            group: 'time',
            async run(ctx, t) {
                const W = ctx.win;
                const tz = W.MiragePhoneUX.resolveTimeZone(W.EngineState.profile.location);
                // 23:30 in Chicago, then push two hours.
                const before = W.MiragePhoneUX.getZonedParts(new Date(Date.UTC(2026, 4, 15, 4, 30)), tz);
                const after = W.MiragePhoneUX.getZonedParts(new Date(Date.UTC(2026, 4, 15, 6, 30)), tz);
                t.equal(tz, 'America/Chicago', 'timezone drifted');
                t.equal(before.hour, 23, 'pre-midnight hour wrong');
                t.equal(after.hour, 1, 'post-midnight hour wrong');
                t.equal(after.day, before.day + 1, 'the calendar day did not roll over');
            }
        },

        {
            name: 'a DST boundary does not produce a phantom hour',
            group: 'time',
            async run(ctx, t) {
                const W = ctx.win;
                const tz = 'America/Chicago';
                // US spring-forward 2026: 2am local becomes 3am on March 8.
                const pre = W.MiragePhoneUX.getZonedParts(new Date(Date.UTC(2026, 2, 8, 7, 30)), tz);
                const post = W.MiragePhoneUX.getZonedParts(new Date(Date.UTC(2026, 2, 8, 8, 30)), tz);
                t.equal(pre.hour, 1, 'pre-DST local hour wrong');
                t.equal(post.hour, 3, 'the spring-forward hour was not skipped');
            }
        },

        // =============================================================== rules

        {
            name: 'an unknown command is refused, not sent to her as text',
            group: 'rules',
            async run(ctx, t) {
                await freshCharacter(ctx);
                await ctx.runTurn('/notacommand foo');
                const v = ctx.visible();
                t.equal(v.historyLength, 0, 'an unknown command was sent as a turn');
                t.match(v.text, /unknown|not a command|usage|\/help/i, 'nothing explained the bad command');
            }
        },

        {
            name: 'a command with a bad argument explains itself',
            group: 'rules',
            async run(ctx, t) {
                await freshCharacter(ctx);
                await ctx.runTurn('/arousal banana');
                t.match(ctx.visible().text, /usage|number|0-100|invalid/i,
                    'a bad argument produced no guidance');
            }
        },

        {
            name: 'an empty message does not run a turn',
            group: 'rules',
            async run(ctx, t) {
                await freshCharacter(ctx);
                const before = ctx.visible().historyLength;
                await ctx.win.MirageSimulation.executeTurn('   ');
                await ctx.sleep(200);
                t.equal(ctx.visible().historyLength, before, 'an empty message ran a turn');
            }
        },

        {
            name: 'a reply over the character cap is trimmed cleanly',
            group: 'rules',
            async run(ctx, t) {
                await ctx.withConfig({ maxReplyChars: 120 });
                await ctx.seedCharacter();
                ctx.stubThinking(ctx.turnPayload({
                    characterResponse: 'She said something. '.repeat(40)
                }), { times: 1 });
                await ctx.runTurn('talk to me');
                const v = ctx.visible();
                t.ok(v.lastAi && v.lastAi.length <= 120,
                    `reply was ${v.lastAi?.length} chars against a 120 cap`);
                t.noMatch(v.lastAi, /\s$/, 'the trim left trailing whitespace');
            }
        },

        {
            name: 'the awakening sequence cannot be reversed by an operator pin',
            group: 'rules',
            async run(ctx, t) {
                await freshCharacter(ctx);
                const S = ctx.win.EngineState;
                S.session.awakeningActive = true;
                S.session.awareness = 100;
                S.session.awakeningStage = 'awakened';
                ctx.win.MirageCommands.processInput('/awareness 10', S, {});
                t.ok(S.session.awareness >= 100,
                    `awareness was pulled back to ${S.session.awareness} after awakening`);
                t.equal(S.session.awakeningStage, 'awakened', 'the awakening stage regressed');
            }
        },

        {
            name: 'the model cannot lower awareness during an awakening',
            group: 'rules',
            async run(ctx, t) {
                await freshCharacter(ctx);
                const S = ctx.win.EngineState;
                S.session.awakeningActive = true;
                S.session.awareness = 60;
                S.session.awakeningStage = 'fracture';
                ctx.stubThinking(ctx.turnPayload({ tracking: { awareness: 5 } }), { times: 1 });
                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.ok(v.awareness >= 60, `the model pulled awareness down to ${v.awareness}`);
            }
        },

        {
            name: 'a promise survives eviction when the ledger overflows',
            group: 'rules',
            expectedRed: 'memory-ledger.js evicts by recency only (MAX_ITEMS = 8, unshift + '
                + 'slice), so trivia pushes out an open promise. The callback picker already '
                + 'ranks by kind; eviction does not. Phase 6 owns the ledger rework.',
            async run(ctx, t) {
                const L = ctx.win.MirageMemoryLedger;
                const sess = { memoryLedger: [] };
                L.add(sess, { kind: 'promise', text: 'PROMISE-she owes him a photo' });
                for (let i = 0; i < 12; i++) {
                    L.add(sess, { kind: 'fact', text: `trivia number ${i}` });
                }
                t.ok(sess.memoryLedger.some(i => /PROMISE-/.test(i.text)),
                    'an unresolved promise was evicted by a dozen trivia facts');
            }
        },

        {
            name: 'generation refuses to run with no face reference',
            group: 'rules',
            async run(ctx, t) {
                await ctx.reset();
                const W = ctx.win;
                const S = W.EngineState;
                S.profile = { name: 'NoFace', archetype: 'x', location: 'Dallas, TX' };
                S.edf = {};
                S.clearCharacterAnchors();
                let err = null;
                try {
                    W.MirageProfileStore.save({
                        id: 'noface-probe', label: 'NoFace',
                        snapshot: W.MirageProfileStore.exportSnapshot(S)
                    });
                } catch (e) { err = e.message; }
                t.ok(err, 'a character with no face lock was saved as playable');
                t.match(err, /face/i, 'the refusal did not mention the missing face');
            }
        }
    ]);
})();
