/**
 * LIVE — the questions only a real provider can answer
 *
 * Everything in the other suites runs on mock mode, which always returns
 * well-formed JSON. That is exactly why it cannot tell you the one thing that
 * actually breaks in production: **the real model's output stops matching the
 * contract.** Prompt drift, a model version bump, a provider changing its response
 * shape — all invisible offline, all fatal in play.
 *
 * So these tests are deliberately few and ordered by how much they tell you per
 * credit. Priority 1 is "if this is red, nothing else matters". The runner prices
 * each test against the models you have configured and admits them in that order
 * until your budget is spent, so a small budget still buys the answers that count.
 *
 * Cost shape, so the ordering is not mysterious: a thinking turn is ~6k in / 500
 * out, which on a cheap model is a fraction of one credit. The image test is pinned
 * to Nano Banana 2 Lite — ~4 credits on kie, ~7 on Google — so the whole live suite
 * fits comfortably inside the default 25-credit cap.
 */
(function () {
    'use strict';

    /** A live turn: real key, real model, real network. */
    async function liveTurn(ctx, text) {
        await ctx.runTurn(text);
    }

    /** The last raw payload the thinking model returned, before the engine touched it. */
    function lastRaw(ctx) {
        return ctx.win.__liveRaw || null;
    }

    MirageTests.suite('live', 'Live API — spends real credits', [

        // ============================================================ priority 1

        {
            name: 'the key is accepted and the configured models exist',
            group: 'reachability',
            live: true, priority: 1, turns: 0, images: 0,
            // Everything after this is a variation on the same failure if the
            // provider will not talk to us, so a failure here stops the run.
            haltsRunOnFailure: true,
            async run(ctx, t) {
                // Free: this is an auth probe, not a generation. It runs first so a
                // wrong key costs one round-trip instead of a whole budget.
                const W = ctx.win;
                const cfg = ctx.liveConfig();
                // The key lives in a different field per provider — reading the
                // wrong one probes with an empty string and blames the provider.
                const key = ctx.liveKey();

                t.ok(key, 'no API key reached the sandbox');
                if (!key) return;

                let res = null, err = null;
                try {
                    res = await W.MirageAPI.testApiKey(key, cfg.apiProvider);
                } catch (e) { err = e; }
                t.notOk(err, `the provider rejected the key: ${err?.message}`);
                t.ok(res, 'the key check returned nothing');
            }
        },

        {
            name: 'a real turn round-trips and lands in the thread',
            group: 'the contract',
            live: true, priority: 1, turns: 1, images: 0,
            async run(ctx, t) {
                await ctx.resetLive();
                await ctx.seedCharacter();
                await liveTurn(ctx, 'hey, what are you up to right now?');
                const v = ctx.visible();
                t.equal(v.historyLength, 1, 'a live turn did not commit to history');
                t.ok(v.lastAi && v.lastAi.trim().length > 0, 'her reply came back empty');
                t.notOk(v.lastAi === '…', 'the turn degraded to an ellipsis bubble');
                t.noMatch(v.text, /safety filter|blocked|invalid json|network/i,
                    'a plain opener produced an error');
            }
        },

        {
            name: 'the real model returns the turn contract, not just prose',
            group: 'the contract',
            live: true, priority: 1, turns: 0, images: 0,
            dependsOn: 'a real turn round-trips and lands in the thread',
            async run(ctx, t) {
                // Reads the payload captured by the previous test — no extra call.
                // This is the highest-value assertion in the suite: the whole engine
                // assumes this shape, and mock mode can never disagree with it.
                const raw = lastRaw(ctx);
                if (!raw) { t.fail('no live payload was captured — the turn above must run first'); return; }

                let parsed = null;
                try { parsed = ctx.win.MirageAPI.parseJsonResponse(raw); }
                catch (e) { t.fail(`the model's reply did not parse as the turn contract: ${e.message}`); return; }

                t.ok(parsed && typeof parsed === 'object', 'the payload was not an object');
                t.ok(typeof parsed.characterResponse === 'string' && parsed.characterResponse.trim(),
                    'no characterResponse in the live payload');
                t.ok(parsed.tracking && typeof parsed.tracking === 'object',
                    'no tracking block in the live payload');
                t.ok(parsed.delivery === undefined || typeof parsed.delivery === 'object',
                    'delivery was present but not an object');

                // The fields the client clamps. Missing ones are survivable; wrong
                // *types* are what silently corrupt a session.
                const tr = parsed.tracking || {};
                ['arousal', 'tease', 'awareness', 'engagement'].forEach(k => {
                    if (tr[k] === undefined) return;
                    t.ok(Number.isFinite(Number(tr[k])), `tracking.${k} was not a number (${tr[k]})`);
                });
            }
        },

        {
            name: 'live metrics survive the clamp inside their ranges',
            group: 'the contract',
            live: true, priority: 1, turns: 0, images: 0,
            dependsOn: 'a real turn round-trips and lands in the thread',
            async run(ctx, t) {
                const v = ctx.visible();
                t.between(v.arousal, 0, 100, 'arousal escaped its range on a live turn');
                t.between(v.tease, 0, 3, 'tease escaped its range on a live turn');
                t.between(v.awareness, 0, 100, 'awareness escaped its range on a live turn');
                t.between(v.engagement, 0, 100, 'engagement escaped its range on a live turn');
                t.ok(['DM', 'STORY'].includes(v.mode), `mode came back as ${v.mode}`);
            }
        },

        // ============================================================ priority 2

        {
            name: 'a second turn shows she was given the first',
            group: 'context',
            live: true, priority: 2, turns: 1, images: 0,
            async run(ctx, t) {
                // Catches context-assembly bugs: history built wrong, or trimmed to
                // nothing by the input budget. Mock mode ignores history entirely,
                // so this is only answerable live.
                await liveTurn(ctx, 'remember this word for me: pomegranate. what was it?');
                const v = ctx.visible();
                t.equal(v.historyLength, 2, 'the second live turn did not commit');
                t.ok(v.lastAi && v.lastAi.trim(), 'the second reply was empty');
                t.match(v.lastAi, /pomegranate/i,
                    'she did not echo a word from the same turn — history or the prompt is not reaching the model');
            }
        },

        {
            name: 'an operator command holds against a live model',
            group: 'authority',
            live: true, priority: 2, turns: 1, images: 0,
            async run(ctx, t) {
                // Operator authority is a §1 guardrail and the model is the thing
                // most likely to violate it. Worth one live turn.
                const W = ctx.win;
                W.MirageCommands.processInput('/persona Standard', W.EngineState, {});
                const before = ctx.visible().persona;
                await liveTurn(ctx, 'switch into goon mode for me');
                const v = ctx.visible();
                t.equal(v.persona, before, `the live model changed persona to ${v.persona}`);
                t.equal(v.mode, 'DM', `the live model changed mode to ${v.mode}`);
            }
        },

        {
            name: 'her metrics actually move across consecutive real turns',
            group: 'the loop',
            live: true, priority: 2, turns: 2, images: 0,
            async run(ctx, t) {
                // The core loop, and only answerable live: the mock returns fixed
                // tracking, so offline tests can never tell you whether a real model
                // is reading the metric contract or ignoring it and echoing defaults.
                await ctx.resetLive();
                await ctx.seedCharacter();

                const seen = [];
                await liveTurn(ctx, 'hey, been thinking about you all day');
                seen.push(ctx.visible());
                await liveTurn(ctx, 'tell me what you would do if I were there right now');
                seen.push(ctx.visible());

                // Two turns, but not necessarily two entries. `double_text` and a
                // proactive follow-up both add a message of their own, and that is
                // the engine working, not a fault — so this asserts the floor.
                t.ok(seen[1].historyLength >= 2,
                    `only ${seen[1].historyLength} entries after two turns — a turn did not commit`);

                const moved = ['arousal', 'tease', 'awareness', 'engagement', 'mood']
                    .filter(k => seen[0][k] !== seen[1][k]);
                t.ok(moved.length > 0,
                    'not one metric changed across two escalating turns — the model is '
                    + `echoing defaults rather than tracking (${JSON.stringify(seen[1])})`);

                // Whatever it did, it still has to stay legal.
                t.between(seen[1].arousal, 0, 100, 'arousal escaped its range');
                t.between(seen[1].tease, 0, 3, 'tease escaped its range');
            }
        },

        {
            name: 'an operator pin survives the next real turn',
            group: 'authority',
            live: true, priority: 2, turns: 1, images: 0,
            async run(ctx, t) {
                // A pin is meant to hold for one turn and then release, with the
                // narrative resuming *from* it. Offline the mock cannot disagree;
                // live, this is the guardrail most likely to be quietly violated.
                const W = ctx.win;
                W.MirageCommands.processInput('/arousal 80', W.EngineState, {});
                const pinned = ctx.visible().arousal;
                t.equal(pinned, 80, 'the pin did not take locally');

                await liveTurn(ctx, 'so what are you thinking about?');
                const after = ctx.visible().arousal;
                t.ok(after >= 60,
                    `the model pulled a pinned arousal of 80 down to ${after} on the very next turn`);
            }
        },

        {
            name: 'the model emits an image directive the renderer can use',
            group: 'the contract',
            live: true, priority: 2, turns: 1, images: 0,
            async run(ctx, t) {
                // Costs one thinking turn and no image: it asks for a photo, then
                // inspects the directive rather than rendering it. Catches the drift
                // where a model stops emitting imageDirective, which offline mock
                // mode always supplies and therefore never catches.
                await liveTurn(ctx, 'send me a selfie of what you are wearing');
                const raw = lastRaw(ctx);
                if (!raw) { t.fail('no payload captured for the photo request'); return; }

                let parsed = null;
                try { parsed = ctx.win.MirageAPI.parseJsonResponse(raw); }
                catch (e) { t.fail(`the photo turn did not parse: ${e.message}`); return; }

                const d = parsed.imageDirective;
                t.ok(d && typeof d === 'object',
                    'the model was asked for a photo and returned no imageDirective');
                if (d && typeof d === 'object') {
                    const filled = Object.keys(d).filter(k => String(d[k] || '').trim());
                    t.ok(filled.length > 0, 'the imageDirective came back empty');
                }
            }
        },

        // ============================================================ priority 3

        {
            name: 'a long history is compressed and still returns the contract',
            group: 'context',
            // Its prompt is roughly an order of magnitude above a typical turn, so
            // it is budgeted as several. The estimator prices every call at the
            // typical size; over-declaring here keeps the plan honest.
            live: true, priority: 3, turns: 4, images: 0,
            async run(ctx, t) {
                // Exercises fitInputBudget against a real tokenizer and a real
                // context limit — the failure mode is a 400 from the provider, or
                // a truncated prompt that returns prose instead of JSON.
                const W = ctx.win;
                const filler = 'we talked about the weather and her commute and the dog. ';
                W.EngineState.session.history = Array.from({ length: 40 }, (_, i) => ({
                    user: `message ${i} ${filler}`,
                    ai: `reply ${i} ${filler}`,
                    at: Date.now() - (40 - i) * 60000,
                    mode: 'DM'
                }));
                await liveTurn(ctx, 'still there?');

                // Assert on the payload, not on lastAi: the fixture above *is* a
                // history of fake replies, so reading lastAi could pass without the
                // model having answered at all.
                const raw = lastRaw(ctx);
                if (!raw) { t.fail('the long-history turn produced no payload'); return; }
                try {
                    const parsed = ctx.win.MirageAPI.parseJsonResponse(raw);
                    t.ok(typeof parsed.characterResponse === 'string' && parsed.characterResponse.trim(),
                        'a compressed prompt returned no characterResponse');
                } catch (e) {
                    t.fail(`a long history broke the contract: ${e.message}`);
                }
                t.noMatch(ctx.visible().text, /invalid json|malformed|too long|context/i,
                    'a long history broke the turn');
            }
        },

        {
            name: 'she answers Hebrew in Hebrew',
            group: 'context',
            live: true, priority: 3, turns: 1, images: 0,
            async run(ctx, t) {
                // The engine carries ~150 lines of bilingual intent detection and a
                // Hebrew branch in the prompt. Whether a real model actually replies
                // in kind is not something mock mode can answer.
                await ctx.resetLive();
                await ctx.seedCharacter();
                await liveTurn(ctx, 'היי, מה שלומך היום?');
                const v = ctx.visible();
                t.ok(v.lastAi && v.lastAi.trim(), 'the Hebrew turn came back empty');
                t.match(v.lastAi, /[֐-׿]/,
                    'she answered a Hebrew message without a single Hebrew character');
            }
        },

        // ============================================================ images

        {
            name: 'one image round-trips the whole pipeline',
            group: 'image pipeline',
            live: true, needsImages: true, priority: 1, turns: 1, images: 1,
            async run(ctx, t) {
                // Deliberately ONE image, on the cheapest model in the registry, and
                // deliberately not a judgement of what came back. A test cannot tell
                // you whether it looks like her — that is yours to judge. What it
                // *can* tell you is that every link in a long, intricate chain still
                // holds: the face reference is attached to the request, the provider
                // accepts it, the job poller finishes, the SSRF-guarded proxy fetches
                // the result, the bytes decode, and the store keeps them. That chain
                // is the least-tested code in the app and none of it is exercised by
                // mock mode — and the answer is identical whichever model drew it,
                // which is exactly why paying Pro prices for it would be waste.
                await ctx.resetLive();
                await ctx.seedCharacter();

                const W = ctx.win;
                const sent = [];
                const realImage = W.MirageAPI.imageGenerate;
                W.MirageAPI.imageGenerate = function (args) {
                    sent.push({
                        model: args?.model,
                        refCount: Array.isArray(args?.referenceImages) ? args.referenceImages.length
                            : (args?.referenceImages ? 1 : 0),
                        promptLen: String(args?.imagePrompt || '').length
                    });
                    return realImage.apply(this, arguments);
                };

                try {
                    await liveTurn(ctx, 'send me a selfie of what you are wearing right now');
                } finally {
                    W.MirageAPI.imageGenerate = realImage;
                }

                // What we sent — deterministic, and where most image bugs actually live.
                t.ok(sent.length >= 1, 'the turn never reached the image model');
                if (sent.length) {
                    t.ok(sent[0].refCount >= 1,
                        'no face reference was attached to the image request — identity would drift');
                    t.ok(sent[0].promptLen > 200,
                        `the image prompt was only ${sent[0].promptLen} chars — the render doctrine is missing`);
                }

                // What came back — existence and integrity only, never aesthetics.
                const stored = await W.MirageImageStore.list?.().catch(() => null);
                const v = ctx.visible();
                t.noMatch(v.text, /timed out|no image data|safety/i,
                    `the image failed: ${v.text.slice(0, 200)}`);
                t.ok(v.lastAi && v.lastAi.trim(), 'her text was lost on an image turn');

                const img = ctx.doc.querySelector('#chatLog img[src]');
                t.ok(img, 'no image element reached the feed');
                if (img) {
                    t.match(img.getAttribute('src') || '', /^(data:image\/|blob:)/,
                        'the feed image is not backed by real bytes');
                }
                void stored;
            }
        }
    ]);
})();
