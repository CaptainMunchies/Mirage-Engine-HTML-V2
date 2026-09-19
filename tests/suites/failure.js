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
            name: 'a reply with no characterResponse recovers on the retry',
            group: 'bad model output',
            async run(ctx, t) {
                // Valid JSON that forgot the one field the turn is *for*. It used
                // to fall through to `|| '…'` and commit a silent ellipsis as
                // though she had spoken; it now fails the contract check and takes
                // the same retry a parse failure takes. One miss should cost the
                // operator nothing.
                await freshCharacter(ctx);
                const bad = JSON.stringify({
                    tracking: { arousal: 40, mode: 'DM', persona: 'Standard' },
                    delivery: { style: 'normal' }
                });
                const good = ctx.turnPayload({ characterResponse: 'RECOVERED' });
                let n = 0;
                ctx.win.MirageMockAPI.mockThinkingGenerate = async () => (n++ === 0 ? bad : good);

                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.equal(n, 2, 'the contract miss did not trigger a retry');
                t.equal(v.historyLength, 1, 'the recovered turn did not commit');
                t.match(v.lastAi, /RECOVERED/, 'no usable reply after the retry');
                t.notOk(v.lastAi === '…', 'the turn was committed as a "…" reply');
            }
        },

        {
            name: 'a reply that keeps breaking the contract is reported, not committed',
            group: 'bad model output',
            async run(ctx, t) {
                await freshCharacter(ctx);
                ctx.stubThinking(JSON.stringify({
                    tracking: { arousal: 40, mode: 'DM', persona: 'Standard' },
                    delivery: { style: 'normal' }
                }));   // every call
                await ctx.runTurn('hello');
                const v = ctx.visible();
                t.equal(v.historyLength, 0, 'a turn with no reply text was committed to history');
                t.notOk(v.lastAi === '…', 'a bare ellipsis was committed instead of failing');
                t.match(v.text, /contract|again|retry|didn.t|failed|empty|incomplete/i,
                    'the operator was not told the turn failed');
            }
        },

        {
            name: 'a tracking number sent as prose is refused, not coerced',
            group: 'bad model output',
            async run(ctx, t) {
                // NaN from a string used to land as whatever the clamp floor is,
                // which reads as the model having decided something it never said.
                await freshCharacter(ctx);
                const bad = ctx.turnPayload({ tracking: { arousal: 'very high' } });
                const good = ctx.turnPayload({ characterResponse: 'RECOVERED' });
                let n = 0;
                ctx.win.MirageMockAPI.mockThinkingGenerate = async () => (n++ === 0 ? bad : good);

                await ctx.runTurn('hello');
                t.equal(n, 2, 'a non-numeric metric was accepted without a retry');
                t.between(ctx.visible().arousal, 0, 100, 'arousal escaped its range');
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
            name: 'the model\'s read of his message drives the locks',
            group: 'bad model output',
            async run(ctx, t) {
                // The keyword matchers are gone; `interpretation` is the only
                // signal the client gets about what he asked for.
                await freshCharacter(ctx);
                ctx.win.EngineState.session.persona = 'Goon';
                ctx.stubThinking(ctx.turnPayload({
                    characterResponse: 'ok',
                    interpretation: {
                        wardrobeChange: 'red kimono',
                        placeChange: 'the kitchen',
                        subjectRequest: 'feet',
                        cameraRequest: 'closeup'
                    }
                }), { times: 1 });
                // The locks are per-turn and cleared once the turn settles, so read
                // them while the turn is live — from the decision log the engine
                // writes as it applies them.
                const seen = [];
                ctx.win.MirageDebugPanel.pushDecision = ((real) => function (evt) {
                    seen.push(evt);
                    return real?.apply(this, arguments);
                })(ctx.win.MirageDebugPanel.pushDecision);

                await ctx.runTurn('anything at all, in any language');

                const read = seen.find(e => /read an ask/i.test(String(e?.summary || '')));
                t.ok(read, 'the model reported asks and the client applied none of them');
                if (read) {
                    t.equal(read.detail.subject, 'feet', 'a reported feet ask did not lock');
                    t.equal(read.detail.camera, 'closeup', 'a reported closeup did not reach the lock');
                    t.equal(read.detail.wardrobe, 'red kimono', 'a reported wardrobe change was dropped');
                    t.equal(read.detail.place, 'the kitchen', 'a reported place change was dropped');
                }
            }
        },

        {
            name: 'a slash command outranks whatever the model reports',
            group: 'bad model output',
            async run(ctx, t) {
                // Operator authority again: a typed command is unambiguous and must
                // never depend on the model agreeing about what it meant.
                await freshCharacter(ctx);
                ctx.win.EngineState.session.persona = 'Goon';
                ctx.stubThinking(ctx.turnPayload({
                    characterResponse: 'ok',
                    interpretation: {
                        wardrobeChange: null, placeChange: null,
                        subjectRequest: 'feet', cameraRequest: 'closeup'
                    }
                }), { times: 1 });
                await ctx.runTurn('/fit check');

                const sess = ctx.win.EngineState.session;
                t.notOk(sess._subjectLockThisTurn === 'feet',
                    'the model overrode a slash command');
            }
        },

        {
            name: 'a missing or malformed interpretation does not break the turn',
            group: 'bad model output',
            async run(ctx, t) {
                // Older prompts, or a model that ignores the block. The turn must
                // still land — this field steers, it is not required.
                await freshCharacter(ctx);
                ctx.stubThinking(ctx.turnPayload({
                    characterResponse: 'NOINTERP', interpretation: 'not an object'
                }), { times: 1 });
                await ctx.runTurn('hey');
                t.match(ctx.visible().lastAi, /NOINTERP/, 'a malformed interpretation lost the turn');
            }
        },

        {
            name: 'the operator can still put her into Story mode',
            group: 'bad model output',
            async run(ctx, t) {
                // The counter-test to the one above. Blocking the model from
                // setting mode must not block the operator from setting it — the
                // point is authority, not that Story mode becomes unreachable.
                await freshCharacter(ctx);
                ctx.stubThinking(ctx.turnPayload({ characterResponse: 'story time' }), { times: 1 });
                await ctx.runTurn('/story');
                t.equal(ctx.visible().mode, 'STORY',
                    'the operator asked for a Story and did not get one');
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
            name: 'a stopped image is not reported as a timeout',
            group: 'provider and network',
            async run(ctx, t) {
                // The kie image path does not wrap its aborts, so the browser's own
                // AbortError reaches the classifier. Its text is browser-specific and
                // both spellings contain "abort", which the timeout regex claimed —
                // so a cancelled or superseded request was reported to the operator
                // as a five-minute stall that never happened.
                const W = ctx.win;
                for (const raw of ['The operation was aborted.', 'The user aborted a request.', 'Cancelled']) {
                    const reason = W.MirageAPI.classifyImageError(new Error(raw));
                    const message = W.MirageAPI.imageFailureMessage(reason, raw);
                    t.equal(reason, 'cancelled', `"${raw}" was not classified as a stop`);
                    t.noMatch(message.title, /timed out/i, `"${raw}" was reported as a timeout`);
                }
            }
        },

        {
            name: 'a withheld turn is recorded as fully as a delivered one',
            group: 'bad model output',
            async run(ctx, t) {
                // Being left on read is a delivered outcome, not a skipped turn. It
                // used to be committed with no debug block and no tracking, so the
                // troubleshoot report had nothing to diff against and claimed every
                // setting had changed — on this turn and again on the next one.
                await freshCharacter(ctx);
                const W = ctx.win;
                const S = W.EngineState;
                ctx.stubThinking(ctx.turnPayload({ characterResponse: 'not sending this' }), { times: 1 });

                // `delivery.style` only biases a weighted roll, so asking the payload
                // for a withhold cannot force one. Drive the branch at its seam.
                const realChoreograph = W.MirageImmersion.choreograph;
                W.MirageImmersion.choreograph = async () => ({ leftOnRead: true });
                try {
                    await ctx.runTurn('ok whatever then');
                } finally {
                    W.MirageImmersion.choreograph = realChoreograph;
                }

                const last = S.session.history[S.session.history.length - 1];
                t.ok(last, 'the withheld turn was not committed to history at all');
                t.equal(last.ai, '', 'this test needs the turn to actually withhold');
                t.ok(last.debug && typeof last.debug === 'object',
                    'a withheld turn carries no settings record');
                t.ok(last.debug.thinkingModel,
                    'the withheld turn recorded no thinking model, so the report reads it as a change');
                t.ok(last.debug.apiProvider,
                    'the withheld turn recorded no provider');
            }
        },

        {
            name: 'a thinking timeout is not reported as an image problem',
            group: 'provider and network',
            async run(ctx, t) {
                // The failure that motivated this: the thinking model stalled, the
                // proxy cut it off, and the operator was told to use "Retry face /
                // Retry Last Image" on a turn where no image was ever requested.
                const W = ctx.win;

                const tagged = new Error('Thinking timed out after 90s — the model never answered.');
                tagged.code = 'THINKING_TIMEOUT';
                tagged.modelId = 'gemini-3.7-flash';
                const seen = W.MirageErrors.describeTurnError(tagged);
                t.match(seen.chat, /thinking model/i, 'the message did not name the thinking model');
                t.noMatch(seen.chat, /retry last image/i, 'thinking advice offered an image retry');
                t.noMatch(seen.toast, /retry face/i, 'the toast offered an image retry');

                // The proxy can still win the race on a path we do not time out
                // ourselves; its message names the call, and that has to be enough.
                const fromProxy = new Error('kie thinking (Gemini 3.7 Flash): Proxy error: The read operation timed out');
                const relayed = W.MirageErrors.describeTurnError(fromProxy);
                t.noMatch(relayed.chat, /retry last image/i, 'a proxy-side thinking timeout got image advice');

                // …and a real image timeout must keep the image advice.
                const image = new Error('Image model (Nano Banana 2 Lite): timed out after 5 minutes');
                const shot = W.MirageErrors.describeTurnError(image);
                t.match(shot.chat, /retry last image/i, 'an image timeout lost its image advice');
            }
        },

        {
            name: 'the browser gives up on thinking before the proxy does',
            group: 'provider and network',
            async run(ctx, t) {
                // The whole reason the client owns a thinking deadline is to win the
                // race against the proxy's own read timeout: whoever gives up first
                // writes the error, and only this side knows it was thinking that
                // stalled rather than an image. Raise this constant past the proxy's
                // and the bug comes straight back with every other test still green.
                //
                // The suite runs against the real mirage_server.py, so read the number
                // out of the source instead of copying it here and letting the two
                // drift.
                const W = ctx.win;
                const src = await (await W.fetch('/mirage_server.py')).text();
                const m = src.match(/_kie_chat\b[\s\S]*?_forward\(req,\s*timeout=(\d+)\)/);
                t.ok(m, 'could not find the kie chat route timeout in mirage_server.py');
                const proxyMs = Number(m[1]) * 1000;

                t.ok(W.MirageAPI.THINKING_TIMEOUT_MS > 0, 'the thinking deadline is disabled');
                t.ok(W.MirageAPI.THINKING_TIMEOUT_MS < proxyMs,
                    `the thinking deadline (${W.MirageAPI.THINKING_TIMEOUT_MS}ms) is not under `
                    + `the proxy's (${proxyMs}ms), so the proxy writes the error again`);
            }
        },

        {
            name: 'a timeout keeps its message instead of becoming a cancel',
            group: 'provider and network',
            async run(ctx, t) {
                // A deadline we set and a Cancel the operator pressed arrive as the
                // same AbortError. Treating every one as a cancel silently ate the
                // caller's message: the 5-minute image timeout built its copy, handed
                // it in as `context`, and got back a bare "Turn cancelled" — so a real
                // timeout ended the turn with nothing shown at all.
                const W = ctx.win;
                const abortErr = () => Object.assign(
                    new Error('The operation was aborted.'), { name: 'AbortError' }
                );

                const cancelled = W.MirageAPI.wrapFetchError(abortErr(), 'Image model (X)');
                t.equal(cancelled.code, 'CANCELLED', 'a plain abort stopped reading as a cancel');

                const timedOut = W.MirageAPI.wrapFetchError(
                    abortErr(), 'Image model (X): timed out after 5 minutes', { timedOut: true }
                );
                t.notOk(timedOut.code, 'a timeout was still tagged as a cancelled turn');
                t.match(timedOut.message, /timed out after 5 minutes/,
                    'the timeout message was discarded');
            }
        },

        {
            name: 'error copy follows the provider it was told about',
            group: 'provider and network',
            async run(ctx, t) {
                // errors.js used to read EngineState.apiProvider itself. Now the caller
                // passes it, which is what moved this file behind the wall — and a
                // silent fall back to the default would send a kie user looking for
                // models their dropdown does not have.
                const W = ctx.win;
                const safety = () => Object.assign(new Error('blocked'), { code: 'SAFETY' });

                const kie = W.MirageErrors.describeTurnError(safety(), { provider: 'kie' });
                t.match(kie.chat, /Settings → Thinking = Grok/, 'the kie tip did not follow the argument');

                const google = W.MirageErrors.describeTurnError(safety(), { provider: 'google' });
                t.match(google.chat, /Switch Settings → Provider to kie\.ai/, 'the google tip did not follow the argument');

                // Called with nothing, it must still produce usable copy rather than
                // throwing on a missing options object.
                const bare = W.MirageErrors.describeTurnError(safety());
                t.ok(bare && bare.chat, 'describeTurnError threw without options');
            }
        },

        {
            name: 'the default input budget leaves room for conversation history',
            group: 'provider and network',
            async run(ctx, t) {
                // A budget under the system instruction is not a budget: fitInputBudget
                // never trims the instruction, so the whole cap comes out of history and
                // the conversation silently goes to zero. 4500 did exactly that.
                await freshCharacter(ctx);
                const W = ctx.win;
                const P = W.MiragePrompt;

                const budget = Number(W.EngineState.maxThinkingInputTokens);
                t.ok(budget > 0, 'the default budget should not be unlimited');

                // The setting is the ceiling. It used to be rounded to its density
                // band, which made 6000 behave identically to 8000.
                t.equal(P.resolveInputPack(6000).tokens, 6000, 'the budget was rounded to a band');
                t.equal(P.resolveInputPack(12000).tokens, 12000, 'the budget was rounded to a band');

                // The band boundary is the load-bearing half of that change. Full
                // wording costs ~7k tokens on its own, so promoting the default to
                // full would spend the whole raise on prompt prose and leave less
                // room for history than 4500 did.
                t.equal(P.resolveInputPack(6000).density, 'medium',
                    'the default budget was promoted to full-density wording');
                t.equal(P.resolveInputPack(8000).density, 'full',
                    'the top presets lost full-density wording');

                const sys = P.buildThinkingSystemInstruction('turn', W.EngineState.getRuntimeContext());
                const sysTokens = P.estimateTokens(sys);
                t.ok(
                    sysTokens < budget,
                    `the system instruction (~${sysTokens} tok) does not fit the default budget (${budget})`
                );

                // Not just "fits" — fits with usable room left over, or history is
                // still the thing that gets sacrificed.
                t.ok(
                    budget - sysTokens >= 500,
                    `only ~${budget - sysTokens} tok left for history after the system instruction`
                );
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
            name: 'a refresh mid-thinking gives you your message back',
            group: 'interruption',
            async run(ctx, t) {
                // pending-turn.js exists for exactly this and had no coverage at
                // all. A turn saves a marker before it calls the model; a refresh
                // during thinking must discard the turn, say so, and return the
                // text to the composer rather than swallowing it.
                await freshCharacter(ctx);
                const W = ctx.win;
                W.MiragePendingTurn.save({
                    charKey: W.MirageChatStore.characterKey(W.EngineState),
                    chatId: W.EngineState.session.activeChatId,
                    text: 'the message I lost to a refresh',
                    internal: false,
                    stage: 'thinking'
                });
                t.ok(W.MiragePendingTurn.load(), 'the pending marker was not written');
                // What the app records so a refresh comes back to this chat. Without
                // it the reload lands in setup and never reaches the recovery path.
                W.EngineState.session.setupStep = 6;
                W.EngineState.markUiResume();

                await ctx.reload();
                await ctx.sleep(400);

                t.equal(ctx.doc.getElementById('simInput')?.value || '',
                    'the message I lost to a refresh',
                    'the interrupted message was not returned to the composer');
                // Read the rendered toast, not the intercepted one: this notice
                // fires during boot, before anything in the parent can wrap
                // MirageUI.toast, so watchToasts would never see it.
                t.match(ctx.doc.body.textContent || '', /interrupted|discarded|restored/i,
                    'nothing told the operator the turn had been interrupted');
                t.notOk(ctx.win.MiragePendingTurn.load(),
                    'the pending marker survived the recovery and will fire again');
            }
        },

        {
            name: 'a refresh mid-image offers to finish the turn you already paid for',
            group: 'interruption',
            async run(ctx, t) {
                // N22. The reply exists and was paid for; only the photo is
                // missing. Offered rather than resumed automatically, because
                // finishing generates an image and spending credits because a page
                // reloaded is not the app's call to make.
                await freshCharacter(ctx);
                const W = ctx.win;
                W.MiragePendingTurn.save({
                    charKey: W.MirageChatStore.characterKey(W.EngineState),
                    chatId: W.EngineState.session.activeChatId,
                    text: 'send me a pic',
                    characterText: 'ALREADYPAIDFOR',
                    parsed: JSON.parse(ctx.turnPayload({ characterResponse: 'ALREADYPAIDFOR' })),
                    wantImage: true,
                    internal: false,
                    stage: 'image'
                });
                W.EngineState.session.setupStep = 6;
                W.EngineState.markUiResume();

                await ctx.reload();
                await ctx.sleep(600);

                const modal = ctx.doc.getElementById('resumeTurnModal');
                t.ok(modal && !modal.hidden, 'no offer to finish the interrupted turn');
                t.match(ctx.doc.getElementById('resumeTurnPreview')?.textContent || '',
                    /ALREADYPAIDFOR/, 'the offer did not show what she had already written');

                // The marker must survive an unanswered offer — binning paid work
                // because the dialog was dismissed is the bug, not the fix.
                t.ok(ctx.win.MiragePendingTurn.load(),
                    'the pending turn was cleared before the operator answered');

                ctx.doc.getElementById('btnResumeTurnDiscard')?.click();
                await ctx.sleep(200);
                t.notOk(ctx.win.MiragePendingTurn.load(), 'discarding left the marker behind');
                t.equal(ctx.doc.getElementById('simInput')?.value || '', 'send me a pic',
                    'discarding did not return the message to the composer');
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
            name: 'the character cap guides her, it never cuts her',
            group: 'rules',
            async run(ctx, t) {
                // The cap is prompt guidance and nothing else. A trim here could only
                // ever run after the reply was written and paid for, so the one thing
                // it could do with an overshoot was delete the end of a sentence the
                // operator had already been charged for.
                await ctx.withConfig({ maxReplyChars: 120 });
                await ctx.seedCharacter();
                const W = ctx.win;

                // The guidance half still has to be in the prompt, or nothing is
                // steering the length at all.
                const sys = W.MiragePrompt.buildThinkingSystemInstruction(
                    'turn', W.EngineState.getRuntimeContext()
                );
                t.match(sys, /LENGTH CAP/, 'the length instruction is missing from the prompt');
                t.match(sys, /120/, 'the prompt did not tell the model the operator’s number');

                ctx.stubThinking(ctx.turnPayload({
                    characterResponse: 'She said something. '.repeat(40)
                }), { times: 1 });
                await ctx.runTurn('talk to me');

                const v = ctx.visible();
                t.ok(v.lastAi && v.lastAi.length > 120,
                    `an over-long reply was truncated to ${v.lastAi?.length} chars`);
                t.match(v.lastAi, /She said something\.\s*$/,
                    'the tail of the reply was cut off');
            }
        },

        {
            name: 'the HUD says what the session says, through the view',
            group: 'rules',
            async run(ctx, t) {
                // Nothing guarded this before the extraction: the Layer 2 baselines
                // record behaviour and text, and they carry no HUD fields at all — I
                // checked rather than assumed, having already been wrong about that
                // once with the chat view's class names.
                // Reset first, then capture the window: ctx.reset() reboots the
                // sandbox, so a `ctx.win` grabbed before it points at a torn-down
                // frame whose localStorage is already null.
                await freshCharacter(ctx);
                const W = ctx.win;
                const H = W.MirageHudView;

                // The formatter itself.
                const pure = H.hudView({
                    persona: 'Goon', mode: 'STORY', arousal: 58, tease: 3,
                    awareness: 70, awakeningActive: true, awakeningStage: 'spill',
                    thermal: 'Warm', mood: 'Playful', moodIntensity: 2,
                    outfit: 'Concert Mesh', outfitSet: true,
                    env: 'Tel Aviv Boutique', envSet: true,
                    engagement: { label: 'Hot (72)', band: 'hot', color: '#ff0' }
                });
                t.equal(pure.fields.hudAwareness, '70 · spill', 'the awakening stage left the HUD');
                t.equal(pure.fields.hudMood, 'Playful · 2', 'mood lost its intensity');
                t.equal(pure.fields.hudCompliance, 'Hot (72)', 'the engagement label was not used');
                t.equal(pure.modeClass, 'hud-mode-story', 'STORY did not change the mode class');
                t.equal(pure.engagementWrapClass, 'hud-compliance hud-compliance-hot', 'the band class is wrong');

                // An unset scene field prints a dash, not an empty cell — an empty
                // HUD slot reads as broken rather than as "nothing here".
                const bare = H.hudView({ outfit: 'ignored', outfitSet: false, persona: null });
                t.equal(bare.fields.hudOutfit, '—', 'an unset outfit did not fall back to a dash');
                t.equal(bare.fields.hudPersona, '—', 'a missing persona did not fall back to a dash');
                t.equal(bare.fields.hudMood, 'Neutral · 1', 'the mood default changed');
                t.equal(bare.modeClass, 'hud-mode-dm', 'the default mode class changed');

                // …and the wiring, which the formatter alone cannot prove.
                const S = W.EngineState;
                Object.assign(S.session, {
                    persona: 'Goon', arousal: 58, tease: 3, awareness: 70,
                    awakeningActive: true, awakeningStage: 'spill',
                    thermal: 'Warm', mood: 'Playful', moodIntensity: 2
                });
                W.MirageSimulation.updateHud();
                const text = (id) => W.document.getElementById(id)?.textContent;
                t.equal(text('hudArousal'), '58', 'the HUD did not follow the session');
                t.equal(text('hudAwareness'), '70 · spill', 'the awakening stage did not reach the HUD');
                t.equal(text('hudMood'), 'Playful · 2', 'mood did not reach the HUD');

                t.noMatch(String(H.hudView), /EngineState|\bS\(\)|document\./, 'the HUD view reaches through the wall');
            }
        },

        {
            name: 'the chat view keeps the class names the stylesheet hangs on',
            group: 'rules',
            async run(ctx, t) {
                // Extracting this markup out of appendChat / renderPhoneCard needed a
                // guard, and the obvious candidate did not work: the Layer 2 baselines
                // were run against a deliberately broken class name and passed, because
                // they record behaviour and text, not markup. So the classes get pinned
                // here. Not a full html snapshot — that breaks on every whitespace
                // change and teaches people to re-record without reading.
                const V = ctx.win.MirageChatView;

                // Each html pattern is quote-anchored. Bare substrings looked fine and
                // were useless: `chat-caption-text-TYPO` contains `chat-caption-text`,
                // so the first draft of this test passed against the very typo it was
                // written to catch.
                const cases = [
                    [{ role: 'user', text: 'hi' }, /^chat-entry chat-user chat-bubble chat-bubble-user$/, /class="ig-bubble ig-bubble-out"/],
                    [{ role: 'ai', text: 'hi' }, /^chat-entry chat-ai chat-bubble chat-bubble-ai$/, /class="ig-bubble ig-bubble-in"/],
                    [{ kind: 'caption', text: 'Left on read…' }, /^chat-entry chat-caption$/, /class="chat-caption-text"/],
                    [{ kind: 'command', role: 'user', text: '/next scene' }, /^chat-entry chat-command chat-user$/, /class="chat-command-text"/],
                    [{ kind: 'story', role: 'ai', text: 'post' }, /^chat-entry chat-story chat-ai$/, /class="chat-story-badge"/],
                    [{ kind: 'alert', title: 'x', body: 'y' }, /^chat-entry chat-alert chat-alert-warn$/, /class="chat-alert-box"/]
                ];
                cases.forEach(([view, classRe, htmlRe]) => {
                    const painted = V.chatEntry(view);
                    t.match(painted.className, classRe, `chatEntry className for ${view.kind || view.role}`);
                    t.match(painted.html, htmlRe, `chatEntry html for ${view.kind || view.role}`);
                });

                const dm = V.phoneCard({ text: 'x', imageUrl: 'data:,', mode: 'DM' });
                t.match(dm.className, /^phone-card phone-card-dm$/, 'phoneCard DM className');
                t.match(dm.html, /class="phone-card-img"/, 'phoneCard lost its image element');

                const storyCard = V.phoneCard({ text: 'x', imageUrl: 'data:,', mode: 'STORY' });
                t.match(storyCard.className, /^phone-card phone-card-story$/, 'phoneCard Story className');
                t.match(storyCard.html, /class="story-kicker"/, 'phoneCard Story lost its kicker');

                const failed = V.phoneCard({ text: 'x', mode: 'DM', imageFailed: true, imageFailReason: 'filtered' });
                t.match(failed.className, /^phone-card phone-card-dm phone-card-no-image$/, 'a failed card lost its class');
                t.match(failed.html, /Blocked by safety filter/, 'a filtered image stopped naming the filter');

                // The view must never reach for engine state — that is the whole
                // point of it, and it is what lets the gallery render with no engine.
                t.noMatch(String(V.chatEntry), /EngineState|\bS\(\)/, 'the chat view reaches into engine state');
                t.noMatch(String(V.phoneCard), /EngineState|\bS\(\)/, 'the phone view reaches into engine state');
                t.noMatch(String(V.chatEntry), /document\./, 'the chat view touches the DOM');
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
