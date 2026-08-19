/**
 * MIRAGE ENGINE v2 — Multi-chat persistence per character (with last-turn image)
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'mirage_v2_chats';
    const LEGACY_KEY = 'mirage_v2_sessions';
    const MAX_HISTORY = 100;
    const MAX_UI_LOG = 400;
    const PROTOCOLS = ['A', 'B1', 'B2', 'B3'];

    function readStore() {
        migrateLegacyOnce();
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { version: 1, characters: {} };
            const data = JSON.parse(raw);
            if (!data.characters || typeof data.characters !== 'object') {
                return { version: 1, characters: {} };
            }
            return data;
        } catch (e) {
            console.warn('[Mirage] Chat store load failed', e);
            return { version: 1, characters: {} };
        }
    }

    function writeStore(data) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014) {
                throw (typeof MirageUI?.makeStorageQuotaError === 'function'
                    ? MirageUI.makeStorageQuotaError(
                        'Browser storage is full — couldn’t save chat progress.'
                    )
                    : e);
            }
            throw e;
        }
    }

    /** Current store without re-entering migration — readStore() calls migrate first. */
    function readStoreRaw() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { version: 1, characters: {} };
            const data = JSON.parse(raw);
            if (!data.characters || typeof data.characters !== 'object') {
                return { version: 1, characters: {} };
            }
            return data;
        } catch {
            return { version: 1, characters: {} };
        }
    }

    /**
     * Fold the pre-multi-chat `mirage_v2_sessions` key into the current store.
     *
     * This used to build a *fresh* `{ characters: {} }` and writeStore it, discarding
     * whatever `mirage_v2_chats` already held — and it runs on every readStore(). It
     * was only ever safe because the legacy key is deleted immediately afterwards. If
     * that key ever came back — a restored backup, a synced profile, a partial import
     * — the very next read destroyed every chat. Import makes that reachable, so this
     * now merges into the existing store and never replaces a character that already
     * has chats.
     */
    function migrateLegacyOnce() {
        try {
            const legacyRaw = localStorage.getItem(LEGACY_KEY);
            if (!legacyRaw) return;
            const legacy = JSON.parse(legacyRaw);
            if (!legacy || typeof legacy !== 'object') {
                // Unparseable or empty legacy blob — drop it rather than retrying every read.
                localStorage.removeItem(LEGACY_KEY);
                return;
            }

            const store = readStoreRaw();
            let migrated = 0;
            Object.entries(legacy).forEach(([charKey, entry]) => {
                if (!entry) return;
                // Never clobber a character that already has chats in the live store.
                const existing = store.characters[charKey];
                if (existing?.chats?.length) return;
                const chatId = `chat-migrated-${charKey}`;
                migrated += 1;
                store.characters[charKey] = {
                    activeChatId: chatId,
                    chats: [{
                        id: chatId,
                        label: entry.lastTurn?.ai
                            ? entry.lastTurn.ai.slice(0, 48) + (entry.lastTurn.ai.length > 48 ? '…' : '')
                            : defaultChatLabel(),
                        createdAt: entry.updatedAt || new Date().toISOString(),
                        updatedAt: entry.updatedAt || new Date().toISOString(),
                        protocol: entry.protocol ?? null,
                        persona: MiragePrompt.normalizePersonaId?.(entry.persona) || entry.persona || 'Standard',
                        mode: entry.mode ?? 'DM',
                        outfit: entry.outfit ?? null,
                        env: entry.env ?? null,
                        arousal: entry.arousal ?? 0,
                        tease: entry.tease ?? 0,
                        awareness: entry.awareness ?? 0,
                        thermal: entry.thermal ?? 'Normal',
                        mood: entry.mood ?? 'Neutral',
                        moodIntensity: entry.moodIntensity ?? 1,
                        moodNote: entry.moodNote ?? '',
                        lastShotType: entry.lastShotType ?? null,
                        startInstruction: entry.startInstruction ?? '',
                        history: stripHistory(entry.history),
                        lastTurn: entry.lastTurn || null
                    }]
                };
            });
            if (migrated > 0) writeStore(store);
            localStorage.removeItem(LEGACY_KEY);
        } catch (e) {
            // Leave LEGACY_KEY in place: a failed write (quota) should be retried,
            // not silently discarded along with the only copy of that data.
            console.warn('[Mirage] Legacy session migration failed', e);
        }
    }

    function characterKey(state) {
        if (state?.activeCharacterId) return state.activeCharacterId;
        const name = String(
            state?.profile?.name
            || state?.profile?.autoFillCache?.name
            || ''
        ).trim();
        if (!name) return null;
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'character';
        return `draft-${slug}`;
    }

    function makeChatId() {
        return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    }

    function defaultChatLabel() {
        return `Chat · ${new Date().toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        })}`;
    }

    /**
     * "12 turns" — from the running total where a chat has one, falling back to the
     * (capped) history length for chats saved before turnCount existed.
     */
    function formatTurnCount(chat) {
        const stored = Number(chat?.turnCount) || 0;
        const fallback = Array.isArray(chat?.history) ? chat.history.length : 0;
        const n = Math.max(stored, fallback);
        const approx = !stored && fallback >= MAX_HISTORY ? '+' : '';
        return `${n}${approx} turn${n === 1 ? '' : 's'}`;
    }

    function chatHasContent(chat) {
        return !!(chat?.lastTurn?.ai || (Array.isArray(chat?.history) && chat.history.length));
    }

    function simNowMs() {
        try {
            if (typeof MirageImmersion?.simNowMs === 'function') return MirageImmersion.simNowMs();
        } catch { /* fall through */ }
        try {
            if (typeof MiragePhoneUX?.herNow === 'function') return MiragePhoneUX.herNow().getTime();
        } catch { /* fall through */ }
        return Date.now();
    }

    function lastTranscriptStamp(sess, role) {
        const hist = Array.isArray(sess?.history) ? sess.history : [];
        for (let i = hist.length - 1; i >= 0; i--) {
            const h = hist[i];
            const at = Number(h?.at);
            if (!Number.isFinite(at) || at <= 0) continue;
            if (role === 'ai' && String(h.ai || '').trim()) return at;
            if (role === 'user' && String(h.user || '').trim()) return at;
        }
        return 0;
    }

    /**
     * Activity pointers from older engine builds drift off the transcript
     * (wall Date.now vs sim stamps, or lastAi never updated after Wait for her).
     * Trust the chat log when saved is behind, or when saved looks like live wall-clock.
     */
    function coalesceStamp(saved, transcript) {
        const s = Number(saved) || 0;
        const t = Number(transcript) || 0;
        if (!t) return s || null;
        if (!s) return t;
        if (t > s + 15 * 60 * 1000) return t;
        if (s > t + 15 * 60 * 1000 && Math.abs(s - Date.now()) < 20 * 60 * 1000) return t;
        return Math.max(s, t);
    }

    function latestTranscriptStamp(sess) {
        let latest = 0;
        const bump = (n) => {
            const v = Number(n);
            if (Number.isFinite(v) && v > latest) latest = v;
        };
        if (Array.isArray(sess?.history)) sess.history.forEach(h => bump(h?.at));
        if (Array.isArray(sess?.uiLog)) sess.uiLog.forEach(e => bump(e?.at));
        bump(sess?._lastChatStampMs);
        bump(sess?.lastChatStampMs);
        return latest;
    }

    /** Align lastAi/lastUser/_lastChatStampMs with the saved transcript, then un-rewind the phone. */
    function cohereSessionClock(sess, { hydrate = false } = {}) {
        if (!sess) return;
        const fromAi = lastTranscriptStamp(sess, 'ai');
        const fromUser = lastTranscriptStamp(sess, 'user');
        if (hydrate) {
            sess.lastAiMessageAt = coalesceStamp(sess.lastAiMessageAt, fromAi);
            sess.lastUserMessageAt = coalesceStamp(sess.lastUserMessageAt, fromUser);
        } else {
            if (fromAi > (Number(sess.lastAiMessageAt) || 0)) sess.lastAiMessageAt = fromAi;
            if (fromUser > (Number(sess.lastUserMessageAt) || 0)) sess.lastUserMessageAt = fromUser;
        }
        const latest = latestTranscriptStamp(sess);
        if (latest > 0 && !sess.clockMayLagStamps) {
            sess._lastChatStampMs = Math.max(Number(sess._lastChatStampMs) || 0, latest);
        }
        if (!sess.clockMayLagStamps) {
            try {
                global.MiragePhoneUX?.ensureClockNotBehindStamps?.({ includeDom: false });
            } catch { /* ignore */ }
        }
    }

    function inferProtocolAndMode(chat) {
        const rawProto = String(chat?.protocol || '').trim().toUpperCase();
        let protocol = PROTOCOLS.includes(rawProto) ? rawProto : null;
        let mode = String(chat?.mode || '').trim().toUpperCase();
        if (mode !== 'DM' && mode !== 'STORY') mode = '';
        const lastMode = String(chat?.lastTurn?.mode || '').trim().toUpperCase();
        if (!mode && (lastMode === 'DM' || lastMode === 'STORY')) mode = lastMode;

        if (!protocol) {
            protocol = mode === 'STORY' ? 'B1' : 'A';
        }
        if (!mode) {
            mode = protocol.startsWith('B') ? 'STORY' : 'DM';
        }
        return { protocol, mode };
    }

    function compactStoredDebug(debug) {
        if (!debug || typeof debug !== 'object') return null;
        const clip = (v, n) => {
            if (v == null || v === '') return null;
            const s = typeof v === 'string' ? v : String(v);
            return s.length > n ? `${s.slice(0, n - 1)}…` : s;
        };
        const out = {
            thinkingModel: debug.thinkingModel || null,
            imageModel: debug.imageModel || null,
            apiProvider: debug.apiProvider || null,
            referenceMode: debug.referenceMode || null,
            sceneContinuityRef: debug.sceneContinuityRef != null ? !!debug.sceneContinuityRef : null,
            persona: debug.persona || null,
            protocol: debug.protocol || null,
            mode: debug.mode || null,
            outfit: debug.outfit || null,
            outfitSource: debug.outfitSource || null,
            env: debug.env || null,
            generateImage: debug.generateImage != null ? !!debug.generateImage : null,
            imageFailed: !!debug.imageFailed,
            imageSkipped: !!debug.imageSkipped,
            imageFailReason: debug.imageFailReason || null,
            imageFailDetail: clip(debug.imageFailDetail, 500),
            commandInject: clip(debug.commandInject, 900),
            godMode: !!debug.godMode,
            changeOutfit: !!debug.changeOutfit,
            refreshScene: !!debug.refreshScene,
            fitCheck: !!debug.fitCheck,
            closeup: !!debug.closeup,
            cropLock: debug.cropLock || null,
            internal: !!debug.internal,
            storyLaunch: !!debug.storyLaunch,
            proactive: !!debug.proactive,
            deliveryStyle: debug.deliveryStyle || null,
            herClock: debug.herClock || null,
            clockOffsetMs: Number.isFinite(Number(debug.clockOffsetMs)) ? Number(debug.clockOffsetMs) : null,
            pacing: debug.pacing || null,
            mockImages: !!debug.mockImages,
            mockThinking: !!debug.mockThinking,
            shotType: debug.shotType || null,
            crop: debug.crop || null,
            goonFace: debug.goonFace || null,
            goonFrame: debug.goonFrame || null,
            imageRefs: Array.isArray(debug.imageRefs) ? debug.imageRefs.slice(0, 8) : null,
            imagePromptClip: clip(debug.imagePromptClip, 800),
            faceRecovery: !!debug.faceRecovery,
            retried: !!debug.retried,
            retryMode: debug.retryMode || null,
            failed: !!debug.failed,
            error: clip(debug.error, 400)
        };
        Object.keys(out).forEach((k) => {
            if (out[k] == null || out[k] === '') delete out[k];
        });
        return Object.keys(out).length ? out : null;
    }

    function stripHistory(history) {
        return (history || []).slice(-MAX_HISTORY).map(h => ({
            user: h.user,
            ai: h.ai,
            at: h.at || simNowMs(),
            mode: h.mode === 'STORY' ? 'STORY' : 'DM',
            tracking: h.tracking && typeof h.tracking === 'object' ? h.tracking : null,
            debug: compactStoredDebug(h.debug)
        }));
    }

    function stripUiLog(log, history) {
        let rows = Array.isArray(log) ? log : [];
        const hist = Array.isArray(history) ? history : [];
        if (hist.length) {
            const oldest = hist.reduce((min, h) => {
                const at = Number(h?.at) || 0;
                return at > 0 ? Math.min(min, at) : min;
            }, Number.POSITIVE_INFINITY);
            if (Number.isFinite(oldest)) {
                rows = rows.filter(e => (Number(e?.at) || 0) >= oldest - 2 * 60 * 1000);
            }
        }
        return rows.slice(-MAX_UI_LOG).map(e => ({
            kind: e.kind || 'system',
            text: String(e.text || '').slice(0, 2000),
            label: e.label || null,
            devOnly: !!e.devOnly,
            clockArrow: e.clockArrow ? String(e.clockArrow).slice(0, 120) : null,
            alertType: e.alertType || null,
            title: e.title ? String(e.title).slice(0, 200) : null,
            body: e.body ? String(e.body).slice(0, 1200) : null,
            at: Number(e.at) || simNowMs()
        }));
    }

    function engagementToLegacyCompliance(score) {
        const n = Number(score);
        if (!Number.isFinite(n)) return 'engaged';
        if (n <= 20) return 'ignoring';
        if (n <= 25) return 'refusing';
        if (n <= 45) return 'reluctant';
        return 'engaged';
    }

    function resolvePersistedEngagement(chat) {
        if (chat?.engagement != null) {
            const clamped = typeof MirageLoyaltyUX?.clampEngagement === 'function'
                ? MirageLoyaltyUX.clampEngagement(chat.engagement)
                : null;
            if (clamped != null) return clamped;
            const n = Number(chat.engagement);
            if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
        }
        const migrated = typeof MirageLoyaltyUX?.migrateComplianceToEngagement === 'function'
            ? MirageLoyaltyUX.migrateComplianceToEngagement(chat?.compliance)
            : null;
        return migrated != null ? migrated : 55;
    }

    function exportChatFields(state) {
        const sess = state.session || {};
        const engagement = Number.isFinite(Number(sess.engagement))
            ? Math.max(0, Math.min(100, Math.round(Number(sess.engagement))))
            : (typeof MirageLoyaltyUX?.migrateComplianceToEngagement === 'function'
                ? (MirageLoyaltyUX.migrateComplianceToEngagement(sess.compliance) ?? 55)
                : 55);
        return {
            protocol: sess.protocol ?? null,
            persona: sess.persona ?? 'Standard',
            mode: sess.mode ?? 'DM',
            outfit: sess.outfit ?? null,
            outfitSource: sess.outfitSource || null,
            env: sess.env ?? null,
            lastOutfitDetail: sess.lastOutfitDetail ?? null,
            arousal: sess.arousal ?? 0,
            tease: sess.tease ?? 0,
            awareness: sess.awareness ?? 0,
            thermal: sess.thermal ?? 'Normal',
            thermalPinExpired: !!sess.thermalPinExpired,
            thermalPinnedEnv: sess.thermalPinnedEnv || '',
            mood: sess.mood ?? 'Neutral',
            moodIntensity: Number.isFinite(Number(sess.moodIntensity))
                ? Math.max(0, Math.min(3, Math.round(Number(sess.moodIntensity))))
                : 1,
            moodNote: String(sess.moodNote || '').slice(0, 120),
            hardCutStreak: Math.max(0, Number(sess.hardCutStreak) || 0),
            awakeningActive: !!sess.awakeningActive,
            awakeningStage: sess.awakeningStage || 'off',
            lastShotType: sess.lastShotType ?? null,
            shotHistory: Array.isArray(sess.shotHistory) ? sess.shotHistory.slice(0, 5) : [],
            engagement,
            /** @deprecated legacy string for old readers — approx from engagement bands */
            compliance: engagementToLegacyCompliance(engagement),
            storyActive: !!sess._storyActive,
            startInstruction: sess.startInstruction ?? '',
            directorScene: sess.directorScene ?? '',
            clockOffsetMs: Number(sess.clockOffsetMs) || 0,
            lastSeenAt: sess.lastSeenAt ?? null,
            lastUserMessageAt: sess.lastUserMessageAt ?? null,
            lastAiMessageAt: sess.lastAiMessageAt ?? null,
            lastChatStampMs: Number(sess._lastChatStampMs) || Number(sess.lastChatStampMs) || null,
            lastReplyLagMs: sess.lastReplyLagMs ?? null,
            chatHeat: Number(sess.chatHeat) || 0,
            lastAttendedWallMs: Number(sess.lastAttendedWallMs) || null,
            catchUpForMessageAt: Number(sess.catchUpForMessageAt) || null,
            clockMayLagStamps: !!sess.clockMayLagStamps,
            clockResumeHold: sess.clockResumeHold && typeof sess.clockResumeHold === 'object'
                ? {
                    gapMs: Number(sess.clockResumeHold.gapMs) || 0,
                    at: Number(sess.clockResumeHold.at) || Date.now()
                }
                : null,
            pendingWorldBeat: sess.pendingWorldBeat || null,
            lastStoryAt: sess.lastStoryAt ?? null,
            routineBand: sess._routineBand || null,
            routineAt: Number(sess._routineAt) || 0,
            herStreak: Math.max(0, Number(sess.herStreak) || 0),
            ghostCooldownTurns: Math.max(0, Number(sess.ghostCooldownTurns) || 0),
            socialHold: sess.socialHold && typeof sess.socialHold === 'object'
                ? {
                    kind: String(sess.socialHold.kind || ''),
                    flavor: sess.socialHold.flavor || null,
                    reason: sess.socialHold.reason || null,
                    outcome: sess.socialHold.outcome || null,
                    at: Number(sess.socialHold.at) || 0
                }
                : null,
            userProfileId: sess.userProfileId ?? null,
            userProfileLabel: sess.userProfileLabel ?? null,
            ...(typeof MirageMemoryLedger !== 'undefined' ? MirageMemoryLedger.exportFields(sess) : {
                memoryLedger: [],
                turnsSinceCallback: 0
            }),
            uiLog: stripUiLog(sess.uiLog, sess.history)
        };
    }

    function lastTurnImageKey(charKey, chatId) {
        return `chat-${charKey}-${chatId}-last`;
    }

    function turnImageKey(charKey, chatId, turnAt) {
        return `chat-${charKey}-${chatId}-img-${turnAt}`;
    }

    /** Single overwritten last-frame key for SCENE continuity refs (outfit + env). */
    function sceneContinuityKey(charKey, chatId) {
        return `scene-cont-${charKey}-${chatId}`;
    }

    function chatImageSaveCount(state) {
        const n = state?.chatImageSaveCount ?? EngineState?.chatImageSaveCount ?? 3;
        return Math.max(1, Math.min(20, Math.floor(Number(n) || 3)));
    }

    function normalizeTurnImages(images) {
        if (!Array.isArray(images)) return [];
        // Resume slots are for real stills (or failed gens we can retry) — not text-only turns.
        return images.filter(t => t && (t.imageKey || t.imageFailed || t.imageMock));
    }

    function ensureCharacterRecord(store, charKey) {
        if (!store.characters[charKey]) {
            store.characters[charKey] = { activeChatId: null, chats: [] };
        }
        return store.characters[charKey];
    }

    function listChats(charKey) {
        if (!charKey) return [];
        const rec = readStore().characters[charKey];
        if (!rec?.chats?.length) return [];
        return rec.chats.slice().sort((a, b) =>
            (b.updatedAt || '').localeCompare(a.updatedAt || '')
        );
    }

    function getChat(charKey, chatId) {
        if (!charKey || !chatId) return null;
        return listChats(charKey).find(c => c.id === chatId) || null;
    }

    /**
     * Add restored chats to a character, keeping anything already there.
     * A chat whose id collides gets a fresh one rather than replacing the
     * resident chat — an import must never be able to destroy live work.
     * @returns {Array<{from: string, to: string}>} ids that had to be reassigned
     */
    function importChats(charKey, chats) {
        if (!charKey || !Array.isArray(chats) || !chats.length) return [];
        const store = readStore();
        const rec = store.characters[charKey] || { activeChatId: null, chats: [] };
        const taken = new Set(rec.chats.map(c => c.id));
        const remapped = [];

        chats.forEach(chat => {
            if (!chat || typeof chat !== 'object') return;
            let id = chat.id;
            if (!id || taken.has(id)) {
                const next = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                remapped.push({ from: id || '(none)', to: next });
                id = next;
            }
            taken.add(id);
            rec.chats.push({ ...chat, id });
        });

        rec.chats.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        if (!rec.activeChatId && rec.chats[0]) rec.activeChatId = rec.chats[0].id;
        store.characters[charKey] = rec;
        writeStore(store);
        return remapped;
    }

    function getActiveChatId(charKey) {
        if (!charKey) return null;
        return readStore().characters[charKey]?.activeChatId || null;
    }

    function getActiveChat(state) {
        const charKey = characterKey(state);
        if (!charKey || !state.session?.activeChatId) return null;
        return getChat(charKey, state.session.activeChatId);
    }

    function getForState(state) {
        return getActiveChat(state);
    }

    function hasResumable(charKey) {
        return listChats(charKey).some(c => c.lastTurn?.ai || (c.history?.length > 0));
    }

    function hasResumableForState(state) {
        const charKey = characterKey(state);
        return charKey ? hasResumable(charKey) : false;
    }

    function applyChatToState(state, chat) {
        if (!chat) return false;
        const sess = state.session;
        sess.activeChatId = chat.id;
        // Never fall back to the previous session for chat-scoped fields — that bleeds
        // director/protocol/scene intent from the chat you just left.
        const inferred = inferProtocolAndMode(chat);
        sess.protocol = inferred.protocol;
        sess.persona = MiragePrompt.normalizePersonaId?.(chat.persona) || chat.persona || 'Standard';
        sess.mode = inferred.mode;
        sess.outfit = chat.outfit ?? null;
        sess.outfitSource = chat.outfitSource || null;
        sess.env = chat.env ?? null;
        sess.lastOutfitDetail = chat.lastOutfitDetail ?? null;
        sess.arousal = chat.arousal ?? 0;
        sess.tease = chat.tease ?? 0;
        sess.awareness = chat.awareness ?? 0;
        sess.thermal = chat.thermal ?? 'Normal';
        sess.thermalPinExpired = !!chat.thermalPinExpired;
        sess.thermalPinnedEnv = chat.thermalPinnedEnv || '';
        sess.mood = (typeof MiragePrompt?.normalizeMood === 'function'
            ? MiragePrompt.normalizeMood(chat.mood)
            : null) || chat.mood || 'Neutral';
        sess.moodIntensity = Number.isFinite(Number(chat.moodIntensity))
            ? Math.max(0, Math.min(3, Math.round(Number(chat.moodIntensity))))
            : 1;
        sess.moodNote = String(chat.moodNote || '').slice(0, 120);
        sess.hardCutStreak = Math.max(0, Number(chat.hardCutStreak) || 0);
        sess.awakeningActive = !!chat.awakeningActive;
        sess.awakeningStage = chat.awakeningStage || (sess.awakeningActive ? 'crack' : 'off');
        sess.lastShotType = chat.lastShotType ?? null;
        sess.shotHistory = Array.isArray(chat.shotHistory) ? chat.shotHistory.slice(0, 5) : [];
        sess.engagement = resolvePersistedEngagement(chat);
        sess._storyActive = !!chat.storyActive;
        sess.operatorOverrides = {};
        sess.startInstruction = chat.startInstruction ?? '';
        sess.directorScene = chat.directorScene ?? '';
        sess.clockOffsetMs = Number(chat.clockOffsetMs) || 0;
        sess.lastSeenAt = chat.lastSeenAt ?? null;
        sess.lastUserMessageAt = chat.lastUserMessageAt ?? null;
        sess.lastAiMessageAt = chat.lastAiMessageAt ?? null;
        sess._lastChatStampMs = Number(chat.lastChatStampMs) || Number(chat._lastChatStampMs) || 0;
        sess.lastReplyLagMs = chat.lastReplyLagMs ?? null;
        sess.chatHeat = Number(chat.chatHeat) || 0;
        sess.lastAttendedWallMs = Number(chat.lastAttendedWallMs) || Number(new Date(chat.updatedAt).getTime()) || null;
        sess.catchUpForMessageAt = Number(chat.catchUpForMessageAt) || null;
        sess.clockMayLagStamps = !!chat.clockMayLagStamps;
        sess.clockResumeHold = chat.clockResumeHold && typeof chat.clockResumeHold === 'object'
            ? {
                gapMs: Number(chat.clockResumeHold.gapMs) || 0,
                at: Number(chat.clockResumeHold.at) || Date.now()
            }
            : null;
        sess.pendingWorldBeat = chat.pendingWorldBeat || null;
        sess.lastStoryAt = chat.lastStoryAt ?? null;
        sess._routineBand = chat.routineBand || chat._routineBand || null;
        sess._routineAt = Number(chat.routineAt) || Number(chat._routineAt) || 0;
        sess.herStreak = Math.max(0, Number(chat.herStreak) || 0);
        sess.ghostCooldownTurns = Math.max(0, Number(chat.ghostCooldownTurns) || 0);
        sess.socialHold = chat.socialHold && typeof chat.socialHold === 'object'
            ? {
                kind: String(chat.socialHold.kind || ''),
                flavor: chat.socialHold.flavor || null,
                reason: chat.socialHold.reason || null,
                outcome: chat.socialHold.outcome || null,
                at: Number(chat.socialHold.at) || 0
            }
            : null;
        sess.userProfileId = chat.userProfileId ?? null;
        sess.userProfileLabel = chat.userProfileLabel ?? null;
        // Legacy chats: adopt the settings-active operator profile once
        if (!sess.userProfileId && typeof MirageUserProfiles?.pinActiveForChat === 'function') {
            const pinned = MirageUserProfiles.pinActiveForChat();
            sess.userProfileId = pinned.userProfileId;
            sess.userProfileLabel = pinned.userProfileLabel;
        }
        sess.presence = 'idle';
        if (typeof MirageMemoryLedger !== 'undefined') {
            MirageMemoryLedger.applyFields(sess, chat);
        } else {
            sess.memoryLedger = Array.isArray(chat.memoryLedger) ? chat.memoryLedger : [];
            sess.turnsSinceCallback = Number(chat.turnsSinceCallback) || 0;
        }
        sess.history = stripHistory(chat.history);
        sess.uiLog = stripUiLog(chat.uiLog, chat.history);
        cohereSessionClock(sess, { hydrate: true });
        return true;
    }

    function applyMetricsToState(state, chat) {
        return applyChatToState(state, chat);
    }

    function createChat(state, { label, resetMetrics = true } = {}) {
        const charKey = characterKey(state) || 'draft-unnamed';

        if (resetMetrics) {
            if (typeof state.resetSimulationRuntime === 'function') {
                state.resetSimulationRuntime({ keepProtocol: true });
            } else if (typeof EngineState?.resetSimulationRuntime === 'function') {
                EngineState.resetSimulationRuntime({ keepProtocol: true });
            }
            if (typeof state.seedSessionDynamics === 'function') {
                state.seedSessionDynamics();
            } else if (typeof state.seedSessionEngagement === 'function') {
                state.seedSessionEngagement();
            } else if (typeof MirageLoyaltyUX?.seedSessionDynamics === 'function') {
                MirageLoyaltyUX.seedSessionDynamics(
                    state.session,
                    state.profile,
                    state.edf,
                    state.session?.protocol
                );
            } else if (typeof MirageLoyaltyUX?.seedEngagement === 'function') {
                state.session.engagement = MirageLoyaltyUX.seedEngagement(
                    state.profile,
                    state.edf,
                    state.session?.protocol
                );
            }
        }

        // Pin settings-active operator profile onto brand-new chats
        if (typeof MirageUserProfiles?.pinActiveForChat === 'function') {
            const pinned = MirageUserProfiles.pinActiveForChat();
            state.session.userProfileId = pinned.userProfileId;
            state.session.userProfileLabel = pinned.userProfileLabel;
        }

        const store = readStore();
        const rec = ensureCharacterRecord(store, charKey);
        const chat = {
            id: makeChatId(),
            label: label || defaultChatLabel(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...exportChatFields(state),
            history: [],
            uiLog: [],
            lastTurn: null,
            turnImages: []
        };

        rec.chats.push(chat);
        rec.activeChatId = chat.id;
        writeStore(store);

        state.session.activeChatId = chat.id;
        applyChatToState(state, chat);
        if (typeof MirageDebugPanel?.syncChatScope === 'function') {
            MirageDebugPanel.syncChatScope();
        }
        return chat;
    }

    function setActiveChat(state, chatId) {
        const charKey = characterKey(state);
        if (!charKey || !chatId) return null;
        const chat = getChat(charKey, chatId);
        if (!chat) return null;

        const store = readStore();
        ensureCharacterRecord(store, charKey).activeChatId = chatId;
        writeStore(store);

        applyChatToState(state, chat);
        if (typeof MirageDebugPanel?.syncChatScope === 'function') {
            MirageDebugPanel.syncChatScope();
        }
        return chat;
    }

    async function saveActiveChat(state, turnMeta = {}) {
        const charKey = characterKey(state);
        if (!charKey) return null;

        // Never treat an incidental save (decay, her proactive turn) as the
        // operator coming back — that wiped the ≥1h gap and hid the clock picker.
        if (state?.session && !state.session.clockResumeHold) {
            const gap = typeof global.MirageImmersion?.wallAbsenceMs === 'function'
                ? Number(global.MirageImmersion.wallAbsenceMs()) || 0
                : 0;
            const threshold = Number(global.MirageImmersion?.CLOCK_RESUME_MS) || (60 * 60 * 1000);
            if (gap < threshold) {
                state.session.lastAttendedWallMs = Date.now();
            }
        }
        if (state?.session) cohereSessionClock(state.session);

        const store = readStore();
        const rec = ensureCharacterRecord(store, charKey);
        let chatId = state.session.activeChatId;

        if (!chatId) {
            // Incidental saves (tab hide, clock-resume) must not spawn empty Unset chats.
            return null;
        }

        let idx = rec.chats.findIndex(c => c.id === chatId);
        const existing = idx >= 0 ? rec.chats[idx] : null;

        const wallKeyAt = Date.now();
        const turnAt = Number(turnMeta.at) || simNowMs();
        const mockImage = !!turnMeta.imageMock;
        let imageKey = null;
        if (!mockImage && turnMeta.imageDataUrl?.startsWith('data:')) {
            imageKey = turnImageKey(charKey, chatId, wallKeyAt);
            try {
                await MirageImageStore.saveDataUrl(imageKey, turnMeta.imageDataUrl);
            } catch (e) {
                console.warn('[Mirage] Chat turn image save failed', e);
                imageKey = null;
            }
        }

        const maxImages = chatImageSaveCount(state);
        const prevImages = normalizeTurnImages(existing?.turnImages);

        let turnImages = prevImages;
        let newImageEntry = null;

        let replacedNonHeadTurn = false;
        if (turnMeta.replaceLastTurn && turnMeta.lastAi && prevImages.length) {
            let replaceIdx = -1;
            if (turnMeta.replaceImageAt != null) {
                replaceIdx = prevImages.findIndex(t => t.at === turnMeta.replaceImageAt);
            }
            if (replaceIdx < 0) {
                // Prefer the turn that actually carried an image (skip double-text follow-ups)
                replaceIdx = prevImages.findIndex(t =>
                    t.imageKey || t.imageDirective || t.imageFailed
                );
            }
            if (replaceIdx < 0) replaceIdx = 0;
            replacedNonHeadTurn = replaceIdx > 0;

            const prev = prevImages[replaceIdx];
            const replaceAt = turnMeta.replaceImageAt || prev.at || turnAt;

            if (!mockImage && turnMeta.imageDataUrl?.startsWith('data:')) {
                imageKey = turnImageKey(charKey, chatId, replaceAt);
                try {
                    await MirageImageStore.saveDataUrl(imageKey, turnMeta.imageDataUrl);
                } catch (e) {
                    console.warn('[Mirage] Chat turn image replace failed', e);
                    imageKey = null;
                }
            }

            if (prev.imageKey && prev.imageKey !== imageKey) {
                MirageImageStore.remove(prev.imageKey).catch(() => {});
            }

            newImageEntry = {
                at: replaceAt,
                user: turnMeta.lastUser || prev.user || '',
                ai: turnMeta.lastAi,
                mode: turnMeta.lastMode || prev.mode || state.session.mode,
                imageKey: turnMeta.imageFailed || turnMeta.imageSkipped || mockImage ? null : imageKey,
                imageFailed: !!turnMeta.imageFailed,
                imageSkipped: !!turnMeta.imageSkipped,
                imageMock: mockImage,
                imageFailReason: turnMeta.imageFailReason || null,
                imageDirective: turnMeta.imageDirective || prev.imageDirective || null
            };
            const nextImages = prevImages.slice();
            nextImages[replaceIdx] = newImageEntry;
            turnImages = nextImages.slice(0, maxImages);
        } else if (turnMeta.lastAi) {
            const visualKept = mockImage
                || !!(imageKey && !turnMeta.imageSkipped)
                || !!turnMeta.imageFailed;
            newImageEntry = {
                at: turnAt,
                user: turnMeta.lastUser || '',
                ai: turnMeta.lastAi,
                mode: turnMeta.lastMode || state.session.mode,
                imageKey: turnMeta.imageFailed || turnMeta.imageSkipped || mockImage ? null : imageKey,
                imageFailed: !!turnMeta.imageFailed,
                imageSkipped: !!turnMeta.imageSkipped,
                imageMock: mockImage,
                imageFailReason: turnMeta.imageFailReason || null,
                imageDirective: turnMeta.imageDirective || null
            };
            if (visualKept) {
                turnImages = [newImageEntry, ...prevImages].slice(0, maxImages);
                const keepKeys = new Set(turnImages.map(t => t.imageKey).filter(Boolean));
                prevImages.forEach(t => {
                    if (t.imageKey && !keepKeys.has(t.imageKey)) {
                        MirageImageStore.remove(t.imageKey).catch(() => {});
                    }
                });
                const legacyKey = lastTurnImageKey(charKey, chatId);
                if (!keepKeys.has(legacyKey)) {
                    MirageImageStore.remove(legacyKey).catch(() => {});
                }
            }
            // Text-only turns update lastTurn / history but do not consume an image slot.
        }

        // history is capped at MAX_HISTORY, so its length stops being a turn count once
        // a chat gets long — the saved-chats list read "100 turns" forever. Count the
        // turns that are new since the last save (by their own timestamps) and keep a
        // running total that survives the cap. Chats that were already past 100 before
        // this shipped start their count from what history still holds, so their first
        // number is a floor rather than a total.
        const hist = Array.isArray(state.session.history) ? state.session.history : [];
        const countedThrough = Number(existing?.lastCountedAt) || 0;
        const addedTurns = countedThrough
            ? hist.filter(h => (Number(h.at) || 0) > countedThrough).length
            : hist.length;
        const turnCount = (Number(existing?.turnCount) || 0) + addedTurns;
        const lastCountedAt = hist.reduce(
            (max, h) => Math.max(max, Number(h.at) || 0),
            countedThrough
        );

        const chat = {
            id: chatId,
            label: existing?.label || defaultChatLabel(),
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...exportChatFields(state),
            turnCount,
            lastCountedAt,
            history: stripHistory(state.session.history),
            uiLog: stripUiLog(state.session.uiLog, state.session.history),
            turnImages,
            // Keep the follow-up text as lastTurn when we only replaced an earlier image card
            lastTurn: (turnMeta.replaceLastTurn && replacedNonHeadTurn)
                ? (existing?.lastTurn || newImageEntry)
                : (newImageEntry || existing?.lastTurn || null)
        };

        if (chat.history.length === 1 && chat.lastTurn?.ai && (!existing || existing.label === defaultChatLabel())) {
            chat.label = chat.lastTurn.ai.slice(0, 52) + (chat.lastTurn.ai.length > 52 ? '…' : '');
        }

        if (idx >= 0) rec.chats[idx] = chat;
        else rec.chats.push(chat);

        rec.activeChatId = chatId;
        writeStore(store);
        return chat;
    }

    async function save(state, turnMeta) {
        return saveActiveChat(state, turnMeta);
    }

    function deleteChat(charKey, chatId) {
        if (!charKey || !chatId) return;
        const store = readStore();
        const rec = store.characters[charKey];
        if (!rec) return;

        const doomed = rec.chats.find(c => c.id === chatId);

        rec.chats = rec.chats.filter(c => c.id !== chatId);
        if (rec.activeChatId === chatId) {
            rec.activeChatId = rec.chats[0]?.id || null;
        }
        if (!rec.chats.length) delete store.characters[charKey];
        writeStore(store);

        MirageDebugPanel?.forgetChatScope?.(charKey, chatId);
        MirageImageStore.remove(lastTurnImageKey(charKey, chatId)).catch(() => {});
        MirageImageStore.remove(sceneContinuityKey(charKey, chatId)).catch(() => {});
        normalizeTurnImages(doomed?.turnImages).forEach(t => {
            if (t.imageKey) MirageImageStore.remove(t.imageKey).catch(() => {});
        });
    }

    function removeCharacter(charKey) {
        if (!charKey) return;
        const store = readStore();
        const rec = store.characters[charKey];
        if (rec?.chats) {
            rec.chats.forEach(c => {
                MirageDebugPanel?.forgetChatScope?.(charKey, c.id);
                MirageImageStore.remove(lastTurnImageKey(charKey, c.id)).catch(() => {});
                MirageImageStore.remove(sceneContinuityKey(charKey, c.id)).catch(() => {});
                normalizeTurnImages(c.turnImages).forEach(t => {
                    if (t.imageKey) MirageImageStore.remove(t.imageKey).catch(() => {});
                });
            });
        }
        delete store.characters[charKey];
        writeStore(store);
    }

    function migrate(fromKey, toKey) {
        if (!fromKey || !toKey || fromKey === toKey) return;
        const store = readStore();
        if (!store.characters[fromKey]) return;
        if (!store.characters[toKey]) {
            store.characters[toKey] = store.characters[fromKey];
            store.characters[toKey].chats = (store.characters[toKey].chats || []).map(chat => ({
                ...chat,
                lastTurn: chat.lastTurn ? {
                    ...chat.lastTurn,
                    imageKey: chat.lastTurn.imageKey
                        ? chat.lastTurn.imageKey.replace(`chat-${fromKey}-`, `chat-${toKey}-`)
                        : null
                } : null
            }));
        }
        delete store.characters[fromKey];
        writeStore(store);
    }

    function remove(charKey) {
        removeCharacter(charKey);
    }

    function resetSessionVolatile(state) {
        if (typeof EngineState?.resetSessionVolatile === 'function') {
            EngineState.resetSessionVolatile();
            return;
        }
        const sess = state?.session;
        if (!sess) return;
        sess.history = [];
        sess.uiLog = [];
        sess.arousal = 0;
        sess.tease = 0;
        sess.awareness = 0;
        sess.thermal = 'Normal';
        sess.mood = 'Neutral';
        sess.moodIntensity = 1;
        sess.moodNote = '';
        sess.hardCutStreak = 0;
        sess.lastShotType = null;
        sess.shotHistory = [];
        sess.activeChatId = null;
        sess._storyActive = false;
        sess.engagement = typeof MirageLoyaltyUX?.seedEngagement === 'function'
            ? MirageLoyaltyUX.seedEngagement(state?.profile, state?.edf, sess.protocol)
            : 55;
        sess.operatorOverrides = {};
        sess.clockOffsetMs = 0;
        sess.lastSeenAt = null;
        sess.lastUserMessageAt = null;
        sess.lastAiMessageAt = null;
        sess._lastChatStampMs = 0;
        sess.lastReplyLagMs = null;
        sess.chatHeat = 0;
        sess.lastAttendedWallMs = Date.now();
        sess.catchUpForMessageAt = null;
        sess.clockResumeHold = null;
        sess.clockMayLagStamps = false;
        sess.presence = 'idle';
        sess.memoryLedger = [];
        sess.turnsSinceCallback = 0;
        sess.pendingWorldBeat = null;
        sess.outfit = null;
        sess.outfitSource = null;
        sess.env = null;
        sess.lastOutfitDetail = null;
        sess.awakeningActive = false;
        sess.awakeningStage = 'off';
        sess.sessionEpoch = (Number(sess.sessionEpoch) || 0) + 1;
    }

    function getMostRecentChat(charKey) {
        const chats = listChats(charKey);
        return chats.find(chatHasContent) || chats[0] || null;
    }

    function onCharacterLoaded(state, characterId) {
        if (!characterId) return null;
        resetSessionVolatile(state);
        if (typeof MirageDebugPanel?.syncChatScope === 'function') {
            MirageDebugPanel.syncChatScope();
        }
        return null;
    }

    function ensureActiveChat(state, { resetMetrics = false } = {}) {
        const charKey = characterKey(state);
        if (!charKey) return null;

        if (state.session.activeChatId && getChat(charKey, state.session.activeChatId)) {
            return getChat(charKey, state.session.activeChatId);
        }

        const chats = listChats(charKey);
        if (chats.length) {
            return setActiveChat(state, chats[0].id);
        }

        return createChat(state, { resetMetrics });
    }

    global.MirageChatStore = {
        characterKey,
        listChats,
        importChats,
        formatTurnCount,
        getChat,
        getActiveChat,
        getActiveChatId,
        getForState,
        getMostRecentChat,
        createChat,
        setActiveChat,
        saveActiveChat,
        save,
        deleteChat,
        removeCharacter,
        remove,
        migrate,
        resetSessionVolatile,
        onCharacterLoaded,
        ensureActiveChat,
        applyChatToState,
        applyMetricsToState,
        normalizeTurnImages,
        hasResumable,
        hasResumableForState,
        lastTurnImageKey,
        turnImageKey,
        sceneContinuityKey,
        stripUiLog,
        chatImageSaveCount,
        MAX_HISTORY,
        MAX_UI_LOG
    };

})(typeof window !== 'undefined' ? window : globalThis);
