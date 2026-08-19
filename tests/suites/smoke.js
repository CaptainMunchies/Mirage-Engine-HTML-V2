/**
 * LAYER 1 — Smoke
 *
 * Boots, loads a character, runs a turn, saves, reloads, restores. Under a minute,
 * no API. This is the one to run constantly, so it covers the spine and nothing
 * clever: if this is red the app is broken, not subtly wrong.
 */
(function () {
    'use strict';

    const PUBLISHED = [
        'MirageApp', 'EngineState', 'MirageUI', 'MirageSimulation', 'MirageImmersion',
        'MiragePhoneUX', 'MirageChatStore', 'MirageProfileStore', 'MirageAPI',
        'MirageKieAPI', 'MirageMockAPI', 'MirageBackup', 'MirageIDB', 'MirageProxySession',
        'MirageImageStore', 'MirageAnchorStore', 'MirageMediaLibrary', 'MirageCommands',
        'MirageModels', 'MiragePrompt', 'MirageMemoryLedger', 'MirageRoutine',
        'MirageCalendar', 'MirageLoyaltyUX', 'MirageControlDeck', 'MirageDebugPanel',
        'MirageSafetyGates', 'MirageUserProfiles', 'MirageCharactersUI', 'MirageChatsUI',
        'MirageSetupFace', 'MirageSetupMedia', 'MirageSetupProfile', 'MirageSetupProtocol',
        'MirageErrors', 'MiragePendingTurn', 'MirageUserProfilesUI'
    ];

    MirageTests.suite('smoke', 'Layer 1 — Smoke', [
        {
            name: 'app boots with every module published',
            group: 'boot',
            async run(ctx, t) {
                await ctx.reset();
                const missing = PUBLISHED.filter(k => typeof ctx.win[k] === 'undefined');
                t.deepEqual(missing, [], 'modules missing from window');
            }
        },

        {
            name: 'the prompt split is real — the renderer never sees the story',
            group: 'boot',
            async run(ctx, t) {
                // The product premise: the image model gets the render doctrine and the
                // identity ledger, and nothing else. app.js has verifyPromptArchitecture()
                // but it only *logs* — it asserts nothing — so this does the asserting,
                // with markers planted in the dossier and the transcript.
                const W = ctx.win;
                await ctx.seedCharacter();
                const S = W.EngineState;
                S.profile.personality = 'DOSSIERMARKERPERSONALITY';
                S.profile.notes = 'DOSSIERMARKERNOTES';
                S.session.history = [
                    { user: 'HISTORYMARKERUSER', ai: 'HISTORYMARKERAI', at: Date.now(), mode: 'DM' }
                ];
                S.session.arousal = 77;

                const c = S.getRuntimeContext();
                const thinking = W.MiragePrompt.buildThinkingSystemInstruction('turn', c);
                const image = W.MiragePrompt.buildImageSystemInstruction(c, {
                    shotType: 'Front Selfie', crop: 'Face'
                });

                t.ok(thinking.includes('DOSSIERMARKERPERSONALITY'), 'the thinking prompt lost the dossier');
                t.notOk(image.includes('DOSSIERMARKERPERSONALITY'), 'persona prose leaked into the image prompt');
                t.notOk(image.includes('DOSSIERMARKERNOTES'), 'dossier notes leaked into the image prompt');
                t.notOk(image.includes('HISTORYMARKERUSER') || image.includes('HISTORYMARKERAI'),
                    'chat history leaked into the image prompt');
                t.notOk(/arousal/i.test(image), 'raw metric semantics leaked into the image prompt');
                t.notOk(image.includes((W.MiragePrompt.NARRATIVE_CORE || ' ').slice(0, 60)),
                    'NARRATIVE_CORE leaked into the image prompt');
                t.ok(image.length > 500, 'the image prompt came back suspiciously short');
            }
        },

        {
            name: 'the local proxy issues a session token',
            group: 'boot',
            async run(ctx, t) {
                const token = await ctx.win.MirageProxySession.ensureToken();
                t.ok(typeof token === 'string' && token.length > 20, 'no usable session token');
            }
        },

        {
            name: 'a character saves and appears in the library',
            group: 'character',
            async run(ctx, t) {
                await ctx.reset();
                await ctx.seedCharacter();
                const list = ctx.win.MirageProfileStore.list().map(e => e.label);
                t.deepEqual(list, ['Nadia'], 'character library');
            }
        },

        {
            name: 'her timezone resolves from the record, not a guess',
            group: 'character',
            async run(ctx, t) {
                const tz = ctx.win.MiragePhoneUX.resolveTimeZone(ctx.win.EngineState.profile.location);
                t.equal(tz, 'America/Chicago', 'resolved timezone');
            }
        },

        {
            name: 'a turn runs end to end and lands in the thread',
            group: 'turn',
            async run(ctx, t) {
                const before = ctx.visible().entries;
                await ctx.runTurn('hey, what are you up to');
                const v = ctx.visible();
                t.ok(v.entries > before, 'no chat entries were added');
                t.equal(v.historyLength, 1, 'history did not gain exactly one turn');
                t.ok(v.lastAi && v.lastAi.length > 0, 'her reply was empty');
            }
        },

        {
            name: 'the turn persisted to the chat store',
            group: 'turn',
            async run(ctx, t) {
                const c = ctx.win.MirageChatStore.getActiveChat(ctx.win.EngineState);
                t.equal(c?.history?.length ?? 0, 1, 'chat store history');
                t.equal(c?.turnCount ?? 0, 1, 'chat store turn count');
            }
        },

        {
            name: 'no errors during boot or the first turn',
            group: 'turn',
            async run(ctx, t) {
                t.deepEqual(ctx.errors(), [], 'sandbox errors');
            }
        },

        {
            name: 'a reload restores the character and its chat',
            group: 'persistence',
            async run(ctx, t) {
                await ctx.reset();
                const id = await ctx.seedCharacter();
                await ctx.runTurn('still there?');

                await ctx.reload();

                const W = ctx.win;
                const chats = W.MirageChatStore.listChats(id);
                t.equal(W.MirageProfileStore.list().length, 1, 'character survived the reload');
                t.equal(chats.length, 1, 'chat survived the reload');
                t.equal(chats[0]?.history?.length ?? 0, 1, 'turn survived the reload');
                t.ok(chats[0]?.history?.[chats[0].history.length - 1]?.ai, 'her reply survived the reload');
                t.deepEqual(ctx.errors(), [], 'sandbox errors after reload');
            }
        },

        {
            name: 'a backup round-trips back into an empty install',
            group: 'persistence',
            async run(ctx, t) {
                // The *download* half is a Playwright-only test — a browser cannot
                // read back a file it saved. What this covers is the part that
                // matters: the bundle export builds is a bundle import can restore.
                const bundle = await ctx.win.MirageBackup.buildBundle(null, {});
                t.equal(ctx.win.MirageBackup.validateBundle(bundle), null,
                    'the bundle it just built did not validate');
                t.equal(bundle.characters.length, 1, 'the bundle did not contain the character');
                t.notOk(JSON.stringify(bundle).includes('mirage_v2_config'),
                    'the backup carried the config key, which holds both API keys');

                // A clean install, then restore into it.
                await ctx.reset();
                t.equal(ctx.win.MirageProfileStore.list().length, 0, 'reset left characters behind');

                const res = await ctx.win.MirageBackup.importBundle(bundle);
                t.equal(res.imported, 1, 'the restore did not import the character');
                const restored = ctx.win.MirageProfileStore.list();
                t.equal(restored.length, 1, 'the character did not come back');
                t.equal(restored[0].label, 'Nadia', 'the restored character lost its name');
            }
        }
    ]);
})();
