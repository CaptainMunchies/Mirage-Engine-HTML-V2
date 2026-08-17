/**
 * MIRAGE ENGINE — Central state store
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'mirage_v2_config';

    /** Placeholders that mean "scene not established yet" — model must set from EDF. */
    const UNSET_SCENE = new Set(['', 'default', 'awaiting trigger', 'unset', '—', '-', 'none', 'null', 'undefined']);

    function isSceneFieldSet(value) {
        if (value == null) return false;
        return !UNSET_SCENE.has(String(value).trim().toLowerCase());
    }

    function defaultSession() {
        return {
            phase: 'setup',
            setupStep: 0,
            arousal: 0,
            awareness: 0,
            tease: 0,
            thermal: 'Normal',
            /** Deck /thermal pin lasted one turn; next thinking turn must re-evaluate. */
            thermalPinExpired: false,
            thermalPinnedEnv: '',
            /** How she feels right now — curated label or short freeform. */
            mood: 'Neutral',
            /** 0 background · 1 clear · 2 strong · 3 overwhelming */
            moodIntensity: 1,
            /** Optional soft cause from /set_emotional_state … | note */
            moodNote: '',
            persona: 'Standard',
            mode: 'Unset',
            // null = not established; thinking model may use OUTFIT_LIBRARY / ENV_ATLAS or invent freely
            outfit: null,
            /** 'library' | 'invented' once tracking.outfit is applied this session. */
            outfitSource: null,
            env: null,
            /** Last imageDirective.outfitDetail — used to lock wardrobe on same-scene follow-ups. */
            lastOutfitDetail: null,
            startInstruction: '',
            lastShotType: null,
            // Last 3 shot types, newest first — feeds the Forced Variance avoid-list
            shotHistory: [],
            history: [],
            /**
             * Persisted chat-log notices (system / CMD / decisions / alerts).
             * Restored with the chat so debug + command popups survive reload.
             */
            uiLog: [],
            herStreak: 0,
            ghostCooldownTurns: 0,
            socialHold: null,
            protocol: null,
            activeChatId: null,
            /** Pinned operator profile for this chat (from settings at create, switchable later). */
            userProfileId: null,
            userProfileLabel: null,
            directorScene: '',
            _storyActive: false,
            /** Attention / investment 0–100 (replaces legacy compliance strings). */
            engagement: 55,
            // Metrics the operator set this turn; authoritative, cleared after the turn
            operatorOverrides: {},
            // Phone realism — offset from wall clock; presence for last-seen chrome
            clockOffsetMs: 0,
            lastSeenAt: null,
            presence: 'idle',
            // Wall-clock activity for silence-aware immersion
            lastUserMessageAt: null,
            lastAiMessageAt: null,
            _lastChatStampMs: 0,
            lastReplyLagMs: null,
            chatHeat: 0,
            lastAttendedWallMs: null,
            catchUpForMessageAt: null,
            clockResumeHold: null,
            clockMayLagStamps: false,
            // Sticky continuity facts + callback pacing
            memoryLedger: [],
            turnsSinceCallback: 0,
            /** Consecutive /next scene or /jump without a real conversational turn. */
            hardCutStreak: 0,
            // Real-time world skips (/time pass, /next scene, /jump) awaiting her reaction
            pendingWorldBeat: null,
            // Sim-time stamp of her last Instagram Story post
            lastStoryAt: null,
            _routineBand: null,
            _routineAt: 0,
            // Irreversible fourth-wall awakening sequence
            awakeningActive: false,
            awakeningStage: 'off',
            // Bumped on every chat boundary so in-flight turns cannot land on the wrong chat
            sessionEpoch: 0
        };
    }

    const METRIC_RANGES = {
        arousal: [0, 100],
        tease: [0, 3],
        awareness: [0, 100],
        engagement: [0, 100],
        moodIntensity: [0, 3]
    };

    const PACING_MODES = ['instant', 'hybrid', 'realtime'];
    const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;
    const DEFAULT_NO_REPLY_WAIT_MS = 3 * 60 * 1000;

    function normalizePacingMode(value, { legacyRealTime } = {}) {
        const key = String(value || '').trim().toLowerCase();
        if (PACING_MODES.includes(key)) return key;
        if (typeof legacyRealTime === 'boolean') return legacyRealTime ? 'realtime' : 'instant';
        return 'instant';
    }

    function clampWaitMs(ms, fallback) {
        const n = Number(ms);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(60 * 1000, Math.min(30 * 60 * 1000, Math.round(n)));
    }

    /**
     * Accept ms, or legacy minute-scale values accidentally stored in the ms field.
     * Tiny values (< 1 min) used to clamp to 60000 and show as "1" in Settings.
     */
    function normalizeWaitMs(raw, fallback) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return fallback;
        // 1–30 → treat as minutes (mis-saved into a *Ms field)
        if (n <= 30) return clampWaitMs(n * 60 * 1000, fallback);
        // 31–59999 → corrupt / incomplete multiply; use default instead of clamping to 1 min
        if (n < 60 * 1000) return fallback;
        return clampWaitMs(n, fallback);
    }

    const THERMAL_VALUES = ['Normal', 'Sweaty', 'Overheating'];

    function clampMetric(name, value) {
        const range = METRIC_RANGES[name];
        if (!range) return value;
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        return Math.max(range[0], Math.min(range[1], Math.round(n)));
    }

    function normalizeThermal(value) {
        const key = String(value || '').trim().toLowerCase();
        return THERMAL_VALUES.find(v => v.toLowerCase() === key) || null;
    }

    function resetSessionVolatile(session) {
        if (!session) return;
        session.history = [];
        session.uiLog = [];
        session.arousal = 0;
        session.tease = 0;
        session.awareness = 0;
        session.thermal = 'Normal';
        session.thermalPinExpired = false;
        session.thermalPinnedEnv = '';
        session.mood = 'Neutral';
        session.moodIntensity = 1;
        session.moodNote = '';
        session.hardCutStreak = 0;
        session.lastShotType = null;
        session.shotHistory = [];
        session.activeChatId = null;
        session._storyActive = false;
        session.engagement = typeof MirageLoyaltyUX?.seedEngagement === 'function'
            ? MirageLoyaltyUX.seedEngagement({}, null, null)
            : 55;
        session.operatorOverrides = {};
        session.clockOffsetMs = 0;
        session.lastSeenAt = null;
        session.lastUserMessageAt = null;
        session.lastAiMessageAt = null;
        session._lastChatStampMs = 0;
        session.lastReplyLagMs = null;
        session.chatHeat = 0;
        session.lastAttendedWallMs = null;
        session.catchUpForMessageAt = null;
        session.clockResumeHold = null;
        session.clockMayLagStamps = false;
        session.presence = 'idle';
        session.memoryLedger = [];
        session.turnsSinceCallback = 0;
        session.pendingWorldBeat = null;
        session.herStreak = 0;
        session.ghostCooldownTurns = 0;
        session.socialHold = null;
        session.lastStoryAt = null;
        session._routineBand = null;
        session._routineAt = 0;
        session._routineThisTurn = null;
        session.userProfileId = null;
        session.userProfileLabel = null;
        session.awakeningActive = false;
        session.awakeningStage = 'off';
        session.sessionEpoch = (Number(session.sessionEpoch) || 0) + 1;
    }

    /**
     * Clear sticky sim runtime so a new chat does not inherit prior outfit/env.
     * Outfit/env stay unset — the turn engine + EDF (OUTFIT_LIBRARY / ENV_ATLAS) establish them.
     */
    function resetSimulationRuntime(session, { keepProtocol = true } = {}) {
        if (!session) return;
        const protocol = keepProtocol ? session.protocol : null;
        const mode = keepProtocol ? session.mode : 'Unset';
        const startInstruction = keepProtocol ? session.startInstruction : '';
        const directorScene = keepProtocol ? session.directorScene : '';
        const phase = session.phase;

        resetSessionVolatile(session);
        session.persona = 'Standard';
        session.outfit = null;
        session.env = null;
        session.lastOutfitDetail = null;

        if (keepProtocol) {
            session.protocol = protocol;
            session.mode = mode;
            session.startInstruction = startInstruction;
            session.directorScene = directorScene;
        } else {
            session.protocol = null;
            session.mode = 'Unset';
            session.startInstruction = '';
            session.directorScene = '';
        }
        session.phase = phase;
        if (typeof MirageDebugPanel?.syncChatScope === 'function') {
            MirageDebugPanel.syncChatScope();
        }
    }

    const EngineState = {
        METRIC_RANGES,
        THERMAL_VALUES,
        PACING_MODES,
        DEFAULT_MAX_WAIT_MS,
        DEFAULT_NO_REPLY_WAIT_MS,

        apiKey: '',
        /** 'google' | 'kie' — routes thinking + image calls */
        apiProvider: 'google',
        kieApiKey: '',
        thinkingModel: MirageModels.DEFAULT_THINKING,
        /**
         * Thinking model for heavy scene work: first scene of a new chat,
         * /next scene, /time pass|/skip, /jump.
         * Defaults to Gemini 3.7 Flash. Grok chat auto-pairs this to the same Grok.
         */
        sceneThinkingModel: MirageModels.DEFAULT_SCENE_THINKING,
        imageModel: MirageModels.DEFAULT_IMAGE,

        developerMode: false,
        /** Dev-only: skip Nano Banana; placeholder images from imageDirective. */
        mockImages: false,
        /** Dev-only: skip thinking API; local EDF JSON. Implies mockImages when saved. */
        mockThinking: false,
        /**
         * Pacing: instant (default) | hybrid | realtime.
         * Legacy realTimeChat is derived for older call sites.
         */
        pacingMode: 'instant',
        /** @deprecated use pacingMode — synced on load/save */
        realTimeChat: false,
        /** Wall-time cap for realtime waits + hybrid/realtime time-jump waits (ms). */
        realTimeMaxWaitMs: DEFAULT_MAX_WAIT_MS,
        /** Quiet before chase — no-reply watch after she messages (ms). */
        noReplyWaitMs: DEFAULT_NO_REPLY_WAIT_MS,
        /**
         * When true, social aftermath / idle / world-skip beats may post an Instagram Story.
         * Protocol opening stories + manual Generate IG Story are always allowed.
         */
        proactiveStories: true,
        /**
         * How aggressively her place follows a daily rhythm.
         * jumps = clock jumps only · stories = jumps + Stories (default) · living = hour-band mid-chat
         */
        routineMode: 'stories',
        saveGeneratedImages: false,
        imageSaveMode: 'none',
        downloadPrefix: '',
        chatImageSaveCount: 3,
        /** 'face' = identity anchor only · 'face+body' = also send a body proportions ref */
        referenceMode: 'face+body',
        /**
         * Last generated frame as outfit/env SCENE ref. Face/body anchors still win identity.
         * Dev-gated in the UI; persisted even when Developer Mode is off.
         */
        sceneContinuityRef: true,
        /**
         * Hard maximum on each of her chat bubbles (characters). 0 = unlimited.
         * Ceiling only — never a target. Default 240.
         */
        maxReplyChars: 240,
        /**
         * Target thinking-model INPUT tokens per play turn (system + user parts).
         * 0 = unlimited (no compressor). Default 4500.
         */
        maxThinkingInputTokens: 4500,

        mediaFiles: [],
        /** In-memory photo library entries: { id, fileName, mimeType, size, file } */
        mediaLibrary: [],
        masterFaceFile: null,
        masterFaceObjectUrl: null,
        masterFaceBase64: null,
        masterBodyFile: null,
        masterBodyObjectUrl: null,
        masterBodyBase64: null,

        /**
         * Last successfully generated frame for this chat — SCENE continuity ref
         * (wardrobe + environment only). Overwritten each generate; FACE/BODY still win identity.
         */
        lastSceneFile: null,
        lastSceneImageKey: null,

        edf: null,
        profile: {},

        activeCharacterId: null,
        activeCharacterLabel: null,
        /** Last screen so a refresh lands on the same character / chat / setup step. */
        uiResume: null,

        session: defaultSession(),

        loadConfig() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return;
                const cfg = JSON.parse(raw);
                if (cfg.apiKey) this.apiKey = cfg.apiKey;
                if (cfg.apiProvider === 'kie' || cfg.apiProvider === 'google') {
                    this.apiProvider = cfg.apiProvider;
                }
                if (typeof cfg.kieApiKey === 'string') this.kieApiKey = cfg.kieApiKey;
                if (cfg.thinkingModel) {
                    this.thinkingModel = MirageModels.resolveThinkingModel(
                        cfg.thinkingModel,
                        this.apiProvider
                    );
                }
                if (cfg.sceneThinkingModel) {
                    this.sceneThinkingModel = MirageModels.resolveThinkingModel(
                        cfg.sceneThinkingModel,
                        this.apiProvider
                    );
                } else {
                    this.sceneThinkingModel = MirageModels.defaultSceneThinking?.(this.apiProvider)
                        || MirageModels.DEFAULT_SCENE_THINKING;
                }
                if (cfg.imageModel) {
                    this.imageModel = MirageModels.resolveImageModel(
                        cfg.imageModel,
                        this.apiProvider
                    );
                }
                if (typeof cfg.developerMode === 'boolean') this.developerMode = cfg.developerMode;
                if (typeof cfg.mockImages === 'boolean') this.mockImages = cfg.mockImages;
                if (typeof cfg.mockThinking === 'boolean') this.mockThinking = cfg.mockThinking;
                // Mock flags persist independently of Developer Mode; they only *apply* while Dev is on.
                if (this.mockThinking) this.mockImages = true;
                if (typeof cfg.sceneContinuityRef === 'boolean') this.sceneContinuityRef = cfg.sceneContinuityRef;
                if (cfg.maxReplyChars != null) {
                    const n = Number(cfg.maxReplyChars);
                    if (Number.isFinite(n) && n <= 0) this.maxReplyChars = 0;
                    else if (n === 480 || n === 900) this.maxReplyChars = 240;
                    else if (Number.isFinite(n)) this.maxReplyChars = Math.max(80, Math.min(4000, Math.round(n)));
                }
                if (cfg.maxThinkingInputTokens != null) {
                    const n = Number(cfg.maxThinkingInputTokens);
                    if (Number.isFinite(n) && n <= 0) this.maxThinkingInputTokens = 0;
                    else if (Number.isFinite(n)) {
                        const allowed = [2500, 4500, 8000];
                        this.maxThinkingInputTokens = allowed.includes(n) ? n : 4500;
                    }
                }
                if (cfg.pacingMode != null || typeof cfg.realTimeChat === 'boolean') {
                    this.pacingMode = normalizePacingMode(cfg.pacingMode, {
                        legacyRealTime: cfg.realTimeChat
                    });
                }
                this.realTimeChat = this.pacingMode === 'realtime';
                let healWaitPersist = false;
                if (cfg.realTimeMaxWaitMs != null || cfg.realTimeMaxWaitMin != null) {
                    // Prefer explicit minutes when present (unambiguous).
                    let ms = cfg.realTimeMaxWaitMin != null
                        ? Number(cfg.realTimeMaxWaitMin) * 60 * 1000
                        : cfg.realTimeMaxWaitMs;
                    // Heal: bare 60000 with no minutes field is almost always "10 minutes
                    // saved wrong then clamped to 1 min" — restore product default.
                    if (
                        cfg.realTimeMaxWaitMin == null
                        && Number(cfg.realTimeMaxWaitMs) === 60 * 1000
                    ) {
                        ms = DEFAULT_MAX_WAIT_MS;
                        healWaitPersist = true;
                    }
                    const next = normalizeWaitMs(ms, DEFAULT_MAX_WAIT_MS);
                    if (
                        cfg.realTimeMaxWaitMin == null
                        && Number.isFinite(Number(cfg.realTimeMaxWaitMs))
                        && next !== Number(cfg.realTimeMaxWaitMs)
                    ) {
                        healWaitPersist = true;
                    }
                    this.realTimeMaxWaitMs = next;
                }
                if (cfg.noReplyWaitMs != null || cfg.noReplyWaitMin != null) {
                    const ms = cfg.noReplyWaitMin != null
                        ? Number(cfg.noReplyWaitMin) * 60 * 1000
                        : cfg.noReplyWaitMs;
                    this.noReplyWaitMs = normalizeWaitMs(ms, DEFAULT_NO_REPLY_WAIT_MS);
                }
                if (typeof cfg.proactiveStories === 'boolean') this.proactiveStories = cfg.proactiveStories;
                if (cfg.routineMode != null) {
                    this.routineMode = typeof global.MirageRoutine?.normalizeMode === 'function'
                        ? global.MirageRoutine.normalizeMode(cfg.routineMode)
                        : (['jumps', 'stories', 'living'].includes(String(cfg.routineMode))
                            ? String(cfg.routineMode)
                            : 'stories');
                }
                if (typeof cfg.saveGeneratedImages === 'boolean') this.saveGeneratedImages = cfg.saveGeneratedImages;
                if (cfg.imageSaveMode) this.imageSaveMode = cfg.imageSaveMode;
                if (typeof cfg.downloadPrefix === 'string') this.downloadPrefix = cfg.downloadPrefix;
                if (typeof cfg.chatImageSaveCount === 'number' && cfg.chatImageSaveCount >= 1) {
                    this.chatImageSaveCount = Math.min(20, Math.floor(cfg.chatImageSaveCount));
                }
                if (cfg.referenceMode === 'face' || cfg.referenceMode === 'face+body') {
                    this.referenceMode = cfg.referenceMode;
                }
                if (cfg.uiResume && typeof cfg.uiResume === 'object') {
                    this.uiResume = {
                        characterId: cfg.uiResume.characterId || null,
                        chatId: cfg.uiResume.chatId || null,
                        setupStep: Number.isInteger(Number(cfg.uiResume.setupStep))
                            ? Number(cfg.uiResume.setupStep)
                            : 0,
                        phase: cfg.uiResume.phase || 'setup',
                        savedAt: Number(cfg.uiResume.savedAt) || Date.now()
                    };
                }
                if (healWaitPersist) {
                    try { this.saveConfig(); } catch { /* ignore */ }
                }
            } catch (e) {
                console.warn('[Mirage] Config load failed', e);
            }
        },

        saveConfig() {
            const maxWaitMs = normalizeWaitMs(this.realTimeMaxWaitMs, DEFAULT_MAX_WAIT_MS);
            const quietMs = normalizeWaitMs(this.noReplyWaitMs, DEFAULT_NO_REPLY_WAIT_MS);
            this.realTimeMaxWaitMs = maxWaitMs;
            this.noReplyWaitMs = quietMs;
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                apiKey: this.apiKey,
                apiProvider: this.apiProvider === 'kie' ? 'kie' : 'google',
                kieApiKey: this.kieApiKey,
                thinkingModel: this.thinkingModel,
                sceneThinkingModel: this.sceneThinkingModel,
                imageModel: this.imageModel,
                developerMode: this.developerMode,
                mockImages: !!this.mockImages,
                mockThinking: !!this.mockThinking,
                sceneContinuityRef: this.sceneContinuityRef !== false,
                maxReplyChars: Number.isFinite(Number(this.maxReplyChars))
                    ? Math.max(0, Math.min(4000, Math.round(Number(this.maxReplyChars))))
                    : 240,
                maxThinkingInputTokens: Number.isFinite(Number(this.maxThinkingInputTokens))
                    ? Math.max(0, Math.min(8000, Math.round(Number(this.maxThinkingInputTokens))))
                    : 4500,
                pacingMode: normalizePacingMode(this.pacingMode),
                realTimeChat: normalizePacingMode(this.pacingMode) === 'realtime',
                realTimeMaxWaitMs: maxWaitMs,
                realTimeMaxWaitMin: Math.round(maxWaitMs / 60000),
                noReplyWaitMs: quietMs,
                noReplyWaitMin: Math.round(quietMs / 60000),
                proactiveStories: this.proactiveStories !== false,
                routineMode: typeof global.MirageRoutine?.normalizeMode === 'function'
                    ? global.MirageRoutine.normalizeMode(this.routineMode)
                    : (this.routineMode || 'stories'),
                saveGeneratedImages: this.saveGeneratedImages,
                imageSaveMode: this.imageSaveMode,
                downloadPrefix: this.downloadPrefix,
                chatImageSaveCount: this.chatImageSaveCount,
                referenceMode: this.referenceMode,
                uiResume: this.uiResume || null
            }));
        },

        markUiResume() {
            const step = Number(this.session?.setupStep);
            this.uiResume = {
                characterId: this.activeCharacterId || null,
                chatId: this.session?.activeChatId || null,
                setupStep: Number.isInteger(step) ? step : 0,
                phase: this.session?.phase || 'setup',
                savedAt: Date.now()
            };
            try { this.saveConfig(); } catch { /* ignore */ }
        },

        isKieProvider() {
            return this.apiProvider === 'kie';
        },

        /** Active provider API key (Google or kie). */
        activeApiKey() {
            return this.isKieProvider() ? (this.kieApiKey || '') : (this.apiKey || '');
        },

        hasApiAccess() {
            return !!this.activeApiKey() || !!(this.developerMode && this.mockThinking);
        },

        getRuntimeContext() {
            const userResolved = typeof MirageUserProfiles?.resolveForSession === 'function'
                ? MirageUserProfiles.resolveForSession(this.session)
                : null;
            return {
                phase: this.session.phase,
                profile: this.profile,
                session: this.session,
                edf: this.edf,
                masterFaceRef: this.edf?.VISUAL_ANCHORS?.MASTER_FACE_REF
                    || this.masterFaceFile?.name
                    || null,
                userProfile: userResolved
            };
        },

        resetSession() {
            this.session = defaultSession();
            this.edf = null;
            this.profile = {};
            this.mediaFiles = [];
            this.mediaLibrary = [];
            this.activeCharacterId = null;
            this.activeCharacterLabel = null;
            this.clearMasterFace();
            this.clearBodyReference();
        },

        resetSessionVolatile() {
            resetSessionVolatile(this.session);
        },

        resetSimulationRuntime(opts) {
            resetSimulationRuntime(this.session, opts);
        },

        isSceneFieldSet(value) {
            return isSceneFieldSet(value);
        },

        needsSceneEstablish() {
            return !isSceneFieldSet(this.session.outfit) || !isSceneFieldSet(this.session.env);
        },

        setPacingMode(mode) {
            this.pacingMode = normalizePacingMode(mode);
            this.realTimeChat = this.pacingMode === 'realtime';
            return this.pacingMode;
        },

        getPacingMode() {
            return normalizePacingMode(this.pacingMode, { legacyRealTime: this.realTimeChat });
        },

        /** Operator pins a metric for the next turn; the model evolves onward from it. */
        setOperatorOverride(name, value) {
            const sess = this.session;
            if (!sess.operatorOverrides) sess.operatorOverrides = {};

            if (name === 'thermal') {
                const thermal = normalizeThermal(value);
                if (!thermal) return null;
                sess.thermal = thermal;
                sess.operatorOverrides.thermal = thermal;
                sess.thermalPinExpired = false;
                sess.thermalPinnedEnv = sess.env || '';
                return thermal;
            }

            if (name === 'mood') {
                const mood = typeof MiragePrompt?.normalizeMood === 'function'
                    ? MiragePrompt.normalizeMood(value)
                    : String(value || '').trim().slice(0, 40);
                if (!mood) return null;
                sess.mood = mood;
                sess.operatorOverrides.mood = mood;
                return mood;
            }

            if (!METRIC_RANGES[name]) return null;
            const clamped = clampMetric(name, value);
            if (clamped == null) return null;
            sess[name] = clamped;
            sess.operatorOverrides[name] = clamped;
            return clamped;
        },

        /**
         * Pin emotional state for this turn (like thermal). Intensity defaults to 2 when omitted.
         * @returns {{ mood: string, intensity: number, note: string }|null}
         */
        setEmotionalState({ mood, intensity, note, pin = true } = {}) {
            const sess = this.session;
            if (!sess.operatorOverrides) sess.operatorOverrides = {};

            let appliedMood = sess.mood || 'Neutral';
            if (mood != null && String(mood).trim()) {
                const m = this.setOperatorOverride('mood', mood);
                if (!m) return null;
                appliedMood = m;
            } else if (pin) {
                sess.operatorOverrides.mood = appliedMood;
            }

            let appliedIntensity = Number(sess.moodIntensity);
            if (!Number.isFinite(appliedIntensity)) appliedIntensity = 1;
            if (intensity != null && intensity !== '') {
                const n = this.setOperatorOverride('moodIntensity', intensity);
                if (n != null) appliedIntensity = n;
            } else if (pin && mood != null && String(mood).trim()) {
                // Operator named a mood without intensity → clear readable default
                appliedIntensity = this.setOperatorOverride('moodIntensity', 2) ?? 2;
            }

            if (note != null) {
                const cleaned = String(note).trim().slice(0, 120);
                sess.moodNote = cleaned;
                if (pin) {
                    if (cleaned) sess.operatorOverrides.moodNote = cleaned;
                    else delete sess.operatorOverrides.moodNote;
                }
            }

            return {
                mood: appliedMood,
                intensity: appliedIntensity,
                note: sess.moodNote || ''
            };
        },

        /** Seed engagement + other dynamics when starting a fresh simulation / chat. */
        seedSessionEngagement() {
            return this.seedSessionDynamics();
        },

        /** Context-seed arousal / tease / thermal / mood / engagement for a new chat. */
        seedSessionDynamics() {
            const sess = this.session;
            if (!sess) return null;
            if (typeof MirageLoyaltyUX?.seedSessionDynamics === 'function') {
                return MirageLoyaltyUX.seedSessionDynamics(sess, this.profile, this.edf, sess.protocol);
            }
            const score = typeof MirageLoyaltyUX?.seedEngagement === 'function'
                ? MirageLoyaltyUX.seedEngagement(this.profile, this.edf, sess.protocol)
                : 55;
            sess.engagement = score;
            return { engagement: score };
        },

        clearOperatorOverrides() {
            const sess = this.session;
            const pinnedThermal = sess.operatorOverrides?.thermal;
            if (pinnedThermal) {
                sess.thermalPinExpired = true;
                sess.thermalPinnedEnv = sess.env || sess.thermalPinnedEnv || '';
            }
            sess.operatorOverrides = {};
        },

        hasOperatorOverride(name) {
            return this.session.operatorOverrides?.[name] != null;
        },

        /** Remember the last few shot types so the renderer can be told what to avoid. */
        recordShotType(shotType, crop, cameraAngle) {
            const shot = String(shotType || '').trim();
            if (!shot) return;
            const c = String(crop || '').trim();
            const a = String(cameraAngle || '').trim().toLowerCase();
            const angle = (a === 'high' || a === 'eye' || a === 'low' || a === 'dutch') ? a : '';
            const label = [shot, c, angle].filter(Boolean).join(' / ');
            const sess = this.session;
            sess.lastShotType = label;
            const history = Array.isArray(sess.shotHistory) ? sess.shotHistory : [];
            if (sess._shotRecordedThisTurn) {
                sess.shotHistory = [label, ...history.slice(1)].slice(0, 5);
                return;
            }
            sess._shotRecordedThisTurn = true;
            if (history[0] === label) {
                sess.shotHistory = history.slice(0, 5);
                return;
            }
            sess.shotHistory = [label, ...history].slice(0, 5);
        },

        recordGoonCombo(face, frame) {
            const f = String(face || '').trim();
            const fr = String(frame || '').trim();
            if (!f && !fr) return;
            const label = [f, fr].filter(Boolean).join(' / ');
            const sess = this.session;
            sess.lastGoonCombo = label;
            const history = Array.isArray(sess.goonLookHistory) ? sess.goonLookHistory : [];
            sess.goonLookHistory = [label, ...history.filter(s => s !== label)].slice(0, 3);
        },

        /**
         * Which reference images the renderer should receive. Degrades to face-only
         * when the model cannot take multiple refs or no body reference is stored.
         */
        effectiveReferenceMode() {
            if (this.referenceMode !== 'face+body') return 'face';
            const model = MirageModels.getImageModel(this.imageModel, this.apiProvider);
            if (!model?.supportsMultiReference) return 'face';
            return this.masterBodyFile ? 'face+body' : 'face';
        },

        /**
         * @param {{ faceOnly?: boolean, duplicateFace?: boolean, outfitFile?: File|null, sceneFile?: File|null }} [opts]
         * faceOnly — skip BODY / OUTFIT / SCENE (identity-priority path).
         * duplicateFace — attach the master face twice to strengthen identity conditioning.
         * outfitFile — wardrobe still from the photo library when tracking.outfit matches a library entry.
         * sceneFile — last generated frame for outfit + environment continuity (ignored for face/body).
         */
        referenceFiles({ faceOnly = false, duplicateFace = false, outfitFile = null, sceneFile = null } = {}) {
            const files = [];
            const roles = [];
            if (this.masterFaceFile) {
                files.push(this.masterFaceFile);
                roles.push('FACE');
                if (duplicateFace) {
                    files.push(this.masterFaceFile);
                    roles.push('FACE');
                }
            }
            if (!faceOnly && this.effectiveReferenceMode() === 'face+body' && this.masterBodyFile) {
                files.push(this.masterBodyFile);
                roles.push('BODY');
            }
            // Library OUTFIT still and last-frame SCENE never stack (caller picks one).
            // Known look → original photo. Invented look → last frame.
            if (!faceOnly && sceneFile) {
                files.push(sceneFile);
                roles.push('SCENE');
            } else if (!faceOnly && outfitFile) {
                files.push(outfitFile);
                roles.push('OUTFIT');
            }

            // Honour the LIVE provider's cap (kie Lite = 4; Google Lite = 0 → 1 FACE).
            // Drop extra FACE before SCENE/OUTFIT so wardrobe continuity survives identity doubling.
            const model = typeof MirageModels !== 'undefined'
                ? MirageModels.getImageModel(this.imageModel, this.apiProvider)
                : null;
            const max = Number.isFinite(model?.maxCharacterRefs)
                ? Math.max(1, model.maxCharacterRefs)
                : files.length;
            while (files.length > max) {
                const faceIdx = roles.lastIndexOf('FACE');
                if (faceIdx > 0 && roles.filter(r => r === 'FACE').length > 1) {
                    files.splice(faceIdx, 1);
                    roles.splice(faceIdx, 1);
                    continue;
                }
                const bodyIdx = roles.lastIndexOf('BODY');
                if (bodyIdx >= 0) {
                    files.splice(bodyIdx, 1);
                    roles.splice(bodyIdx, 1);
                    continue;
                }
                const outfitIdx = roles.lastIndexOf('OUTFIT');
                if (outfitIdx >= 0) {
                    files.splice(outfitIdx, 1);
                    roles.splice(outfitIdx, 1);
                    continue;
                }
                const sceneIdx = roles.lastIndexOf('SCENE');
                if (sceneIdx >= 0) {
                    files.splice(sceneIdx, 1);
                    roles.splice(sceneIdx, 1);
                    continue;
                }
                files.length = max;
                roles.length = max;
                break;
            }
            return { files, roles };
        },

        clearBodyReference() {
            if (this.masterBodyObjectUrl) URL.revokeObjectURL(this.masterBodyObjectUrl);
            this.masterBodyFile = null;
            this.masterBodyObjectUrl = null;
            this.masterBodyBase64 = null;
        },

        setBodyReference(file) {
            this.clearBodyReference();
            this.masterBodyFile = file;
            this.masterBodyObjectUrl = URL.createObjectURL(file);
        },

        clearMasterFace() {
            if (this.masterFaceObjectUrl) URL.revokeObjectURL(this.masterFaceObjectUrl);
            this.masterFaceFile = null;
            this.masterFaceObjectUrl = null;
            this.masterFaceBase64 = null;
        },

        setMasterFace(file) {
            this.clearMasterFace();
            this.masterFaceFile = file;
            this.masterFaceObjectUrl = URL.createObjectURL(file);
        }
    };

    EngineState.loadConfig();
    global.EngineState = EngineState;
})(typeof window !== 'undefined' ? window : globalThis);
