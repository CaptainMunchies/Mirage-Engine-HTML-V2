/**
 * MIRAGE ENGINE v2 — Active simulation (turn engine + image pipeline)
 */
(function () {
    'use strict';

    const S = () => EngineState;

    let lastResolvedImageUrl = null;
    let activeTurnAbort = null;
    let turnInProgress = false;
    let lastTurnSnapshot = null;
    /** Exact image system/prompt from the last generateTurnImage build (for Retry replay). */
    let lastBuiltImagePrompt = null;
    /** Pre-turn snapshot so Cancel can fully rewind to the last completed turn. */
    let activeTurnCheckpoint = null;

    function cloneJson(value) {
        if (value == null) return value;
        try {
            return structuredClone(value);
        } catch {
            try {
                return JSON.parse(JSON.stringify(value));
            } catch {
                return value;
            }
        }
    }

    /** Soft-trim a bubble at a sentence/word boundary so the length cap doesn't mid-word chop. */
    function clampReplyChars(text, limit) {
        const s = String(text || '').trim();
        const cap = Number(limit);
        if (!Number.isFinite(cap) || cap <= 0 || s.length <= cap) return s;
        const cut = s.slice(0, cap);
        const sentence = cut.match(/^[\s\S]*[.!?…](?:["”']|\s|$)/);
        if (sentence && sentence[0].trim().length >= Math.min(80, Math.floor(cap * 0.45))) {
            return sentence[0].trim();
        }
        const sp = cut.lastIndexOf(' ');
        if (sp > cap * 0.5) return cut.slice(0, sp).trim();
        return cut.trim();
    }

    function captureTurnCheckpoint({ userText = null } = {}) {
        const sess = S().session;
        const log = document.getElementById('chatLog');
        const feed = document.getElementById('phoneFeed');
        const phoneCards = feed
            ? feed.querySelectorAll(':scope > .phone-card').length
            : 0;
        return {
            restored: false,
            chatLogLength: log ? log.children.length : 0,
            phoneCardCount: phoneCards,
            historyLength: Array.isArray(sess?.history) ? sess.history.length : 0,
            uiLogLength: Array.isArray(sess?.uiLog) ? sess.uiLog.length : 0,
            userText: userText ? String(userText) : null,
            lastChatStampMs: Number(sess?._lastChatStampMs) || 0,
            lastAiMessageAt: sess?.lastAiMessageAt ?? null,
            lastUserMessageAt: sess?.lastUserMessageAt ?? null,
            loyalty: MirageLoyaltyUX?.snapshotDynamics?.() || null,
            lastBuiltImagePrompt,
            lastResolvedImageUrl,
            lastTurnSnapshot,
            session: {
                outfit: sess.outfit,
                env: sess.env,
                arousal: sess.arousal,
                tease: sess.tease,
                awareness: sess.awareness,
                thermal: sess.thermal,
                mood: sess.mood,
                moodNote: sess.moodNote,
                moodIntensity: sess.moodIntensity,
                engagement: sess.engagement,
                hardCutStreak: Number(sess.hardCutStreak) || 0,
                clockOffsetMs: Number(sess.clockOffsetMs) || 0,
                lastTimeSkipMs: sess.lastTimeSkipMs,
                lastTimeSkipReason: sess.lastTimeSkipReason,
                lastOutfitDetail: sess.lastOutfitDetail || null,
                mode: sess.mode,
                _storyActive: sess._storyActive,
                lastStoryAt: sess.lastStoryAt,
                awakeningActive: sess.awakeningActive,
                awakeningStage: sess.awakeningStage,
                pendingWorldBeat: cloneJson(sess.pendingWorldBeat),
                operatorOverrides: cloneJson(sess.operatorOverrides || {}),
                _lastUserInput: sess._lastUserInput,
                memoryLedger: cloneJson(sess.memoryLedger || []),
                turnsSinceCallback: Number(sess.turnsSinceCallback) || 0,
                // recordShotType / recordGoonCombo fire in applyShotVarianceLock, which
                // runs *before* the image is generated. Without these four, cancelling
                // mid-generation leaves a phantom entry in the avoid-list — and with
                // only four shot types, that measurably skews the next photo's framing.
                lastShotType: sess.lastShotType ?? null,
                shotHistory: cloneJson(sess.shotHistory || []),
                lastGoonCombo: sess.lastGoonCombo ?? null,
                goonLookHistory: cloneJson(sess.goonLookHistory || [])
            }
        };
    }

    /**
     * Undo a cancelled in-flight turn: chat bubbles, phone cards, metrics, clock,
     * world beat, and put the cancelled message back in the composer for editing.
     */
    function rollbackCancelledTurn(checkpoint, { restoreInput = true } = {}) {
        const cp = checkpoint || activeTurnCheckpoint;
        if (!cp || cp.restored) return false;
        cp.restored = true;
        if (activeTurnCheckpoint === cp) activeTurnCheckpoint = null;

        const sess = S().session;
        if (!sess) return false;

        // Turn already committed to history — leave the last completed state alone.
        if (Array.isArray(sess.history) && sess.history.length > cp.historyLength) {
            return false;
        }

        if (Array.isArray(sess.uiLog) && Number.isFinite(cp.uiLogLength)) {
            sess.uiLog = sess.uiLog.slice(0, Math.max(0, cp.uiLogLength));
        }

        const log = document.getElementById('chatLog');
        if (log) {
            while (log.children.length > cp.chatLogLength) {
                log.removeChild(log.lastChild);
            }
        }

        const feed = document.getElementById('phoneFeed');
        if (feed) {
            const cards = [...feed.querySelectorAll(':scope > .phone-card')];
            while (cards.length > cp.phoneCardCount) {
                const card = cards.pop();
                card?.remove();
            }
            const empty = document.getElementById('phoneEmpty');
            if (empty) {
                empty.hidden = feed.querySelectorAll(':scope > .phone-card').length > 0;
            }
        }

        const snap = cp.session || {};
        sess.outfit = snap.outfit;
        sess.env = snap.env;
        sess.arousal = snap.arousal;
        sess.tease = snap.tease;
        sess.awareness = snap.awareness;
        sess.thermal = snap.thermal;
        sess.mood = snap.mood;
        sess.moodNote = snap.moodNote;
        if (snap.moodIntensity != null) sess.moodIntensity = snap.moodIntensity;
        sess.engagement = snap.engagement;
        if (snap.hardCutStreak != null) sess.hardCutStreak = Number(snap.hardCutStreak) || 0;
        sess.clockOffsetMs = Number(snap.clockOffsetMs) || 0;
        sess.lastTimeSkipMs = snap.lastTimeSkipMs;
        sess.lastTimeSkipReason = snap.lastTimeSkipReason;
        sess.lastOutfitDetail = snap.lastOutfitDetail || null;
        sess.mode = snap.mode;
        sess._storyActive = snap._storyActive;
        sess.lastStoryAt = snap.lastStoryAt;
        sess.awakeningActive = snap.awakeningActive;
        sess.awakeningStage = snap.awakeningStage;
        sess.pendingWorldBeat = cloneJson(snap.pendingWorldBeat);
        sess.operatorOverrides = cloneJson(snap.operatorOverrides) || {};
        sess._lastUserInput = snap._lastUserInput;
        sess.memoryLedger = cloneJson(snap.memoryLedger) || [];
        sess.turnsSinceCallback = Number(snap.turnsSinceCallback) || 0;
        // Shot variance: the lock is recorded before generation, so a cancelled turn
        // must give the avoid-list back or the next photo dodges a shot never taken.
        sess.lastShotType = snap.lastShotType ?? null;
        sess.shotHistory = cloneJson(snap.shotHistory) || [];
        sess.lastGoonCombo = snap.lastGoonCombo ?? null;
        sess.goonLookHistory = cloneJson(snap.goonLookHistory) || [];
        sess._lastChatStampMs = Number(cp.lastChatStampMs) || 0;
        sess.lastAiMessageAt = cp.lastAiMessageAt ?? sess.lastAiMessageAt;
        sess.lastUserMessageAt = cp.lastUserMessageAt ?? sess.lastUserMessageAt;

        lastBuiltImagePrompt = cp.lastBuiltImagePrompt;
        lastResolvedImageUrl = cp.lastResolvedImageUrl;
        lastTurnSnapshot = cp.lastTurnSnapshot;

        MirageLoyaltyUX?.restoreDynamics?.(cp.loyalty);
        MiragePhoneUX?.ensureClockNotBehindStamps?.({ includeDom: true });
        MiragePhoneUX?.syncClockChrome?.();
        MiragePhoneUX?.onTurnCancel?.();
        MiragePendingTurn.clear();
        updateHud();
        syncSimControls();
        updateStoryControls();

        if (restoreInput && cp.userText) {
            const input = document.getElementById('simInput');
            if (input) {
                input.value = cp.userText;
                try { input.focus(); } catch { /* ignore */ }
            }
        }
        return true;
    }

    function clearTurnCheckpoint() {
        activeTurnCheckpoint = null;
    }

    function beginTurnAbort() {
        activeTurnAbort?.abort();
        activeTurnAbort = new AbortController();
        turnInProgress = true;
        updateTurnActionControls();
        return activeTurnAbort.signal;
    }

    function endTurnAbort() {
        activeTurnAbort = null;
        turnInProgress = false;
        updateTurnActionControls();
    }

    function isTurnCancelled(err) {
        return err?.code === 'CANCELLED' || err?.message === 'Turn cancelled';
    }

    function throwCancelled() {
        const err = new Error('Turn cancelled');
        err.code = 'CANCELLED';
        throw err;
    }

    /** Abort / restored checkpoint — call after every await before mutating turn state. */
    function assertTurnLive(signal) {
        if (signal?.aborted || activeTurnCheckpoint?.restored) throwCancelled();
    }

    /**
     * Kill every in-flight / deferred path that could write last-chat content into a
     * new or switched chat (thinking turn, left-on-read hold, proactive timer, retry snap).
     */
    function quarantineChatBoundary() {
        activeTurnAbort?.abort();
        MiragePendingTurn.clear();
        MirageImmersion?.cancelDelivery?.();
        MirageImmersion?.clearPendingDelivery?.();
        MirageImmersion?.clearProactive?.();
        MirageImmersion?.clearNoReplyWatch?.();
        MirageImmersion?.clearSocialHold?.();
        MiragePhoneUX?.onTurnCancel?.();
        MirageLoyaltyUX?.resetSession?.();
        MirageDebugPanel?.setLastTurn?.(null);
        MirageDebugPanel?.setLastPrompt?.(null);
        lastTurnSnapshot = null;
        lastBuiltImagePrompt = null;
        lastResolvedImageUrl = null;
        clearTurnCheckpoint();
        MirageUI.setSimGenerating(false);
        setTurnControlsDisabled(false);
        endTurnAbort();
        hideClockResumeOverlay();
        hideUnresponsiveCapOverlay();
        const sess = S().session;
        if (sess) {
            sess.sessionEpoch = (Number(sess.sessionEpoch) || 0) + 1;
        }
        updateTurnActionControls();
    }

    function turnBoundaryToken() {
        return {
            epoch: Number(S().session.sessionEpoch) || 0,
            chatId: S().session.activeChatId || null
        };
    }

    function isTurnBoundaryValid(token) {
        if (!token) return false;
        const sess = S().session;
        return (Number(sess.sessionEpoch) || 0) === token.epoch
            && (sess.activeChatId || null) === token.chatId;
    }

    function cancelActiveTurn() {
        const hasController = !!activeTurnAbort;
        const hasPending = !!MirageImmersion?.getPendingDelivery?.();
        // Real-time waits drop turnInProgress but keep the AbortController —
        // Cancel must still abort the in-flight delivery choreography.
        if (!turnInProgress && !hasController && !hasPending) {
            MirageImmersion?.clearProactive?.();
            MirageImmersion?.cancelDelivery?.();
            MirageUI.setSimGenerating(false);
            MirageUI.setStatus('ACTIVE', 'active');
            MirageUI.toast('Cleared waiting state.', 'info', { essential: true });
            syncSimControls();
            return;
        }
        activeTurnAbort?.abort();
        MiragePendingTurn.clear();
        MirageImmersion?.cancelDelivery?.();
        MirageImmersion?.clearPendingDelivery?.();
        MirageImmersion?.clearProactive?.();
        MiragePhoneUX?.onTurnCancel?.();
        MirageUI.setSimGenerating(false);
        // Rewind immediately so the cancelled bubble disappears now (catch is idempotent).
        rollbackCancelledTurn(activeTurnCheckpoint, { restoreInput: true });
        setTurnControlsDisabled(false);
        endTurnAbort();
        MirageUI.setStatus('ACTIVE', 'active');
        MirageUI.toast('Turn cancelled — back to last completed message.', 'info', { essential: true });
    }

    function chatHasSentImage() {
        if (lastTurnSnapshot?.imageUrl && !lastTurnSnapshot.imageFailed) return true;
        const chat = MirageChatStore.getActiveChat?.(S());
        if (!chat) return false;
        const turns = typeof MirageChatStore.normalizeTurnImages === 'function'
            ? MirageChatStore.normalizeTurnImages(chat.turnImages)
            : (Array.isArray(chat.turnImages) ? chat.turnImages : []);
        if (turns.some(t => t?.imageKey && !t.imageFailed)) return true;
        if (chat.lastTurn?.imageKey && !chat.lastTurn.imageFailed) return true;
        return false;
    }

    /**
     * Hard busy = thinking / image / finalize mutex.
     * Soft busy = delivery choreography, pending hold, or skippable wall wait.
     */
    function isHardBusy() {
        return !!turnInProgress;
    }

    function isEngineBusy() {
        return isHardBusy()
            || !!activeTurnAbort
            || !!MirageImmersion?.getPendingDelivery?.()
            || !!MirageImmersion?.hasActiveWallWait?.()
            || !!S()?.session?.clockResumeHold;
    }

    /** @deprecated prefer isHardBusy / isEngineBusy — kept for call sites that block new turns */
    function isTurnInProgress() {
        return isHardBusy();
    }

    /**
     * Single source of truth for sim button enable/disable.
     * Grey out when unavailable; only Skip wait hides when irrelevant.
     */
    function syncSimControls() {
        const clockHold = !!S()?.session?.clockResumeHold;
        const hardBusy = isHardBusy();
        const busy = isEngineBusy();
        const canCancel = busy && !clockHold;
        const canSkipWait = !!MirageImmersion?.hasActiveWallWait?.() && !clockHold;
        const hasDirective = !!lastTurnSnapshot?.parsed?.imageDirective
            && !lastTurnSnapshot?.imageSkipped;
        const canRetryFace = !busy && hasDirective;
        const canRetryPrompt = canRetryFace && chatHasSentImage();

        const cancelBtn = document.getElementById('btnCancelTurn');
        const skipWaitBtn = document.getElementById('btnSkipWait');
        const retryFaceBtn = document.getElementById('btnRetryFace');
        const retryPromptBtn = document.getElementById('btnRetryPrompt');
        const viewStoryBtn = document.getElementById('btnViewStory');
        const sendBtn = document.getElementById('btnSendMessage');
        const input = document.getElementById('simInput');
        const emojiBtn = document.getElementById('btnEmojiPicker');
        const genImageCheck = document.getElementById('checkGenerateImage');
        const chatsBtn = document.getElementById('btnOpenChats');
        const profileSelect = document.getElementById('simUserProfileSelect');

        // Cancel stays in the gen bar; enable whenever something is running
        if (cancelBtn) {
            cancelBtn.hidden = false;
            cancelBtn.disabled = !canCancel;
        }

        // Skip wait: only button that appears/disappears by relevance
        if (skipWaitBtn) {
            skipWaitBtn.hidden = !canSkipWait;
            skipWaitBtn.disabled = !canSkipWait;
            skipWaitBtn.classList.toggle('is-ready', canSkipWait);
        }

        // Retries: always visible in sim topbar; grey when busy / unavailable
        if (retryFaceBtn) {
            retryFaceBtn.hidden = false;
            retryFaceBtn.disabled = !canRetryFace;
        }
        if (retryPromptBtn) {
            retryPromptBtn.hidden = false;
            retryPromptBtn.disabled = !canRetryPrompt;
        }

        // Generate IG Story: always available in sim (manual story is always allowed)
        if (viewStoryBtn) {
            viewStoryBtn.hidden = false;
            viewStoryBtn.disabled = busy;
        }

        // Composer: only hard-lock during thinking/image (waits still allow interrupt-send).
        // Clock-resume overlay locks everything until they pick.
        if (sendBtn) sendBtn.disabled = hardBusy || clockHold;
        if (input) input.disabled = hardBusy || clockHold;
        if (emojiBtn) emojiBtn.disabled = hardBusy || clockHold;
        if (genImageCheck) genImageCheck.disabled = hardBusy || clockHold;

        // Navigation / profile that shouldn't race an in-flight op
        if (chatsBtn) chatsBtn.disabled = busy;
        if (profileSelect) profileSelect.disabled = busy;

        MirageControlDeck?.sync?.();
    }

    function updateTurnActionControls() {
        syncSimControls();
    }

    function lastSceneInstantMs() {
        const fromStamps = typeof MiragePhoneUX?.latestSimStampMs === 'function'
            ? MiragePhoneUX.latestSimStampMs(S()?.session, { includeDom: true })
            : 0;
        if (fromStamps > 0) return fromStamps;
        const sess = S()?.session;
        const last = Math.max(
            Number(sess?.lastAiMessageAt) || 0,
            Number(sess?.lastUserMessageAt) || 0
        );
        if (last > 0) return last;
        const her = MiragePhoneUX?.herNow?.();
        const now = her instanceof Date ? her.getTime() : Date.now();
        const gap = Number(sess?.clockResumeHold?.gapMs) || 0;
        return now - gap;
    }

    function clockResumeChoiceInstant(choice) {
        const herTz = MiragePhoneUX?.resolveTimeZone?.(S().profile?.location) || 'UTC';
        if (choice === 'keep') return lastSceneInstantMs();
        if (choice === 'her') return Date.now();
        if (choice === 'user') {
            const userTz = MiragePhoneUX?.userTimeZone?.() || 'UTC';
            const parts = MiragePhoneUX?.getZonedParts?.(new Date(), userTz);
            if (parts && typeof MiragePhoneUX.instantForZonedParts === 'function') {
                return MiragePhoneUX.instantForZonedParts(parts, herTz);
            }
            return Date.now();
        }
        return null;
    }

    function fillClockResumePreviews() {
        const herTz = MiragePhoneUX?.resolveTimeZone?.(S().profile?.location) || 'UTC';
        const fmt = (ms) => {
            if (typeof MiragePhoneUX?.formatClockLong === 'function') {
                return MiragePhoneUX.formatClockLong(new Date(ms), herTz);
            }
            return new Date(ms).toLocaleString();
        };
        const keepEl = document.getElementById('clockResumeKeepPreview');
        const herEl = document.getElementById('clockResumeHerPreview');
        const userEl = document.getElementById('clockResumeUserPreview');
        if (keepEl) keepEl.textContent = fmt(clockResumeChoiceInstant('keep'));
        if (herEl) herEl.textContent = fmt(clockResumeChoiceInstant('her'));
        if (userEl) userEl.textContent = fmt(clockResumeChoiceInstant('user'));
    }

    function showClockResumeOverlay() {
        const overlay = document.getElementById('clockResumeOverlay');
        const panel = document.querySelector('.simulation-panel');
        if (!overlay || !panel) return;
        const gap = Number(S()?.session?.clockResumeHold?.gapMs)
            || Number(MirageImmersion?.wallAbsenceMs?.())
            || 0;
        const lead = document.getElementById('clockResumeLead');
        if (lead) {
            const dur = typeof MirageImmersion?.formatDuration === 'function'
                ? MirageImmersion.formatDuration(gap)
                : `${Math.round(gap / 3600000)}h`;
            lead.textContent = `You've been away for ${dur}. The simulation is paused until you choose how her clock should continue.`;
        }
        fillClockResumePreviews();
        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        panel.classList.add('sim-clock-hold');
        syncSimControls();
        requestAnimationFrame(() => {
            overlay.querySelector('[data-clock-resume]')?.focus();
        });
    }

    function hideClockResumeOverlay() {
        const overlay = document.getElementById('clockResumeOverlay');
        const panel = document.querySelector('.simulation-panel');
        if (overlay) {
            overlay.hidden = true;
            overlay.setAttribute('aria-hidden', 'true');
        }
        panel?.classList.remove('sim-clock-hold');
        syncSimControls();
    }

    function showUnresponsiveCapOverlay() {
        const overlay = document.getElementById('unresponsiveCapOverlay');
        if (!overlay) return;
        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => {
            document.getElementById('btnUnresponsiveCapDismiss')?.focus();
        });
    }

    function hideUnresponsiveCapOverlay() {
        const overlay = document.getElementById('unresponsiveCapOverlay');
        if (!overlay) return;
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
    }

    function dismissUnresponsiveCapOverlay() {
        hideUnresponsiveCapOverlay();
    }

    function applyClockResume(choice) {
        const sess = S()?.session;
        if (!sess || !sess.clockResumeHold) return;
        const key = String(choice || '').trim();
        const target = clockResumeChoiceInstant(key);
        if (target == null || !Number.isFinite(target)) return;

        const herTz = MiragePhoneUX?.resolveTimeZone?.(S().profile?.location) || 'UTC';
        if (key === 'her') {
            sess.clockOffsetMs = 0;
            sess.lastSeenAt = Date.now();
            sess.clockMayLagStamps = true;
            sess._lastChatStampMs = Date.now();
            MiragePhoneUX?.syncClockChrome?.();
        } else if (typeof MiragePhoneUX?.setClockToInstant === 'function') {
            sess.clockMayLagStamps = key !== 'keep';
            MiragePhoneUX.setClockToInstant(target);
            if (sess.clockMayLagStamps) sess._lastChatStampMs = target;
        } else {
            sess.clockOffsetMs = target - Date.now();
            sess.clockMayLagStamps = key !== 'keep';
            if (sess.clockMayLagStamps) sess._lastChatStampMs = target;
        }
        if (key === 'keep') {
            sess.clockMayLagStamps = false;
            MiragePhoneUX?.ensureClockNotBehindStamps?.({ includeDom: true });
        }

        const clockLabel = typeof MiragePhoneUX?.formatClockLong === 'function'
            ? MiragePhoneUX.formatClockLong(MiragePhoneUX.herNow?.() || new Date(), herTz)
            : '';
        const notes = {
            keep: `Clock kept at the last scene${clockLabel ? ` (${clockLabel})` : ''}.`,
            her: `Clock synced to real time in her location${clockLabel ? ` (${clockLabel})` : ''}.`,
            user: `Clock synced to your local time${clockLabel ? ` (${clockLabel} on her clock)` : ''}.`
        };

        sess.clockResumeHold = null;
        hideClockResumeOverlay();
        MirageImmersion?.touchLastAttended?.();
        appendSystemNote(notes[key] || 'Clock updated.', { essential: true });
        MiragePhoneUX?.syncClockChrome?.();
        MiragePhoneUX?.updateChrome?.();
        try { MirageChatStore.saveActiveChat?.(S()); } catch { /* ignore */ }
        MirageImmersion?.catchUpAfterAbsence?.();
        MirageImmersion?.resumeQuietChase?.();
        updateHud();
        syncSimControls();
    }

    function setTurnControlsDisabled(_disabled) {
        // Always derive from live engine state (arg kept for call-site compatibility)
        syncSimControls();
    }

    function captureTurnSnapshot(data) {
        lastTurnSnapshot = { ...data };
        syncSimControls();
    }

    function removeLastPhoneCard() {
        const feed = document.getElementById('phoneFeed');
        if (feed?.lastElementChild) feed.lastElementChild.remove();
    }

    /**
     * Remove the most recent image/media phone card (not a text-only double-text bubble).
     * @returns {{ insertBefore: Element|null, at: number|null }}
     */
    function removeLastImagePhoneCard() {
        const feed = document.getElementById('phoneFeed');
        if (!feed) return { insertBefore: null, at: null };
        const cards = [...feed.querySelectorAll(':scope > .phone-card')];
        for (let i = cards.length - 1; i >= 0; i--) {
            const card = cards[i];
            if (card.classList.contains('phone-card-text-only')) continue;
            const next = card.nextElementSibling;
            const at = Number(card.getAttribute('data-at'));
            card.remove();
            return {
                insertBefore: next,
                at: Number.isFinite(at) ? at : null
            };
        }
        // Fallback: no media card — drop the last card like before
        const last = cards[cards.length - 1];
        if (!last) return { insertBefore: null, at: null };
        const next = last.nextElementSibling;
        const at = Number(last.getAttribute('data-at'));
        last.remove();
        return {
            insertBefore: next,
            at: Number.isFinite(at) ? at : null
        };
    }

    function syncChatLogMode() {
        const log = document.getElementById('chatLog');
        if (!log) return;
        // Bubble layout must stay on even in STORY mode — otherwise DM cells
        // fall back to the tall grey .chat-entry card and look "expanded".
        log.classList.add('chat-log--dm');
        log.classList.toggle('chat-log--story', S().session.mode === 'STORY');
    }

    function normalizeProfileNameAge() {
        const p = S()?.profile;
        if (!p) return;
        const ageSet = p.age != null && String(p.age).trim() !== '';
        if (ageSet || !p.name) return;
        const raw = String(p.name).trim();
        const m = raw.match(/^(.*?),\s*(?:בת\s*)?(\d{1,2})\s*$/u);
        if (!m) return;
        p.name = m[1].trim();
        p.age = m[2];
    }

    function updateHud() {
        normalizeProfileNameAge();
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val ?? '—';
        };
        set('hudPersona', S().session.persona);
        const mode = S().session.mode || 'DM';
        set('hudMode', mode);
        const modeEl = document.getElementById('hudMode');
        if (modeEl) {
            modeEl.className = mode === 'STORY' ? 'hud-mode-story' : 'hud-mode-dm';
        }
        set('hudArousal', S().session.arousal);
        set('hudTease', S().session.tease);
        const aw = S().session.awareness;
        const awLabel = S().session.awakeningActive
            ? `${aw} · ${S().session.awakeningStage || 'crack'}`
            : aw;
        set('hudAwareness', awLabel);
        set('hudThermal', S().session.thermal);
        const mood = S().session.mood || 'Neutral';
        const moodI = Number.isFinite(Number(S().session.moodIntensity))
            ? Number(S().session.moodIntensity)
            : 1;
        set('hudMood', `${mood} · ${moodI}`);
        set('hudOutfit', S().isSceneFieldSet?.(S().session.outfit) ? S().session.outfit : '—');
        set('hudEnv', S().isSceneFieldSet?.(S().session.env) ? S().session.env : '—');
        const eng = Number.isFinite(Number(S().session.engagement))
            ? Number(S().session.engagement)
            : 55;
        set('hudCompliance', MirageLoyaltyUX?.labelOf?.(eng) || String(eng));
        const hudEngEl = document.getElementById('hudCompliance');
        if (hudEngEl && typeof MirageLoyaltyUX?.engagementHueColor === 'function') {
            hudEngEl.style.color = MirageLoyaltyUX.engagementHueColor(eng);
        }
        const wrap = document.getElementById('hudComplianceWrap');
        if (wrap) {
            const band = MirageLoyaltyUX?.bandOf?.(eng)?.id || 'warm';
            wrap.className = `hud-compliance hud-compliance-${band}`;
        }
        syncChatLogMode();
        MirageControlDeck?.sync?.();
        syncUserProfileUi();
        refreshCharacterAvatars();
    }

    function syncUserProfileUi() {
        const wrap = document.getElementById('simUserProfileWrap');
        const select = document.getElementById('simUserProfileSelect');
        if (!wrap || !select) return;

        const inSim = S().session.phase === 'active' || S().session.phase === 'standby';
        wrap.hidden = !inSim;
        if (!inSim) return;

        MirageUserProfiles?.ensureSeed?.();
        const resolved = typeof MirageUserProfiles?.resolveForSession === 'function'
            ? MirageUserProfiles.resolveForSession(S().session)
            : null;
        const profiles = typeof MirageUserProfiles?.list === 'function'
            ? MirageUserProfiles.list()
            : [];

        const options = [];
        const seen = new Set();

        if (resolved?.deleted && resolved.id) {
            options.push({
                value: resolved.id,
                label: resolved.label,
                deleted: true
            });
            seen.add(resolved.id);
        }

        profiles.forEach(p => {
            if (seen.has(p.id)) return;
            options.push({ value: p.id, label: p.label, deleted: false });
            seen.add(p.id);
        });

        if (!options.length) {
            options.push({ value: '', label: 'None', deleted: false });
        }

        const current = resolved?.id || '';
        select.innerHTML = options.map(o => {
            const selected = o.value === current ? ' selected' : '';
            return `<option value="${escapeHtml(o.value)}"${selected}>${escapeHtml(o.label)}</option>`;
        }).join('');

        // If chat has no pin yet but settings has active, show active without rewriting chat
        if (!S().session.userProfileId && resolved?.id && !resolved.deleted) {
            select.value = resolved.id;
        }

        wrap.classList.toggle('is-deleted', !!resolved?.deleted);
    }

    async function setChatUserProfile(profileId) {
        const id = String(profileId || '').trim();
        if (!id) {
            MirageUI.toast('Pick a user profile.', 'error');
            syncUserProfileUi();
            return false;
        }

        const prevId = S().session.userProfileId || null;
        const prevLabel = S().session.userProfileLabel || null;
        const live = MirageUserProfiles?.get?.(id);
        if (live) {
            S().session.userProfileId = live.id;
            S().session.userProfileLabel = live.label;
        } else if (S().session.userProfileId === id) {
            // Keep deleted selection as-is
            syncUserProfileUi();
            return true;
        } else {
            MirageUI.toast('That user profile no longer exists.', 'error');
            syncUserProfileUi();
            return false;
        }

        const switched = prevId && prevId !== live.id;
        // Soft continuity cue for the next thinking turn (live dossier already updates).
        S().session._operatorProfileSwitchNote = switched
            ? `OPERATOR PROFILE SWITCHED mid-chat from “${prevLabel || 'previous'}” to “${live.label}”. Treat the new operator profile as who she is talking to now — keep continuity, do not restart the relationship from scratch unless the new details clearly demand it.`
            : `OPERATOR PROFILE set to “${live.label}” for this chat. Use the operator dossier as ground truth.`;

        try {
            await MirageChatStore.saveActiveChat?.(S(), {});
            if (switched) {
                appendCaption(`You’re now “${live.label}” in this chat.`);
            }
            MirageUI.toast(
                switched
                    ? `Switched to “${live.label}” — next replies use that profile.`
                    : `This chat now uses “${live.label}”.`,
                'success',
                { essential: true }
            );
            syncUserProfileUi();
            MirageDebugPanel?.refresh?.();
            return true;
        } catch (e) {
            if (typeof MirageUI?.isStorageQuotaError === 'function' && MirageUI.isStorageQuotaError(e)) {
                MirageUI.showStorageFullDialog({ context: 'Could not update this chat’s user profile.' });
            } else {
                MirageUI.toast(e.message || 'Could not update user profile.', 'error');
            }
            syncUserProfileUi();
            return false;
        }
    }

    function consumeOperatorProfileSwitchNote() {
        const note = S().session?._operatorProfileSwitchNote;
        if (!note) return '';
        S().session._operatorProfileSwitchNote = null;
        return note;
    }

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /** Master-face photo when locked; otherwise name initial. */
    function characterAvatarHtml({ className = 'phone-avatar', name = null } = {}) {
        const label = name || S().profile?.name || 'Character';
        const initial = String(label).charAt(0).toUpperCase() || '?';
        const src = S().masterFaceObjectUrl || null;
        if (src) {
            return `<span class="${escapeHtml(className)} ${escapeHtml(className)}--photo" aria-hidden="true">`
                + `<img src="${escapeHtml(src)}" alt="" class="char-avatar-img">`
                + `</span>`;
        }
        return `<span class="${escapeHtml(className)}" aria-hidden="true">${escapeHtml(initial)}</span>`;
    }

    function refreshCharacterAvatars() {
        const src = S().masterFaceObjectUrl || null;
        const name = S().profile?.name || 'Character';
        const initial = String(name).charAt(0).toUpperCase() || '?';

        const headerAvatar = document.getElementById('phoneHeaderAvatar');
        if (headerAvatar) {
            headerAvatar.className = 'phone-header-avatar'
                + (src ? ' phone-header-avatar--photo' : '');
            if (src) {
                let img = headerAvatar.querySelector('img.char-avatar-img');
                if (!img) {
                    headerAvatar.textContent = '';
                    img = document.createElement('img');
                    img.className = 'char-avatar-img';
                    img.alt = '';
                    headerAvatar.appendChild(img);
                }
                if (img.getAttribute('src') !== src) img.src = src;
            } else {
                headerAvatar.textContent = initial;
            }
        }

        const headerName = document.getElementById('phoneHeaderName');
        if (headerName) headerName.textContent = name;

        document.querySelectorAll('.phone-avatar, .ig-avatar, .story-avatar').forEach((node) => {
            const base = node.classList.contains('ig-avatar')
                ? 'ig-avatar'
                : (node.classList.contains('story-avatar') ? 'story-avatar' : 'phone-avatar');
            if (src) {
                node.classList.add(`${base}--photo`);
                let img = node.querySelector('img.char-avatar-img');
                if (!img) {
                    node.textContent = '';
                    img = document.createElement('img');
                    img.className = 'char-avatar-img';
                    img.alt = '';
                    node.appendChild(img);
                }
                if (img.getAttribute('src') !== src) img.src = src;
            } else {
                node.classList.remove('phone-avatar--photo', 'ig-avatar--photo', 'story-avatar--photo');
                node.textContent = initial;
            }
        });
    }

    function chatStampMs(at) {
        if (at != null && Number.isFinite(Number(at))) return Number(at);
        if (typeof at === 'string' && at.trim()) {
            const parsed = Date.parse(at);
            if (Number.isFinite(parsed)) return parsed;
        }
        if (typeof MirageImmersion?.simNowMs === 'function') return MirageImmersion.simNowMs();
        if (typeof MiragePhoneUX?.herNow === 'function') return MiragePhoneUX.herNow().getTime();
        return Date.now();
    }

    /** Monotonic sim stamp so a bubble never shows earlier than the previous chat line. */
    function nextChatStampMs(at) {
        const explicit = at != null && Number.isFinite(Number(at));
        let stamp = chatStampMs(at);
        const sess = S().session;
        const prev = Number(sess?._lastChatStampMs) || 0;
        if (prev > 0 && stamp < prev && !explicit) {
            // New unstamped line while the pointer sits ahead of "now" — pull the
            // engine forward. Never do this for an explicit history `at`: rebuild
            // used to stamp the "Simulation live" banner at wall-now, then treat
            // every restored bubble as going backwards and add ~1 minute per line.
            // Also skip when the operator rewound onto real time (clockMayLagStamps).
            if (!sess?.clockMayLagStamps) {
                MiragePhoneUX?.ensureClockNotBehindStamps?.({ includeDom: false });
                stamp = chatStampMs();
                if (stamp < prev) {
                    stamp = prev + Math.max(30 * 1000, Math.floor(Math.random() * 90 * 1000));
                    const live = chatStampMs();
                    if (stamp > live + 2000 && typeof MiragePhoneUX?.setClockToInstant === 'function') {
                        MiragePhoneUX.setClockToInstant(stamp);
                    }
                }
            }
        }
        if (sess) {
            sess._lastChatStampMs = sess.clockMayLagStamps
                ? stamp
                : Math.max(prev, stamp);
        }
        return stamp;
    }

    function formatChatTime(at) {
        const stamp = typeof at === 'number' ? at : chatStampMs(at);
        const now = typeof MirageImmersion?.simNowMs === 'function'
            ? MirageImmersion.simNowMs()
            : (typeof MiragePhoneUX?.herNow === 'function'
                ? MiragePhoneUX.herNow().getTime()
                : Date.now());
        const age = now - stamp;
        const tz = MiragePhoneUX?.resolveTimeZone?.(S().profile?.location);
        const date = new Date(stamp);
        const clock = typeof MiragePhoneUX?.formatClock === 'function'
            ? MiragePhoneUX.formatClock(date, tz)
            : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

        // After a real-time rewind, older /next scene bubbles can sit in the sim-future.
        if (age < -2000) {
            try {
                const dayFmt = new Intl.DateTimeFormat('en-US', {
                    timeZone: tz || undefined,
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric'
                });
                return `${dayFmt.format(date)} · ${clock}`;
            } catch {
                return clock;
            }
        }

        const days = typeof MiragePhoneUX?.calendarDaysAgo === 'function'
            ? MiragePhoneUX.calendarDaysAgo(stamp, now, tz)
            : Math.max(0, Math.floor(age / (24 * 60 * 60 * 1000)));

        // WhatsApp: anything before today's 12:00 AM is yesterday; each midnight adds a day.
        if (days <= 0) {
            if (age >= 0 && age < 60 * 1000) return `Just now · ${clock}`;
            return clock;
        }
        if (days === 1) return `Yesterday · ${clock}`;
        return `${days} days ago · ${clock}`;
    }

    /** Recompute bubble stamps after clock jumps (day/week-relative labels). */
    function refreshChatTimestamps() {
        const log = document.getElementById('chatLog');
        if (!log) return;
        log.querySelectorAll('.chat-entry[data-at] .chat-time').forEach(el => {
            const entry = el.closest('.chat-entry');
            const at = Number(entry?.getAttribute('data-at'));
            if (!Number.isFinite(at)) return;
            el.textContent = formatChatTime(at);
        });
        refreshPhoneCardChrome();
    }

    function dmPresenceKicker(_isLatest) {
        // Presence / last-seen lives in the WhatsApp-style phone header only.
        return '';
    }

    /** Refresh phone-card meta times on feed cards. */
    function refreshPhoneCardChrome() {
        const feed = document.getElementById('phoneFeed');
        if (!feed) return;
        feed.querySelectorAll(':scope > .phone-card').forEach((card) => {
            const at = Number(card.getAttribute('data-at'));
            const meta = card.querySelector('.phone-card-meta');
            if (meta && Number.isFinite(at)) {
                meta.textContent = formatChatTime(at);
            }
        });
    }

    function looksLikeSlashCommand(text) {
        return /^\/\w/.test(String(text || '').trim());
    }

    /** Internal history placeholders — never render as operator bubbles. */
    function isInternalUserMarker(text) {
        const t = String(text || '').trim();
        if (!t) return true;
        if (/^\[(continued|story launch|proactive|world_skip|next_scene|jump|time_pass)\]$/i.test(t)) return true;
        return looksLikeLeakedInstruction(t);
    }

    /** Double-text follow-up — no new still; do not steal the previous card's image. */
    function isDoubleTextFollowUp(text) {
        return /^\[continued\]$/i.test(String(text || '').trim());
    }

    /** Internal AI placeholders — never render as her chat bubbles. */
    function isInternalAiMarker(text) {
        const t = String(text || '').trim();
        if (!t) return true;
        if (/^\[reaction\b/i.test(t)) return true;
        return looksLikeLeakedInstruction(t);
    }

    function looksLikeLeakedInstruction(text) {
        const t = String(text || '').trim();
        return /^(PROACTIVE\s+(BEAT|STORY)|CLIENT NOTE|COMMAND CONTEXT|USER INPUT:|AWAKENING CONTEXT)/i.test(t);
    }

    function historyUserLine(internal, storyLaunch, text) {
        if (storyLaunch) return '[Story launch]';
        if (internal) return '[proactive]';
        return text;
    }

    let uiLogSaveTimer = null;

    function flushUiLogSave() {
        if (uiLogSaveTimer) {
            clearTimeout(uiLogSaveTimer);
            uiLogSaveTimer = null;
        }
        try {
            MirageChatStore.saveActiveChat?.(S())?.catch?.(() => {});
        } catch { /* ignore */ }
    }

    function scheduleUiLogSave() {
        if (uiLogSaveTimer) clearTimeout(uiLogSaveTimer);
        uiLogSaveTimer = setTimeout(() => {
            uiLogSaveTimer = null;
            flushUiLogSave();
        }, 200);
    }

    function pushUiLog(entry) {
        const sess = S()?.session;
        if (!sess || !entry) return;
        if (!Array.isArray(sess.uiLog)) sess.uiLog = [];
        sess.uiLog.push(entry);
        const cap = 120;
        if (sess.uiLog.length > cap) sess.uiLog = sess.uiLog.slice(-cap);
        scheduleUiLogSave();
    }

    function appendChat(role, text, {
        system = false,
        caption = false,
        alert = false,
        alertType = 'warn',
        title = '',
        body = '',
        label = null,
        isCommand = false,
        clockArrow = null,
        at = null,
        persist = null,
        touchClock = true
    } = {}) {
        const log = document.getElementById('chatLog');
        if (!log) return;
        syncChatLogMode();

        const stampMs = touchClock === false
            ? (at != null ? chatStampMs(at) : null)
            : nextChatStampMs(at);
        const timeLabel = stampMs != null && !(system || role === 'system' || alert)
            ? formatChatTime(stampMs)
            : '';
        const timeHtml = timeLabel
            ? `<span class="chat-time">${escapeHtml(timeLabel)}</span>`
            : '';
        const entry = document.createElement('div');
        if (!(system || role === 'system' || alert) && stampMs != null) {
            entry.setAttribute('data-at', String(stampMs));
        }
        const commandBubble = role === 'user' && (isCommand || looksLikeSlashCommand(text));
        const clockNote = clockArrow ? String(clockArrow).trim() : '';

        if (alert) {
            entry.className = `chat-entry chat-alert chat-alert-${alertType}`;
            entry.innerHTML = `
                <div class="chat-alert-box">
                    <span class="chat-alert-icon">${alertType === 'image-fail' ? '⚠' : 'ℹ'}</span>
                    <div class="chat-alert-text">
                        <strong>${escapeHtml(title || 'Notice')}</strong>
                        <p>${escapeHtml(body || text || '')}</p>
                    </div>
                </div>`;
        } else if (system || role === 'system' || caption) {
            entry.className = 'chat-entry chat-caption';
            entry.innerHTML = `<span class="chat-caption-text">${escapeHtml(text)}</span>`;
        } else if (commandBubble) {
            entry.className = 'chat-entry chat-command chat-user';
            entry.innerHTML = `
                <span class="chat-command-text">${escapeHtml(text)}</span>
                ${clockNote ? `<span class="chat-command-clock">${escapeHtml(clockNote)}</span>` : ''}
                ${timeHtml}`;
        } else if (role === 'ai' && label === 'STORY') {
            // Only this turn's Story caption — never paint DMs as STORY because mode is still STORY
            entry.className = `chat-entry chat-story chat-${role}`;
            entry.innerHTML = `
                <span class="chat-story-badge">STORY</span>
                <div class="chat-story-body">${escapeHtml(text)}</div>
                ${timeHtml}`;
        } else {
            // Instagram-style DM bubbles
            const isUser = role === 'user';
            const name = S().profile?.name || 'Her';
            entry.className = `chat-entry chat-${role} chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-ai'}`;
            entry.innerHTML = isUser
                ? `<div class="chat-bubble-stack chat-bubble-stack-out">
                     <div class="ig-bubble ig-bubble-out">${escapeHtml(text)}</div>
                     ${timeHtml}
                   </div>`
                : `${characterAvatarHtml({ className: 'ig-avatar', name })}
                   <div class="chat-bubble-stack chat-bubble-stack-in">
                     <div class="ig-bubble ig-bubble-in">${escapeHtml(text)}</div>
                     ${timeHtml}
                   </div>`;
        }

        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;

        const sess = S()?.session;
        if (sess && persist !== false && !(system || role === 'system' || alert)) {
            if (role === 'user') sess.lastUserMessageAt = stampMs;
            if (role === 'ai') sess.lastAiMessageAt = stampMs;
        }

        // Persist system / CMD / decision / alert lines with the chat (skip scaffold rebuilds).
        const shouldPersist = persist != null
            ? !!persist
            : !!(alert || system || role === 'system' || caption || commandBubble);
        if (shouldPersist && S()?.session) {
            let kind = 'caption';
            if (alert) kind = 'alert';
            else if (commandBubble) kind = 'command';

            pushUiLog({
                kind,
                text: String(text || ''),
                label: null,
                devOnly: false,
                clockArrow: clockNote || null,
                alertType: alert ? (alertType || 'warn') : null,
                title: alert ? (title || '') : null,
                body: alert ? (body || text || '') : null,
                at: stampMs || Date.now()
            });
        }

        return entry;
    }

    /** Show/hide developer-only chat lines when Dev Mode is toggled mid-sim. */
    function syncChatDevVisibility() {
        const show = !!S()?.developerMode;
        document.querySelectorAll('#chatLog .chat-entry[data-dev-only]').forEach((el) => {
            el.hidden = !show;
        });
    }

    function appendImageFailureAlert(reason, detail) {
        const { title, body } = MirageAPI.imageFailureMessage(reason, detail);
        console.warn('[Mirage] image failure:', reason, detail || body);
        appendChat('system', '', {
            alert: true,
            alertType: 'image-fail',
            title,
            body
        });
    }

    /**
     * Fold the model's tracking block into session state.
     *
     * Authority rules: the operator owns persona and mode outright — the model only
     * echoes them. Numeric metrics belong to the model except where the operator
     * pinned one this turn, in which case the pin wins and the model resumes from it.
     * lockOutfit / lockEnv keep last-frame wardrobe/location when the thinking model
     * invents a new look on a same-scene follow-up (common with lite models).
     */
    function applyTracking(tracking, { parsed = null, lockOutfit = false, lockEnv = false, resume = false } = {}) {
        if (!tracking) return;
        const sess = S().session;
        const pinned = sess.operatorOverrides || {};
        const prevOutfit = sess.outfit;
        const prevEnv = sess.env;
        const sceneSet = (v) => (typeof S().isSceneFieldSet === 'function'
            ? S().isSceneFieldSet(v)
            : !!(v && String(v).trim() && !/^(|default|awaiting trigger|unset|—|-|none)$/i.test(String(v).trim())));

        function classifySceneSource(kind, label) {
            const edf = S().edf;
            const bank = kind === 'outfit'
                ? edf?.VISUAL_ANCHORS?.OUTFIT_LIBRARY
                : (edf?.ENV_ATLAS_TOP_5 || edf?.VISUAL_ANCHORS?.ENV_ATLAS);
            if (kind === 'outfit' && typeof MiragePrompt?.matchOutfitToLibrary === 'function') {
                const scored = MiragePrompt.matchOutfitToLibrary(bank, label, {});
                if (scored && scored.score >= 80) {
                    return { fromRefs: true, matched: scored.label, score: scored.score };
                }
            }
            const hit = typeof MiragePrompt?.findOutfitLibraryEntry === 'function'
                ? MiragePrompt.findOutfitLibraryEntry(bank, label)
                : null;
            if (!hit) return { fromRefs: false, matched: String(label || '') };
            const matched = (hit && typeof hit === 'object')
                ? (hit.Label || hit.label || hit.Name || hit.name || label)
                : label;
            return { fromRefs: true, matched: String(matched || label) };
        }

        function outfitHasStill(label) {
            return !!(typeof MirageMediaLibrary?.resolveOutfitPhoto === 'function'
                && MirageMediaLibrary.resolveOutfitPhoto(S(), label));
        }

        function logSceneShift(kind, from, to, extra = {}) {
            const next = String(to || '').trim();
            if (!next || next === from) return;
            const src = classifySceneSource(kind, next);
            const noun = kind === 'outfit' ? 'Outfit' : 'Env';
            let origin;
            if (!src.fromRefs) origin = 'invented';
            else if (kind === 'outfit' && outfitHasStill(src.matched || next)) origin = 'library still';
            else origin = kind === 'outfit' ? 'library ref' : 'atlas ref';
            const verb = sceneSet(from) ? '→' : 'established ·';
            const snapped = extra.snappedFrom ? ` ← was “${extra.snappedFrom}”` : '';
            appendDebugDecision({
                kind: 'scene',
                summary: `${noun} ${verb} ${origin} “${src.matched || next}”${snapped}`,
                detail: {
                    from: from || null,
                    to: src.matched || next,
                    source: src.fromRefs ? (origin === 'library still' ? 'library-still' : 'library') : 'invented',
                    matched: src.matched,
                    snappedFrom: extra.snappedFrom || null,
                    hasStill: kind === 'outfit' ? outfitHasStill(src.matched || next) : null
                }
            });
            if (kind === 'env' && sess._sceneCutFromEnv && typeof MiragePrompt?.placeFamily === 'function') {
                const prevF = MiragePrompt.placeFamily(sess._sceneCutFromEnv);
                const nextF = MiragePrompt.placeFamily(next);
                if (prevF && nextF && prevF === nextF) {
                    appendDebugDecision({
                        kind: 'scene',
                        summary: `Env same-family after PLACE CUT (${prevF}) — “${sess._sceneCutFromEnv}” → “${next}”`,
                        detail: { from: sess._sceneCutFromEnv, to: next, family: prevF }
                    });
                }
            }
        }

        // persona and mode are deliberately ignored — client-owned.

        const holdOutfit = lockOutfit && sceneSet(prevOutfit)
            && !sess._changeOutfitThisTurn && !sess._godModeThisTurn;

        if (holdOutfit) {
            const proposed = tracking.outfit != null ? String(tracking.outfit).trim() : '';
            if (proposed && proposed !== prevOutfit) {
                appendDebugDecision({
                    kind: 'scene',
                    summary: `Outfit lock kept ${prevOutfit}`,
                    detail: { from: prevOutfit, proposed }
                });
            }
            tracking.outfit = prevOutfit;
            if (!sess.outfitSource && prevOutfit) {
                sess.outfitSource = classifySceneSource('outfit', prevOutfit).fromRefs ? 'library' : 'invented';
            }
            if (parsed) {
                if (!parsed.imageDirective || typeof parsed.imageDirective !== 'object') {
                    parsed.imageDirective = {};
                }
                const locked = String(sess.lastOutfitDetail || '').trim()
                    || `Exact same clothes as the last frame (${prevOutfit}) — same garments, colors, sleeve length`;
                parsed.imageDirective.outfitDetail = locked;
            }
        } else if (tracking.outfit != null && String(tracking.outfit).trim()) {
            let next = String(tracking.outfit).trim();
            let snappedFrom = null;
            const lib = S().edf?.VISUAL_ANCHORS?.OUTFIT_LIBRARY;
            const hint = String(sess._outfitLookHintThisTurn || '').trim();
            if (lib && typeof MiragePrompt?.matchOutfitToLibrary === 'function') {
                const already = classifySceneSource('outfit', next);
                if (already.fromRefs && already.matched && already.matched !== next) {
                    snappedFrom = next;
                    next = already.matched;
                    tracking.outfit = next;
                } else if (!already.fromRefs) {
                    const query = hint || next;
                    const hit = MiragePrompt.matchOutfitToLibrary(lib, query, { exclude: prevOutfit });
                    const threshold = hint ? 48 : 72;
                    const specificMiss = !!(hint && (!hit || hit.score < threshold));
                    if (!specificMiss && hit && hit.score >= threshold && hit.label !== next) {
                        snappedFrom = next;
                        next = hit.label;
                        tracking.outfit = next;
                        const libDetail = String(
                            hit.entry?.Description
                            || hit.entry?.description
                            || hit.entry?.Detail
                            || ''
                        ).trim();
                        if (parsed?.imageDirective && libDetail) {
                            parsed.imageDirective.outfitDetail = libDetail;
                        }
                    }
                }
            }
            if (next !== sess.outfit) {
                logSceneShift('outfit', sess.outfit, next, { snappedFrom });
            }
            sess.outfit = next;
            const src = classifySceneSource('outfit', next);
            sess.outfitSource = src.fromRefs ? 'library' : 'invented';
            const detail = parsed?.imageDirective?.outfitDetail;
            if (detail && String(detail).trim()) {
                sess.lastOutfitDetail = String(detail).trim();
            }
        }

        if (typeof MiragePrompt?.ensureOutfitCoverage === 'function'
            && parsed
            && (holdOutfit || sceneSet(sess.outfit))) {
            if (!parsed.imageDirective || typeof parsed.imageDirective !== 'object') {
                parsed.imageDirective = {};
            }
            const before = String(parsed.imageDirective.outfitDetail || sess.lastOutfitDetail || '').trim();
            const sameLook = holdOutfit || String(sess.outfit || '') === String(prevOutfit || '');
            const stamped = MiragePrompt.ensureOutfitCoverage(before, {
                label: sess.outfit || tracking.outfit || '',
                goon: sess.persona === 'Goon',
                previousDetail: sameLook ? (sess.lastOutfitDetail || '') : ''
            });
            if (stamped) {
                parsed.imageDirective.outfitDetail = stamped;
                sess.lastOutfitDetail = stamped;
                if (before && stamped !== before) {
                    appendDebugDecision({
                        kind: 'scene',
                        summary: 'Outfit coverage: named missing top/bottoms',
                        detail: { from: before, to: stamped }
                    });
                }
            }
        }

        if (lockEnv && sceneSet(prevEnv) && !sess._changePlaceThisTurn && !sess._godModeThisTurn) {
            const proposed = tracking.env != null ? String(tracking.env).trim() : '';
            if (proposed && proposed !== prevEnv) {
                appendDebugDecision({
                    kind: 'scene',
                    summary: `Env lock kept ${prevEnv}`,
                    detail: { from: prevEnv, proposed }
                });
            }
            tracking.env = prevEnv;
            if (parsed?.imageDirective && sess.env) {
                const envDetail = String(parsed.imageDirective.envDetail || '').trim();
                if (!envDetail) parsed.imageDirective.envDetail = prevEnv;
            }
        } else if (tracking.env != null && String(tracking.env).trim()) {
            const next = String(tracking.env).trim();
            if (next !== sess.env) {
                logSceneShift('env', sess.env, next);
            }
            sess.env = next;
        }

        ['arousal', 'tease', 'awareness'].forEach(key => {
            if (pinned[key] != null) return;
            if (tracking[key] == null) return;
            // Awakening owns awareness — model cannot lower it or stall the sequence.
            if (key === 'awareness' && sess.awakeningActive) {
                const proposed = MiragePrompt.clampNumber(
                    tracking[key],
                    S().METRIC_RANGES.awareness[0],
                    S().METRIC_RANGES.awareness[1],
                    sess.awareness || 0
                );
                if (proposed > (sess.awareness || 0)) {
                    sess.awareness = Math.round(proposed);
                    sess.awakeningStage = MiragePrompt.awakeningStageFromAwareness(sess.awareness);
                }
                return;
            }
            const clamped = MiragePrompt.clampNumber(
                tracking[key],
                S().METRIC_RANGES[key][0],
                S().METRIC_RANGES[key][1],
                sess[key] || 0
            );
            if (key === 'arousal' && typeof MirageLoyaltyUX?.limitArousalRise === 'function') {
                const libido = MirageLoyaltyUX.ensureLibido?.(S().profile, S().edf);
                sess.arousal = MirageLoyaltyUX.limitArousalRise(sess.arousal, clamped, libido);
            } else if (key === 'tease' && typeof MirageLoyaltyUX?.limitTeaseChange === 'function') {
                sess.tease = MirageLoyaltyUX.limitTeaseChange(
                    sess.tease,
                    clamped,
                    S().profile,
                    S().edf
                );
            } else {
                sess[key] = Math.round(clamped);
            }
        });
        if (sess.persona === 'Goon' && pinned.tease == null && (Number(sess.tease) || 0) < 1) {
            sess.tease = 1;
        }

        if (pinned.thermal == null && tracking.thermal != null) {
            const thermal = S().THERMAL_VALUES.find(
                v => v.toLowerCase() === String(tracking.thermal).trim().toLowerCase()
            );
            if (thermal) sess.thermal = thermal;
        } else if (pinned.thermal == null) {
            // Soft nudge when model omits thermal — scene / arousal / skip hints
            const nudged = softNudgeThermal(sess, parsed, {
                useArousal: !sess._skipWeather
            });
            if (nudged && nudged !== sess.thermal) {
                const prev = sess.thermal;
                sess.thermal = nudged;
                appendDebugDecision({
                    kind: 'thermal',
                    summary: `Thermal nudge ${prev} → ${nudged}`,
                    detail: { from: prev, to: nudged, reason: 'client soft nudge' }
                });
            }
        }

        if (!resume && pinned.thermal == null && sess.thermalPinExpired) {
            const prev = sess.thermal;
            const next = thermalAfterPinExpired(sess, parsed);
            if (next && next !== prev) {
                sess.thermal = next;
                appendDebugDecision({
                    kind: 'thermal',
                    summary: `Thermal pin expired ${prev} → ${next}`,
                    detail: { from: prev, to: next, reason: 'one-turn pin expired' }
                });
            }
            sess.thermalPinExpired = false;
            sess.thermalPinnedEnv = '';
        }

        if (pinned.mood == null && tracking.mood != null && String(tracking.mood).trim()) {
            const nextMood = typeof MiragePrompt?.normalizeMood === 'function'
                ? MiragePrompt.normalizeMood(tracking.mood)
                : String(tracking.mood).trim().slice(0, 40);
            if (nextMood && nextMood !== sess.mood) {
                const prev = sess.mood;
                sess.mood = nextMood;
                appendDebugDecision({
                    kind: 'mood',
                    summary: `Mood ${prev || '—'} → ${nextMood}`,
                    detail: { from: prev, to: nextMood }
                });
            } else if (nextMood) {
                sess.mood = nextMood;
            }
        }

        if (pinned.moodIntensity == null && tracking.moodIntensity != null) {
            const nextI = MiragePrompt.clampNumber(
                tracking.moodIntensity,
                S().METRIC_RANGES.moodIntensity[0],
                S().METRIC_RANGES.moodIntensity[1],
                sess.moodIntensity ?? 1
            );
            const rounded = Math.round(nextI);
            if (rounded !== sess.moodIntensity) {
                appendDebugDecision({
                    kind: 'mood',
                    summary: `Mood intensity ${sess.moodIntensity ?? '—'} → ${rounded}`,
                    detail: { from: sess.moodIntensity, to: rounded }
                });
            }
            sess.moodIntensity = rounded;
        }

        if (typeof MirageLoyaltyUX?.enforceSkipWeatherCeiling === 'function' && sess._skipWeather) {
            const ceiling = MirageLoyaltyUX.enforceSkipWeatherCeiling(sess, parsed, {
                profile: S().profile,
                edf: S().edf
            });
            if (ceiling) logSkipWeather(sess._skipWeather, ceiling);
        }

        // Engagement is written once in afterTurn (rise clamp). Writing here would stack.

        if (sess.mode === 'STORY') sess._storyActive = true;
        updateHud();
    }

    function logSkipWeather(plan, extra = null) {
        if (!plan) return;
        const bits = [];
        const ch = plan.changes || extra || {};
        if (ch.mood) bits.push(`mood ${ch.mood.from} → ${ch.mood.to}`);
        if (ch.arousal) bits.push(`arousal ${ch.arousal.from} → ${ch.arousal.to}`);
        if (ch.tease) bits.push(`tease ${ch.tease.from} → ${ch.tease.to}`);
        if (ch.thermal) bits.push(`thermal ${ch.thermal.from} → ${ch.thermal.to}`);
        if (extra) {
            Object.entries(extra).forEach(([k, v]) => {
                if (!v || ch[k]) return;
                bits.push(`${k} ${v.from} → ${v.to}`);
            });
        }
        const span = plan.skipMs
            ? (typeof MirageImmersion?.formatDuration === 'function'
                ? MirageImmersion.formatDuration(plan.skipMs)
                : `${Math.round(plan.skipMs / 3600000)}h`)
            : 'cut';
        appendDebugDecision({
            kind: 'weather',
            summary: bits.length
                ? `Skip weather · ${span}${plan.hardCut ? ` · cut ×${plan.streak || 1}` : ''} · ${bits.join(' · ')}`
                : `Skip weather · ${span}${plan.hardCut ? ` · cut ×${plan.streak || 1}` : ''} · engagement rise blocked`,
            detail: { ...plan, ceiling: extra || null }
        });
    }

    /** Soft thermal when model forgot — raise only; never overrides pin. */
    function softNudgeThermal(sess, parsed, { useArousal = true } = {}) {
        const arousal = Number(sess?.arousal) || 0;
        const reason = String(parsed?.delivery?.timeSkipReason || '').toLowerCase();
        const env = String(sess?.env || parsed?.tracking?.env || '').toLowerCase();
        const dir = String(parsed?.imageDirective?.lighting || '').toLowerCase();
        const blob = `${reason} ${env} ${dir}`;
        if (/overheat|sauna|workout|run|gym|fever|boiling/.test(blob) || (useArousal && arousal >= 85)) {
            return 'Overheating';
        }
        if (/sweat|humid|summer|hot day|cardio|dance|club|beach/.test(blob) || (useArousal && arousal >= 70)) {
            return 'Sweaty';
        }
        return null;
    }

    function thermalRank(t) {
        const v = String(t || 'Normal');
        if (v === 'Overheating') return 2;
        if (v === 'Sweaty') return 1;
        return 0;
    }

    function thermalFromRank(r) {
        if (r >= 2) return 'Overheating';
        if (r >= 1) return 'Sweaty';
        return 'Normal';
    }

    /** After a one-turn /thermal pin: keep heat if the beat still earns it, else walk toward Normal. */
    function thermalAfterPinExpired(sess, parsed) {
        const current = sess?.thermal || 'Normal';
        const rank = thermalRank(current);
        if (rank <= 0) return current;
        const raise = softNudgeThermal(sess, parsed, {
            useArousal: !sess._skipWeather
        });
        if (raise === 'Overheating') return 'Overheating';
        if (raise === 'Sweaty') return rank >= 1 ? current : 'Sweaty';

        const envNow = String(sess?.env || '').trim().toLowerCase();
        const envThen = String(sess?.thermalPinnedEnv || '').trim().toLowerCase();
        const envChanged = !!(envThen && envNow && envThen !== envNow);
        const pose = String(parsed?.imageDirective?.pose || '').toLowerCase();
        const sitting = /sit|couch|bed|desk|scroll|idle|still|lying/.test(`${envNow} ${pose}`);
        const arousal = Number(sess?.arousal) || 0;
        if (envChanged || sitting || arousal < 55) {
            return thermalFromRank(rank - 1);
        }
        return thermalFromRank(rank - 1);
    }

    function clearPhoneFeed() {
        const feed = document.getElementById('phoneFeed');
        const empty = document.getElementById('phoneEmpty');
        if (feed) {
            feed.querySelectorAll('img.phone-card-img').forEach((img) => {
                const src = img.getAttribute('src') || '';
                if (src.startsWith('blob:')) {
                    try { URL.revokeObjectURL(src); } catch { /* ignore */ }
                }
            });
            // innerHTML = '' destroys the #phoneTyping node phone-ux created on demand.
            // Without clearing presence too, any path that wipes the feed mid-typing
            // leaves the header stuck reading "typing…" for a turn that no longer exists.
            MiragePhoneUX?.showTyping?.(false);
            feed.innerHTML = '';
        }
        if (empty) empty.hidden = false;
        if (lastResolvedImageUrl?.startsWith('blob:')) {
            try { URL.revokeObjectURL(lastResolvedImageUrl); } catch (_) { /* ignore */ }
        }
        lastResolvedImageUrl = null;
    }

    function takeMatchingTurnImage(images, histAt, used) {
        const at = Number(histAt);
        if (!Array.isArray(images) || !images.length || !Number.isFinite(at)) return null;
        let best = -1;
        let bestD = Infinity;
        images.forEach((t, i) => {
            if (!t || used.has(i)) return;
            const tAt = Number(t.at);
            if (!Number.isFinite(tAt)) return;
            const d = Math.abs(tAt - at);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        });
        if (best < 0 || bestD > 12000) return null;
        used.add(best);
        return images[best];
    }

    /**
     * Rebuild the phone mockup from full chat history. Stored stills (last N)
     * attach to the matching AI line; everything else comes back as text.
     */
    async function restorePhoneFeedFromChat(chat) {
        const history = Array.isArray(chat?.history) ? chat.history : [];
        const images = typeof MirageChatStore.normalizeTurnImages === 'function'
            ? MirageChatStore.normalizeTurnImages(chat?.turnImages)
            : (Array.isArray(chat?.turnImages) ? chat.turnImages : []);
        const used = new Set();

        for (const turn of history) {
            if (!turn?.ai || isInternalAiMarker(turn.ai)) continue;
            const continued = isDoubleTextFollowUp(turn.user);
            const img = continued ? null : takeMatchingTurnImage(images, turn.at, used);
            let imageUrl = null;
            let imageFailed = !!img?.imageFailed;
            let textOnly = true;
            const mock = !!img?.imageMock;

            if (img?.imageKey && !img.imageFailed) {
                try {
                    imageUrl = await MirageImageStore.getObjectUrl(img.imageKey);
                } catch (e) {
                    console.warn('[Mirage] Could not restore turn image', e);
                }
            }

            if (imageUrl || imageFailed || mock) textOnly = false;
            if (!imageUrl && img?.imageKey && !mock) {
                imageFailed = true;
                textOnly = false;
            }

            renderPhoneCard(
                turn.ai,
                imageUrl,
                turn.mode === 'STORY' ? 'STORY' : 'DM',
                {
                    imageFailed,
                    imageFailReason: img?.imageFailReason || null,
                    textOnly,
                    at: turn.at,
                    mock: mock && !textOnly
                }
            );
        }
    }

    function onPhoneImageError(cardEl, captionText) {
        appendImageFailureAlert('failed', 'The image file could not be loaded in the phone preview.');
        const img = cardEl?.querySelector('.phone-card-img');
        if (img) {
            img.replaceWith(Object.assign(document.createElement('div'), {
                className: 'phone-card-img phone-card-placeholder phone-card-failed',
                textContent: 'Image unavailable'
            }));
        }
        cardEl?.querySelector('.phone-card-expand')?.remove();
    }

    function wantImageThisTurn() {
        const el = document.getElementById('checkGenerateImage');
        return el ? el.checked : true;
    }

    function renderPhoneCard(text, imageUrl, mode, { imageFailed = false, imageFailReason = null, textOnly = false, insertBefore = null, at = null, mock = false } = {}) {
        const feed = document.getElementById('phoneFeed');
        const empty = document.getElementById('phoneEmpty');
        if (!feed) return;

        if (empty) empty.hidden = true;

        const card = document.createElement('div');
        const isStory = mode === 'STORY';
        const isMock = !!mock;
        card.className = `phone-card ${isStory ? 'phone-card-story' : 'phone-card-dm'}${imageFailed ? ' phone-card-no-image' : ''}${textOnly ? ' phone-card-text-only' : ''}${isMock ? ' phone-card-mock' : ''}`;
        if (!textOnly) card.dataset.phoneImage = '1';
        if (isMock) card.dataset.mockImage = '1';

        const stampMs = Number.isFinite(Number(at)) ? Number(at) : chatStampMs(at);
        card.setAttribute('data-at', String(stampMs));

        const name = S().profile?.name || 'Character';
        // New card becomes latest; presence lives in the phone header, not per-card.
        const avatar = characterAvatarHtml({ className: 'phone-avatar', name });

        let imgBlock;
        const mockBadge = isMock
            ? '<span class="phone-card-mock-badge" title="Dev mock — not saved">MOCK</span>'
            : '';
        if (textOnly) {
            imgBlock = '';
        } else if (imageUrl && !imageFailed) {
            imgBlock = mockBadge
                + `<img src="${imageUrl}" alt="Generated visual" class="phone-card-img">`
                + `<button type="button" class="phone-card-expand" title="View larger" aria-label="View larger">`
                + `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">`
                + `<path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>`
                + `</svg></button>`;
        } else if (isMock) {
            imgBlock = mockBadge
                + `<div class="phone-card-img phone-card-placeholder phone-card-mock-ph">Mock image · not saved</div>`;
        } else if (imageFailed) {
            const failLabel = imageFailReason === 'filtered'
                ? 'Blocked by safety filter'
                : 'Image blocked / failed';
            imgBlock = `<div class="phone-card-img phone-card-placeholder phone-card-failed">${failLabel}</div>`;
        } else {
            imgBlock = `<div class="phone-card-img phone-card-placeholder">No image</div>`;
        }

        if (isStory) {
            card.innerHTML = `
                <div class="phone-card-header story">
                    <span class="story-ring" aria-hidden="true">${characterAvatarHtml({ className: 'story-avatar', name })}</span>
                    <div class="story-header-text">
                        <span class="story-kicker">INSTAGRAM STORY</span>
                        <strong>${escapeHtml(name)}</strong>
                    </div>
                </div>
                ${textOnly ? '' : `<div class="phone-card-media">${imgBlock}</div>`}
                <div class="phone-card-caption story-caption">${escapeHtml(text)}</div>
            `;
        } else if (textOnly) {
            card.innerHTML = `
                <div class="phone-card-header dm phone-card-header-slim">
                    ${avatar}
                    <div class="dm-header-text">
                        <strong>${escapeHtml(name)}</strong>
                    </div>
                </div>
                <div class="phone-card-text-only-body">${escapeHtml(text)}</div>
            `;
        } else {
            card.innerHTML = `
                <div class="phone-card-header dm phone-card-header-slim">
                    ${avatar}
                    <div class="dm-header-text">
                        <strong>${escapeHtml(name)}</strong>
                    </div>
                </div>
                <div class="phone-card-media">${imgBlock}
                    <div class="snap-overlay">${escapeHtml(text)}</div>
                </div>
            `;
        }

        const meta = document.createElement('div');
        meta.className = 'phone-card-meta';
        meta.textContent = formatChatTime(stampMs);
        card.appendChild(meta);

        if (insertBefore && insertBefore.parentNode === feed) {
            feed.insertBefore(card, insertBefore);
        } else {
            feed.appendChild(card);
        }

        // Demote previous DM kickers — only the newest card tracks live presence
        refreshPhoneCardChrome();

        const img = card.querySelector('img.phone-card-img');
        if (img) {
            img.addEventListener('error', () => onPhoneImageError(card, text), { once: true });
            const expandBtn = card.querySelector('.phone-card-expand');
            expandBtn?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openPhoneLightbox({
                    src: img.currentSrc || img.src,
                    caption: text,
                    isStory
                });
            });
        }

        feed.scrollTop = feed.scrollHeight;
        lastResolvedImageUrl = imageUrl;
    }

    function openPhoneLightbox({ src, caption = '', isStory = false } = {}) {
        const root = document.getElementById('phoneLightbox');
        const img = document.getElementById('phoneLightboxImg');
        const cap = document.getElementById('phoneLightboxCaption');
        if (!root || !img || !src) return;

        img.hidden = false;
        img.src = src;
        const text = String(caption || '').trim();
        if (cap) {
            if (text) {
                cap.hidden = false;
                cap.textContent = text;
                cap.classList.toggle('is-story', !!isStory);
            } else {
                cap.hidden = true;
                cap.textContent = '';
            }
        }

        root.hidden = false;
        root.setAttribute('aria-hidden', 'false');
        // Restart enter animation
        root.classList.remove('is-open');
        void root.offsetWidth;
        requestAnimationFrame(() => root.classList.add('is-open'));
        document.getElementById('btnPhoneLightboxClose')?.focus?.();
    }

    function closePhoneLightbox() {
        const root = document.getElementById('phoneLightbox');
        const img = document.getElementById('phoneLightboxImg');
        if (!root || root.hidden) return;
        root.classList.remove('is-open');
        const finish = () => {
            root.hidden = true;
            root.setAttribute('aria-hidden', 'true');
            if (img) {
                img.removeAttribute('src');
                img.hidden = true;
            }
            const cap = document.getElementById('phoneLightboxCaption');
            if (cap) {
                cap.hidden = true;
                cap.textContent = '';
            }
        };
        // Match CSS close transition; fall back if reduced-motion / no transition
        let done = false;
        const once = () => {
            if (done) return;
            done = true;
            finish();
        };
        root.addEventListener('transitionend', once, { once: true });
        setTimeout(once, 280);
    }

    async function downloadPhoneLightboxImage() {
        const img = document.getElementById('phoneLightboxImg');
        const src = img?.currentSrc || img?.src;
        if (!src) {
            MirageUI?.toast?.('Nothing to download.', 'error');
            return;
        }

        try {
            let dataUrl = src;
            if (!src.startsWith('data:')) {
                const res = await fetch(src);
                if (!res.ok) throw new Error(`fetch ${res.status}`);
                const blob = await res.blob();
                dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error || new Error('read failed'));
                    reader.readAsDataURL(blob);
                });
            }
            const ext = typeof MirageImageStore?.extFromDataUrl === 'function'
                ? MirageImageStore.extFromDataUrl(dataUrl)
                : 'jpg';
            const name = typeof MirageImageStore?.buildDownloadName === 'function'
                ? MirageImageStore.buildDownloadName(S(), ext)
                : `mirage-${Date.now()}.${ext}`;
            MirageImageStore.downloadDataUrl(dataUrl, name);
            MirageUI?.toast?.('Image downloaded.', 'success', { essential: true });
        } catch (err) {
            console.warn('[Mirage] lightbox download failed', err);
            MirageUI?.toast?.('Download failed.', 'error');
        }
    }

    function bindPhoneLightbox() {
        document.getElementById('btnPhoneLightboxClose')?.addEventListener('click', closePhoneLightbox);
        document.getElementById('btnPhoneLightboxBackdrop')?.addEventListener('click', closePhoneLightbox);
        document.getElementById('btnPhoneLightboxDownload')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            downloadPhoneLightboxImage();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const root = document.getElementById('phoneLightbox');
            if (!root || root.hidden) return;
            e.preventDefault();
            closePhoneLightbox();
        });
    }

    function stripHistoryBloat() {
        S().session.history = (S().session.history || []).map(h => ({
            user: h.user,
            ai: h.ai,
            tracking: h.tracking,
            debug: h.debug && typeof h.debug === 'object' ? h.debug : null,
            at: h.at,
            mode: h.mode === 'STORY' ? 'STORY' : 'DM'
        }));
    }

    function buildTurnDebug(extra = {}) {
        const sess = S()?.session || {};
        const prompt = lastBuiltImagePrompt;
        const herNow = typeof MiragePhoneUX?.herNow === 'function' ? MiragePhoneUX.herNow() : new Date();
        const tz = MiragePhoneUX?.resolveTimeZone?.(S()?.profile?.location);
        const clipStr = (v, n) => {
            const s = String(v || '').trim();
            if (!s) return null;
            return s.length > n ? `${s.slice(0, n - 1)}…` : s;
        };
        const usedImage = extra.generateImage && !extra.imageSkipped;
        return {
            thinkingModel: extra.thinkingModel || extra.thinkingModelId || null,
            imageModel: S()?.imageModel || null,
            apiProvider: S()?.apiProvider || null,
            referenceMode: S()?.effectiveReferenceMode?.() || S()?.referenceMode || null,
            sceneContinuityRef: !!S()?.sceneContinuityRef,
            persona: sess.persona || null,
            protocol: sess.protocol || null,
            mode: extra.cardMode || sess.mode || null,
            outfit: sess.outfit || null,
            outfitSource: sess.outfitSource || null,
            env: sess.env || null,
            generateImage: extra.generateImage != null ? !!extra.generateImage : null,
            imageFailed: !!extra.imageFailed,
            imageSkipped: !!extra.imageSkipped,
            imageFailReason: extra.imageFailReason || null,
            imageFailDetail: clipStr(extra.imageFailDetail, 500),
            commandInject: clipStr(extra.commandInject || extra.cmd?.inject, 900),
            godMode: !!(extra.godMode || extra.cmd?.godMode),
            changeOutfit: !!(extra.changeOutfit || extra.cmd?.changeOutfit),
            refreshScene: !!(extra.refreshScene || extra.cmd?.refreshScene),
            fitCheck: !!(extra.fitCheck || extra.cmd?.fitCheck),
            closeup: !!(extra.closeup || extra.cmd?.closeup),
            cropLock: extra.cropLock || extra.cmd?.cropLock || null,
            userShot: !!(extra.userShot || extra.cmd?.userShot || extra.cmd?.mirrorBack),
            mirrorBack: !!(extra.mirrorBack || extra.cmd?.mirrorBack),
            subjectLock: extra.subjectLock || extra.cmd?.subjectLock || null,
            internal: !!extra.internal,
            storyLaunch: !!extra.storyLaunch,
            proactive: !!extra.proactive,
            deliveryStyle: extra.deliveryStyle || extra.plan?.style || null,
            herClock: typeof MiragePhoneUX?.formatClock === 'function'
                ? MiragePhoneUX.formatClock(herNow, tz)
                : herNow.toISOString(),
            clockOffsetMs: Number(sess.clockOffsetMs) || 0,
            pacing: MirageImmersion?.pacingMode?.() || S()?.pacingMode || null,
            mockImages: !!S()?.mockImages,
            mockThinking: !!S()?.mockThinking,
            shotType: extra.parsed?.imageDirective?.shotType || extra.shotType || null,
            crop: extra.parsed?.imageDirective?.crop || extra.crop || extra.cmd?.cropLock || null,
            goonFace: extra.parsed?.imageDirective?.goonFace || extra.goonFace || null,
            goonFrame: extra.parsed?.imageDirective?.goonFrame || extra.goonFrame || null,
            imageRefs: usedImage && Array.isArray(prompt?.references) ? prompt.references.slice() : null,
            imagePromptClip: usedImage ? clipStr(prompt?.imagePrompt, 800) : null,
            faceRecovery: !!extra.faceRecovery,
            retried: !!extra.retried,
            retryMode: extra.retryMode || null,
            failed: !!extra.failed,
            error: clipStr(extra.error, 400)
        };
    }

    function patchLastHistoryDebug(patch) {
        const hist = S()?.session?.history;
        if (!hist?.length || !patch) return;
        const last = hist[hist.length - 1];
        last.debug = { ...(last.debug || {}), ...patch };
    }

    function cleanImageDirective(directive) {
        return MiragePrompt.sanitizeImageDirective(directive);
    }

    function shouldPersistImages() {
        return S().saveGeneratedImages && S().imageSaveMode !== 'none';
    }

    function isMockImageActive() {
        return !!(S()?.developerMode && S()?.mockImages);
    }

    function imageSaveTargets() {
        const mode = S().imageSaveMode;
        if (!S().saveGeneratedImages || mode === 'none') return { browser: false, download: false };
        return {
            browser: mode === 'browser' || mode === 'both',
            download: mode === 'download' || mode === 'both'
        };
    }

    async function persistGeneratedImage(dataUrl) {
        if (isMockImageActive()) return null;
        if (!dataUrl?.startsWith('data:') || !shouldPersistImages()) return null;

        const targets = imageSaveTargets();
        let imageKey = null;

        if (targets.browser) {
            const ck = MirageChatStore.characterKey(S());
            const chatId = S().session.activeChatId || 'misc';
            if (ck) {
                imageKey = `${ck}-${chatId}-extra-${Date.now()}`;
                try {
                    await MirageImageStore.saveDataUrl(imageKey, dataUrl);
                } catch (e) {
                    console.warn('[Mirage] Extra image store failed', e);
                    imageKey = null;
                }
            }
        }

        if (targets.download) {
            const ext = MirageImageStore.extFromDataUrl(dataUrl);
            MirageImageStore.downloadDataUrl(dataUrl, MirageImageStore.buildDownloadName(S(), ext));
        }

        return imageKey;
    }

    function sceneContinuityStoreKey() {
        const ck = MirageChatStore.characterKey?.(S());
        const chatId = S().session?.activeChatId;
        if (!ck || !chatId || typeof MirageChatStore.sceneContinuityKey !== 'function') return null;
        return MirageChatStore.sceneContinuityKey(ck, chatId);
    }

    /**
     * Keep exactly one last generated frame as a SCENE ref (outfit + env continuity).
     * Overwrites the previous continuity image for this chat.
     */
    async function rememberSceneContinuity(dataUrl) {
        if (isMockImageActive()) return;
        if (!dataUrl?.startsWith('data:')) return;
        const file = typeof MirageImageStore.dataUrlToFile === 'function'
            ? MirageImageStore.dataUrlToFile(dataUrl, 'scene-continuity.jpg')
            : null;
        if (!file) return;

        S().lastSceneFile = file;

        const key = sceneContinuityStoreKey();
        if (!key) {
            S().lastSceneImageKey = null;
            return;
        }
        try {
            // put() overwrites — only one continuity frame per chat
            await MirageImageStore.saveDataUrl(key, dataUrl);
            S().lastSceneImageKey = key;
        } catch (e) {
            console.warn('[Mirage] Scene continuity store failed', e);
            S().lastSceneImageKey = null;
        }
    }

    async function clearSceneContinuity({ removeStored = true } = {}) {
        S().lastSceneFile = null;
        const key = S().lastSceneImageKey || sceneContinuityStoreKey();
        S().lastSceneImageKey = null;
        if (removeStored && key) {
            try {
                await MirageImageStore.remove(key);
            } catch { /* ignore */ }
        }
    }

    /** Restore last-frame SCENE ref after loading a chat (or seed from newest turn image). */
    async function restoreSceneContinuity() {
        S().lastSceneFile = null;
        S().lastSceneImageKey = null;

        const key = sceneContinuityStoreKey();
        if (key && typeof MirageImageStore.getFile === 'function') {
            try {
                const file = await MirageImageStore.getFile(key, 'scene-continuity.jpg');
                if (file) {
                    S().lastSceneFile = file;
                    S().lastSceneImageKey = key;
                    return true;
                }
            } catch (e) {
                console.warn('[Mirage] Scene continuity restore failed', e);
            }
        }

        // Fallback: newest saved turn image for this chat (in-memory only until next generate)
        const chat = MirageChatStore.getActiveChat?.(S());
        const turns = MirageChatStore.normalizeTurnImages?.(chat?.turnImages) || [];
        const latest = turns.find(t => t.imageKey && !t.imageFailed);
        if (latest?.imageKey && typeof MirageImageStore.getFile === 'function') {
            try {
                const file = await MirageImageStore.getFile(latest.imageKey, 'scene-continuity.jpg');
                if (file) {
                    S().lastSceneFile = file;
                    return true;
                }
            } catch (e) {
                console.warn('[Mirage] Scene continuity seed failed', e);
            }
        }
        return false;
    }

    async function resolveImageReferenceFiles({ recovery = false, imageDirective = null } = {}) {
        let sceneFile = null;
        let outfitFile = null;
        if (!recovery) {
            const tight = typeof MiragePrompt.isTightCrop === 'function'
                && MiragePrompt.isTightCrop(imageDirective?.crop, imageDirective?.pose);
            const skipLastFrame = !!S().session?._skipSceneRefThisTurn || tight;
            if (!tight && typeof MirageMediaLibrary?.resolveOutfitPhoto === 'function') {
                outfitFile = MirageMediaLibrary.resolveOutfitPhoto(S(), S().session?.outfit);
            }
            // Known library look → original still every turn. Invented look → last frame.
            if (outfitFile) {
                sceneFile = null;
            } else if (S().sceneContinuityRef !== false && !skipLastFrame) {
                sceneFile = S().lastSceneFile || null;
                if (!sceneFile && S().lastSceneImageKey && typeof MirageImageStore?.getFile === 'function') {
                    try {
                        sceneFile = await MirageImageStore.getFile(S().lastSceneImageKey, 'scene-continuity.jpg');
                        if (sceneFile) S().lastSceneFile = sceneFile;
                    } catch (e) {
                        console.warn('[Mirage] Scene continuity file reload failed', e);
                    }
                }
            } else if (S().sceneContinuityRef !== false && skipLastFrame) {
                appendDebugDecision({
                    kind: 'image',
                    summary: tight ? 'Scene ref skipped · tight crop' : 'Scene ref skipped · wardrobe/place change',
                    detail: {
                        tight,
                        skipFlag: !!S().session?._skipSceneRefThisTurn,
                        hasLastFrame: !!(S().lastSceneFile || S().lastSceneImageKey)
                    }
                });
            }
        }
        const lite = typeof MiragePrompt.currentImageIsLite === 'function'
            ? MiragePrompt.currentImageIsLite({ imageModel: S().imageModel, provider: S().apiProvider })
            : /lite/i.test(String(S().imageModel || ''));
        // Duplicate FACE only when there is no wardrobe still — two FACE refs overweight
        // clothes from the master crop and crowd SCENE/OUTFIT off tight caps.
        const crop = String(imageDirective?.crop || '');
        const bodySubject = !!(S().session?._subjectLockThisTurn)
            || /^(Torso|Full)$/i.test(crop)
            || (typeof MiragePrompt.isBodyDetailPose === 'function'
                && MiragePrompt.isBodyDetailPose(imageDirective?.pose))
            || (!!(S().session?._godModeThisTurn)
                && /body|torso|lying|laying|bed|midsection/i.test(
                    `${imageDirective?.pose || ''} ${S().session?._userTextThisTurn || ''}`
                ));
        return S().referenceFiles({
            faceOnly: recovery,
            duplicateFace: recovery || (lite && !sceneFile && !outfitFile && !bodySubject),
            outfitFile,
            sceneFile
        });
    }

    function applyDirectorShotLocks(parsed, sess, cmd) {
        if (!parsed) return;
        const fit = !!(sess?._fitCheckThisTurn || cmd?.fitCheck);
        const cropLock = sess?._cropLockThisTurn || null;
        const hasDir = parsed.imageDirective && typeof parsed.imageDirective === 'object';
        if (!hasDir) {
            if (!fit && !cropLock) return;
            parsed.imageDirective = {};
        }
        const d = parsed.imageDirective;
        if (fit) {
            d.shotType = 'Mirror Selfie';
            d.crop = 'Full';
            if (sess && typeof MiragePrompt.applyFitCheckToDirective === 'function') {
                sess._fitCheckThisTurn = true;
                MiragePrompt.applyFitCheckToDirective(d, sess);
            } else if (sess?.persona === 'Goon') {
                const existing = String(d.goonFrame || '');
                d.goonFrame = /^(MirrorFullPose|MirrorSquat|MirrorSit)$/.test(existing)
                    ? existing
                    : 'MirrorFullPose';
            }
            if (parsed.tracking) {
                parsed.tracking.shotType = 'Mirror Selfie';
                parsed.tracking.crop = 'Full';
            }
        } else if (cropLock) {
            d.crop = cropLock;
            if (sess && typeof MiragePrompt.applyAskedShotToDirective === 'function'
                && (sess._subjectLockThisTurn === 'feet' || MiragePrompt.isFeetPose?.(d.pose))) {
                MiragePrompt.applyAskedShotToDirective(d, sess);
            } else if (sess?.persona === 'Goon') {
                if (cropLock === 'Extreme' && sess._subjectLockThisTurn !== 'feet') {
                    d.goonFace = d.goonFace || 'Mouth';
                    d.goonFrame = 'FaceOnly';
                } else if (cropLock === 'Face') {
                    d.goonFrame = String(d.goonFrame || '').startsWith('Mirror') ? 'MirrorFace' : 'FaceOnly';
                } else if (cropLock === 'Torso') {
                    const f = String(d.goonFrame || '');
                    if (!f || /^(FaceOnly|MirrorFace|Cleavage|Mouth)$/.test(f)) {
                        d.goonFrame = /POV/i.test(String(d.shotType || '')) ? 'POVDown' : 'FrontTorso';
                    }
                } else if (cropLock === 'Full' && !d.goonFrame) {
                    d.goonFrame = 'ArmOutFull';
                }
            }
            if (parsed.tracking) parsed.tracking.crop = cropLock;
        }
        if (sess?._mirrorBackThisTurn && typeof MiragePrompt.applyMirrorBackToDirective === 'function') {
            MiragePrompt.applyMirrorBackToDirective(d, sess);
            if (parsed.tracking) {
                parsed.tracking.shotType = d.shotType;
                parsed.tracking.crop = d.crop;
            }
        }
        if (sess && typeof MiragePrompt.isTightCrop === 'function' && MiragePrompt.isTightCrop(d.crop, d.pose)
            && !sess._mirrorBackThisTurn) {
            sess._skipSceneRefThisTurn = true;
        }
    }

    function applyShotVarianceLock(parsed, sess) {
        const d = parsed?.imageDirective;
        if (!d || !sess) return d;
        if (!sess._userShotThisTurn && sess._userAskThisTurn && sess.persona !== 'Goon') {
            if (typeof MirageCommands?.directiveHonoursAsk === 'function'
                && MirageCommands.directiveHonoursAsk(d, sess)) {
                sess._userShotThisTurn = true;
                appendDebugDecision({
                    kind: 'image',
                    summary: `Ask honoured → ${d.shotType || '?'} / ${d.crop || '?'}`,
                    detail: {
                        shotType: d.shotType || null,
                        crop: d.crop || null,
                        cameraAngle: d.cameraAngle || null
                    }
                });
            }
        }
        const rotated = typeof MiragePrompt.enforceShotVariance === 'function'
            && MiragePrompt.enforceShotVariance(d, sess);
        if (parsed.tracking) {
            parsed.tracking.shotType = d.shotType;
            parsed.tracking.crop = d.crop;
        }
        if (d.shotType) S().recordShotType(d.shotType, d.crop, d.cameraAngle);
        if (sess.persona === 'Goon' && (d.goonFace || d.goonFrame)) {
            S().recordGoonCombo(d.goonFace, d.goonFrame);
        }
        if (rotated) {
            appendDebugDecision({
                kind: 'image',
                summary: `Shot rotate → ${d.shotType} / ${d.crop}`
                    + (d.cameraAngle ? ` / ${d.cameraAngle}` : '')
                    + (d.goonFrame ? ` · ${d.goonFrame}` : ''),
                detail: {
                    shotType: d.shotType,
                    crop: d.crop,
                    cameraAngle: d.cameraAngle || null,
                    goonFrame: d.goonFrame || null,
                    skipScene: !!sess._skipSceneRefThisTurn
                }
            });
        }
        return d;
    }

    function ensureImageDirective(parsed, sess) {
        if (!parsed) return null;
        if (parsed.imageDirective && typeof parsed.imageDirective === 'object') {
            applyDirectorShotLocks(parsed, sess);
            applyShotVarianceLock(parsed, sess);
            return parsed.imageDirective;
        }
        const fit = !!sess?._fitCheckThisTurn;
        const cropLock = sess?._cropLockThisTurn || null;
        parsed.imageDirective = {
            shotType: fit ? 'Mirror Selfie' : 'Front Selfie',
            crop: fit ? 'Full' : (cropLock || 'Bust'),
            pose: fit
                ? ''
                : (cropLock === 'Extreme'
                    ? 'lips filling most of the 9:16 frame, hairline chin and shoulders cropped out'
                    : (cropLock === 'Face'
                        ? 'phone pulled in close, face filling the frame, looking into the lens'
                        : (cropLock === 'Torso' || cropLock === 'Full'
                            ? 'self-taken body selfie, any angle that shows the requested crop'
                            : 'front-camera candid iPhone selfie, face toward the lens'))),
            expression: 'natural candid expression',
            bodyLanguage: fit ? '' : 'relaxed, looking into the lens',
            lighting: (typeof MiragePhoneUX?.timeOfDayLock === 'function'
                ? MiragePhoneUX.timeOfDayLock().lighting
                : 'available natural light'),
            imperfections: 'slight iPhone grain, authentic social-media capture',
            outfitDetail: sess?.lastOutfitDetail
                || (sess?.outfit && String(sess.outfit).trim())
                || 'the clothes from the last frame',
            envDetail: (sess?.env && String(sess.env).trim()) || 'her current location'
        };
        if (sess?.persona === 'Goon') {
            parsed.imageDirective.goonFace = cropLock === 'Extreme' ? 'Mouth' : (sess._goonFaceBiasThisTurn || 'CrossTease');
            if (!fit) {
            parsed.imageDirective.goonFrame = cropLock === 'Extreme' || cropLock === 'Face'
                ? 'FaceOnly'
                : (cropLock === 'Torso' ? 'FrontTorso' : (cropLock === 'Full' ? 'ArmOutFull' : 'Cleavage'));
            }
            parsed.imageDirective.expression = cropLock === 'Extreme'
                ? 'mouth fills the frame — glossy lips, tongue out. Do not pull back to a whole-face portrait'
                : '';
        }
        applyDirectorShotLocks(parsed, sess);
        applyShotVarianceLock(parsed, sess);
        return parsed.imageDirective;
    }

    async function generateTurnImage(imageDirective, { signal, faceRecovery = false } = {}) {
        const ctx = S().getRuntimeContext();
        const softImage = typeof MirageModels.imageNeedsSoftening === 'function'
            ? MirageModels.imageNeedsSoftening(S().imageModel, S().apiProvider)
            : !!MirageModels.isGeminiFamily?.(S().imageModel);
        ctx.softPrompt = !!softImage;
        if (S().session) S().session._softPrompt = !!(S().session._softPrompt || softImage);

        let cleanDirective = cleanImageDirective(imageDirective);
        if (S()?.session?._fitCheckThisTurn) {
            if (typeof MiragePrompt.applyFitCheckToDirective === 'function') {
                MiragePrompt.applyFitCheckToDirective(cleanDirective, S().session);
            }
            cleanDirective.shotType = 'Mirror Selfie';
            cleanDirective.crop = 'Full';
            cleanDirective.pose = MiragePrompt.poseForRenderer?.(
                'Mirror Selfie',
                cleanDirective.pose,
                'Full'
            ) || cleanDirective.pose;
        } else if (S()?.session?._subjectLockThisTurn === 'feet'
            || (typeof MiragePrompt.isFeetPose === 'function' && MiragePrompt.isFeetPose(cleanDirective.pose))) {
            if (typeof MiragePrompt.applyAskedShotToDirective === 'function') {
                MiragePrompt.applyAskedShotToDirective(cleanDirective, S().session);
            }
        }

        // Optional Face Recovery only when the directive itself is marked (legacy / internal).
        const recovery = !!(
            faceRecovery
            || MiragePrompt.isFaceRecovery?.(cleanDirective)
        );

        if (recovery) {
            cleanDirective = MiragePrompt.applyFaceRecoveryDirective(cleanDirective);
        }

        if (typeof MiragePhoneUX?.applyTimeOfDayToDirective === 'function') {
            cleanDirective = MiragePhoneUX.applyTimeOfDayToDirective(cleanDirective);
        }

        if (!recovery && typeof MiragePrompt.enforceShotVariance === 'function') {
            MiragePrompt.enforceShotVariance(cleanDirective, S().session);
        }

        // Recovery drops BODY/OUTFIT/SCENE and doubles the FACE ref so identity outranks scene ambition.
        const { files, roles } = await resolveImageReferenceFiles({ recovery, imageDirective: cleanDirective });

        const imageOpts = {
            references: roles,
            faceRecovery: recovery,
            soft: softImage,
            imageModel: S().imageModel,
            provider: S().apiProvider
        };
        const imageSys = MiragePrompt.buildImageSystemInstruction(ctx, cleanDirective, imageOpts);
        const imagePrompt = MiragePrompt.buildImagePrompt(ctx, cleanDirective, imageOpts);

        MirageDebugPanel?.setLastPrompt?.({
            at: new Date().toISOString(),
            faceRecovery: recovery,
            references: roles,
            imageSystem: imageSys,
            imagePrompt
        });

        lastBuiltImagePrompt = {
            systemInstruction: imageSys,
            imagePrompt,
            cleanDirective,
            faceRecovery: recovery,
            references: roles,
            soft: softImage
        };

        MirageControlDeck?.sync?.();

        return MirageAPI.imageGenerate({
            apiKey: S().activeApiKey(),
            model: S().imageModel,
            systemInstruction: imageSys,
            imagePrompt,
            imageDirective: cleanDirective,
            referenceImages: files,
            referenceRoles: roles,
            signal
        });
    }

    function handleClientOnlyCommand(result) {
        if (result.clientOnly === 'skip_wait') {
            const skipped = !!MirageImmersion?.skipWallWaits?.();
            if (skipped) {
                MirageUI.toast('Wait skipped.', 'success', { essential: true });
            } else {
                MirageUI.toast('Nothing to skip — no wall wait is running.', 'info', { essential: true });
            }
            updateTurnActionControls();
            return true;
        }
        if (result.clientOnly === 'error') {
            MirageUI.toast(result.message || 'Invalid command.', 'error');
            return true;
        }
        if (result.clientOnly === 'queued') {
            MirageUI.toast(result.message || 'Queued.', 'info', { lane: 'dev' });
            updateHud();
            MirageControlDeck?.sync?.();
            return true;
        }
        if (result.clientOnly === 'world_skip') {
            applyWorldSkip(result.worldSkip || {});
            return true;
        }
        if (result.clientOnly === 'time_pass') {
            applyTimePass(result.timePass || {});
            return true;
        }
        return false;
    }

    /**
     * Real-time: /time pass, /next scene, /jump queue a world beat without an immediate
     * character reply. Clock advance is deferred until after the wait when deferClock is set.
     */
    function worldSkipClientNote(skip, clockAdvanceMs) {
        const base = String(skip?.clientNote || '').trim();
        const arrow = typeof MiragePhoneUX?.formatClockArrow === 'function'
            ? MiragePhoneUX.formatClockArrow(
                clockAdvanceMs,
                MiragePhoneUX.herNow?.()?.getTime?.()
            )
            : '';
        const longJump = clockAdvanceMs >= 24 * 60 * 60 * 1000;
        const span = typeof MirageImmersion?.formatTimeJumpSpan === 'function'
            ? MirageImmersion.formatTimeJumpSpan(clockAdvanceMs, skip?.duration || skip?.scenario)
            : null;

        const withArrow = (note) => {
            const n = String(note || '').trim();
            if (!arrow) return n;
            if (!n) return arrow;
            if (n.includes('→')) return n;
            return `${n} · ${arrow}`;
        };

        if (!longJump || !span) {
            return withArrow(base || 'World updated.');
        }

        // Keep stacked prefixes; still surface the long span.
        if (base && /queued ·/i.test(base)) {
            return withArrow(base.includes(span) ? base : `${base} · ${span}`);
        }

        if (skip?.kind === 'time_pass') {
            return withArrow(`Time pass queued (${span}) — waiting for time to pass, then the clock advances…`);
        }
        if (skip?.kind === 'next_scene') {
            return withArrow(`Scene jump queued (${span}) — waiting for time to pass, then the clock advances…`);
        }
        if (skip?.kind === 'jump') {
            return withArrow(
                `Jump queued (${span})${skip.scenario ? ` — ${skip.scenario}` : ''} — waiting for time to pass…`
            );
        }
        return withArrow(
            base
                ? (base.includes(span) ? base : `${base} (${span})`)
                : `Time passing — ${span}…`
        );
    }

    function applyWorldSkip(skip) {
        const sess = S().session;
        MirageDebugPanel?.beginDevTurn?.();
        sess.clockMayLagStamps = false;
        MirageImmersion?.resetUnresponsiveStreak?.();
        const deferClock = !!(skip.deferClock && MirageImmersion?.waitsOnTimeJumps?.());
        const clockAdvanceMs = Math.max(0, Number(skip.clockAdvanceMs) || 0);
        const note = worldSkipClientNote(skip, clockAdvanceMs);

        if (skip.refreshScene) {
            if (typeof S().isSceneFieldSet === 'function' && S().isSceneFieldSet(sess.env)) {
                sess._sceneCutFromEnv = sess.env;
            }
            sess.outfit = null;
            sess.outfitSource = null;
            sess.env = null;
            sess.lastOutfitDetail = null;
            clearSceneContinuity();
        }

        // Cool the thread — gap is coming (sim and/or wall)
        sess.chatHeat = 0;
        const prevAi = Number(sess.lastAiMessageAt) || 0;
        const nowSim = MiragePhoneUX?.herNow?.()?.getTime?.()
            || (Date.now() + (Number(sess.clockOffsetMs) || 0));
        // If clock is deferred, estimate post-jump lag for presence; don't advance yet
        const projectedNow = deferClock && clockAdvanceMs > 0
            ? nowSim + clockAdvanceMs
            : nowSim;
        sess.lastReplyLagMs = prevAi > 0
            ? Math.max(0, projectedNow - prevAi)
            : 24 * 60 * 60 * 1000;
        sess.presence = 'idle';
        sess.lastSeenAt = nowSim;

        sess.pendingWorldBeat = {
            kind: skip.kind || 'world_skip',
            inject: skip.inject || '',
            scenario: skip.scenario || null,
            duration: skip.duration || null,
            clockAdvanceMs: deferClock ? clockAdvanceMs : 0,
            deferClock,
            useSceneThinking: !!skip.useSceneThinking,
            refreshScene: !!skip.refreshScene,
            mustDeliver: !!(skip.mustDeliver || skip.refreshScene),
            routineJump: skip.routineJump || null,
            at: Date.now()
        };

        MirageImmersion?.cancelDelivery?.();
        MirageImmersion?.clearPendingDelivery?.();
        if (typeof MirageImmersion?.clearAllWaits === 'function') {
            MirageImmersion.clearAllWaits();
        } else {
            MirageImmersion?.clearProactive?.();
        }
        MirageImmersion?.clearSocialHold?.();

        if (MirageImmersion?.waitsOnTimeJumps?.()) {
            MirageUI.toast(note, 'info', { lane: 'dev' });
        }
        updateHud();
        MiragePhoneUX?.updateChrome?.();
        MirageControlDeck?.sync?.();

        if (MirageImmersion?.waitsOnTimeJumps?.()) {
            const waitSource = clockAdvanceMs > 0
                ? clockAdvanceMs
                : (skip.kind === 'time_pass'
                    ? (2 * 60 * 1000 + Math.random() * 8 * 60 * 1000)
                    : (45 * 1000 + Math.random() * 4 * 60 * 1000));
            const waitMs = typeof MirageImmersion.toRealWaitMs === 'function'
                ? MirageImmersion.toRealWaitMs(waitSource)
                : waitSource;
            appendDebugDecision({
                kind: 'world_skip',
                summary: `World skip armed — wait ${MirageImmersion.formatDuration?.(waitMs) || waitMs}`,
                detail: { kind: skip.kind, deferClock, clockAdvanceMs, waitMs }
            });
            // beginSkippableWallWait (via armProactive → scheduleSocialBeat) owns UI + Skip wait
            MirageImmersion.armProactive({
                reason: 'world_skip',
                waitMs
            });
            updateTurnActionControls();
        }

        try {
            MirageChatStore.saveActiveChat?.(S(), {
                lastUser: `[${skip.kind || 'world_skip'}]`,
                lastAi: '',
                lastMode: sess.mode,
                imageDataUrl: null,
                imageFailed: false,
                imageSkipped: true,
                imageFailReason: null,
                imageDirective: null
            });
        } catch { /* ignore persistence errors */ }
    }

    /**
     * /time pass: jump the sim clock immediately, then fire the same quiet lottery
     * as the 3-min ghost (DM / Story / stay silent) without waiting those 3 minutes.
     */
    function applyTimePass(skip) {
        const sess = S().session;
        if (!sess) return;
        MirageDebugPanel?.beginDevTurn?.();
        const clockAdvanceMs = Math.max(0, Number(skip.clockAdvanceMs) || 0);
        sess.clockMayLagStamps = false;
        MirageImmersion?.resetUnresponsiveStreak?.();

        MirageImmersion?.cancelDelivery?.();
        MirageImmersion?.clearPendingDelivery?.();
        if (typeof MirageImmersion?.clearAllWaits === 'function') {
            MirageImmersion.clearAllWaits();
        } else {
            MirageImmersion?.clearProactive?.();
        }
        MirageImmersion?.clearSocialHold?.();
        MirageImmersion?.clearNoReplyWatch?.();

        if (clockAdvanceMs > 0) {
            if (typeof MiragePhoneUX?.advanceClock === 'function') {
                MiragePhoneUX.advanceClock(clockAdvanceMs);
            }
            sess.lastTimeSkipMs = clockAdvanceMs;
            sess.lastTimeSkipReason = skip.duration || 'time pass';
            try {
                const tz = MiragePhoneUX?.resolveTimeZone?.(S()?.profile?.location);
                const y = MiragePhoneUX?.getZonedParts?.(MiragePhoneUX.herNow(), tz)?.year;
                if (y) MirageCalendar?.ensureYear?.(y, S().profile);
            } catch { /* ignore */ }
            if (typeof MirageLoyaltyUX?.applySkipCooling === 'function') {
                const weather = MirageLoyaltyUX.applySkipCooling(sess, {
                    skipMs: clockAdvanceMs,
                    hardCut: false,
                    profile: S().profile,
                    edf: S().edf
                });
                if (weather?.active || weather?.skipEngagementRise) {
                    logSkipWeather(weather);
                }
            }
        }

        sess.chatHeat = 0;
        const nowSim = MiragePhoneUX?.herNow?.()?.getTime?.()
            || (Date.now() + (Number(sess.clockOffsetMs) || 0));
        sess.presence = 'idle';
        sess.lastSeenAt = nowSim;

        sess.pendingWorldBeat = {
            kind: 'time_pass',
            inject: skip.inject || '',
            duration: skip.duration || null,
            clockAdvanceMs: 0,
            deferClock: false,
            useSceneThinking: true,
            skipMs: clockAdvanceMs,
            at: Date.now()
        };

        const span = typeof MirageImmersion?.formatTimeJumpSpan === 'function'
            ? MirageImmersion.formatTimeJumpSpan(clockAdvanceMs, skip.duration)
            : (typeof MirageImmersion?.formatDuration === 'function'
                ? MirageImmersion.formatDuration(clockAdvanceMs)
                : '');
        appendDebugDecision({
            kind: 'world_skip',
            summary: `Time pass · clock +${span || clockAdvanceMs} · lottery now`,
            detail: { duration: skip.duration, clockAdvanceMs }
        });

        if (typeof MirageRoutine?.stampFromClock === 'function') {
            try { MirageRoutine.stampFromClock(sess); } catch { /* ignore */ }
        }

        MiragePhoneUX?.syncClockChrome?.();
        updateHud();
        MirageControlDeck?.sync?.();
        updateTurnActionControls();

        if (typeof MirageImmersion?.scheduleSocialBeat === 'function') {
            MirageImmersion.scheduleSocialBeat({ reason: 'time_pass' });
        } else if (typeof MirageImmersion?.armNoReplyWatch === 'function') {
            MirageImmersion.armNoReplyWatch('time_pass');
        }

        try {
            MirageChatStore.saveActiveChat?.(S(), {
                lastUser: '[time_pass]',
                lastAi: '',
                lastMode: sess.mode,
                imageDataUrl: null,
                imageFailed: false,
                imageSkipped: true,
                imageFailReason: null,
                imageDirective: null
            });
        } catch { /* ignore persistence errors */ }
    }

    function applyPendingWorldClock() {
        const beat = S().session?.pendingWorldBeat;
        if (!beat?.deferClock) return null;
        const ms = Math.max(0, Number(beat.clockAdvanceMs) || 0);
        const reason = beat.duration || beat.scenario || beat.kind || 'world skip';
        beat.deferClock = false;
        beat.clockAdvanceMs = 0;
        if (ms <= 0) return null;
        return beginProvisionalClockAdvance(ms, reason);
    }

    /**
     * Advance sim clock for LIVE STATE / stamps, but keep a rollback handle if thinking fails.
     * @returns {{ offsetBefore: number, ms: number, reason: string }|null}
     */
    function beginProvisionalClockAdvance(ms, reason) {
        const sess = S().session;
        const advance = Math.max(0, Number(ms) || 0);
        if (!sess || advance <= 0) return null;
        const guard = {
            offsetBefore: Number(sess.clockOffsetMs) || 0,
            ms: advance,
            reason: String(reason || 'time skip')
        };
        MiragePhoneUX?.advanceClock?.(advance);
        sess.lastTimeSkipMs = advance;
        sess.lastTimeSkipReason = guard.reason;
        MiragePhoneUX?.syncClockChrome?.();
        updateHud();
        return guard;
    }

    function rollbackProvisionalClockAdvance(guard) {
        if (!guard || !S().session) return;
        S().session.clockOffsetMs = guard.offsetBefore;
        MiragePhoneUX?.syncClockChrome?.();
        updateHud();
    }

    function mergeClockGuards(prev, next) {
        if (!prev) return next;
        if (!next) return prev;
        return {
            offsetBefore: prev.offsetBefore,
            ms: (Number(prev.ms) || 0) + (Number(next.ms) || 0),
            reason: next.reason || prev.reason
        };
    }

    function consumePendingWorldBeat() {
        const beat = S().session.pendingWorldBeat;
        if (!beat) return { note: '', clockGuard: null };
        // Apply deferred clock right before her reply is authored/stamped (provisional)
        const clockGuard = beat.deferClock ? applyPendingWorldClock() : null;
        S().session.pendingWorldBeat = null;
        const bits = [
            'WORLD STATE UPDATE (already applied on the client — do not ask confirmation):',
            beat.inject || '',
            beat.kind === 'time_pass'
                ? 'Time already passed on her clock. She does not know anyone skipped it. Match this beat to the NEW time — she may still be in the same clothes/place if only minutes passed, or she may have a new outfit/location if the hour or activity changed. Any change is her idea. Do not dump a long recap unless she would actually send it.'
                : beat.kind === 'next_scene'
                    ? ('Hard scene cut already happened — next beat of her day'
                        + (beat.routineJump?.activity ? ` (${beat.routineJump.activity})` : '')
                        + '. Establish a NEW place type + outfit — not a renamed last room. She MUST appear via a DM or a Story — never withhold. Re-evaluate mood/thermal/arousal for the new clock.')
                    : beat.kind === 'jump'
                        ? `Narrative teleported to: ${beat.scenario || 'new scenario'}. Establish the scene. She MUST text or post from there — never withhold.`
                        : ''
        ].filter(Boolean);
        return {
            note: `CLIENT NOTE:\n${bits.join('\n')}\n`,
            clockGuard
        };
    }

    async function finalizeTurn({
        text,
        characterText,
        parsed,
        cardMode,
        internal,
        storyLaunch,
        imageUrl,
        imageFailed,
        imageFailReason,
        imageFailDetail = null,
        imageSkipped = false,
        cmd,
        boundary = null,
        thinkingModelId = null,
        generateImage = null,
        proactive = false,
        deliveryStyle = null
    }) {
        if (boundary && !isTurnBoundaryValid(boundary)) {
            return;
        }

        MiragePhoneUX?.showTyping?.(false);

        let aiEntry = null;
        if (storyLaunch || cardMode === 'STORY') {
            aiEntry = appendChat('ai', characterText, { label: 'STORY' });
        } else {
            aiEntry = appendChat('ai', characterText);
        }
        const cardAt = Number(aiEntry?.getAttribute('data-at'));
        renderPhoneCard(characterText, imageUrl, cardMode, {
            imageFailed,
            imageFailReason,
            textOnly: imageSkipped,
            at: Number.isFinite(cardAt) ? cardAt : undefined,
            mock: !!(isMockImageActive() && imageUrl && !imageFailed && !imageSkipped)
        });

        if (parsed?.memoryUpdates) {
            MirageMemoryLedger?.applyUpdates?.(S().session, parsed.memoryUpdates);
        }

        const turnDebug = buildTurnDebug({
            cmd,
            parsed,
            cardMode,
            internal,
            storyLaunch,
            imageFailed,
            imageFailReason,
            imageFailDetail,
            imageSkipped,
            generateImage,
            proactive,
            deliveryStyle,
            thinkingModelId
        });

        S().session.history.push({
            user: historyUserLine(internal, storyLaunch, text),
            ai: characterText,
            tracking: parsed.tracking,
            debug: turnDebug,
            at: Number.isFinite(cardAt) ? cardAt : chatStampMs(),
            mode: (storyLaunch || cardMode === 'STORY') ? 'STORY' : 'DM'
        });

        S().session.phase = 'active';
        if (storyLaunch || cardMode === 'STORY') {
            const stamped = MirageImmersion?.simNowMs?.()
                || MiragePhoneUX?.herNow?.()?.getTime?.()
                || Date.now();
            S().session.lastStoryAt = stamped;
        }
        MiragePhoneUX?.onTurnEnd?.();

        const mockImage = isMockImageActive() && !imageFailed && !imageSkipped && !!imageUrl;
        await MirageChatStore.saveActiveChat(S(), {
                lastUser: historyUserLine(internal, storyLaunch, text),
            lastAi: characterText,
            lastMode: cardMode,
            imageDataUrl: imageFailed || imageSkipped || mockImage ? null : imageUrl,
            imageFailed,
            imageSkipped,
            imageMock: mockImage,
            imageFailReason,
            imageDirective: parsed?.imageDirective || null,
            at: Number.isFinite(cardAt) ? cardAt : undefined
        });

        MirageDebugPanel.setLastTurn({
            at: new Date().toISOString(),
            historyAt: Number.isFinite(cardAt) ? cardAt : chatStampMs(),
            userInput: text,
            parsed,
            imageFailed,
            imageSkipped,
            imageFailReason,
            imageFailDetail,
            commandInject: cmd?.inject || null,
            ...turnDebug
        });

        const prompt = lastBuiltImagePrompt;
        const imageState = imageFailed ? 'failed' : (imageSkipped ? 'skipped' : (generateImage ? 'photo' : 'skipped'));
        logDevTurn('close', {
            input: historyUserLine(internal, storyLaunch, text),
            reply: characterText,
            mode: (storyLaunch || cardMode === 'STORY') ? 'STORY' : 'DM',
            style: deliveryStyle,
            shot: parsed?.imageDirective?.shotType || turnDebug.shotType,
            crop: parsed?.imageDirective?.crop || turnDebug.crop,
            refs: Array.isArray(prompt?.references) ? prompt.references : turnDebug.imageRefs,
            image: imageState,
            outfit: S().session.outfit,
            outfitSource: S().session.outfitSource || null,
            env: S().session.env,
            engagement: S().session.engagement,
            thinkingModel: thinkingModelId,
            generateImage,
            storyLaunch,
            proactive
        });

        MiragePendingTurn.clear();
        MirageUI.setStatus('ACTIVE', 'active');
        clearTurnCheckpoint();

        captureTurnSnapshot({
            text,
            characterText,
            parsed,
            cardMode,
            internal,
            storyLaunch,
            imageUrl,
            imageFailed,
            imageFailReason,
            imageSkipped,
            cmd,
            imagePromptBundle: (imageUrl || imageFailed) ? lastBuiltImagePrompt : null
        });
    }

    async function generateImageFromBundle(bundle, { signal, imageDirective = null } = {}) {
        if (!bundle?.systemInstruction || !bundle?.imagePrompt) {
            throw new Error('Missing stored image prompt bundle');
        }

        const recovery = !!bundle.faceRecovery;
        const { files, roles } = await resolveImageReferenceFiles({
            recovery,
            imageDirective: bundle.cleanDirective || imageDirective
        });

        MirageDebugPanel?.setLastPrompt?.({
            at: new Date().toISOString(),
            faceRecovery: recovery,
            references: roles,
            imageSystem: bundle.systemInstruction,
            imagePrompt: bundle.imagePrompt,
            replay: true
        });

        // Keep the exact text; only refs are rebuilt from current media files.
        lastBuiltImagePrompt = {
            ...bundle,
            references: roles
        };

        MirageControlDeck?.sync?.();

        return MirageAPI.imageGenerate({
            apiKey: S().activeApiKey(),
            model: S().imageModel,
            systemInstruction: bundle.systemInstruction,
            imagePrompt: bundle.imagePrompt,
            imageDirective: bundle.cleanDirective || imageDirective,
            referenceImages: files,
            referenceRoles: roles,
            signal
        });
    }

    async function generateImageForTurn(parsed, { signal, faceRecovery = false, promptBundle = null } = {}) {
        if (!parsed?.imageDirective && !promptBundle) {
            return { imageUrl: null, imageFailed: false, imageFailReason: null, imageFailDetail: null };
        }

        let imageUrl = null;
        let imageFailed = false;
        let imageFailReason = null;
        let imageFailDetail = null;

        try {
            if (promptBundle?.systemInstruction && promptBundle?.imagePrompt) {
                imageUrl = await generateImageFromBundle(promptBundle, {
                    signal,
                    imageDirective: parsed?.imageDirective || null
                });
            } else {
                imageUrl = await generateTurnImage(parsed.imageDirective, { signal, faceRecovery });
            }
            // Always keep last frame for SCENE continuity (independent of download/browser save prefs)
            await rememberSceneContinuity(imageUrl);
            const detail = parsed?.imageDirective?.outfitDetail;
            if (detail && S()?.session) {
                S().session.lastOutfitDetail = String(detail).trim();
            }
            await persistGeneratedImage(imageUrl);
        } catch (imgErr) {
            if (isTurnCancelled(imgErr)) throw imgErr;
            console.error('[Mirage] image generation error', imgErr);
            imageFailReason = MirageAPI.classifyImageError(imgErr);
            imageFailDetail = String(imgErr?.message || imgErr || '').slice(0, 500);
            imageFailed = true;
            imageUrl = null;
        }

        return { imageUrl, imageFailed, imageFailReason, imageFailDetail };
    }

    function handleTurnError(err) {
        if (typeof MirageUI?.isStorageQuotaError === 'function' && MirageUI.isStorageQuotaError(err)) {
            MirageUI.setStatus('ERROR', 'error');
            MirageUI.showStorageFullDialog({
                context: 'Chat progress for this turn was not saved.'
            });
            appendChat('system', 'Browser storage is full — this turn’s chat save failed. Free space, then continue.', {
                system: true
            });
            return;
        }
        const info = MirageErrors.describeTurnError(err);
        if (info.silent) return;
        try {
            const preview = String(err?.rawPreview || info.rawPreview || '').slice(0, 2500);
            MirageDebugPanel?.setLastTurn?.({
                at: new Date().toISOString(),
                failed: true,
                userInput: S()?.session?._lastUserInput || null,
                error: info.toast || String(err?.message || err || 'turn failed'),
                errorCode: info.code || err?.code || null,
                rawPreview: preview || null,
                chatError: info.chat || null,
                toast: info.toast || null,
                thinkingModel: err?.modelId || null,
                imageFailed: false,
                imageSkipped: true,
                commandInject: S()?.session?._lastCommandInject || null,
                godMode: !!S()?.session?._godModeThisTurn
            });
            MirageDebugPanel?.pushNotice?.({
                kind: 'error',
                tone: 'error',
                summary: info.toast || 'Turn failed',
                detail: {
                    error: String(err?.message || err || ''),
                    code: info.code || err?.code || null,
                    modelId: err?.modelId || null,
                    userInput: S()?.session?._lastUserInput || null,
                    rawPreview: preview || null,
                    chatError: info.chat || null
                }
            });
        } catch { /* ignore */ }
        MirageUI.setStatus('ERROR', 'error');
        if (info.chat) {
            const isSafety = /safety filter|blocked by/i.test(String(info.chat + info.toast));
            appendChat('system', '', {
                alert: true,
                alertType: isSafety ? 'image-fail' : 'warn',
                title: isSafety ? 'Blocked by safety filter' : (info.toast || 'Turn failed'),
                body: info.chat
            });
            try { MirageChatStore.saveActiveChat?.(S()); } catch { /* ignore */ }
        }
        MirageUI.toast(info.toast, 'error', 8000);
        logDevTurn('close', {
            input: S()?.session?._lastUserInput || '',
            failed: true,
            error: info.toast || String(err?.message || err || 'turn failed'),
            errorCode: info.code || err?.code || null,
            rawPreview: String(err?.rawPreview || '').slice(0, 400),
            thinkingModel: err?.modelId || null
        });
        if (info.action === 'settings') {
            document.getElementById('configModal').hidden = false;
        }
    }

    function discardInFlightTurn() {
        const pending = MiragePendingTurn.load();
        MiragePendingTurn.clear();
        if (!pending) return null;
        if (!MiragePendingTurn.matches(S(), pending)) return null;
        return pending;
    }

    async function resumePendingTurnIfAny() {
        const pending = MiragePendingTurn.load();
        if (!pending || !MiragePendingTurn.matches(S(), pending)) return false;

        const input = document.getElementById('simInput');
        setTurnControlsDisabled(true);
        const signal = beginTurnAbort();
        activeTurnCheckpoint = captureTurnCheckpoint({
            userText: pending.internal ? null : pending.text
        });

        MirageUI.setStatus('GENERATING', 'busy');
        MirageUI.setSimGenerating(true, { phase: 'image', label: 'Finishing her photo…' });

        try {
            applyTracking(pending.parsed.tracking, { parsed: pending.parsed, resume: true });

            // The operator's pins applied to this turn; the model owns the metrics again.
            S().clearOperatorOverrides();
            updateHud();

            if (pending.storyLaunch) {
                S().session.mode = 'STORY';
                S().session._storyActive = true;
                updateHud();
            }

            if (!pending.internal && pending.text) {
                appendChat('user', pending.text);
            }

            let imageUrl = null;
            let imageFailed = false;
            let imageFailReason = null;
            let imageFailDetail = null;
            const imageSkipped = pending.wantImage === false
                && pending.cardMode !== 'STORY'
                && !pending.storyLaunch;

            if (imageSkipped) {
                MirageUI.setSimGenerating(true, { phase: 'thinking', label: 'Finishing her message…' });
            } else {
                ({ imageUrl, imageFailed, imageFailReason, imageFailDetail } = await generateImageForTurn(pending.parsed, { signal }));
            }

            if (imageFailed) {
                appendImageFailureAlert(imageFailReason, imageFailDetail || 'Image generation failed while resuming.');
            }

            await finalizeTurn({
                text: pending.text,
                characterText: pending.characterText,
                parsed: pending.parsed,
                cardMode: pending.cardMode,
                internal: pending.internal,
                storyLaunch: pending.storyLaunch,
                imageUrl,
                imageFailed,
                imageFailReason,
                imageFailDetail,
                imageSkipped,
                cmd: pending.cmd,
                generateImage: !imageSkipped
            });

            MirageUI.toast('Picked up where we left off.', 'success', { essential: true, duration: 5000 });
            return true;
        } catch (err) {
            if (isTurnCancelled(err)) {
                MiragePendingTurn.clear();
                rollbackCancelledTurn(activeTurnCheckpoint, {
                    restoreInput: !pending.internal
                });
                return false;
            }
            MiragePendingTurn.clear();
            clearTurnCheckpoint();
            handleTurnError(err);
            return false;
        } finally {
            MirageUI.setSimGenerating(false);
            setTurnControlsDisabled(false);
            endTurnAbort();
            document.getElementById('simInput')?.focus();
        }
    }

    async function retryLastImage({ mode = 'prompt' } = {}) {
        const snap = lastTurnSnapshot;
        if (!snap?.parsed?.imageDirective) {
            MirageUI.toast('No image to retry from the last turn.', 'error');
            return;
        }
        if (S()?.session?.clockResumeHold) {
            MirageUI.toast('Pick how to handle the time gap first.', 'error');
            showClockResumeOverlay();
            return;
        }
        if (turnInProgress) {
            MirageUI.toast('Wait for the current turn to finish.', 'error');
            return;
        }
        if (mode === 'prompt' && !chatHasSentImage()) {
            MirageUI.toast('Retry Last Image needs at least one image already sent in this chat.', 'error');
            return;
        }
        if (!S().activeApiKey() && !(S().developerMode && S().mockImages)) {
            MirageUI.toast('Configure your API key in Settings.', 'error');
            return;
        }

        const faceRecovery = mode === 'face';
        const bundle = !faceRecovery
            && snap.imagePromptBundle?.systemInstruction
            && snap.imagePromptBundle?.imagePrompt
            ? snap.imagePromptBundle
            : null;

        setTurnControlsDisabled(true);
        const signal = beginTurnAbort();
        MirageUI.setStatus('GENERATING', 'busy');
        MirageUI.setSimGenerating(true, {
            phase: 'image',
            label: faceRecovery ? 'Retrying with Face Recovery…' : 'Retrying with same prompt…'
        });

        let imageUrl = null;
        let imageFailed = false;
        let imageFailReason = null;
        let imageFailDetail = null;

        try {
            ({ imageUrl, imageFailed, imageFailReason, imageFailDetail } = await generateImageForTurn(snap.parsed, {
                signal,
                faceRecovery,
                promptBundle: bundle
            }));

            const removed = removeLastImagePhoneCard();
            renderPhoneCard(snap.characterText, imageUrl, snap.cardMode, {
                imageFailed,
                imageFailReason,
                insertBefore: removed.insertBefore,
                at: removed.at,
                mock: !!(isMockImageActive() && imageUrl && !imageFailed)
            });

            if (imageFailed) {
                appendImageFailureAlert(imageFailReason, imageFailDetail || 'Image retry failed.');
            } else if (S()?.developerMode) {
                MirageUI.toast(
                    faceRecovery
                        ? 'Image regenerated (Face Recovery).'
                        : (bundle ? 'Image regenerated (same prompt).' : 'Image regenerated.'),
                    'success'
                );
            }

            const chat = MirageChatStore.getActiveChat(S());
            const imageTurn = (chat?.turnImages || []).find(t =>
                t?.imageKey || t?.imageDirective || t?.imageFailed
            );
            const replaceImageAt = imageTurn?.at || chat?.lastTurn?.at;

            await MirageChatStore.saveActiveChat(S(), {
                replaceLastTurn: true,
                replaceImageAt,
                lastUser: snap.text,
                lastAi: snap.characterText,
                lastMode: snap.cardMode,
                imageDataUrl: imageFailed || isMockImageActive() ? null : imageUrl,
                imageFailed,
                imageSkipped: false,
                imageMock: !!(!imageFailed && isMockImageActive() && imageUrl),
                imageFailReason,
                imageDirective: snap.parsed?.imageDirective || null
            });

            captureTurnSnapshot({
                ...snap,
                imageUrl,
                imageFailed,
                imageFailReason,
                imageSkipped: false,
                imagePromptBundle: lastBuiltImagePrompt || snap.imagePromptBundle || null
            });

            const retryDebug = buildTurnDebug({
                parsed: snap.parsed,
                cardMode: snap.cardMode,
                cmd: snap.cmd,
                imageFailed,
                imageFailReason,
                imageFailDetail,
                imageSkipped: false,
                generateImage: true,
                retried: true,
                retryMode: mode,
                faceRecovery
            });
            patchLastHistoryDebug(retryDebug);

            MirageDebugPanel.setLastTurn({
                at: new Date().toISOString(),
                userInput: snap.text,
                parsed: snap.parsed,
                imageFailed,
                imageSkipped: false,
                imageFailReason,
                imageFailDetail,
                commandInject: snap.cmd?.inject || null,
                retried: true,
                retryMode: mode,
                promptReplay: !!bundle,
                faceRecovery,
                ...retryDebug
            });

            MirageUI.setStatus('ACTIVE', 'active');
        } catch (err) {
            if (isTurnCancelled(err)) return;
            handleTurnError(err);
        } finally {
            MirageUI.setSimGenerating(false);
            setTurnControlsDisabled(false);
            endTurnAbort();
            document.getElementById('simInput')?.focus();
        }
    }

    function retryFace() {
        return retryLastImage({ mode: 'face' });
    }

    function retryPrompt() {
        return retryLastImage({ mode: 'prompt' });
    }

    async function deliverTurnPayload(payload, { signal, plan, withReaction = false, boundary = null } = {}) {
        if (boundary && !isTurnBoundaryValid(boundary)) return;

        // Narrative skip: advance sim clock when the reply actually fires (after any real-time wait)
        const skipMs = Number(plan?.timeSkipMs) || 0;
        if (skipMs > 0) {
            MiragePhoneUX?.advanceClock?.(skipMs);
            S().session.lastTimeSkipMs = skipMs;
            S().session.lastTimeSkipReason = plan?.timeSkipReason || '';
            MiragePhoneUX?.syncClockChrome?.();
            if (!MirageImmersion?.waitsOnTimeJumps?.()) {
                const span = typeof MirageImmersion?.formatTimeJumpSpan === 'function'
                    ? MirageImmersion.formatTimeJumpSpan(skipMs, plan?.timeSkipReason)
                    : null;
                if (skipMs >= 24 * 60 * 60 * 1000 && span) {
                    appendCaption(`${span} passed.`);
                }
            }
        }

        let {
            text,
            characterText,
            parsed,
            cardMode,
            internal,
            storyLaunch,
            generateImage,
            cmd
        } = payload;

        let imageUrl = null;
        let imageFailed = false;
        let imageFailReason = null;
        let imageFailDetail = null;

        const applyReaction = !!(withReaction || plan?.style === 'reaction');
        if (applyReaction) {
            const face = typeof MirageImmersion?.normalizeReactionEmoji === 'function'
                ? MirageImmersion.normalizeReactionEmoji(plan?.reaction)
                : (String(plan?.reaction || '❤️').trim() || '❤️');
            MiragePhoneUX?.markUserReaction?.(face);
        }

        if (payload?.proactive) {
            const style = plan?.style;
            if (style !== 'ghost_type' && style !== 'left_on_read') {
                const reason = payload.proactiveReason || '';
                const operatorBeat = typeof MirageImmersion?.countsTowardUnresponsiveCap === 'function'
                    && reason
                    && !MirageImmersion.countsTowardUnresponsiveCap(reason);
                if (!operatorBeat) {
                    const sess = S()?.session;
                    if (sess) {
                        const cap = Number(MirageImmersion?.HER_STREAK_CAP) || 5;
                        sess.herStreak = Math.min(cap, (Number(sess.herStreak) || 0) + 1);
                    }
                }
            }
        }

        if ((cardMode === 'STORY' || storyLaunch) && generateImage) {
            ensureImageDirective(parsed, S().session);
        } else if (generateImage) {
            ensureImageDirective(parsed, S().session);
        }

        if (generateImage && parsed?.imageDirective) {
            MirageUI.setSimGenerating(true, {
                phase: 'image',
                label: 'Taking a photo… this can take a few minutes'
            });
            ({ imageUrl, imageFailed, imageFailReason, imageFailDetail } = await generateImageForTurn(parsed, { signal }));
            assertTurnLive(signal);
            if (imageFailed) {
                appendImageFailureAlert(imageFailReason, imageFailDetail || 'Image generation failed for this turn.');
                appendDebugDecision({
                    kind: 'image',
                    summary: `Image failed · ${imageFailReason || 'unknown'}`,
                    detail: { reason: imageFailReason, detail: imageFailDetail || null }
                });
            } else {
                const refs = Array.isArray(lastBuiltImagePrompt?.references)
                    ? lastBuiltImagePrompt.references
                    : [];
                const shot = parsed?.imageDirective?.shotType || '';
                const crop = parsed?.imageDirective?.crop || '';
                appendDebugDecision({
                    kind: 'image',
                    summary: `Image · ${[shot, crop].filter(Boolean).join(' / ') || 'ok'}${refs.length ? ` · ${refs.join(', ')}` : ''}`,
                    detail: {
                        refs,
                        shot,
                        crop,
                        skipScene: !!S()?.session?._skipSceneRefThisTurn,
                        hasLastFrame: !!(S()?.lastSceneFile || S()?.lastSceneImageKey)
                    }
                });
            }
        } else if (!generateImage) {
            appendDebugDecision({
                kind: 'image',
                summary: 'Image skipped · checkbox off / text-only DM',
                detail: { skipped: true }
            });
        }

        if (boundary && !isTurnBoundaryValid(boundary)) return;
        assertTurnLive(signal);

        if (characterText) {
            await finalizeTurn({
                text,
                characterText,
                parsed,
                cardMode,
                internal,
                storyLaunch,
                imageUrl,
                imageFailed,
                imageFailReason,
                imageFailDetail,
                imageSkipped: !generateImage,
                cmd,
                boundary,
                thinkingModelId: payload?.thinkingModelId || null,
                generateImage,
                proactive: !!payload?.proactive,
                deliveryStyle: plan?.style || null
            });
        } else if (applyReaction) {
            // Safety net: reaction without text should not happen (planDelivery demotes).
            // Still persist a quiet history beat so resume stays coherent.
            if (boundary && !isTurnBoundaryValid(boundary)) return;
            const face = String(plan?.reaction || '❤️').trim() || '❤️';
            S().session.history.push({
                user: historyUserLine(internal, storyLaunch, text),
                ai: `[reaction ${face}]`,
                tracking: parsed?.tracking,
                debug: buildTurnDebug({
                    parsed,
                    cardMode,
                    internal,
                    storyLaunch,
                    imageSkipped: true,
                    generateImage: false,
                    deliveryStyle: 'reaction',
                    cmd
                }),
                at: chatStampMs()
            });
            await MirageChatStore.saveActiveChat(S(), {
                lastUser: historyUserLine(internal, storyLaunch, text),
                lastAi: `[reaction ${face}]`,
                lastMode: cardMode,
                imageDataUrl: null,
                imageFailed: false,
                imageSkipped: true,
                imageFailReason: null,
                imageDirective: null
            });
            MiragePhoneUX?.onTurnEnd?.();
            MiragePendingTurn.clear();
            MirageUI.setStatus('ACTIVE', 'active');
            clearTurnCheckpoint();
        }

        // Double-text: second bubble after a natural gap (abortable)
        const second = String(plan?.secondMessage || '').trim();
        if (second && plan?.style === 'double_text' && !signal?.aborted) {
            if (boundary && !isTurnBoundaryValid(boundary)) return;
            MiragePhoneUX?.showTyping?.(true);
            const gap = Math.min(
                MirageImmersion?.capRealWaitMs?.(MirageImmersion?.typingMsFor?.(second) || 2000) || 2000,
                12000
            );
            try {
                await MirageImmersion.sleep(gap, { signal });
            } catch (err) {
                MiragePhoneUX?.showTyping?.(false);
                if (isTurnCancelled(err)) throw err;
                throw err;
            }
            assertTurnLive(signal);
            MiragePhoneUX?.showTyping?.(false);
            const secondEntry = appendChat('ai', second);
            const secondAt = Number(secondEntry?.getAttribute('data-at'));
            renderPhoneCard(second, null, cardMode, {
                textOnly: true,
                at: Number.isFinite(secondAt) ? secondAt : undefined
            });
            S().session.history.push({
                user: '[continued]',
                ai: second,
                at: Number.isFinite(secondAt) ? secondAt : chatStampMs(),
                mode: cardMode === 'STORY' ? 'STORY' : 'DM'
            });
            await MirageChatStore.saveActiveChat(S(), {
                lastUser: text,
                lastAi: second,
                lastMode: cardMode,
                imageDataUrl: null,
                imageFailed: false,
                imageSkipped: true,
                imageFailReason: null,
                imageDirective: null
            });
            MiragePhoneUX?.onTurnEnd?.();
        }

        if (payload?.proactive) {
            try { await MirageChatStore.saveActiveChat(S()); } catch { /* ignore */ }
        }

        MirageImmersion?.onTurnSettled?.();
    }

    async function releasePendingDelivery() {
        const pending = MirageImmersion?.getPendingDelivery?.();
        if (!pending || turnInProgress) return false;

        // Stale hold from a previous chat — never dump it into the active one
        if (pending.boundary && !isTurnBoundaryValid(pending.boundary)) {
            MirageImmersion.clearPendingDelivery();
            return false;
        }

        MirageImmersion.clearPendingDelivery();
        const signal = beginTurnAbort();
        const boundary = pending.boundary || turnBoundaryToken();
        setTurnControlsDisabled(true);
        MirageUI.setStatus('GENERATING', 'busy');
        MiragePhoneUX?.showTyping?.(true);

        try {
            await deliverTurnPayload(pending, {
                signal,
                plan: { style: 'normal', secondMessage: pending.plan?.secondMessage || '' },
                boundary
            });
            return true;
        } catch (err) {
            if (!isTurnCancelled(err)) handleTurnError(err);
            return false;
        } finally {
            MiragePhoneUX?.showTyping?.(false);
            MirageUI.setSimGenerating(false);
            setTurnControlsDisabled(false);
            endTurnAbort();
            document.getElementById('simInput')?.focus();
        }
    }

    async function executeTurn(userInput, {
        internal = false,
        storyLaunch = false,
        wantImage = null,
        proactive = false,
        proactiveReason = '',
        forceInstant = false,
        clockAdvanceMs = 0,
        waitDrift = false,
        skipSceneRef = false,
        forceDeliver = false
    } = {}) {
        const rawText = String(userInput || '').trim();
        if (!rawText) return;

        if (S()?.session?.clockResumeHold && !storyLaunch) {
            MirageUI.toast('Pick how to handle the time gap first.', 'error');
            showClockResumeOverlay();
            return;
        }
        if (!proactive && !internal && !storyLaunch
            && MirageImmersion?.maybeOfferClockResume?.()) {
            MirageUI.toast('Pick how to handle the time gap first.', 'error');
            return;
        }

        if (turnInProgress) {
            MirageUI.toast('Wait for the current turn to finish.', 'error');
            return;
        }

        if (!S().activeApiKey() && !(S().developerMode && S().mockThinking)) {
            MirageUI.toast('Configure your API key in Settings.', 'error');
            return;
        }

        // Decay from the gap BEFORE this message is stamped so a "hey" after
        // an hour of ghosting lands on Cold, not the leftover Hot score.
        MirageImmersion?.decayEngagementOnResume?.();

        // New operator message supersedes any held left-on-read reply / proactive wait.
        // /skip wait must run BEFORE cancel — it finishes the wait instead of aborting it.
        const cmd = MirageCommands.processInput(rawText, S(), {
            internal,
            storyLaunch,
            proactive
        });
        if (!cmd.proceed && cmd.clientOnly === 'skip_wait') {
            handleClientOnlyCommand(cmd);
            return;
        }

        const ghostHold = !!(
            MirageImmersion?.isDitchHold?.()
            || MirageImmersion?.isComeBackHold?.()
        );
        if (cmd.proceed && cmd.pinOnly && ghostHold && !cmd.mustDeliver && !internal) {
            // This path returns before the normal command bubble is appended further
            // down, so echo the command here — otherwise `/arousal 80` during a ditch
            // hold moves a HUD number and leaves no trace anywhere that it was deferred.
            const pinText = cmd.userText || String(rawText || '').trim();
            if (pinText) appendChat('user', pinText, { isCommand: true });
            if (cmd.clientNote) appendSystemNote(cmd.clientNote, { essential: true });
            updateHud();
            appendSystemNote('Pinned — she’ll use it when she next texts.', { essential: true });
            return;
        }

        if (!internal || storyLaunch) {
            MirageImmersion?.resetUnresponsiveStreak?.();
            if (S()?.session) S().session.herStreak = 0;
            if (!internal) {
                MirageImmersion?.cancelDelivery?.();
                MirageImmersion?.clearPendingDelivery?.();
                MirageImmersion?.onUserActivity?.();
            }
        }

        if (!cmd.proceed) {
            // Client-only slash cmds still show the same centered command chip
            // (slash text + clock arrow) as Instant /next scene.
            if (!internal && (
                cmd.clientOnly === 'world_skip'
                || cmd.clientOnly === 'time_pass'
                || cmd.clientOnly === 'skip_wait'
            )) {
                const skip = cmd.worldSkip || cmd.timePass || {};
                const advanceMs = Number(skip.clockAdvanceMs) || 0;
                const arrow = advanceMs > 0 && typeof MiragePhoneUX?.formatClockArrow === 'function'
                    ? MiragePhoneUX.formatClockArrow(
                        advanceMs,
                        MiragePhoneUX.herNow?.()?.getTime?.()
                    )
                    : '';
                appendChat('user', String(rawText || '').trim() || cmd.userText || '/command', {
                    isCommand: true,
                    clockArrow: arrow || null
                });
            }
            if (handleClientOnlyCommand(cmd)) return;
            return;
        }

        MirageDebugPanel?.beginDevTurn?.();

        // Hard scene break (/next scene, /jump) — drop outfit/env stickiness + last-frame SCENE ref
        if (cmd.refreshScene) {
            if (typeof S().isSceneFieldSet === 'function' && S().isSceneFieldSet(S().session.env)) {
                S().session._sceneCutFromEnv = S().session.env;
            }
            S().session.outfit = null;
            S().session.env = null;
            S().session.lastOutfitDetail = null;
            clearSceneContinuity();
        }

        const text = cmd.userText;
        if (!internal && S().session) {
            S().session._userTextThisTurn = text || '';
            if (!cmd.outfitLookHint && text
                && typeof MiragePrompt?.isSpecificOutfitLook === 'function'
                && MiragePrompt.isSpecificOutfitLook(text)) {
                cmd.outfitLookHint = text;
            }
        }
        // Freeze pacing for this entire turn (Settings mid-turn can't flip planning mid-flight)
        const turnPacing = MirageImmersion?.pacingMode?.() || 'instant';
        // Stories always render a photo. /next scene and /jump always deliver a Story
        // or a DM (mustDeliver) — leftover STORY chrome from an earlier post does not
        // force a photo, and never withholds.
        const rawIsStoryCmd = /^(?:\/story\b|view story\b)/i.test(String(rawText || '').trim())
            || (typeof MirageCommands.isViewStory === 'function' && MirageCommands.isViewStory(rawText));
        const thisTurnIsStory = !!(
            storyLaunch
            || cmd.forceImage
            || rawIsStoryCmd
        );
        let generateImage = thisTurnIsStory ? true : (wantImage ?? wantImageThisTurn());
        if (cmd.fitCheck || cmd.forcePhoto || cmd.godMode || cmd.changeOutfit || cmd.awakening || cmd.closeup) {
            generateImage = true;
        }
        const pendingSkip = S().session?.pendingWorldBeat;
        const longTimePass = pendingSkip?.kind === 'time_pass'
            && (Number(pendingSkip.skipMs || S().session.lastTimeSkipMs) || 0) >= 45 * 60 * 1000;
        if ((skipSceneRef || cmd.refreshScene || pendingSkip?.refreshScene || cmd.changeOutfit || cmd.godMode || cmd.closeup || cmd.subjectLock || longTimePass) && S().session) {
            S().session._skipSceneRefThisTurn = true;
        }
        if (typeof MirageRoutine?.resolveForTurn === 'function' && S().session) {
            const routineBeat = MirageRoutine.resolveForTurn({
                storyLaunch: !!storyLaunch || !!thisTurnIsStory,
                skipMs: Math.max(
                    Number(S().session.lastTimeSkipMs) || 0,
                    Number(pendingSkip?.skipMs) || 0,
                    Number(pendingSkip?.clockAdvanceMs) || 0
                ),
                hardCut: !!(cmd.refreshScene || pendingSkip?.refreshScene),
                session: S().session
            });
            S().session._routineThisTurn = routineBeat;
            if (routineBeat?.mustMove) {
                S().session._skipSceneRefThisTurn = true;
            }
            if (routineBeat?.line) {
                appendDebugDecision({
                    kind: 'routine',
                    summary: `Her day · ${routineBeat.band} · ${routineBeat.mustMove ? 'move' : (routineBeat.envSet ? 'stay' : 'establish')} · ${routineBeat.placeFamily}`,
                    detail: {
                        mode: routineBeat.mode,
                        band: routineBeat.band,
                        lifestyle: routineBeat.lifestyle,
                        placeFamily: routineBeat.placeFamily,
                        forbid: routineBeat.forbidFamilies,
                        outfitHint: routineBeat.outfitHint,
                        mustMove: !!routineBeat.mustMove,
                        clock: routineBeat.clockLabel
                    }
                });
            }
        }
        if (S().session) {
            const goon = S().session.persona === 'Goon';
            const askedShot = !!(cmd.userShot || cmd.cropLock || cmd.subjectLock || cmd.mirrorBack);
            S().session._fitCheckThisTurn = !!cmd.fitCheck;
            S().session._godModeThisTurn = !!cmd.godMode;
            if (cmd.godMode) {
                // /instruct is freeform — never apply keyword camera locks (booty shorts ≠ MirrorBooty).
                S().session._userAskThisTurn = true;
                S().session._askCropThisTurn = null;
                S().session._askSubjectThisTurn = null;
                S().session._askMirrorThisTurn = false;
                S().session._cropLockThisTurn = null;
                S().session._closeupThisTurn = false;
                S().session._mirrorBackThisTurn = false;
                S().session._subjectLockThisTurn = null;
                S().session._userShotThisTurn = true;
            } else {
                S().session._userAskThisTurn = askedShot;
                S().session._askCropThisTurn = cmd.cropLock || null;
                S().session._askSubjectThisTurn = cmd.subjectLock || null;
                S().session._askMirrorThisTurn = !!(cmd.mirrorBack
                    || (text && typeof MirageCommands?.looksLikeMirrorBackRequest === 'function'
                        && MirageCommands.looksLikeMirrorBackRequest(text)));
                const forceAsk = !!goon;
                S().session._cropLockThisTurn = forceAsk ? (cmd.cropLock || null) : null;
                S().session._closeupThisTurn = !!(S().session._cropLockThisTurn === 'Extreme'
                    || S().session._cropLockThisTurn === 'Face');
                S().session._mirrorBackThisTurn = forceAsk && S().session._askMirrorThisTurn;
                S().session._subjectLockThisTurn = forceAsk ? (cmd.subjectLock || null) : null;
                S().session._userShotThisTurn = !!(askedShot && goon);
            }
            S().session._changeOutfitThisTurn = !!cmd.changeOutfit;
            S().session._outfitLookHintThisTurn = cmd.outfitLookHint || '';
            S().session._changePlaceThisTurn = !!cmd.changePlace;
            S().session._lastCommandInject = cmd.inject || S().session._lastCommandInject || null;
        }
        const realTime = turnPacing === 'realtime';
        // God-mode slash commands + story launches never wait on Delivered→Seen pacing
        const isCommand = !internal && (
            cmd.task === 'command'
            || String(text || '').trim().startsWith('/')
            || String(rawText || '').trim().startsWith('/')
        );
        const mustDeliver = !!(
            forceDeliver
            || cmd.mustDeliver
            || cmd.refreshScene
            || pendingSkip?.refreshScene
            || pendingSkip?.kind === 'next_scene'
            || pendingSkip?.kind === 'jump'
            || cmd.godMode
            || cmd.fitCheck
            || cmd.changeOutfit
            || cmd.awakening
            || cmd.forcePhoto
            || storyLaunch
        );
        const skipRealtime = forceInstant || storyLaunch || isCommand
            || mustDeliver
            || MirageCommands.isViewStory(rawText);

        if (cmd.clientNote && !internal) {
            // Checkpoint before any provisional UI / state from this turn
            if (!activeTurnCheckpoint) {
                activeTurnCheckpoint = captureTurnCheckpoint({ userText: text });
            }
            appendSystemNote(cmd.clientNote);
            updateHud();
            if (cmd.storyToDm) updateStoryControls();
        }

        const input = document.getElementById('simInput');
        setTurnControlsDisabled(true);
        const signal = beginTurnAbort();
        const boundary = turnBoundaryToken();

        if (!activeTurnCheckpoint) {
            activeTurnCheckpoint = captureTurnCheckpoint({
                userText: internal ? null : text
            });
        }

        MiragePendingTurn.save({
            charKey: MirageChatStore.characterKey(S()),
            chatId: S().session.activeChatId,
            text: internal ? '' : text,
            internal: !!internal,
            storyLaunch: !!storyLaunch,
            stage: 'thinking'
        });

        if (!internal) {
            MirageLoyaltyUX.recordUserMessage(text);
            S().session._lastUserInput = text;
            S().session._lastCommandInject = cmd.inject || null;
            const cmdClockMs = Number(cmd.clockAdvanceMs) || 0;
            const clockArrow = isCommand && cmdClockMs > 0
                && typeof MiragePhoneUX?.formatClockArrow === 'function'
                ? MiragePhoneUX.formatClockArrow(
                    cmdClockMs,
                    MiragePhoneUX.herNow?.()?.getTime?.()
                )
                : null;
            appendChat('user', text, { isCommand, clockArrow });
            MirageImmersion?.touchUserActivity?.();
            MiragePhoneUX?.onTurnStart?.({
                deferOpen: !skipRealtime,
                skipReceipts: skipRealtime
            });
        } else {
            MiragePhoneUX?.showTyping?.(true);
        }
        stripHistoryBloat();
        MirageUI.setStatus('GENERATING', 'busy');
        MirageUI.setSimGenerating(true, {
            phase: 'thinking',
            label: proactive
                ? 'She’s reaching out…'
                : (storyLaunch ? 'Posting a story…'
                    : (isCommand ? 'Working…' : 'She’s thinking…'))
        });

        const openInput = internal
            ? (storyLaunch
                ? `[Story · ${proactiveReason || 'launch'}]`
                : `[${proactiveReason || 'proactive'}]`)
            : text;
        logDevTurn('open', {
            input: openInput,
            command: isCommand,
            storyLaunch,
            proactive,
            proactiveReason,
            mustDeliver,
            generateImage,
            pacing: turnPacing,
            refreshScene: !!cmd.refreshScene,
            godMode: !!cmd.godMode,
            changeOutfit: !!cmd.changeOutfit
        });

        const task = cmd.task || (text.startsWith('/') ? 'command' : 'turn');
        let parsed = null;
        let characterText = '';
        let cardMode = S().session.mode;
        let heldLeftOnRead = false;
        let clockGuard = null;
        let thinkingModelId = null;

        try {
            const ctx = S().getRuntimeContext();
            ctx.phase = 'active';

            // Provisional clock for /next scene etc. — rolled back if thinking fails
            const cmdClock = Number(cmd.clockAdvanceMs) || 0;
            const driftClock = Number(clockAdvanceMs) || 0;
            if (cmdClock > 0) {
                clockGuard = beginProvisionalClockAdvance(
                    cmdClock,
                    cmd.clientNote || 'scene command'
                );
            } else if (driftClock > 0) {
                const fromMs = typeof MiragePhoneUX?.herNow === 'function'
                    ? MiragePhoneUX.herNow().getTime()
                    : Date.now();
                if (waitDrift) {
                    const arrow = typeof MiragePhoneUX?.formatClockArrow === 'function'
                        ? MiragePhoneUX.formatClockArrow(driftClock, fromMs)
                        : '';
                    appendSystemNote(
                        arrow
                            ? `${arrow} — some time passed.`
                            : 'Some time passed.',
                        { essential: true }
                    );
                }
                clockGuard = beginProvisionalClockAdvance(
                    driftClock,
                    waitDrift ? 'wait drift' : 'idle drift'
                );
            }

            const inputPack = typeof MiragePrompt?.resolveInputPack === 'function'
                ? MiragePrompt.resolveInputPack()
                : null;
            const historyText = typeof MiragePrompt?.formatHistoryForPrompt === 'function'
                ? MiragePrompt.formatHistoryForPrompt(S().session.history, inputPack)
                : S().session.history.slice(-4).map(h =>
                    `User: ${h.user}\nCharacter: ${h.ai}`
                ).join('\n\n');

            const memoryBlock = MirageMemoryLedger?.formatForPrompt?.(S().session) || '';
            const callbackNote = MirageMemoryLedger?.consumeCallbackNote?.(S().session) || '';
            const pendingBeat = S().session.pendingWorldBeat;
            const timePassLanding = pendingBeat?.kind === 'time_pass';
            const routineBeat = S().session?._routineThisTurn;
            const routineMove = !!routineBeat?.mustMove;
            const routineNewClothes = !!(routineBeat && routineBeat.outfitHint && routineBeat.outfitHint !== 'same');
            const needsScene = S().needsSceneEstablish?.() || !(S().session.history?.length);
            const sceneNote = needsScene
                ? 'CLIENT NOTE: Fresh simulation — Session Outfit/Env are unset. Establish both in tracking this turn. Clothes: prefer an OUTFIT_LIBRARY Label that fits this clock/place; invent a new outfit ONLY if none of those looks fit. outfitDetail MUST name a top AND bottoms, or a one-piece (dress/jumpsuit/romper). Places: ENV_ATLAS is optional — invent a new location whenever it fits better. Do not reuse a prior chat\'s clothes/location. Mirror choices in imageDirective.outfitDetail / envDetail.\n'
                : '';
            const userAuthored = !internal && !proactive;
            const sceneLocked = !needsScene
                && !cmd.refreshScene
                && !pendingBeat?.refreshScene
                && !['next_scene', 'jump'].includes(pendingBeat?.kind)
                && !cmd.changeOutfit
                && !cmd.godMode
                && !timePassLanding
                && !routineNewClothes
                && typeof S().isSceneFieldSet === 'function'
                && S().isSceneFieldSet(S().session.outfit);
            const outfitClientLock = sceneLocked && !userAuthored;
            const envLockLine = (skipSceneRef || routineMove)
                ? (routineMove
                    ? ''
                    : 'ENV may shift if time-of-day / activity drifted — that is Wait-for-her idle, not a /next scene hard cut. Keep the same clothes unless the hour clearly demands otherwise.\n')
                : (S().isSceneFieldSet(S().session.env)
                    ? `ENV LOCK — stay at "${S().session.env}" unless the beat clearly moves her.\n`
                    : '');
            const lockNote = outfitClientLock
                ? `CLIENT NOTE: OUTFIT LOCK — she is wearing "${S().session.outfit}". tracking.outfit MUST stay that exact label. imageDirective.outfitDetail must describe those same garments and MUST name the top AND bottoms (or the one-piece). A new selfie is NOT a wardrobe change. Do not invent a sweater, jacket, or different bottoms.\n`
                    + envLockLine
                : (userAuthored && sceneLocked
                    ? `CLIENT NOTE: WARDROBE INTENT is yours this turn. If HIS message is asking her to change clothes (any wording, any language): Goon complies. Other personas — Would she actually change into that in this place, hour, and persona, as if real life? If YES: tracking.outfit + outfitDetail MUST be the new look — prefer an OUTFIT_LIBRARY Label; invent only if that look is not in the library. If NO: keep "${S().session.outfit}" exactly. If he is not asking for clothes, keep "${S().session.outfit}" exactly — a new selfie is not a wardrobe change. Kept or new: outfitDetail names a top AND bottoms, or a one-piece (dress/jumpsuit/romper).\n`
                        + envLockLine
                    : '');
            const skipForOutfit = Math.max(
                Number(S().session.lastTimeSkipMs) || 0,
                Number(pendingBeat?.skipMs) || 0,
                Number(pendingBeat?.clockAdvanceMs) || 0
            );
            const staleNote = !needsScene
                && timePassLanding
                && skipForOutfit >= 18 * 60 * 60 * 1000
                && typeof S().isSceneFieldSet === 'function'
                && S().isSceneFieldSet(S().session.outfit)
                ? `CLIENT NOTE: OUTFIT STALE — "${S().session.outfit}" is from a new calendar day / multi-day skip. tracking.outfit MUST be a NEW short label (not that look). Prefer a different OUTFIT_LIBRARY Label; invent only if none fit. New day = new clothes. Her idea. Match outfitDetail — top AND bottoms, or a one-piece (dress/jumpsuit/romper).\n`
                : '';

            const useSceneThinking = !!(
                cmd.useSceneThinking
                || cmd.godMode
                || pendingBeat?.useSceneThinking
                || (pendingBeat && ['next_scene', 'jump', 'time_pass'].includes(pendingBeat.kind))
                || needsScene
                || storyLaunch
            );
            const worldBeat = consumePendingWorldBeat();
            if (worldBeat.clockGuard) {
                clockGuard = mergeClockGuards(clockGuard, worldBeat.clockGuard);
            }
            const worldBeatNote = worldBeat.note || '';
            const skipMs = Number(clockGuard?.ms) || 0;
            const hardCut = !!(
                cmd.refreshScene
                || pendingBeat?.refreshScene
                || pendingBeat?.kind === 'next_scene'
                || pendingBeat?.kind === 'jump'
            );
            if ((skipMs > 0 || hardCut) && typeof MirageLoyaltyUX?.applySkipCooling === 'function') {
                const weather = MirageLoyaltyUX.applySkipCooling(S().session, {
                    skipMs,
                    hardCut,
                    profile: S().profile,
                    edf: S().edf
                });
                if (weather?.active || weather?.skipEngagementRise) {
                    logSkipWeather(weather);
                    updateHud();
                }
            }
            const weatherNote = S().session?._skipWeather?.note
                ? `CLIENT NOTE: ${S().session._skipWeather.note}\n`
                : '';
            const mainThinkingId = MirageModels.resolveThinkingModel(S().thinkingModel, S().apiProvider);
            thinkingModelId = useSceneThinking
                ? MirageModels.resolveThinkingModel(
                    S().sceneThinkingModel || MirageModels.defaultSceneThinking?.(S().apiProvider),
                    S().apiProvider
                )
                : mainThinkingId;
            // Scene commands default to Gemini — if main thinking is uncensorious (e.g. Grok),
            // prefer it so /next scene doesn't hit Gemini safety while chat uses Grok.
            if (useSceneThinking
                && typeof MirageModels.thinkingNeedsSoftening === 'function'
                && MirageModels.thinkingNeedsSoftening(thinkingModelId, S().apiProvider)
                && !MirageModels.thinkingNeedsSoftening(mainThinkingId, S().apiProvider)) {
                thinkingModelId = mainThinkingId;
            }
            const softThinking = typeof MirageModels.thinkingNeedsSoftening === 'function'
                ? MirageModels.thinkingNeedsSoftening(thinkingModelId, S().apiProvider)
                : !!MirageModels.isGeminiFamily?.(thinkingModelId);
            ctx.softPrompt = !!softThinking;
            if (S().session) S().session._softPrompt = !!softThinking;
            let awakeningNote = '';
            if (S().session.awakeningActive && !cmd.awakening) {
                const tick = MiragePrompt.tickAwakening(S().session);
                if (tick.inject?.length) {
                    awakeningNote = `${tick.inject.join('\n')}\n`;
                    updateHud();
                }
            }
            const storyLaunchNote = storyLaunch
                ? 'CLIENT NOTE: PUBLIC INSTAGRAM STORY — not a DM and not aimed at him. '
                    + 'characterResponse = one follower-facing caption that fits her place/time/mood. '
                    + 'FORBIDDEN: addressing the operator, "saw you watched", DM questions, private one-to-one tease, "sorry just saw this", double-texts. '
                    + 'imageDirective REQUIRED and MUST be self-taken (Front Selfie, Mirror Selfie, POV, or Propped — she takes it). '
                    + 'Choose crop (Extreme/Face/Bust/Torso/Full/Scene) from the beat. NEVER a third-person photo. delivery.style must be omitted or normal.\n'
                : '';
            const presence = MirageImmersion?.assessPresence?.(S().session);
            let silenceNote = '';
            if (presence?.onPhone) {
                silenceNote = `CLIENT NOTE: He replied fast (${MirageImmersion.formatDuration(presence.lagMs)} after her last text) — chat heat ${presence.heat}. She is ON HER PHONE in this thread. Keep tone live/present; client will Seen almost immediately.\n`;
            } else if (Number.isFinite(presence?.lagMs) && presence.lagMs > 3 * 60 * 1000) {
                silenceNote = `CLIENT NOTE: He took ${MirageImmersion.formatDuration(presence.lagMs)} to reply — she may have put the phone down. Slower open / busier vibe / apology double-text can fit.\n`;
            }
            const sceneJumpDeliver = !!(
                cmd.refreshScene
                || pendingBeat?.refreshScene
                || pendingBeat?.kind === 'next_scene'
                || pendingBeat?.kind === 'jump'
            );
            const deliveryHint = storyLaunch
                ? ''
                : (sceneJumpDeliver
                    ? 'CLIENT NOTE: LANDING LOCK — this beat MUST be a visible Instagram Story or a DM. FORBIDDEN: left_on_read, ghost_type, went_quiet, withhold, empty characterResponse. tracking.mode STORY or DM.\n'
                    : ((skipRealtime)
                        ? ''
                        : (typeof MirageLoyaltyUX?.ghostDeliveryClientNote === 'function'
                            ? MirageLoyaltyUX.ghostDeliveryClientNote(S().profile, S().edf, S().session)
                            : 'CLIENT NOTE: Vary delivery.style. Instant, Hybrid, and Realtime all honor ignore (ghost_type / left_on_read / went_quiet).\n')));
            const moodHint = typeof MiragePrompt?.moodDeliveryClientNote === 'function'
                ? MiragePrompt.moodDeliveryClientNote(S().session)
                : '';
            const profileSwitchNote = consumeOperatorProfileSwitchNote();

            function assembleThinkingUserText(userLine, histBlock, extraNotes = '') {
                return [
                    histBlock ? `RECENT CONVERSATION:\n${histBlock}\n` : '',
                    memoryBlock ? `${memoryBlock}\n` : '',
                    cmd.inject ? `COMMAND CONTEXT:\n${cmd.inject}\n` : '',
                    awakeningNote ? `AWAKENING CONTEXT:\n${awakeningNote}` : '',
                    profileSwitchNote ? `CLIENT NOTE: ${profileSwitchNote}\n` : '',
                    sceneNote,
                    lockNote,
                    staleNote,
                    storyLaunchNote,
                    worldBeatNote,
                    weatherNote,
                    callbackNote ? `${callbackNote}\n` : '',
                    silenceNote,
                    deliveryHint,
                    moodHint,
                    extraNotes,
                    (ctx.softPrompt || softThinking)
                        ? 'CLIENT NOTE: Gemini safety softening is ON — keep Goon/heat intensity via implication and body language; avoid hardcore keyword piles in characterResponse and imageDirective.\n'
                        : '',
                    (!generateImage) ? 'CLIENT NOTE: Image generation is OFF this turn — text-only DM. imageDirective may be omitted. Stories still require a photo.\n' : '',
                    `USER INPUT:\n${userLine}`
                ].filter(Boolean).join('\n');
            }

            const userParts = [{ text: assembleThinkingUserText(text, historyText) }];

            let systemInstruction = MiragePrompt.buildThinkingSystemInstruction(task, ctx);
            if (typeof MiragePrompt.fitInputBudget === 'function') {
                const fitted = MiragePrompt.fitInputBudget(
                    systemInstruction,
                    userParts[0]?.text || '',
                    inputPack?.tokens
                );
                systemInstruction = fitted.systemInstruction;
                if (userParts[0]) userParts[0].text = fitted.userText;
                reportInputBudget(fitted);
            }

            const thinkCall = {
                apiKey: S().activeApiKey(),
                model: thinkingModelId,
                systemInstruction,
                userParts,
                jsonMode: true,
                signal
            };

            function isRefusalThinkingFail(err) {
                if (!err) return false;
                const preview = String(err.rawPreview || err.message || '');
                if (err.code === 'SAFETY') return true;
                if (typeof MirageAPI.looksLikeSafetyRejection === 'function'
                    && MirageAPI.looksLikeSafetyRejection(preview)) {
                    return true;
                }
                return /i cannot fulfill|i can'?t fulfill|unable to generate|sexually (explicit|suggestive)|i can'?t (help|assist|generate)/i.test(preview);
            }

            function isRecoverableThinkingFail(err) {
                if (!err || signal?.aborted) return false;
                if (isRefusalThinkingFail(err)) return true;
                if (err.code === 'JSON_PARSE' || err.code === 'EMPTY_THINKING') return true;
                return /empty response/i.test(String(err.message || ''));
            }

            function prepareSoftenedThinkingRetry(err) {
                ctx.softPrompt = true;
                if (S().session) S().session._softPrompt = true;
                const rewritten = typeof MiragePrompt.softenUserBeatForRetry === 'function'
                    ? MiragePrompt.softenUserBeatForRetry(text)
                    : text;
                const softHist = typeof MiragePrompt.formatHistoryForPrompt === 'function'
                    ? MiragePrompt.formatHistoryForPrompt(S().session.history, inputPack, { softenUser: true })
                    : historyText;
                const retryNote = `${MiragePrompt.THINKING_RETRY_SOFT_APPENDIX || ''}\n`
                    + 'CLIENT NOTE: Retry pass — same selfie/chat beat via implication only. Valid JSON. Do not refuse.\n';
                let sys = MiragePrompt.buildThinkingSystemInstruction(task, ctx);
                if (MiragePrompt.THINKING_RETRY_SOFT_APPENDIX) {
                    sys = `${sys}\n\n${MiragePrompt.THINKING_RETRY_SOFT_APPENDIX}`;
                }
                let userText = assembleThinkingUserText(rewritten, softHist, retryNote);
                if (typeof MiragePrompt.fitInputBudget === 'function') {
                    const fitted = MiragePrompt.fitInputBudget(sys, userText, inputPack?.tokens);
                    sys = fitted.systemInstruction;
                    userText = fitted.userText;
                    reportInputBudget(fitted);
                }
                thinkCall.systemInstruction = sys;
                thinkCall.userParts = [{ text: userText }];
                appendDebugDecision({
                    kind: 'notice',
                    summary: 'Thinking refused — retrying with softened wording',
                    detail: {
                        code: err.code || null,
                        preview: String(err.rawPreview || err.message || '').slice(0, 180),
                        rewritten: String(rewritten || '').slice(0, 240)
                    }
                });
            }

            async function generateAndParseThinking() {
                const rawText = await MirageAPI.thinkingGenerate(thinkCall);
                return MirageAPI.parseJsonResponse(rawText);
            }

            logDevTurn('thinking', {
                input: openInput,
                command: isCommand,
                storyLaunch,
                proactive,
                proactiveReason,
                mustDeliver,
                generateImage,
                pacing: turnPacing,
                thinkingModel: thinkingModelId
            });
            const thinkStartedAt = Date.now();
            const thinkWatch = setTimeout(() => {
                if (signal?.aborted) return;
                MirageUI.setSimGenerating(true, {
                    phase: 'thinking',
                    label: 'Still generating — waiting on the model…'
                });
            }, 12000);

            try {
                parsed = await generateAndParseThinking();
            } catch (firstErr) {
                if (firstErr) firstErr.modelId = thinkingModelId;
                if (!isRecoverableThinkingFail(firstErr)) throw firstErr;
                if (isRefusalThinkingFail(firstErr)) {
                    prepareSoftenedThinkingRetry(firstErr);
                    MirageUI.setSimGenerating(true, { phase: 'thinking', label: 'Retrying with milder wording…' });
                } else {
                    appendDebugDecision({
                        kind: 'notice',
                        summary: 'Thinking failed — retrying once',
                        detail: { code: firstErr.code || null, preview: firstErr.rawPreview || null }
                    });
                    console.warn('[Mirage] thinking failed — retrying once', firstErr.code || firstErr.message);
                    MirageUI.setSimGenerating(true, { phase: 'thinking', label: 'Trying again…' });
                }
                parsed = await generateAndParseThinking();
            } finally {
                clearTimeout(thinkWatch);
                const thinkMs = Date.now() - thinkStartedAt;
                if (thinkMs >= 8000) {
                    appendDebugDecision({
                        kind: 'turn',
                        summary: `Thinking took ${MirageImmersion?.formatDuration?.(thinkMs) || `${Math.round(thinkMs / 1000)}s`}`,
                        detail: {
                            phase: 'thinking_done',
                            thinkMs,
                            thinkingModel: thinkingModelId,
                            proactiveReason: proactiveReason || ''
                        }
                    });
                }
            }
            characterText = parsed.characterResponse || parsed.response || '…';
            if (parsed) applyDirectorShotLocks(parsed, S().session, cmd);
            if (mustDeliver && parsed?.delivery && typeof parsed.delivery === 'object') {
                const st = String(parsed.delivery.style || '').toLowerCase();
                if (st === 'left_on_read' || st === 'ghost_type') {
                    parsed.delivery.style = 'normal';
                }
            }
            const replyCap = Number(S()?.maxReplyChars);
            if (Number.isFinite(replyCap) && replyCap > 0) {
                characterText = clampReplyChars(characterText, replyCap);
                parsed.characterResponse = characterText;
                if (parsed.delivery && parsed.delivery.secondMessage) {
                    parsed.delivery.secondMessage = clampReplyChars(
                        parsed.delivery.secondMessage,
                        replyCap
                    );
                }
            }

            // Chat switched / new chat started while thinking — drop this result
            if (!isTurnBoundaryValid(boundary)) return;
            assertTurnLive(signal);

            const envBeforeRoutine = S().session.env;
            const outfitBefore = S().session.outfit;
            applyTracking(parsed.tracking, {
                parsed,
                lockOutfit: !!outfitClientLock,
                lockEnv: !!(sceneLocked && !skipSceneRef && !routineMove
                    && !cmd.changePlace && S().isSceneFieldSet(S().session.env))
            });
            if (userAuthored && S().session.outfit
                && S().session.outfit !== outfitBefore
                && typeof S().isSceneFieldSet === 'function'
                && S().isSceneFieldSet(S().session.outfit)) {
                S().session._skipSceneRefThisTurn = true;
                S().session._changeOutfitThisTurn = true;
                generateImage = true;
            }
            if (userAuthored && S().session.env
                && S().session.env !== envBeforeRoutine
                && typeof S().isSceneFieldSet === 'function'
                && S().isSceneFieldSet(S().session.env)
                && S().isSceneFieldSet(envBeforeRoutine)) {
                S().session._skipSceneRefThisTurn = true;
            }
            if (routineBeat && S().session) {
                if (typeof MirageRoutine?.stamp === 'function') {
                    MirageRoutine.stamp(S().session, routineBeat);
                }
                if (routineMove && typeof MiragePrompt?.placeFamily === 'function') {
                    const prevF = MiragePrompt.placeFamily(envBeforeRoutine);
                    const nextF = MiragePrompt.placeFamily(S().session.env);
                    const forbid = routineBeat.forbidFamilies || [];
                    if (prevF && nextF && (nextF === prevF || forbid.includes(nextF))) {
                        appendDebugDecision({
                            kind: 'scene',
                            summary: `Env same-family after ROUTINE (${prevF}) — “${envBeforeRoutine}” → “${S().session.env}”`,
                            detail: {
                                from: envBeforeRoutine,
                                to: S().session.env,
                                family: nextF,
                                forbid,
                                band: routineBeat.band
                            }
                        });
                    }
                }
            }

            if (!hardCut && S().session) S().session.hardCutStreak = 0;

            const prevEng = S().session.engagement;
            const loyalty = MirageLoyaltyUX.afterTurn({
                tracking: parsed.tracking,
                characterText,
                profile: S().profile,
                session: S().session,
                userText: text,
                internal: !!internal,
                proactive: !!proactive,
                isCommand: !!isCommand
            });
            if (loyalty.engagement != null) {
                if (prevEng !== loyalty.engagement) {
                    appendDebugDecision({
                        kind: 'metric',
                        summary: `Engagement ${prevEng ?? '—'} → ${loyalty.engagement}${loyalty.spiked ? ' (hook)' : ''}`,
                        detail: { from: prevEng, to: loyalty.engagement, hook: !!loyalty.spiked }
                    });
                }
                S().session.engagement = loyalty.engagement;
            }

            S().clearOperatorOverrides();
            updateHud();
            (loyalty.hints || []).forEach(h => {
                appendDebugDecision({ kind: 'hint', summary: h });
            });

            const trackingMode = String(parsed?.tracking?.mode || '').toUpperCase();
            if (storyLaunch || rawIsStoryCmd || trackingMode === 'STORY') {
                S().session.mode = 'STORY';
                S().session._storyActive = true;
                updateHud();
            } else if (S().session.mode === 'STORY') {
                // Follow-up DM / Wait-for-her text — don't keep STORY chrome on ordinary bubbles
                S().session.mode = 'DM';
                updateHud();
            }

            cardMode = (storyLaunch || rawIsStoryCmd || S().session.mode === 'STORY') ? 'STORY' : 'DM';
            if (cardMode === 'STORY') {
                generateImage = true;
            }
            if (generateImage) {
                ensureImageDirective(parsed, S().session);
            }

            const plan = MirageImmersion?.planDelivery?.(parsed, S().session, {
                forceInstant: skipRealtime || mustDeliver,
                storyLaunch: !!storyLaunch || cardMode === 'STORY',
                allowTimeSkip: !isCommand && !storyLaunch && !mustDeliver,
                // Immediate Story→DM: never narrative-skip (avoids next-day wrap to an earlier clock face)
                freshStoryReply: !!(cmd.storyToDm && Number(cmd.storyAgeMs) < 5 * 60 * 1000),
                lastUserText: text,
                proactive: !!proactive,
                pacingMode: turnPacing,
                mustDeliver
            }) || {
                style: 'normal',
                typingMs: 350,
                characterText,
                instant: true,
                timeSkipMs: 0,
                narrativeWaitMs: 0
            };
            characterText = plan.characterText != null ? plan.characterText : characterText;

            const payload = {
                text,
                characterText,
                parsed,
                cardMode,
                internal,
                storyLaunch,
                proactive: !!proactive,
                proactiveReason: proactiveReason || '',
                generateImage,
                cmd,
                plan,
                thinkingModelId
            };

            MiragePendingTurn.save({
                charKey: MirageChatStore.characterKey(S()),
                chatId: S().session.activeChatId,
                text,
                characterText,
                parsed,
                cardMode,
                internal,
                storyLaunch,
                wantImage: generateImage,
                cmd: { inject: cmd.inject || null, task },
                stage: 'image'
            });

            // Real-time waits release the turn lock so the operator can keep texting
            // (a new send cancels this delivery via deliveryGen + AbortSignal).
            if (realTime && !plan.instant) {
                turnInProgress = false;
                setTurnControlsDisabled(false);
                updateTurnActionControls();
            }

            const beat = await MirageImmersion.choreograph(plan, { signal });
            assertTurnLive(signal);

            if (!mustDeliver && (beat?.leftOnRead || beat?.ghosted || beat?.wentQuiet || beat?.withhold || plan?.withhold)) {
                // She withholds a reply — silence notice + ditch / follow-up / Story
                if (!isTurnBoundaryValid(boundary)) return;
                MiragePendingTurn.clear();
                MiragePhoneUX?.showTyping?.(false);
                MirageUI.setSimGenerating(false);
                MirageUI.setStatus('ACTIVE', 'active');
                const kind = beat?.wentQuiet || plan?.style === 'went_quiet'
                    ? 'went_quiet'
                    : (beat?.ghosted || plan?.style === 'ghost_type'
                        ? 'ghost'
                        : 'left_on_read');
                if (!internal) {
                    S().session.history.push({
                        user: historyUserLine(false, false, text),
                        ai: '',
                        at: chatStampMs(),
                        mode: 'DM'
                    });
                    try { MirageChatStore.saveActiveChat?.(S()); } catch { /* ignore */ }
                }
                MirageImmersion?.handleIgnoreAftermath?.(kind, {
                    silenceSimMs: beat?.silenceSimMs || plan?.silenceSimMs || null,
                    waitMs: plan?.leftOnReadHoldMs || null,
                    openedThread: !!(beat?.openedThread ?? plan?.openedThread)
                });
                logDevTurn('close', {
                    input: text,
                    withheld: true,
                    withheldStyle: kind,
                    mode: 'DM',
                    style: plan?.style || kind,
                    outfit: S().session.outfit,
                    outfitSource: S().session.outfitSource || null,
                    env: S().session.env,
                    engagement: S().session.engagement,
                    thinkingModel: thinkingModelId,
                    mustDeliver: false,
                    generateImage: false
                });
                heldLeftOnRead = true;
                clearTurnCheckpoint();
                return;
            }

            turnInProgress = true;
            setTurnControlsDisabled(true);
            updateTurnActionControls();
            await deliverTurnPayload(payload, {
                signal,
                plan,
                withReaction: !!beat?.withReaction || plan.style === 'reaction',
                boundary
            });
            assertTurnLive(signal);
        } catch (err) {
            rollbackProvisionalClockAdvance(clockGuard);
            clockGuard = null;
            if (err && thinkingModelId && !err.modelId) {
                err.modelId = thinkingModelId;
            }
            if (isTurnCancelled(err)) {
                MirageImmersion?.cancelDelivery?.();
                // Don't clear a pending left-on-read that we just armed in this turn
                if (!heldLeftOnRead) MirageImmersion?.clearPendingDelivery?.();
                MiragePendingTurn.clear();
                rollbackCancelledTurn(activeTurnCheckpoint, { restoreInput: !internal });
                MiragePhoneUX?.ensureClockNotBehindStamps?.({ includeDom: true });
                return;
            }
            MiragePendingTurn.clear();
            MirageImmersion?.clearPendingDelivery?.();
            clearTurnCheckpoint();
            MiragePhoneUX?.ensureClockNotBehindStamps?.({ includeDom: true });
            handleTurnError(err);
        } finally {
            if (S()?.session) {
                S().session._lastCommandInject = '';
                S().session._skipSceneRefThisTurn = false;
                S().session._fitCheckThisTurn = false;
                S().session._fitCheckStanceThisTurn = null;
                S().session._closeupThisTurn = false;
                S().session._cropLockThisTurn = null;
                S().session._shotLockThisTurn = null;
                S().session._shotRotateThisTurn = false;
                S().session._shotRecordedThisTurn = false;
                S().session._godModeThisTurn = false;
                S().session._userShotThisTurn = false;
                S().session._userAskThisTurn = false;
                S().session._askCropThisTurn = null;
                S().session._askSubjectThisTurn = null;
                S().session._askMirrorThisTurn = false;
                S().session._mirrorBackThisTurn = false;
                S().session._subjectLockThisTurn = null;
                S().session._changeOutfitThisTurn = false;
                S().session._outfitLookHintThisTurn = '';
                S().session._changePlaceThisTurn = false;
                S().session._userTextThisTurn = '';
                S().session._goonFaceBiasThisTurn = null;
                S().session._sceneCutFromEnv = null;
                S().session._routineThisTurn = null;
                MirageLoyaltyUX?.clearSkipWeather?.(S().session);
            }
            // A newer turn may have replaced our AbortController — never clobber its UI.
            const superseded = !!(activeTurnAbort && activeTurnAbort.signal !== signal);
            if (!superseded) {
                MiragePhoneUX?.showTyping?.(false);
                // Always clear Thinking / Generating — withhold path also clears earlier
                MirageUI.setSimGenerating(false);
                setTurnControlsDisabled(false);
                endTurnAbort();
                if (!heldLeftOnRead) input?.focus();
            }
            MirageUI?.refreshKieCredits?.();
        }
    }

    function updateStoryControls() {
        syncSimControls();
    }

    function postStory() {
        executeTurn('VIEW STORY', {
            internal: true,
            storyLaunch: true,
            forceInstant: true,
            wantImage: true
        });
    }

    function sendMessage() {
        const input = document.getElementById('simInput');
        const val = input?.value.trim();
        if (!val) return;
        if (input) input.value = '';
        executeTurn(val);
    }

    function replayUiLogEntry(e) {
        if (!e) return;
        const at = Number(e.at) || undefined;
        if (e.kind === 'command') {
            appendChat('user', e.text || '', {
                isCommand: true,
                clockArrow: e.clockArrow || null,
                at,
                persist: false
            });
            return;
        }
        if (e.kind === 'decision' || e.devOnly) return;
        if (/^simulation live\b/i.test(e.text || '') || /^chat loaded\b/i.test(e.text || '')) return;
        if (e.kind === 'alert') {
            appendChat('system', '', {
                alert: true,
                alertType: e.alertType || 'warn',
                title: e.title || 'Notice',
                body: e.body || e.text || '',
                at,
                persist: false
            });
            return;
        }
        appendChat('system', e.text || '', {
            caption: true,
            at,
            persist: false
        });
    }

    function rebuildChatFromHistory(history, { resumed = false, lastTurnFailed = false, uiLog = null } = {}) {
        const log = document.getElementById('chatLog');
        if (!log) return;
        log.innerHTML = '';
        if (S().session) S().session._lastChatStampMs = 0;

        if (S().session.startInstruction && !resumed) {
            appendChat('system', S().session.startInstruction, {
                caption: true,
                persist: false
            });
        }

        const noticesRaw = Array.isArray(uiLog)
            ? uiLog
            : (Array.isArray(S()?.session?.uiLog) ? S().session.uiLog : []);
        const hist = history || [];
        // Keep every persisted system / CMD / decision / alert line. A tight
        // timestamp window used to drop them after time skips (wall clock vs sim clock).
        const notices = noticesRaw;
        const events = [];

        notices.forEach((e) => {
            if (!e) return;
            events.push({
                ...e,
                at: Number(e.at) || 0,
                _src: 'log'
            });
        });

        hist.forEach((turn) => {
            const at = Number(turn.at) || chatStampMs();
            if (turn.user && !isInternalUserMarker(turn.user)) {
                const isCmd = looksLikeSlashCommand(turn.user);
                // Prefer persisted CMD bubble (keeps clock arrow) over bare history user line
                const dupCmd = isCmd && events.some(e =>
                    e.kind === 'command'
                    && String(e.text || '').trim() === String(turn.user || '').trim()
                    && Math.abs((Number(e.at) || 0) - at) < 5 * 60 * 1000
                );
                if (!dupCmd) {
                    events.push({
                        kind: isCmd ? 'command' : 'user',
                        text: turn.user,
                        at,
                        _src: 'hist'
                    });
                }
            }
            if (turn.ai && !isInternalAiMarker(turn.ai)) {
                events.push({
                    kind: 'ai',
                    text: turn.ai,
                    at: at + 1,
                    mode: turn.mode === 'STORY' ? 'STORY' : 'DM',
                    _src: 'hist'
                });
            }
        });

        events.sort((a, b) => (a.at || 0) - (b.at || 0));

        events.forEach((e) => {
            if (e.kind === 'user') {
                appendChat('user', e.text || '', { at: e.at, persist: false });
            } else if (e.kind === 'ai') {
                appendChat('ai', e.text || '', {
                    at: e.at,
                    persist: false,
                    label: e.mode === 'STORY' ? 'STORY' : null
                });
            } else {
                replayUiLogEntry(e);
            }
        });

        syncChatDevVisibility();
        MiragePhoneUX?.ensureClockNotBehindStamps?.({ includeDom: true });
        MiragePhoneUX?.syncClockChrome?.();

        if (lastTurnFailed) {
            const hasFail = noticesRaw.some(e => e?.kind === 'alert' && e?.alertType === 'image-fail');
            if (!hasFail) {
                const { title, body } = MirageAPI.imageFailureMessage(
                    'failed',
                    'Her last message was saved, but the image for that turn did not load.'
                );
                appendChat('system', '', {
                    alert: true,
                    alertType: 'image-fail',
                    title,
                    body,
                    persist: false
                });
            }
        }
    }

    async function restoreLastTurnUi() {
        return restoreChatUi();
    }

    async function restoreChatUi() {
        const chat = MirageChatStore.getActiveChat(S());
        if (!chat?.lastTurn?.ai && !(chat?.history?.length > 0)) return false;

        clearPhoneFeed();
        rebuildChatFromHistory(chat.history, {
            resumed: true,
            lastTurnFailed: !!chat.lastTurn?.imageFailed,
            uiLog: chat.uiLog
        });

        await restorePhoneFeedFromChat(chat);

        const restoredCards = document.querySelectorAll('#phoneFeed .phone-card').length;
        if (chat.lastTurn?.imageFailed && !restoredCards) {
            appendImageFailureAlert('failed', 'Her last message was saved, but the image for that turn did not load.');
        }

        if (chat.lastTurn?.imageDirective) {
            captureTurnSnapshot({
                text: chat.lastTurn.user,
                characterText: chat.lastTurn.ai,
                cardMode: chat.lastTurn.mode || S().session.mode,
                parsed: { imageDirective: chat.lastTurn.imageDirective },
                imageFailed: chat.lastTurn.imageFailed,
                imageSkipped: chat.lastTurn.imageSkipped
            });
        }

        updateHud();
        updateTurnActionControls();
        MiragePhoneUX?.ensureClockNotBehindStamps?.({ includeDom: true });
        if (typeof MirageImmersion?.resumeAfterAbsence === 'function') {
            MirageImmersion.resumeAfterAbsence();
        } else {
            const held = !!MirageImmersion?.maybeOfferClockResume?.();
            if (!held) MirageImmersion?.catchUpAfterAbsence?.();
        }
        MiragePhoneUX?.restoreUserReceipts?.();
        MiragePhoneUX?.updateChrome?.();
        await restoreSceneContinuity();
        return true;
    }

    function resetChatUi() {
        hideClockResumeOverlay();
        hideUnresponsiveCapOverlay();
        clearPhoneFeed();
        MirageLoyaltyUX.resetSession();
        MiragePhoneUX?.showTyping?.(false);
        MiragePhoneUX?.setPresence?.('idle');
        MirageDebugPanel.setLastTurn(null);
        MirageDebugPanel.setLastPrompt?.(null);
        rebuildChatFromHistory([], { resumed: false });
        clearSceneContinuity({ removeStored: false });
        updateHud();
        MiragePhoneUX?.updateChrome?.();
    }

    async function launch() {
        if (S().session.phase !== 'standby' && S().session.phase !== 'active') {
            MirageUI.toast('Complete setup and initialize from Standby first.', 'error');
            return false;
        }

        if (!S().hasApiAccess()) {
            MirageUI.refreshEngineStatus?.();
            MirageUI.toast('Configure your API key in Settings before starting a simulation.', 'error');
            const cfg = document.getElementById('configModal');
            if (cfg) cfg.hidden = false;
            return false;
        }

        const sess = S().session;
        const protocolSnap = sess.protocol;
        const modeSnap = sess.mode;
        const startSnap = sess.startInstruction;
        const directorSnap = sess.directorScene;
        const storyProto = typeof MirageSetupProtocol?.isStoryProtocol === 'function'
            && MirageSetupProtocol.isStoryProtocol(protocolSnap);

        sess.clockResumeHold = null;
        sess._skipAbsenceResume = true;

        quarantineChatBoundary();
        stripHistoryBloat();

        try {
            MirageChatStore.createChat(S(), { resetMetrics: true });
        } catch (err) {
            sess._skipAbsenceResume = false;
            sess.phase = 'standby';
            sess.protocol = protocolSnap;
            sess.mode = modeSnap;
            sess.startInstruction = startSnap;
            sess.directorScene = directorSnap;
            if (typeof MirageUI?.isStorageQuotaError === 'function' && MirageUI.isStorageQuotaError(err)) {
                MirageUI.showStorageFullDialog({ context: 'Couldn’t start a new chat.' });
            } else {
                MirageUI.toast(err?.message || 'Could not start a new chat.', 'error');
            }
            window.MirageApp?.goToSetupStep(5, { force: true });
            return false;
        }

        sess.protocol = protocolSnap;
        sess.mode = modeSnap || (storyProto ? 'STORY' : 'DM');
        sess.startInstruction = startSnap;
        sess.directorScene = directorSnap;
        sess.clockResumeHold = null;
        sess.lastAiMessageAt = null;
        sess.lastUserMessageAt = null;
        sess.lastAttendedWallMs = Date.now();
        sess.history = Array.isArray(sess.history) ? sess.history : [];

        sess.phase = 'active';
        MirageUI.refreshEngineStatus?.();
        try {
            window.MirageApp?.goToSetupStep(6, { force: true });
        } finally {
            sess._skipAbsenceResume = false;
        }

        MiragePendingTurn.clear();
        MirageLoyaltyUX.resetSession();
        MirageDebugPanel.setLastTurn(null);
        MirageDebugPanel.setLastPrompt?.(null);
        S().seedSessionDynamics?.() || S().seedSessionEngagement?.();
        clearSceneContinuity({ removeStored: false });

        clearPhoneFeed();
        rebuildChatFromHistory([], { resumed: false });

        updateHud();
        updateStoryControls();

        if (MirageSetupProtocol.shouldAutoLaunchStory(S())) {
            MirageImmersion?.clearProactive?.();
            MirageImmersion?.cancelDelivery?.();

            // B2 Story Shuffle: randomize local clock (B1 Sync keeps real "now" in her TZ)
            let shuffleNote = '';
            if (S().session.protocol === 'B2' && typeof MiragePhoneUX?.jumpToRandomLocalTime === 'function') {
                const jumped = MiragePhoneUX.jumpToRandomLocalTime();
                if (jumped) {
                    shuffleNote = `Story Shuffle moved her clock to ${jumped.clock} (${jumped.label}).`;
                    appendCaption(shuffleNote);
                }
            }

            appendCaption(MirageSetupProtocol.storyLaunchMessage(S()));
            try {
                await executeTurn(MirageSetupProtocol.getStoryLaunchInput(S()), {
                    internal: true,
                    storyLaunch: true,
                    forceInstant: true,
                    wantImage: true
                });
            } catch (err) {
                handleTurnError(err);
                return false;
            }
        }

        return true;
    }

    function onEnter() {
        if (S().session.phase !== 'active' && S().session.phase !== 'standby') {
            MirageUI.toast('Initialize from Standby first.', 'error');
            window.MirageApp?.goToSetupStep(5);
            return;
        }

        if (S().session.phase === 'standby') {
            S().session.phase = 'active';
        }

        stripHistoryBloat();
        updateHud();
        updateStoryControls();
        if (S().session._skipAbsenceResume) {
            S().session.clockResumeHold = null;
        } else if (typeof MirageImmersion?.resumeAfterAbsence === 'function') {
            MirageImmersion.resumeAfterAbsence();
        } else {
            const held = !!MirageImmersion?.maybeOfferClockResume?.();
            if (!held) MirageImmersion?.catchUpAfterAbsence?.();
        }
        MiragePhoneUX?.updateChrome?.();
        MirageDebugPanel.refresh();

        const label = document.getElementById('simCharacterLabel');
        if (label) {
            const name = typeof MirageSetupProfile?.displayName === 'function'
                ? MirageSetupProfile.displayName(S().profile)
                : (S().profile?.name || 'Character');
            label.textContent = [
                name,
                S().profile?.age ? String(S().profile.age).trim() : '',
                S().session.mode || 'DM'
            ].filter(Boolean).join(' · ');
        }
        syncUserProfileUi();

        const discarded = discardInFlightTurn();
        if (discarded) {
            const input = document.getElementById('simInput');
            if (input && !discarded.internal && discarded.text && !input.value.trim()) {
                input.value = discarded.text;
            }
            MirageUI.toast(
                discarded.internal
                    ? 'Interrupted generation discarded — last complete turn restored.'
                    : 'Interrupted turn discarded — last complete message restored. Your text is back in the box.',
                'info',
                { essential: true, duration: 7000 }
            );
        }
        updateTurnActionControls();
    }

    const CHAT_EMOJIS = [
        '😀', '😁', '😂', '🤣', '😊', '😇', '😉', '😍',
        '🥰', '😘', '😗', '😋', '😜', '🤪', '🤨', '😏',
        '😒', '🙄', '😬', '😔', '😪', '😴', '😷', '🤒',
        '🥵', '🥶', '😳', '🥺', '😢', '😭', '😤', '😠',
        '🤯', '😈', '💀', '👀', '💋', '💘', '❤️', '🧡',
        '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❣️',
        '💕', '💞', '💓', '💗', '💖', '✨', '🔥', '⭐',
        '🎉', '✅', '❌', '💯', '🙏', '👍', '👎', '👏',
        '🙌', '🤝', '✌️', '🤞', '🤟', '🤘', '👌', '🤌',
        '👈', '👉', '👆', '👇', '👋', '🫡', '💪', '🫠'
    ];

    function insertEmojiAtCursor(emoji) {
        const input = document.getElementById('simInput');
        if (!input || !emoji) return;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        const before = input.value.slice(0, start);
        const after = input.value.slice(end);
        input.value = before + emoji + after;
        const pos = start + emoji.length;
        input.focus();
        try {
            input.setSelectionRange(pos, pos);
        } catch { /* ignore */ }
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function closeEmojiPicker() {
        const panel = document.getElementById('emojiPickerPanel');
        const btn = document.getElementById('btnEmojiPicker');
        if (panel) panel.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function openEmojiPicker() {
        const panel = document.getElementById('emojiPickerPanel');
        const btn = document.getElementById('btnEmojiPicker');
        const grid = document.getElementById('emojiPickerGrid');
        if (!panel || !grid) return;
        if (!grid.childElementCount) {
            CHAT_EMOJIS.forEach(emoji => {
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.textContent = emoji;
                cell.title = emoji;
                cell.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    insertEmojiAtCursor(emoji);
                    // keep open for multi-pick; Esc / outside / Send closes
                });
                grid.appendChild(cell);
            });
        }
        panel.hidden = false;
        btn?.setAttribute('aria-expanded', 'true');
    }

    function toggleEmojiPicker() {
        const panel = document.getElementById('emojiPickerPanel');
        if (!panel) return;
        if (panel.hidden) openEmojiPicker();
        else closeEmojiPicker();
    }

    function bindEmojiPicker() {
        const btn = document.getElementById('btnEmojiPicker');
        const wrap = btn?.closest('.emoji-picker-wrap');
        btn?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleEmojiPicker();
        });
        document.addEventListener('click', (e) => {
            if (!wrap || wrap.contains(e.target)) return;
            closeEmojiPicker();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeEmojiPicker();
        });
    }

    function bind() {
        document.getElementById('btnSendMessage')?.addEventListener('click', () => {
            closeEmojiPicker();
            sendMessage();
        });
        document.getElementById('btnViewStory')?.addEventListener('click', postStory);
        document.getElementById('btnCancelTurn')?.addEventListener('click', cancelActiveTurn);
        document.getElementById('btnSkipWait')?.addEventListener('click', () => {
            handleClientOnlyCommand({ clientOnly: 'skip_wait' });
        });
        document.getElementById('btnRetryFace')?.addEventListener('click', retryFace);
        document.getElementById('btnRetryPrompt')?.addEventListener('click', retryPrompt);
        document.getElementById('simUserProfileSelect')?.addEventListener('change', (e) => {
            void setChatUserProfile(e.target.value);
        });
        document.getElementById('simInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                closeEmojiPicker();
                sendMessage();
            }
        });
        bindEmojiPicker();
        bindPhoneLightbox();
        document.getElementById('clockResumeOverlay')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-clock-resume]');
            if (!btn) return;
            e.preventDefault();
            applyClockResume(btn.getAttribute('data-clock-resume'));
        });
        document.getElementById('btnUnresponsiveCapDismiss')?.addEventListener('click', () => {
            dismissUnresponsiveCapOverlay();
        });
        syncSimControls();
        window.addEventListener('pagehide', flushUiLogSave);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushUiLogSave();
        });
    }

    function appendCaption(text, opts = {}) {
        if (!text) return;
        appendChat('system', String(text), {
            caption: true,
            persist: opts.persist !== false,
            at: opts.at,
            touchClock: opts.touchClock !== false
        });
    }

    /**
     * The system instruction is never trimmed to fit the input budget, so when it
     * alone exceeds "Max thinking prompt per turn" the cap simply cannot hold. Say so
     * in the decision log rather than letting the setting look like it worked.
     */
    function reportInputBudget(fitted) {
        if (!fitted?.overBudget) return;
        appendDebugDecision({
            kind: 'notice',
            summary: `Input budget exceeded — system prompt alone is ~${fitted.systemTokens} tokens `
                + `against a ${fitted.budgetTokens} cap`,
            detail: {
                budgetTokens: fitted.budgetTokens,
                estimatedTokens: fitted.estimatedTokens,
                systemTokens: fitted.systemTokens,
                note: 'History was trimmed to nothing; the system instruction is never trimmed.'
            }
        });
    }

    function appendSystemNote(text, { essential = false } = {}) {
        if (!text) return;
        if (essential) {
            appendCaption(text);
            return;
        }
        MirageUI.toast(String(text), 'info', { lane: 'dev' });
    }

    /** Decision line — debug panel only. Chat stays a conversation. */
    function appendDebugDecision(evt) {
        if (!evt) return;
        try {
            MirageDebugPanel?.pushDecision?.(evt);
        } catch { /* ignore */ }
    }

    function clipDev(s, n) {
        const t = String(s || '').replace(/\s+/g, ' ').trim();
        if (!t) return '';
        return t.length > n ? `${t.slice(0, n - 1)}…` : t;
    }

    function logDevTurn(phase, fields = {}) {
        const bits = [];
        if (phase === 'open') {
            bits.push(fields.command ? 'CMD' : (fields.storyLaunch ? 'STORY' : (fields.proactive ? 'proactive' : 'DM')));
            if (fields.input) bits.push(clipDev(fields.input, 80));
            if (fields.mustDeliver) bits.push('must-deliver');
            bits.push(fields.generateImage ? 'image on' : 'image off');
            if (fields.pacing) bits.push(fields.pacing);
        } else if (phase === 'thinking') {
            bits.push('thinking started');
            if (fields.thinkingModel) bits.push(fields.thinkingModel);
            if (fields.proactiveReason) bits.push(fields.proactiveReason);
        } else {
            bits.push(fields.withheld ? 'withheld' : (fields.failed ? 'FAILED' : (fields.mode || 'DM')));
            if (fields.shot) bits.push([fields.shot, fields.crop].filter(Boolean).join(' / '));
            if (fields.image === 'failed') bits.push('photo FAIL');
            else if (fields.image === 'skipped') bits.push('no photo');
            else if (fields.image === 'photo') bits.push('photo');
            if (fields.refs?.length) bits.push(fields.refs.join('+'));
            if (fields.style) bits.push(fields.style);
            if (fields.outfitSource === 'library' || fields.outfitSource === 'library-still') bits.push('look:library');
            else if (fields.outfitSource === 'invented') bits.push('look:invented');
        }
        appendDebugDecision({
            kind: 'turn',
            summary: bits.filter(Boolean).join(' · '),
            detail: {
                phase,
                input: clipDev(fields.input, 180),
                reply: clipDev(fields.reply, 140),
                error: clipDev(fields.error, 160),
                errorCode: fields.errorCode || null,
                rawPreview: clipDev(fields.rawPreview, 400),
                command: !!fields.command,
                storyLaunch: !!fields.storyLaunch,
                proactive: !!fields.proactive,
                proactiveReason: fields.proactiveReason || '',
                mustDeliver: !!fields.mustDeliver,
                generateImage: !!fields.generateImage,
                pacing: fields.pacing || null,
                refreshScene: !!fields.refreshScene,
                godMode: !!fields.godMode,
                changeOutfit: !!fields.changeOutfit,
                thinkingModel: fields.thinkingModel || null,
                mode: fields.mode || null,
                style: fields.style || null,
                shot: fields.shot || null,
                crop: fields.crop || null,
                refs: Array.isArray(fields.refs) ? fields.refs.slice(0, 8) : null,
                image: fields.image || null,
                outfit: fields.outfit || null,
                outfitSource: fields.outfitSource || null,
                env: fields.env || null,
                engagement: fields.engagement != null ? fields.engagement : null,
                withheld: !!fields.withheld,
                withheldStyle: fields.withheldStyle || null,
                failed: !!fields.failed
            }
        });
    }

    window.MirageSimulation = {
        bind,
        launch,
        onEnter,
        executeTurn,
        applyPendingWorldClock,
        isTurnInProgress,
        isEngineBusy,
        isHardBusy,
        syncSimControls,
        updateHud,
        updateTurnActionControls,
        syncUserProfileUi,
        setChatUserProfile,
        restoreLastTurnUi,
        restoreChatUi,
        resetChatUi,
        showClockResumeOverlay,
        hideClockResumeOverlay,
        showUnresponsiveCapOverlay,
        hideUnresponsiveCapOverlay,
        dismissUnresponsiveCapOverlay,
        applyClockResume,
        discardInFlightTurn,
        resumePendingTurnIfAny,
        retryLastImage,
        retryFace,
        retryPrompt,
        cancelActiveTurn,
        quarantineChatBoundary,
        releasePendingDelivery,
        postStory,
        updateStoryControls,
        appendCaption,
        appendSystemNote,
        appendDebugDecision,
        syncChatDevVisibility,
        refreshChatTimestamps,
        clearSceneContinuity,
        restoreSceneContinuity
    };
})();
