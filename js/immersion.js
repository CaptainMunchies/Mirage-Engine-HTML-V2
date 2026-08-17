/**
 * MIRAGE ENGINE v2 — Immersion scheduler
 *
 * Real-time reply delays, async social texture (ghost-type, left-on-read, unread
 * aftermath, reactions, double-text), proactive DM / Story beats, and operator
 * presence gating. Instant mode still supports ignore silence + post-skip Stories.
 */
(function (global) {
    'use strict';

    const S = () => global.EngineState;

    /** Fallback ceiling when Settings max-wait is unset. */
    const REAL_WAIT_CAP_MS = 10 * 60 * 1000;
    /** Fallback quiet-before-chase when Settings unset. */
    const UNSEEN_UNREAD_MS = 3 * 60 * 1000;
    /** Real-world gap before the blocking clock-resume prompt. */
    const CLOCK_RESUME_MS = 60 * 60 * 1000;

    const STYLES = new Set([
        'normal', 'slow', 'ghost_type', 'left_on_read', 'went_quiet', 'reaction', 'double_text'
    ]);

    /** Client lottery — model alone defaults to "normal" + delaySec:0 and feels instant. */
    const STYLE_WEIGHTS = [
        { style: 'normal', w: 38 },
        { style: 'slow', w: 18 },
        { style: 'ghost_type', w: 10 },
        { style: 'left_on_read', w: 12 },
        { style: 'went_quiet', w: 8 },
        { style: 'reaction', w: 8 },
        { style: 'double_text', w: 10 }
    ];

    const DOUBLE_TEXT_EXCUSES = [
        // Kept for reference / future texture — never auto-injected into live replies.
        'sorry was in the shower',
        'omg wait',
        'k one sec',
        'sorry phone died',
        'wait nvm',
        'lol sorry',
        'ok back',
        'sorry just saw this'
    ];

    let deliveryGen = 0;
    let proactiveTimer = null;
    /** @type {{ run: Function, reason: string }|null} */
    let proactivePending = null;
    let unreadAftermathTimer = null;
    let pendingDelivery = null;
    let waitStatusTimer = null;
    /**
     * Explicit skippable wall wait (time jumps / wait-for-her / narrative skip).
     * NOT used for short Seen/typing sleeps — those must not light Skip wait.
     * @type {{ id: number, reason: string, timer: any, finish: (opts?: { skipped?: boolean }) => void }|null}
     */
    let skippableWallWait = null;
    let skippableWallWaitSeq = 0;
    /** Active immersion sleep waiters — cancel aborts; optional wallWait ties to Skip wait. */
    const sleepWaiters = new Set();

    /**
     * Skip in-flight Delivered/Seen/typing sleeps so the turn can finish immediately.
     * Resolves waiters (does NOT reject) — avoids Cancel's turn-rollback path.
     */
    function accelerateInFlightWaits() {
        const waiters = [...sleepWaiters];
        waiters.forEach((w) => {
            try { w.skip(); } catch { /* ignore */ }
        });
        if (skippableWallWait?.finish && !skippableWallWait.waiter) {
            // Timer-backed world_skip / wait-for-her — fire the beat now
            try {
                skippableWallWait.finish({ skipped: true });
            } catch (e) {
                console.warn('[Mirage] pacing accelerate wall wait failed', e);
                clearSkippableWallWait({ silent: true });
            }
        } else if (skippableWallWait) {
            clearSkippableWallWait({ silent: true });
        }
        MiragePhoneUX?.showTyping?.(false);
        clearWaitLabel();
        if (waitStatusTimer) {
            clearTimeout(waitStatusTimer);
            waitStatusTimer = null;
        }
        MirageSimulation?.updateTurnActionControls?.();
    }

    /**
     * Settings changed pacing while a sim may be mid-turn / mid-wait.
     * Policy: never roll back a turn that already started; adapt waits to the new mode.
     */
    function onPacingModeChanged(fromMode, toMode) {
        const from = String(fromMode || pacingMode()).toLowerCase();
        const to = String(toMode || pacingMode()).toLowerCase();
        if (from === to) {
            MirageSimulation?.updateTurnActionControls?.();
            MirageControlDeck?.sync?.();
            return;
        }

        const leavingRealtime = from === 'realtime' && to !== 'realtime';
        const leavingTimeJumpWaits = (from === 'hybrid' || from === 'realtime')
            && to === 'instant';
        const enteringRealtime = to === 'realtime' && from !== 'realtime';
        const comeBack = isComeBackHold()
            ? { ...(S()?.session?.socialHold || {}) }
            : null;
        const hardBusy = !!MirageSimulation?.isHardBusy?.();
        const engineBusy = !!MirageSimulation?.isEngineBusy?.();

        clearProactive();

        if (leavingRealtime) {
            // Realtime → Instant/Hybrid: drop Delivered theater; finish the reply now
            accelerateInFlightWaits();
            emitDecision({
                kind: 'pacing',
                summary: `Pacing ${from} → ${to} — accelerated in-flight delivery`,
                detail: { from, to, hardBusy, engineBusy }
            });
            if (!hardBusy) {
                MirageUI?.setSimGenerating?.(false);
                MirageUI?.setStatus?.('ACTIVE', 'active');
            }
            MirageUI?.toast?.(
                'Pacing updated — finishing this reply without realtime waits.',
                'info',
                { essential: true }
            );
        } else if (leavingTimeJumpWaits && hasActiveWallWait()) {
            // Hybrid → Instant with an armed time-jump wait: skip & fire the beat
            skipWallWaits();
            emitDecision({
                kind: 'pacing',
                summary: `Pacing ${from} → ${to} — skipped time-jump wait`,
                detail: { from, to }
            });
            MirageUI?.toast?.(
                'Pacing updated — skipped the time wait.',
                'info',
                { essential: true }
            );
        } else if (enteringRealtime) {
            // Instant/Hybrid → Realtime: current turn keeps its already-built plan
            emitDecision({
                kind: 'pacing',
                summary: `Pacing ${from} → ${to} — applies after this turn`,
                detail: { from, to, hardBusy, engineBusy }
            });
            if (engineBusy || hardBusy) {
                MirageUI?.toast?.(
                    'Realtime on — current turn finishes as planned; new pacing applies next.',
                    'info',
                    { essential: true }
                );
            }
        } else if (from === 'instant' && to === 'hybrid') {
            emitDecision({
                kind: 'pacing',
                summary: `Pacing ${from} → ${to}`,
                detail: { from, to }
            });
            if (engineBusy || hardBusy) {
                MirageUI?.toast?.(
                    'Hybrid on — time-jump waits apply on the next scene jump.',
                    'info',
                    { essential: true }
                );
            }
        } else if (from === 'hybrid' && to === 'realtime') {
            // Keep any armed world_skip wait (realtime also waits on jumps)
            emitDecision({
                kind: 'pacing',
                summary: `Pacing ${from} → ${to}`,
                detail: { from, to, hardBusy, engineBusy }
            });
            if (engineBusy || hardBusy) {
                MirageUI?.toast?.(
                    'Realtime on — current wait/turn continues; full theater on the next reply.',
                    'info',
                    { essential: true }
                );
            }
        }

        if (comeBack && !hardBusy && !engineBusy) {
            scheduleSocialBeat({
                reason: comeBack.reason || 'ghost',
                outcome: comeBack.outcome || 'follow_up'
            });
        }

        MirageSimulation?.updateTurnActionControls?.();
        MirageControlDeck?.sync?.();
        try { MirageDebugPanel?.refresh?.(); } catch { /* ignore */ }
    }

    function pacingMode() {
        if (typeof S()?.getPacingMode === 'function') return S().getPacingMode();
        const m = String(S()?.pacingMode || '').toLowerCase();
        if (m === 'instant' || m === 'hybrid' || m === 'realtime') return m;
        return S()?.realTimeChat ? 'realtime' : 'instant';
    }

    /** Full phone theater (Delivered delays, long Seen, ghost, idle chase). */
    function enabled() {
        return pacingMode() === 'realtime';
    }

    /** Hybrid + Realtime: wall-wait on narrative / world time jumps. */
    function waitsOnTimeJumps() {
        const m = pacingMode();
        return m === 'hybrid' || m === 'realtime';
    }

    /** Instant + Hybrid: Seen-while-thinking + short typing (not full RT). */
    function isInstantLike() {
        return !enabled();
    }

    function realWaitCapMs() {
        const n = Number(S()?.realTimeMaxWaitMs);
        if (Number.isFinite(n) && n >= 60 * 1000) {
            return Math.min(30 * 60 * 1000, Math.round(n));
        }
        return REAL_WAIT_CAP_MS;
    }

    function noReplyWaitMs() {
        const n = Number(S()?.noReplyWaitMs);
        if (Number.isFinite(n) && n >= 60 * 1000) {
            return Math.min(30 * 60 * 1000, Math.round(n));
        }
        return UNSEEN_UNREAD_MS;
    }

    function emitDecision(evt) {
        try {
            MirageSimulation?.appendDebugDecision?.(evt);
            // appendDebugDecision already pushes the debug panel; avoid double-push
        } catch { /* ignore */ }
    }

    function sleep(ms, { signal, gen, wallWait = false, waitLabel = null } = {}) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted || (gen != null && gen !== deliveryGen)) {
                const err = new Error('Turn cancelled');
                err.code = 'CANCELLED';
                reject(err);
                return;
            }

            let settled = false;
            const timer = setTimeout(() => {
                finish(() => {
                    if (gen != null && gen !== deliveryGen) {
                        const err = new Error('Turn cancelled');
                        err.code = 'CANCELLED';
                        reject(err);
                        return;
                    }
                    resolve();
                });
            }, Math.max(0, ms));

            const onAbort = () => {
                finish(() => {
                    const err = new Error('Turn cancelled');
                    err.code = 'CANCELLED';
                    reject(err);
                });
            };

            const waiter = {
                wallWait: !!wallWait,
                skip: () => finish(() => resolve()),
                cancel: () => finish(() => {
                    const err = new Error('Turn cancelled');
                    err.code = 'CANCELLED';
                    reject(err);
                })
            };

            function finish(fn) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                sleepWaiters.delete(waiter);
                signal?.removeEventListener?.('abort', onAbort);
                if (waiter.wallWait && skippableWallWait?.waiter === waiter) {
                    skippableWallWait = null;
                }
                fn();
                MirageSimulation?.updateTurnActionControls?.();
            }

            sleepWaiters.add(waiter);
            signal?.addEventListener?.('abort', onAbort, { once: true });

            if (wallWait) {
                clearSkippableWallWait({ silent: true });
                if (waitLabel) setWaitLabel(waitLabel);
                skippableWallWait = {
                    id: ++skippableWallWaitSeq,
                    reason: 'narrative',
                    timer: null,
                    waiter,
                    finish: ({ skipped = false } = {}) => {
                        if (skipped) waiter.skip();
                    }
                };
                MirageSimulation?.updateTurnActionControls?.();
            }
        });
    }

    function clearSkippableWallWait({ silent = false, fire = false } = {}) {
        const cur = skippableWallWait;
        if (!cur) return false;
        skippableWallWait = null;
        if (cur.timer) {
            clearTimeout(cur.timer);
            cur.timer = null;
        }
        // Detach sleep waiter link without resolving/rejecting unless fire requested via finish
        if (cur.waiter) cur.waiter.wallWait = false;
        if (fire) {
            try { cur.onFire?.(); } catch (e) {
                console.warn('[Mirage] wall wait fire failed', e);
            }
        }
        if (!silent) {
            clearWaitLabel();
            MirageUI?.setStatus?.('ACTIVE', 'active');
            MirageSimulation?.updateTurnActionControls?.();
        }
        return true;
    }

    /**
     * Start an operator-skippable wall wait (time jump / wait-for-her).
     * Always pairs UI + Skip wait button + onFire callback.
     */
    function beginSkippableWallWait({ reason, waitMs, label, onFire, silentUi = false } = {}) {
        clearSkippableWallWait({ silent: true });
        if (proactiveTimer) {
            clearTimeout(proactiveTimer);
            proactiveTimer = null;
        }
        proactivePending = null;

        const ms = Math.max(250, Math.round(Number(waitMs) || 0));
        const id = ++skippableWallWaitSeq;
        if (!silentUi) setWaitLabel(label || 'Waiting…');

        const finish = ({ skipped = false } = {}) => {
            if (skippableWallWait?.id !== id) return false;
            if (skippableWallWait.timer) clearTimeout(skippableWallWait.timer);
            skippableWallWait = null;
            proactiveTimer = null;
            proactivePending = null;
            clearWaitLabel();
            MirageUI?.setStatus?.('ACTIVE', 'active');
            MirageSimulation?.updateTurnActionControls?.();
            if (skipped) {
                emitDecision({
                    kind: 'skip_wait',
                    summary: `Operator skipped wall wait (${reason || 'wait'})`
                });
            }
            try { onFire?.({ skipped }); } catch (e) {
                console.warn('[Mirage] wall wait onFire failed', e);
            }
            return true;
        };

        const timer = setTimeout(() => finish({ skipped: false }), ms);
        skippableWallWait = { id, reason: reason || 'wait', timer, finish };
        proactivePending = { reason: reason || 'wait', run: () => finish({ skipped: false }) };
        proactiveTimer = timer;
        MirageSimulation?.updateTurnActionControls?.();
        return skippableWallWait;
    }

    function hasActiveWallWait() {
        return !!skippableWallWait;
    }

    function skipWallWaits() {
        if (!skippableWallWait) return false;
        // Narrative sleep-backed wait: resolve the sleep promise
        if (skippableWallWait.waiter) {
            emitDecision({
                kind: 'skip_wait',
                summary: `Operator skipped wall wait (${skippableWallWait.reason || 'narrative'})`
            });
            skippableWallWait.waiter.skip();
            return true;
        }
        return !!skippableWallWait.finish({ skipped: true });
    }

    function clamp(n, lo, hi) {
        return Math.max(lo, Math.min(hi, n));
    }

    function randBetween(lo, hi) {
        return lo + Math.random() * (hi - lo);
    }

    /**
     * Hybrid sim→real wait: short gaps ~1:1, mid gaps compress, long gaps asymptote
     * toward Settings max-wait. Always hard-capped at realWaitCapMs().
     */
    function toRealWaitMs(simMs) {
        const ms = Math.max(0, Number(simMs) || 0);
        if (ms <= 0) return 0;
        const cap = realWaitCapMs();
        const twoMin = 2 * 60 * 1000;
        const thirtyMin = 30 * 60 * 1000;
        const midTarget = Math.min(5 * 60 * 1000, Math.max(twoMin, cap * 0.5));
        let mapped;
        if (ms <= twoMin) {
            mapped = ms;
        } else if (ms <= thirtyMin) {
            const t = (ms - twoMin) / (thirtyMin - twoMin);
            mapped = twoMin + t * (midTarget - twoMin);
        } else {
            const over = ms - thirtyMin;
            const base = midTarget;
            const room = Math.max(0, cap - base);
            const scale = 6 * 60 * 60 * 1000;
            mapped = base + room * (1 - Math.exp(-over / scale));
        }
        return capRealWaitMs(mapped);
    }

    function capRealWaitMs(ms) {
        return Math.min(Math.max(0, Math.round(Number(ms) || 0)), realWaitCapMs());
    }

    function pickWeighted(items) {
        const total = items.reduce((s, it) => s + it.w, 0);
        let r = Math.random() * total;
        for (const it of items) {
            r -= it.w;
            if (r <= 0) return it.style;
        }
        return items[0].style;
    }

    /** Typing duration from message length (~38 chars/sec) + jitter. */
    function typingMsFor(text) {
        const len = String(text || '').length;
        return clamp(1200 + (len / 38) * 1000 + randBetween(200, 900), 1500, 45000);
    }

    function formatDuration(ms) {
        const n = Math.max(0, Number(ms) || 0);
        const DAY = 24 * 60 * 60 * 1000;
        const WEEK = 7 * DAY;
        const MONTH = 30 * DAY;
        const YEAR = 365 * DAY;
        if (n >= YEAR) {
            const y = Math.max(1, Math.round(n / YEAR));
            return y === 1 ? '1 year' : `${y} years`;
        }
        if (n >= MONTH) {
            const m = Math.max(1, Math.round(n / MONTH));
            return m === 1 ? '1 month' : `${m} months`;
        }
        if (n >= WEEK) {
            const w = Math.max(1, Math.round(n / WEEK));
            return w === 1 ? '1 week' : `${w} weeks`;
        }
        if (n >= DAY) {
            const d = Math.max(1, Math.round(n / DAY));
            return d === 1 ? '1 day' : `${d} days`;
        }
        const sec = Math.round(n / 1000);
        if (sec < 60) return `${sec}s`;
        const min = Math.round(sec / 60);
        if (min < 60) return `${min} min`;
        const hr = Math.floor(min / 60);
        const rem = min % 60;
        return rem ? `${hr}h ${rem}m` : `${hr}h`;
    }

    /** Age labels for chat stamps once a full day (or more) has passed. */
    function formatRelativeAgo(ms) {
        const n = Math.max(0, Number(ms) || 0);
        const DAY = 24 * 60 * 60 * 1000;
        const WEEK = 7 * DAY;
        const MONTH = 30 * DAY;
        const YEAR = 365 * DAY;
        if (n < DAY) {
            return `${formatDuration(n)} ago`;
        }
        // Whole midnights, not rolling 24h: 24–48h after a 10am stamp is still
        // "yesterday" until the second 12:00 AM, then "2 days ago".
        if (n >= YEAR) {
            const y = Math.max(1, Math.floor(n / YEAR));
            return y === 1 ? '1 year ago' : `${y} years ago`;
        }
        if (n >= MONTH) {
            const m = Math.max(1, Math.floor(n / MONTH));
            return m === 1 ? '1 month ago' : `${m} months ago`;
        }
        if (n >= WEEK) {
            const w = Math.max(1, Math.floor(n / WEEK));
            return w === 1 ? '1 week ago' : `${w} weeks ago`;
        }
        const d = Math.max(1, Math.floor(n / DAY));
        if (d <= 1) return 'yesterday';
        return `${d} days ago`;
    }

    /** Prefer day/week span in wait UI when the jump is ≥24h. */
    function formatTimeJumpSpan(ms, fallback) {
        const n = Math.max(0, Number(ms) || 0);
        if (n >= 24 * 60 * 60 * 1000) return formatDuration(n);
        const hint = String(fallback || '').trim();
        return hint || formatDuration(n);
    }

    /** Simulation-clock "now" (wall time + session clockOffsetMs). */
    function simNowMs() {
        try {
            if (typeof MiragePhoneUX?.herNow === 'function') {
                return MiragePhoneUX.herNow().getTime();
            }
        } catch { /* fall through */ }
        const offset = Number(S()?.session?.clockOffsetMs) || 0;
        return Date.now() + offset;
    }

    /** Sim-time silence since last operator text (includes /time pass jumps). */
    function silenceSinceUserMs() {
        const sess = S()?.session;
        if (!sess) return 0;
        const t = Number(sess.lastUserMessageAt) || 0;
        if (!t) return 0;
        return Math.max(0, simNowMs() - t);
    }

    function silenceSinceAnyMs() {
        const sess = S()?.session;
        if (!sess) return 0;
        const t = Math.max(
            Number(sess.lastUserMessageAt) || 0,
            Number(sess.lastAiMessageAt) || 0
        );
        if (!t) return 0;
        return Math.max(0, simNowMs() - t);
    }

    function touchLastAttended() {
        const sess = S()?.session;
        if (!sess || sess.clockResumeHold) return;
        sess.lastAttendedWallMs = Date.now();
    }

    /** Wall-clock time since the operator last attended this chat. */
    function wallAbsenceMs() {
        const sess = S()?.session;
        if (!sess) return 0;
        const last = Number(sess.lastAttendedWallMs) || 0;
        if (last > 0) return Math.max(0, Date.now() - last);
        return silenceSinceAnyMs();
    }

    function isClockResumeHold() {
        return !!S()?.session?.clockResumeHold;
    }

    /**
     * After ≥1h real-world absence, freeze the sim until they pick a clock.
     * @returns {boolean} true if the blocking prompt is showing
     */
    function maybeOfferClockResume() {
        const sess = S()?.session;
        if (!sess || sess.phase !== 'active') return false;
        if (sess.clockResumeHold) {
            MirageSimulation?.showClockResumeOverlay?.();
            return true;
        }
        const hist = Array.isArray(sess.history) ? sess.history.length : 0;
        // Brand-new chats have nothing to resume — leftover stamps must not block Launch.
        if (!hist) return false;
        if (!sess.lastAiMessageAt && !sess.lastUserMessageAt) return false;
        const gap = wallAbsenceMs();
        if (!(gap >= CLOCK_RESUME_MS)) return false;
        sess.clockResumeHold = { gapMs: gap, at: Date.now() };
        clearProactive();
        clearNoReplyWatch();
        try { MirageChatStore.saveActiveChat?.(S()); } catch { /* ignore */ }
        MirageSimulation?.showClockResumeOverlay?.();
        return true;
    }

    /**
     * Re-entering a chat: offer the clock picker BEFORE any save that would
     * stamp lastAttendedWallMs (that made the picker think you'd never left).
     * Decay still uses the real gap. Attendance is touched only if we did not hold.
     * @returns {boolean} true if the blocking clock prompt is showing
     */
    function resumeAfterAbsence() {
        const held = maybeOfferClockResume();
        if (held) {
            // Don't decay until they pick a clock — KEEP must not inherit hours of wall silence.
            return true;
        }
        catchUpAfterAbsence();
        touchLastAttended();
        resumeQuietChase();
        return false;
    }

    /**
     * How long after HER last bubble he replied (sim-time, captured at send).
     * Infinity / missing = cold open (first text or no prior AI).
     */
    function lastReplyLagMs(sess = S()?.session) {
        const lag = Number(sess?.lastReplyLagMs);
        if (!Number.isFinite(lag) || lag < 0) return Number.POSITIVE_INFINITY;
        return lag;
    }

    function updateChatHeat(prevHeat, replyLagMs) {
        let heat = clamp(Number(prevHeat) || 0, 0, 5);
        if (!Number.isFinite(replyLagMs) || replyLagMs === Number.POSITIVE_INFINITY) {
            return 0;
        }
        // Snappy reply while she's likely still staring at the thread
        if (replyLagMs < 12 * 1000) heat = Math.min(5, heat + 2);
        else if (replyLagMs < 35 * 1000) heat = Math.min(5, heat + 1.5);
        else if (replyLagMs < 90 * 1000) heat = Math.min(5, heat + 1);
        else if (replyLagMs < 4 * 60 * 1000) heat = Math.max(0, heat - 0.25);
        else if (replyLagMs < 15 * 60 * 1000) heat = Math.max(0, heat - 1.5);
        else heat = 0;
        return Math.round(heat * 2) / 2;
    }

    /**
     * Phone presence from sim-time reply speed + chat heat.
     * /time pass and clock jumps widen the gap the same as real silence.
     * hot  = still in the open chat (he snapped back)
     * warm = phone unlocked / nearby
     * cool = locked screen, will check later
     * cold = was offline / elsewhere
     */
    function assessPresence(sess = S()?.session) {
        const lag = lastReplyLagMs(sess);
        let heat = Number(sess?.chatHeat) || 0;
        const now = simNowMs();
        // Heat cools if she's been waiting on him a while after her last send (sim time)
        const sinceAi = sess?.lastAiMessageAt
            ? Math.max(0, now - Number(sess.lastAiMessageAt))
            : Number.POSITIVE_INFINITY;
        if (sinceAi > 8 * 60 * 1000) heat = Math.max(0, heat - 1);
        if (sinceAi > 25 * 60 * 1000) heat = 0;

        let band = 'cold';
        if (heat >= 3 || lag < 25 * 1000) band = 'hot';
        else if (heat >= 1.5 || lag < 3 * 60 * 1000) band = 'warm';
        else if (lag < 25 * 60 * 1000) band = 'cool';

        const onPhone = band === 'hot' || band === 'warm';
        return { band, onPhone, lagMs: lag, heat, sinceAiMs: sinceAi };
    }

    function touchUserActivity() {
        const sess = S()?.session;
        if (!sess) return;
        const now = simNowMs();
        const prevAi = Number(sess.lastAiMessageAt) || 0;
        const lag = prevAi > 0 ? Math.max(0, now - prevAi) : Number.POSITIVE_INFINITY;
        sess.lastReplyLagMs = lag;
        sess.chatHeat = updateChatHeat(sess.chatHeat, lag);
        sess.lastUserMessageAt = now;

        // Instant chrome: if she's hot on-phone, show Active now (not last-seen)
        if (enabled() && assessPresence(sess).onPhone) {
            MiragePhoneUX?.setPresence?.('active');
        }
    }

    function touchAiActivity(stampMs) {
        const sess = S()?.session;
        if (!sess) return;
        const t = Number(stampMs);
        if (Number.isFinite(t) && t > 0) {
            sess.lastAiMessageAt = Math.max(Number(sess.lastAiMessageAt) || 0, t);
            return;
        }
        const fromLog = typeof MiragePhoneUX?.latestTranscriptStampMs === 'function'
            ? MiragePhoneUX.latestTranscriptStampMs(sess, { includeDom: true })
            : 0;
        sess.lastAiMessageAt = Math.max(
            Number(sess.lastAiMessageAt) || 0,
            fromLog || simNowMs()
        );
    }

    function normalizeStyle(raw) {
        let style = String(raw || '').trim().toLowerCase().replace(/-/g, '_');
        if (!STYLES.has(style)) style = '';
        return style;
    }

    const REACTION_FALLBACKS = ['❤️', '😂', '🔥', '👀', '💀', '🥰', '😭', '👏', '🥺', '💕', '😍', '🫣'];
    const REACTION_WORD_EMOJI = {
        heart: '❤️', hearts: '❤️', love: '❤️', fire: '🔥', lit: '🔥',
        laugh: '😂', lol: '😂', lmao: '😂', eyes: '👀', look: '👀',
        skull: '💀', dead: '💀', cry: '😭', sad: '😭', clap: '👏',
        please: '🥺', smile: '🥰', hot: '😍', shy: '🫣', wow: '😮'
    };
    const HER_STREAK_CAP = 5;
    const OPERATOR_PROACTIVE_REASONS = new Set(['wait', 'world_skip']);
    const DITCH_HOLD_KINDS = new Set(['ditch', 'cold_ditch']);
    const COMEBACK_HOLD_KINDS = new Set(['busy_later', 'type_delete', 'left_on_read']);
    const WITHHOLD_STYLES = new Set(['ghost_type', 'left_on_read', 'went_quiet']);

    function currentGhostProfile(sess) {
        const fallback = {
            tier: 'medium',
            axes: { intimacy: 0, statusGap: 0, attachment: 0, publicness: 0 },
            engagement: 55,
            ghostMul: 1,
            storyMul: 1,
            followUpMul: 1,
            ditchMul: 1,
            doubleTextMul: 1,
            typeDeleteOk: true,
            presenceVeto: true,
            textureFloor: 0.4,
            cooldownTurns: 3,
            storyDamp: 1
        };
        if (typeof MirageLoyaltyUX?.ghostProfile !== 'function') return fallback;
        try {
            return MirageLoyaltyUX.ghostProfile(S()?.profile, S()?.edf, sess || S()?.session) || fallback;
        } catch {
            return fallback;
        }
    }

    function isWithholdStyle(style) {
        return WITHHOLD_STYLES.has(String(style || ''));
    }

    function isDitchHold(sess) {
        const k = (sess || S()?.session)?.socialHold?.kind;
        return DITCH_HOLD_KINDS.has(k);
    }

    function isComeBackHold(sess) {
        const k = (sess || S()?.session)?.socialHold?.kind;
        return COMEBACK_HOLD_KINDS.has(k);
    }

    function markThreadSeen() {
        if (typeof MiragePhoneUX?.markAllUserSeen === 'function') {
            MiragePhoneUX.markAllUserSeen();
            return;
        }
        MiragePhoneUX?.markUserSeen?.();
    }

    function herUnansweredStreak() {
        return Math.max(0, Number(S()?.session?.herStreak) || 0);
    }

    function sheIsAtStreakCap() {
        return herUnansweredStreak() >= HER_STREAK_CAP;
    }

    function countsTowardUnresponsiveCap(reason) {
        const r = String(reason || '').trim();
        if (!r) return false;
        return !OPERATOR_PROACTIVE_REASONS.has(r);
    }

    function isUnresponsiveCap() {
        return S()?.session?.socialHold?.kind === 'unresponsive_cap';
    }

    function resetUnresponsiveStreak() {
        const sess = S()?.session;
        if (!sess) return;
        sess.herStreak = 0;
        if (sess.socialHold?.kind === 'unresponsive_cap') sess.socialHold = null;
        MirageSimulation?.hideUnresponsiveCapOverlay?.();
    }

    function setUnresponsiveCap() {
        const sess = S()?.session;
        if (!sess) return;
        sess.socialHold = {
            kind: 'unresponsive_cap',
            reason: 'streak_cap',
            at: simNowMs()
        };
        clearProactive();
        clearUnreadAftermath();
        cancelDelivery('unresponsive_cap');
        MirageUI?.setStatus?.('ACTIVE', 'active');
        MirageSimulation?.showUnresponsiveCapOverlay?.();
        MirageSimulation?.appendDebugDecision?.({
            kind: 'unresponsive_cap',
            summary: `Paused after ${HER_STREAK_CAP} turns with no operator reply`,
            detail: { herStreak: Number(sess.herStreak) || 0 }
        });
    }

    /** Consecutive her-initiated Stories with no operator reply in between. */
    function consecutiveProactiveStories() {
        const hist = Array.isArray(S()?.session?.history) ? S().session.history : [];
        let n = 0;
        for (let i = hist.length - 1; i >= 0; i--) {
            const u = String(hist[i]?.user || '');
            if (u === '[Story launch]' || /^PROACTIVE STORY:/i.test(u)) {
                n += 1;
                continue;
            }
            if (u.startsWith('[')) continue;
            break;
        }
        return n;
    }

    /**
     * Wait for her / idle / no-reply chase: don't stack 10 Stories at the same clock.
     * Soft drift — keep clothes; maybe move activity. Not a /next scene hard cut.
     */
    function planIdleDrift(reason) {
        const streak = herUnansweredStreak();
        const stories = consecutiveProactiveStories();
        const lastStoryAt = Number(S()?.session?.lastStoryAt) || 0;
        const now = simNowMs();
        const sameMoment = lastStoryAt > 0 && (now - lastStoryAt) < 12 * 60 * 1000;
        const waitLike = reason === 'wait' || reason === 'idle' || reason === 'idle_long'
            || reason === 'no_reply' || reason === 'unread';
        const plan = {
            clockAdvanceMs: 0,
            allowSceneShift: false,
            skipSceneRef: false,
            preferFollowUp: false
        };
        if (!waitLike) return plan;

        const n = Math.max(streak, stories, (reason === 'wait' && sameMoment) ? 1 : 0);
        if (n >= 1 || (reason === 'wait' && stories >= 1) || sameMoment) {
            if (n <= 1) {
                plan.clockAdvanceMs = randBetween(20 * 60 * 1000, 75 * 60 * 1000);
            } else if (n === 2) {
                plan.clockAdvanceMs = randBetween(70 * 60 * 1000, 3 * 60 * 60 * 1000);
                plan.allowSceneShift = true;
                plan.skipSceneRef = true;
            } else {
                plan.clockAdvanceMs = randBetween(2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000);
                plan.allowSceneShift = true;
                plan.skipSceneRef = true;
            }
        }
        if (stories >= 1 && reason !== 'world_skip') {
            plan.preferFollowUp = stories >= 2 || Math.random() < 0.6;
        }
        return plan;
    }

    /** Any single emoji/token for a message reaction — not limited to hearts. */
    function normalizeReactionEmoji(raw) {
        let s = String(raw || '').trim();
        if (!s) {
            return REACTION_FALLBACKS[Math.floor(Math.random() * REACTION_FALLBACKS.length)];
        }
        const word = REACTION_WORD_EMOJI[s.toLowerCase().replace(/[^a-z]/g, '')];
        if (word) return word;
        // Prefer first grapheme cluster when available (keeps ZWJ emoji intact)
        try {
            if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
                const first = [...seg.segment(s)][0]?.segment;
                if (first && first.trim()) s = first.trim();
            }
        } catch { /* keep s */ }
        // Guard against the model dumping a whole sentence into reaction
        if (s.length > 8) s = s.slice(0, 8);
        return s || REACTION_FALLBACKS[0];
    }

    /** Last operator chat text that needs a real reply (not silence). */
    function lastUserNeedsReply(sess, overrideText) {
        let text = overrideText != null ? String(overrideText) : '';
        if (!text) {
            const hist = sess?.history;
            if (Array.isArray(hist) && hist.length) {
                text = String(hist[hist.length - 1]?.user || '');
            }
        }
        if (!text || text.startsWith('[')) {
            text = String(sess?._lastUserInput || '');
        }
        const t = text.trim();
        if (!t || t.startsWith('/')) return false;
        if (/\?|？|؟/.test(t)) return true;
        if (/^(where|when|why|how|what|who|which|is|are|do|does|did|can|could|would|will|should)\b/i.test(t)) {
            return true;
        }
        if (/\b(where are you|where r you|wya|wyd)\b/i.test(t)) return true;
        if (/(איפה|למה|מתי|מה\s|מי\s|איך|הייכן)/.test(t)) return true;
        return false;
    }

    /**
     * Resolve narrative timeSkipSec → ms.
     * Soft band snaps only refine a real skip — never invent a ~24h wrap that
     * lands on an earlier clock face (reads as time going backwards in the UI).
     */
    function resolveNarrativeTimeSkip(delivery) {
        const rawSec = Number(delivery?.timeSkipSec);
        let timeSkipMs = Number.isFinite(rawSec) && rawSec > 0 ? Math.round(rawSec * 1000) : 0;
        const modelReason = String(delivery?.timeSkipReason || '').trim();
        let timeSkipReason = timeSkipMs > 0 ? modelReason : '';

        // No skip requested → do not invent one from arriveLocalHour alone
        if (timeSkipMs <= 0) {
            return { timeSkipMs: 0, timeSkipReason: '' };
        }

        const explicitHour = Number(delivery?.arriveLocalHour);
        const hasExplicit = Number.isFinite(explicitHour) && explicitHour >= 0 && explicitHour <= 23;
        const resolveOrganic = MiragePhoneUX?.resolveOrganicArrival;
        const overnight = typeof MiragePhoneUX?.looksLikeOvernightIntent === 'function'
            && (
                MiragePhoneUX.looksLikeOvernightIntent(modelReason)
                || MiragePhoneUX.looksLikeOvernightIntent(String(delivery?.timeSkipReason || ''))
            );

        // Short ping-pong skips stay short — only de-round minutes
        const SHORT_SKIP_MS = 45 * 60 * 1000;
        if (!overnight && timeSkipMs <= SHORT_SKIP_MS) {
            if (typeof MiragePhoneUX?.organicizeAdvanceMs === 'function') {
                timeSkipMs = MiragePhoneUX.organicizeAdvanceMs(timeSkipMs, { allowDayJump: false });
            }
            return { timeSkipMs, timeSkipReason };
        }

        let organic = null;
        if (typeof resolveOrganic === 'function') {
            const maxMs = overnight
                ? null
                : Math.max(timeSkipMs * 2, 4 * 60 * 60 * 1000);
            if (hasExplicit) {
                organic = resolveOrganic(Math.floor(explicitHour), {
                    minForwardMs: Math.min(30 * 60 * 1000, Math.max(60 * 1000, timeSkipMs * 0.25)),
                    allowDayWrap: overnight,
                    maxMs
                });
            } else if (modelReason) {
                organic = resolveOrganic(modelReason, {
                    minForwardMs: Math.min(30 * 60 * 1000, Math.max(60 * 1000, timeSkipMs * 0.25)),
                    allowDayWrap: overnight,
                    maxMs
                });
            }
        }

        // Safety: long raw skip lands in dead of night → morning only with overnight intent
        if (!organic && overnight && timeSkipMs > 0 && typeof MiragePhoneUX?.localHourAtOffset === 'function') {
            const landHour = MiragePhoneUX.localHourAtOffset(timeSkipMs);
            if ((landHour >= 1 && landHour < 7) || landHour === 0) {
                organic = typeof resolveOrganic === 'function'
                    ? resolveOrganic('morning', {
                        minForwardMs: 45 * 60 * 1000,
                        allowDayWrap: true
                    })
                    : null;
                if (!timeSkipReason) timeSkipReason = 'next morning';
            }
        }

        if (organic && organic.ms > 0) {
            const rewind = typeof MiragePhoneUX?.isApparentClockRewind === 'function'
                && MiragePhoneUX.isApparentClockRewind(organic.ms);
            if (rewind && !overnight) {
                // Keep the model's duration; don't wrap to "earlier" tomorrow
                if (typeof MiragePhoneUX?.organicizeAdvanceMs === 'function') {
                    timeSkipMs = MiragePhoneUX.organicizeAdvanceMs(timeSkipMs, { allowDayJump: false });
                }
            } else {
                timeSkipMs = organic.ms;
                if (!timeSkipReason) {
                    const hh = organic.hour;
                    const mm = String(organic.minute).padStart(2, '0');
                    timeSkipReason = `until ~${hh}:${mm} local`;
                }
            }
        } else if (typeof MiragePhoneUX?.organicizeAdvanceMs === 'function') {
            timeSkipMs = MiragePhoneUX.organicizeAdvanceMs(timeSkipMs, {
                allowDayJump: overnight
            });
        }

        // Final guard: never accept an apparent rewind without overnight intent
        if (
            !overnight
            && typeof MiragePhoneUX?.isApparentClockRewind === 'function'
            && MiragePhoneUX.isApparentClockRewind(timeSkipMs)
        ) {
            timeSkipMs = Math.min(timeSkipMs, 3 * 60 * 60 * 1000);
            if (typeof MiragePhoneUX?.organicizeAdvanceMs === 'function') {
                timeSkipMs = MiragePhoneUX.organicizeAdvanceMs(
                    Math.max(60 * 1000, Number(rawSec) * 1000 || timeSkipMs),
                    { allowDayJump: false }
                );
            }
        }

        return { timeSkipMs, timeSkipReason };
    }

    /**
     * Blend model suggestion with a client lottery so texture actually happens.
     * Difficulty first, then inferred axes, then mood / engagement / presence.
     */
    function resolveStyle(modelStyle, {
        engagement, presence, needsReply = false, mood, moodIntensity, mustDeliver = false, sess = null
    } = {}) {
        const suggested = normalizeStyle(modelStyle);
        const weights = STYLE_WEIGHTS.map(x => ({ ...x }));
        const band = presence?.band || 'cool';
        const onPhone = !!presence?.onPhone;
        const gp = currentGhostProfile(sess || S()?.session);
        const eng = Number.isFinite(Number(engagement))
            ? Number(engagement)
            : gp.engagement;
        const coldEng = eng <= 25;
        const coolEng = eng <= 45;
        const moodKey = typeof MiragePrompt?.normalizeMood === 'function'
            ? (MiragePrompt.normalizeMood(mood) || 'Neutral')
            : String(mood || 'Neutral');
        const mInt = Number.isFinite(Number(moodIntensity)) ? Math.max(0, Math.min(3, Math.round(Number(moodIntensity)))) : 1;
        const cooldown = Math.max(0, Number((sess || S()?.session)?.ghostCooldownTurns) || 0);

        weights.forEach(w => {
            if (w.style === 'ghost_type' || w.style === 'left_on_read' || w.style === 'went_quiet') {
                w.w *= gp.ghostMul;
            }
            if (w.style === 'double_text') w.w *= gp.doubleTextMul;
        });

        if (coldEng || coolEng) {
            weights.forEach(w => {
                if (w.style === 'left_on_read' || w.style === 'went_quiet') w.w *= coldEng ? 2.2 : 1.45;
                if (w.style === 'ghost_type') w.w *= coldEng ? 1.15 : 1.25;
                if (w.style === 'normal') w.w *= coldEng ? 0.45 : 0.7;
            });
        }

        if (mInt >= 2) {
            const soft = /^(Hurt|Sad|Lonely|Missing him|Melancholy|Vulnerable|Distant|Cold|Anxious)$/i.test(moodKey);
            const sharp = /^(Annoyed|Frustrated|Angry|Jealous)$/i.test(moodKey);
            const bright = /^(Giddy|Excited|Playful|Flirty|Hopeful|Warm|Soft)$/i.test(moodKey);
            if (soft || sharp) {
                weights.forEach(w => {
                    if (w.style === 'left_on_read' || w.style === 'went_quiet' || w.style === 'slow') {
                        w.w *= mInt >= 3 ? 1.8 : 1.35;
                    }
                    if (w.style === 'ghost_type') w.w *= gp.typeDeleteOk ? 1.15 : 0.4;
                    if (w.style === 'double_text') w.w *= 0.55;
                    if (w.style === 'normal' && soft) w.w *= 0.85;
                });
            }
            if (bright && !coldEng) {
                weights.forEach(w => {
                    if (w.style === 'double_text' || w.style === 'reaction') w.w *= mInt >= 3 ? 1.7 : 1.35;
                    if (w.style === 'went_quiet') w.w *= 0.35;
                    if (w.style === 'left_on_read') w.w *= gp.typeDeleteOk ? 0.45 : 0.85;
                    if (w.style === 'ghost_type') w.w *= gp.typeDeleteOk ? 1.25 : 0.2;
                });
            }
        }

        if (band === 'hot') {
            weights.forEach(w => {
                if (w.style === 'normal') w.w *= gp.presenceVeto ? 2.2 : 1.15;
                if (w.style === 'reaction') w.w *= gp.presenceVeto ? 1.8 : 1.15;
                if (w.style === 'double_text') w.w *= 0.7;
                if (w.style === 'slow') w.w *= gp.presenceVeto ? 0.15 : 0.7;
                if (isWithholdStyle(w.style)) w.w *= gp.presenceVeto ? 0.08 : 0.85;
            });
        } else if (band === 'warm') {
            weights.forEach(w => {
                if (w.style === 'normal') w.w *= gp.presenceVeto ? 1.5 : 1.1;
                if (w.style === 'reaction') w.w *= 1.3;
                if (w.style === 'slow') w.w *= gp.presenceVeto ? 0.4 : 0.75;
                if (isWithholdStyle(w.style)) w.w *= gp.presenceVeto ? 0.35 : 0.9;
            });
        } else if (band === 'cold') {
            weights.forEach(w => {
                if (w.style === 'double_text' || w.style === 'slow') w.w *= 1.7;
                if (w.style === 'left_on_read' || w.style === 'went_quiet') w.w *= 1.5;
                if (w.style === 'ghost_type') w.w *= 0.55;
                if (w.style === 'reaction') w.w *= 0.45;
                if (w.style === 'normal') w.w *= 0.7;
            });
        }

        if (!onPhone || band === 'cool' || band === 'cold') {
            weights.forEach(w => {
                if (w.style === 'ghost_type' || w.style === 'left_on_read') w.w = 0;
            });
        }
        if (!gp.typeDeleteOk) {
            weights.forEach(w => {
                if (w.style === 'ghost_type') w.w = 0;
            });
        }
        if (gp.tier === 'low' && !coldEng && mInt < 2) {
            weights.forEach(w => {
                if (w.style === 'went_quiet') w.w *= 0.15;
            });
        }

        if (needsReply) {
            weights.forEach(w => {
                if (w.style === 'double_text') w.w *= 0.25;
                if (isWithholdStyle(w.style)) w.w *= 0.42;
            });
        }

        if (cooldown > 0) {
            weights.forEach(w => {
                if (isWithholdStyle(w.style)) w.w = 0;
            });
        }

        if (mustDeliver) {
            weights.forEach(w => {
                if (isWithholdStyle(w.style)) w.w = 0;
            });
        }

        const usable = weights.filter(w => w.w > 0);
        const rolled = pickWeighted(usable.length ? usable : STYLE_WEIGHTS.map(x => ({ ...x })));

        if (gp.presenceVeto && band === 'hot' && (isWithholdStyle(suggested) || suggested === 'slow')) {
            if (!coldEng) {
                if (needsReply) return 'normal';
                return Math.random() < 0.85 ? (Math.random() < 0.25 ? 'reaction' : 'normal') : suggested;
            }
        }

        let picked;
        if (suggested && suggested !== 'normal') {
            picked = Math.random() < 0.72 ? suggested : rolled;
        } else {
            const textureChance = Number(gp.textureFloor);
            const floor = Number.isFinite(textureChance)
                ? textureChance
                : (band === 'hot' ? 0.18 : band === 'warm' ? 0.32 : 0.42);
            picked = Math.random() < floor ? rolled : (suggested || rolled);
        }
        if (mustDeliver && isWithholdStyle(picked)) picked = 'normal';
        if (cooldown > 0 && isWithholdStyle(picked)) picked = 'normal';
        if (!gp.typeDeleteOk && picked === 'ghost_type') {
            picked = onPhone && (band === 'hot' || band === 'warm') ? 'left_on_read' : 'went_quiet';
        }
        if ((!onPhone || band === 'cool' || band === 'cold')
            && (picked === 'ghost_type' || picked === 'left_on_read')) {
            picked = 'went_quiet';
        }
        // Presence conversions can reintroduce withhold after the first mustDeliver clamp.
        if (mustDeliver && isWithholdStyle(picked)) picked = 'normal';

        const liveSess = sess || S()?.session;
        if (liveSess && cooldown > 0 && !mustDeliver) {
            liveSess.ghostCooldownTurns = Math.max(0, cooldown - 1);
        }
        if (liveSess && isWithholdStyle(picked) && !mustDeliver) {
            liveSess.ghostCooldownTurns = Math.max(1, Number(gp.cooldownTurns) || 2);
        }

        emitDecision({
            kind: 'style',
            summary: `Delivery style → ${picked}`,
            detail: {
                suggested: suggested || null,
                rolled,
                picked,
                engagement: eng,
                presenceBand: band,
                needsReply: !!needsReply,
                difficulty: gp.tier,
                typeDeleteOk: gp.typeDeleteOk,
                presenceVeto: gp.presenceVeto,
                cooldown
            }
        });
        return picked;
    }

    function defaultSecondMessage() {
        return '';
    }

    /**
     * Build a delivery plan from model JSON + session.
     * @param {{ forceInstant?: boolean, storyLaunch?: boolean }} [opts]
     */
    function planDelivery(parsed, sess, opts = {}) {
        const delivery = parsed?.delivery && typeof parsed.delivery === 'object'
            ? parsed.delivery
            : {};
        // Freeze pacing for this plan so a mid-turn Settings change can't flip the path mid-build
        const turnPacing = opts.pacingMode
            || (typeof pacingMode === 'function' ? pacingMode() : 'instant');
        const turnInstantLike = turnPacing !== 'realtime' || !!opts.forceInstant;
        const turnWaitsOnJumps = turnPacing === 'hybrid' || turnPacing === 'realtime';
        const engagement = Number.isFinite(Number(sess?.engagement))
            ? Number(sess.engagement)
            : (MirageLoyaltyUX?.migrateComplianceToEngagement?.(
                sess?.compliance || parsed?.tracking?.compliance
            ) ?? 55);
        let presence = assessPresence(sess);
        // After a big clock jump / proactive reach-out she's initiating — don't treat
        // "year of sim silence" as cold offline (that schedules multi-minute Delivered waits).
        const landingAfterJump = !!opts.proactive
            || !!opts.landingAfterJump
            || Number(sess?.lastTimeSkipMs) >= 20 * 60 * 1000
            || !!sess?.pendingWorldBeat;
        if (landingAfterJump && (presence.band === 'cold' || presence.band === 'cool')) {
            presence = { ...presence, band: 'warm', onPhone: true };
            emitDecision({
                kind: 'presence',
                summary: 'Presence softened to warm (post-jump / proactive landing)',
                detail: { from: assessPresence(sess).band, to: 'warm' }
            });
        }
        const needsReply = !!opts.mustDeliver || lastUserNeedsReply(sess, opts.lastUserText);
        // Instagram Story posts are a single caption + image — never DM social texture
        let style = opts.storyLaunch
            ? 'normal'
            : resolveStyle(delivery.style, {
                engagement,
                presence,
                needsReply,
                mood: sess?.mood,
                moodIntensity: sess?.moodIntensity,
                mustDeliver: !!opts.mustDeliver,
                sess
            });
        if (opts.mustDeliver && isWithholdStyle(style)) {
            emitDecision({
                kind: 'style',
                summary: 'Delivery style → normal (director command cannot ghost)',
                detail: { suggested: style, reason: 'mustDeliver' }
            });
            style = 'normal';
        }
        let characterText = parsed?.characterResponse || parsed?.response || '…';
        let secondMessage = opts.storyLaunch ? '' : String(delivery.secondMessage || '').trim();
        const reaction = normalizeReactionEmoji(delivery.reaction);

        const allowTimeSkip = opts.allowTimeSkip !== false
            && !opts.storyLaunch
            && !opts.freshStoryReply;
        let timeSkipMs = 0;
        let timeSkipReason = '';
        if (allowTimeSkip) {
            const resolved = resolveNarrativeTimeSkip(delivery);
            timeSkipMs = resolved.timeSkipMs;
            timeSkipReason = resolved.timeSkipReason;
        }
        const narrativeWaitMs = (turnWaitsOnJumps
            && !opts.forceInstant
            && !opts.mustDeliver
            && !opts.storyLaunch
            && timeSkipMs > 0)
            ? toRealWaitMs(timeSkipMs)
            : 0;

        // Never invent "lol sorry" / "hey" fillers — only keep double_text when both bubbles are real.
        if (!opts.storyLaunch && style === 'double_text') {
            const first = String(characterText || '').trim();
            const second = String(secondMessage || '').trim();
            if (!second || second === '…') {
                emitDecision({
                    kind: 'style',
                    summary: 'Delivery style → normal (double_text demoted — missing secondMessage)',
                    detail: { suggested: 'double_text', reason: 'missing secondMessage' }
                });
                style = 'normal';
                secondMessage = '';
            } else if (!first || first === '…') {
                characterText = second;
                secondMessage = '';
                style = 'normal';
                emitDecision({
                    kind: 'style',
                    summary: 'Delivery style → normal (double_text demoted — empty first bubble)',
                    detail: { suggested: 'double_text', reason: 'empty characterResponse' }
                });
            }
        }

        // Reaction = emoji on his message + at least one text reply (never emoji-only).
        if (!opts.storyLaunch && style === 'reaction') {
            let first = String(characterText || '').trim();
            const second = String(secondMessage || '').trim();
            if ((!first || first === '…') && second && second !== '…') {
                characterText = second;
                secondMessage = '';
                first = characterText;
            }
            if (!first || first === '…') {
                emitDecision({
                    kind: 'style',
                    summary: 'Delivery style → normal (reaction demoted — missing text reply)',
                    detail: { suggested: 'reaction', reason: 'empty characterResponse' }
                });
                style = 'normal';
            } else {
                secondMessage = '';
            }
        }

        // Instant / Hybrid / story-launch path — still allow ignore withhold (no bubble + silence notice)
        // Hybrid uses this for normal DM texture; narrativeWaitMs may still be > 0 for time jumps.
        if (turnInstantLike || opts.forceInstant || opts.storyLaunch) {
            const ignoring = isWithholdStyle(style);
            if (!opts.storyLaunch && !opts.mustDeliver && ignoring) {
                const openedThread = style !== 'went_quiet'
                    || presence.band === 'hot'
                    || presence.band === 'warm'
                    || !!presence.onPhone;
                const silenceKind = style === 'ghost_type'
                    ? 'ghost'
                    : (style === 'went_quiet' ? 'went_quiet' : 'ignore');
                const silenceMs = pickSilenceGapMs(silenceKind);
                const flickerMs = style === 'ghost_type' ? randBetween(1000, 2000) : 0;
                emitDecision({
                    kind: 'withhold',
                    summary: `Withhold reply (${style}) — ${formatDuration(silenceMs)} sim silence`,
                    detail: { style, silenceSimMs: silenceMs, pacing: turnPacing, openedThread }
                });
                return {
                    style,
                    preReadMs: 0,
                    gapMs: 0,
                    typingMs: flickerMs || 80,
                    ghostMs: flickerMs,
                    leftOnReadHoldMs: 0,
                    characterText: '',
                    secondMessage: '',
                    reaction,
                    instant: true,
                    withhold: true,
                    openedThread,
                    storyLaunch: false,
                    silenceSimMs: silenceMs,
                    followUp: style === 'went_quiet' ? 'ditch' : 'social',
                    presence,
                    timeSkipMs: 0,
                    timeSkipReason: '',
                    narrativeWaitMs: 0,
                    pacingMode: turnPacing
                };
            }
            const typingMs = (opts.storyLaunch || opts.mustDeliver)
                ? 0
                : (opts.forceInstant ? 80 : randBetween(500, 2000));
            return {
                style: opts.storyLaunch ? 'normal'
                    : (style === 'reaction' ? 'reaction'
                        : (style === 'double_text' && secondMessage ? 'double_text' : 'normal')),
                preReadMs: 0,
                gapMs: 0,
                typingMs,
                ghostMs: 0,
                leftOnReadHoldMs: 0,
                characterText,
                secondMessage: opts.storyLaunch ? '' : secondMessage,
                reaction,
                instant: true,
                withhold: false,
                openedThread: !opts.storyLaunch,
                storyLaunch: !!opts.storyLaunch,
                mustDeliver: !!opts.mustDeliver,
                followUp: null,
                presence,
                timeSkipMs,
                timeSkipReason,
                narrativeWaitMs: 0,
                pacingMode: turnPacing
            };
        }

        const suggested = Number(delivery.delaySec);
        const hasHint = Number.isFinite(suggested) && suggested > 0;
        let preReadMs;
        let gapMs;

        // Phone still open → she sees the notification / thread instantly
        if (presence.band === 'hot') {
            preReadMs = hasHint
                ? clamp(suggested * 1000, 400, 8 * 1000)
                : randBetween(350, 2800);
            gapMs = randBetween(200, 900);
        } else if (presence.band === 'warm') {
            preReadMs = hasHint
                ? clamp(suggested * 1000, 1500, 45 * 1000)
                : randBetween(2 * 1000, 22 * 1000);
            gapMs = randBetween(400, 2000);
        } else if (style === 'slow') {
            preReadMs = hasHint
                ? clamp(suggested * 1000, 60 * 1000, 15 * 60 * 1000)
                : randBetween(90 * 1000, 8 * 60 * 1000);
            gapMs = randBetween(800, 3500);
        } else if (style === 'left_on_read' || style === 'ghost_type') {
            preReadMs = hasHint
                ? clamp(suggested * 1000, 8 * 1000, 12 * 60 * 1000)
                : randBetween(12 * 1000, 90 * 1000);
            gapMs = style === 'ghost_type'
                ? randBetween(2 * 1000, 20 * 1000)
                : randBetween(600, 3500);
        } else if (style === 'went_quiet') {
            preReadMs = presence.onPhone
                ? randBetween(8 * 1000, 45 * 1000)
                : (hasHint
                    ? clamp(suggested * 1000, 12 * 1000, 10 * 60 * 1000)
                    : randBetween(20 * 1000, 6 * 60 * 1000));
            gapMs = randBetween(400, 1800);
        } else if (style === 'reaction') {
            preReadMs = presence.band === 'cool'
                ? randBetween(5 * 1000, 45 * 1000)
                : randBetween(8 * 1000, 90 * 1000);
            gapMs = randBetween(400, 1500);
        } else if (presence.band === 'cool') {
            preReadMs = hasHint
                ? clamp(suggested * 1000, 12 * 1000, 10 * 60 * 1000)
                : randBetween(25 * 1000, 4 * 60 * 1000);
            gapMs = randBetween(600, 3500);
        } else {
            // cold
            preReadMs = hasHint
                ? clamp(suggested * 1000, 45 * 1000, 15 * 60 * 1000)
                : randBetween(2 * 60 * 1000, 12 * 60 * 1000);
            gapMs = randBetween(800, 4000);
        }

        // Style overrides for ghost gap when not already set above for ghost
        if (style === 'ghost_type' && presence.band !== 'hot') {
            gapMs = randBetween(2 * 1000, 20 * 1000);
        }

        let leftOnReadHoldMs = style === 'left_on_read'
            ? randBetween(3 * 60 * 1000, 18 * 60 * 1000)
            : style === 'ghost_type'
                ? randBetween(2 * 60 * 1000, 12 * 60 * 1000)
                : 0;

        // Hot: slightly snappier typing (she's already composing in her head)
        let typingMs = typingMsFor(characterText || secondMessage || 'hey');
        if (presence.band === 'hot') {
            typingMs = Math.max(900, Math.round(typingMs * 0.72));
        }

        // Hybrid compress + hard 10-minute cap on every wall wait
        preReadMs = toRealWaitMs(preReadMs);
        gapMs = toRealWaitMs(gapMs);
        leftOnReadHoldMs = leftOnReadHoldMs > 0 ? toRealWaitMs(leftOnReadHoldMs) : 0;
        typingMs = capRealWaitMs(typingMs);

        return {
            style,
            preReadMs,
            gapMs,
            typingMs,
            ghostMs: style === 'ghost_type' ? capRealWaitMs(randBetween(1800, 6500)) : 0,
            leftOnReadHoldMs,
            characterText,
            secondMessage,
            reaction,
            instant: false,
            withhold: isWithholdStyle(style),
            openedThread: style !== 'went_quiet'
                || presence.band === 'hot'
                || presence.band === 'warm'
                || !!presence.onPhone,
            storyLaunch: false,
            mustDeliver: !!opts.mustDeliver,
            followUp: isWithholdStyle(style)
                ? (style === 'went_quiet' ? 'ditch' : 'social')
                : null,
            presence,
            timeSkipMs,
            timeSkipReason,
            narrativeWaitMs,
            pacingMode: turnPacing
        };
    }

    function setWaitLabel(label) {
        MirageUI?.setSimGenerating?.(true, { phase: 'waiting', label: label || 'Waiting for her…' });
        MirageUI?.setStatus?.('WAITING', 'busy');
        MirageSimulation?.updateTurnActionControls?.();
    }

    function clearWaitLabel() {
        MirageUI?.setSimGenerating?.(false);
        MirageSimulation?.updateTurnActionControls?.();
    }

    function formatWaitHint(ms, presence) {
        if (presence?.band === 'hot') return 'Active now — she\'s in the chat…';
        if (presence?.band === 'warm') return 'Delivered — phone nearby…';
        if (ms < 20000) return 'Delivered…';
        if (ms < 90000) return 'Delivered — waiting for her to open…';
        if (ms < 4 * 60000) return 'Still on Delivered…';
        return 'Real-time — she may take a while…';
    }

    /**
     * Run receipt + typing choreography.
     * - release:true → deliver now (possibly withReaction: emoji + text)
     * - leftOnRead / ghosted → hold; no DM bubble yet
     */
    async function choreograph(plan, { signal } = {}) {
        const gen = ++deliveryGen;

        // Narrative time gap — wall wait in Hybrid + Realtime (clear waiting UI)
        // Instant / director landings never fake a "time passing" wall wait.
        if (plan.narrativeWaitMs > 0 && !plan.instant && !plan.mustDeliver && !plan.storyLaunch) {
            const skipMs = Number(plan.timeSkipMs) || 0;
            const span = formatTimeJumpSpan(skipMs, plan.timeSkipReason);
            const reason = plan.timeSkipReason || 'Some time passes…';
            const waitLabel = skipMs >= 24 * 60 * 60 * 1000
                ? `Time passing — ${span}…`
                : (reason.length < 48 ? `Time passing — ${reason}` : reason);
            setWaitLabel(waitLabel);
            emitDecision({
                kind: 'time_wait',
                summary: `Wall wait ${formatDuration(plan.narrativeWaitMs)} for time jump`,
                detail: {
                    narrativeWaitMs: plan.narrativeWaitMs,
                    timeSkipMs: plan.timeSkipMs || 0,
                    reason: plan.timeSkipReason || null,
                    pacing: pacingMode()
                }
            });
            await sleep(plan.narrativeWaitMs, {
                signal,
                gen,
                wallWait: true,
                waitLabel
            });
        }

        if (plan.instant) {
            if (plan.withhold || isWithholdStyle(plan.style)) {
                const opened = plan.openedThread !== false && plan.style !== 'went_quiet'
                    ? true
                    : !!plan.openedThread;
                if (opened) markThreadSeen();
                if (plan.style === 'ghost_type') {
                    MiragePhoneUX?.showTyping?.(true);
                    await sleep(plan.ghostMs || plan.typingMs || randBetween(1000, 2000), { signal, gen });
                    MiragePhoneUX?.showTyping?.(false);
                    MirageUI?.toast?.('She was typing… then deleted it.', 'info');
                } else if (plan.style === 'left_on_read') {
                    MirageUI?.toast?.('Left on read…', 'info');
                }
                return {
                    release: false,
                    leftOnRead: plan.style === 'left_on_read',
                    ghosted: plan.style === 'ghost_type',
                    wentQuiet: plan.style === 'went_quiet',
                    withhold: true,
                    openedThread: opened,
                    silenceSimMs: plan.silenceSimMs || 0,
                    gen
                };
            }
            if (plan.style === 'reaction') {
                if (!plan.storyLaunch) markThreadSeen();
                return { release: true, withReaction: true, gen };
            }
            if (!plan.storyLaunch) markThreadSeen();
            if ((plan.typingMs || 0) > 0) {
                MiragePhoneUX?.showTyping?.(true);
                await sleep(plan.typingMs, { signal, gen });
            }
            return { release: true, gen };
        }

        const presence = plan.presence || assessPresence();

        // Hot thread: she's already looking — don't fake "away"
        if (presence.band === 'hot') {
            MiragePhoneUX?.setPresence?.('active');
        } else {
            MiragePhoneUX?.showTyping?.(false);
            MiragePhoneUX?.setPresence?.('idle');
        }
        setWaitLabel(formatWaitHint(plan.preReadMs, presence));

        // Long Delivered waits are skippable (same Skip wait control as time jumps)
        await sleep(plan.preReadMs, {
            signal,
            gen,
            wallWait: plan.preReadMs >= 8000,
            waitLabel: formatWaitHint(plan.preReadMs, presence)
        });

        const openedThread = plan.style === 'went_quiet'
            ? !!plan.openedThread
            : true;
        if (openedThread) {
            markThreadSeen();
            MiragePhoneUX?.setPresence?.('reading');
            setWaitLabel('Seen');
        }

        if (plan.style === 'went_quiet') {
            if (openedThread) {
                await sleep(plan.gapMs || 400, { signal, gen });
            }
            MiragePhoneUX?.setPresence?.('idle');
            clearWaitLabel();
            MirageUI?.setStatus?.('ACTIVE', 'active');
            return {
                release: false,
                wentQuiet: true,
                withhold: true,
                openedThread,
                gen
            };
        }

        if (plan.style === 'left_on_read') {
            await sleep(plan.gapMs, { signal, gen });
            MiragePhoneUX?.setPresence?.('idle');
            clearWaitLabel();
            MirageUI?.setStatus?.('ACTIVE', 'active');
            MirageUI?.toast?.('Left on read…', 'info');
            return { release: false, leftOnRead: true, openedThread: true, gen };
        }

        await sleep(plan.gapMs, {
            signal,
            gen,
            wallWait: plan.gapMs >= 8000,
            waitLabel: 'Seen — still reading…'
        });

        // Typing… then delete (no send)
        if (plan.style === 'ghost_type' && plan.ghostMs > 0) {
            MiragePhoneUX?.showTyping?.(true);
            setWaitLabel('Typing…');
            await sleep(plan.ghostMs, { signal, gen });
            MiragePhoneUX?.showTyping?.(false);
            MiragePhoneUX?.setPresence?.('idle');
            setWaitLabel('Draft deleted');
            MirageUI?.toast?.('She was typing… then deleted it.', 'info');
            await sleep(capRealWaitMs(randBetween(1200, 4000)), { signal, gen });
            clearWaitLabel();
            MirageUI?.setStatus?.('ACTIVE', 'active');
            return { release: false, ghosted: true, openedThread: true, gen };
        }

        if (plan.style === 'reaction') {
            // React first, then type the required text reply (never emoji-only).
            MiragePhoneUX?.showTyping?.(false);
            clearWaitLabel();
            if (typeof MiragePhoneUX?.markUserReaction === 'function') {
                MiragePhoneUX.markUserReaction(plan.reaction);
            }
            setWaitLabel('Reacted');
            await sleep(randBetween(280, 900), { signal, gen });
            MiragePhoneUX?.showTyping?.(true);
            MiragePhoneUX?.setPresence?.('typing');
            setWaitLabel('Typing…');
            await sleep(plan.typingMs || typingMsFor(plan.characterText || 'hey'), { signal, gen });
            return { release: true, withReaction: true, gen };
        }

        MiragePhoneUX?.showTyping?.(true);
        MiragePhoneUX?.setPresence?.('typing');
        setWaitLabel('Typing…');
        await sleep(plan.typingMs, { signal, gen });

        return { release: true, gen };
    }

    function cancelDelivery(reason) {
        deliveryGen += 1;
        [...sleepWaiters].forEach((w) => {
            try { w.cancel(); } catch { /* ignore */ }
        });
        clearSkippableWallWait({ silent: true });
        pendingDelivery = null;
        MiragePhoneUX?.showTyping?.(false);
        clearWaitLabel();
        if (waitStatusTimer) {
            clearTimeout(waitStatusTimer);
            waitStatusTimer = null;
        }
        MirageSimulation?.updateTurnActionControls?.();
        return reason;
    }

    function getPendingDelivery() {
        return pendingDelivery;
    }

    function setPendingDelivery(payload) {
        pendingDelivery = payload;
    }

    function clearPendingDelivery() {
        pendingDelivery = null;
    }

    function weightedPick(weights) {
        const entries = Object.entries(weights).filter(([, w]) => w > 0);
        const total = entries.reduce((s, [, w]) => s + w, 0);
        if (!total) return 'follow_up';
        let r = Math.random() * total;
        for (const [key, w] of entries) {
            r -= w;
            if (r <= 0) return key;
        }
        return entries[entries.length - 1][0];
    }

    function proactiveStoriesEnabled() {
        return S()?.proactiveStories !== false;
    }

    /**
     * Context-aware aftermath: ditch | follow_up | story
     * Warm personal → follow-up DM. Mad / bored / ghosted → story or ditch.
     * Story weight is zeroed when Settings → Proactively generate stories is off.
     */
    function pickSocialOutcome(kind) {
        const sess = S()?.session;
        const eng = Number.isFinite(Number(sess?.engagement))
            ? Number(sess.engagement)
            : (MirageLoyaltyUX?.migrateComplianceToEngagement?.(sess?.compliance) ?? 55);
        const cold = eng <= 25;
        const cool = eng <= 45;
        const heat = Number(sess?.chatHeat) || 0;
        const presence = assessPresence(sess);
        const w = { ditch: 1, follow_up: 1, story: 1 };
        const allowStory = proactiveStoriesEnabled();

        if (kind === 'unread' || kind === 'no_reply') {
            if (cold) {
                w.ditch = 4.2; w.story = 3.4; w.follow_up = 0.6;
            } else if (heat >= 3 || presence.band === 'hot') {
                w.follow_up = 5.2; w.story = 1.4; w.ditch = 0.7;
            } else if (heat >= 1.5 || presence.band === 'warm' || !cool) {
                w.follow_up = 3.4; w.story = 2.2; w.ditch = 1.2;
            } else {
                w.story = 3.2; w.ditch = 2.6; w.follow_up = 1.4;
            }
        } else if (kind === 'left_on_read' || kind === 'ignore') {
            if (cold) {
                w.ditch = 3.8; w.story = 3.6; w.follow_up = 0.8;
            } else if (heat >= 3) {
                w.follow_up = 3.5; w.story = 2.0; w.ditch = 1.5;
            } else {
                w.story = 3.0; w.ditch = 2.4; w.follow_up = 1.8;
            }
        } else if (kind === 'ghost') {
            w.follow_up = 4.0; w.story = 1.8; w.ditch = 1.2;
            if (cold) {
                w.ditch = 3.0; w.story = 2.8; w.follow_up = 1.5;
            }
        } else if (kind === 'world_skip') {
            // /next scene and /jump always land a Story or DM — never silence.
            w.story = heat >= 2.5 ? 2.8 : 4.0;
            w.follow_up = heat >= 2.5 ? 4.2 : 2.4;
            w.ditch = 0;
        } else if (kind === 'time_pass') {
            // Same lottery as the 3-min ghost / no-reply chase
            if (cold) {
                w.ditch = 4.2; w.story = 3.4; w.follow_up = 0.6;
            } else if (heat >= 3 || presence.band === 'hot') {
                w.follow_up = 5.2; w.story = 1.4; w.ditch = 0.7;
            } else if (heat >= 1.5 || presence.band === 'warm' || !cool) {
                w.follow_up = 3.4; w.story = 2.2; w.ditch = 1.2;
            } else {
                w.story = 3.2; w.ditch = 2.6; w.follow_up = 1.4;
            }
        } else if (kind === 'wait') {
            // Wait for her: mix DM / Story / later a time-drift Story — not Story-only spam
            w.follow_up = heat >= 2.5 ? 4.6 : 3.2;
            w.story = heat >= 2.5 ? 2.2 : 2.8;
            w.ditch = cold ? 2.2 : 0.5;
        } else {
            if (cold) {
                w.ditch = 3.5; w.story = 3.2; w.follow_up = 1.0;
            } else if (heat >= 3) {
                w.follow_up = 4.8; w.story = 1.6; w.ditch = 0.6;
            } else if (heat >= 1.5) {
                w.follow_up = 3.2; w.story = 2.4; w.ditch = 1.0;
            } else {
                w.story = 3.4; w.follow_up = 2.2; w.ditch = 1.6;
            }
        }

        if (!allowStory) w.story = 0;
        const gp = currentGhostProfile(sess);
        w.ditch *= gp.ditchMul;
        w.follow_up *= gp.followUpMul;
        w.story *= gp.storyMul;
        if (kind === 'world_skip') w.ditch = 0;
        const stories = consecutiveProactiveStories();
        if (allowStory && stories >= 1 && kind !== 'world_skip' && kind !== 'time_pass') {
            const damp = stories >= 2 ? 0.12 : 0.28;
            w.story *= 1 - ((1 - damp) * (Number(gp.storyDamp) || 1));
            w.follow_up *= 1.55;
        }
        const picked = weightedPick(w);
        emitDecision({
            kind: 'social',
            summary: `Social beat → ${picked} (${kind})`,
            detail: {
                kind,
                picked,
                weights: { ...w },
                engagement: eng,
                heat,
                allowStory,
                difficulty: gp.tier
            }
        });
        return picked;
    }

    /** Simulation-time silence before "X passed without a response". */
    function pickSilenceGapMs(kind) {
        if (kind === 'ghost') return randBetween(20 * 1000, 3 * 60 * 1000);
        if (kind === 'went_quiet') return randBetween(4 * 60 * 1000, 35 * 60 * 1000);
        if (kind === 'ignore' || kind === 'left_on_read') {
            return randBetween(25 * 60 * 1000, 3.5 * 60 * 60 * 1000);
        }
        return randBetween(15 * 60 * 1000, 2 * 60 * 60 * 1000);
    }

    function clearSocialHold() {
        const sess = S()?.session;
        if (sess) sess.socialHold = null;
    }

    function setDitchHold(reason) {
        const sess = S()?.session;
        if (!sess) return;
        sess.socialHold = {
            kind: 'ditch',
            flavor: 'cold_ditch',
            reason: reason || 'ditch',
            at: simNowMs()
        };
        clearProactive();
        clearUnreadAftermath();
        cancelDelivery('ditch');
        MirageUI?.setStatus?.('ACTIVE', 'active');
        MirageUI?.toast?.('She went quiet…', 'info');
        if (typeof MirageRoutine?.stampFromClock === 'function') {
            try { MirageRoutine.stampFromClock(sess); } catch { /* ignore */ }
        }
        try { MirageChatStore.saveActiveChat?.(S()); } catch { /* ignore */ }
    }

    function setComeBackHold(reason, outcome) {
        const sess = S()?.session;
        if (!sess) return;
        const flavor = reason === 'ghost' || reason === 'type_delete'
            ? 'type_delete'
            : (reason === 'left_on_read' ? 'left_on_read' : 'busy_later');
        sess.socialHold = {
            kind: 'busy_later',
            flavor,
            reason: reason || 'busy_later',
            outcome: outcome || 'follow_up',
            at: simNowMs()
        };
        try { MirageChatStore.saveActiveChat?.(S()); } catch { /* ignore */ }
    }

    function clearUnreadAftermath() {
        if (unreadAftermathTimer) {
            clearTimeout(unreadAftermathTimer);
            unreadAftermathTimer = null;
        }
    }

    function clearNoReplyWatch() {
        clearUnreadAftermath();
    }

    /** @deprecated alias */
    function clearUnseenWatch() {
        clearNoReplyWatch();
    }

    /**
     * After she sends: 3 minutes with no operator reply → social aftermath.
     * /time pass does not use this — it fires the lottery immediately after the clock jump.
     */
    function armNoReplyWatch(reason = 'no_reply') {
        if (S()?.session?.phase !== 'active') return;
        if (isDitchHold()) return;
        if (sheIsAtStreakCap() || isUnresponsiveCap()) {
            setUnresponsiveCap();
            return;
        }
        clearUnreadAftermath();
        // This watch owns the next beat — don't also idle-nudge on top
        clearProactive();
        unreadAftermathTimer = setTimeout(() => {
            unreadAftermathTimer = null;
            if (isDitchHold()) return;
            if (S()?.session?.socialHold?.kind === 'unresponsive_cap') return;
            if (MirageSimulation?.isTurnInProgress?.()) {
                armNoReplyWatch(reason);
                return;
            }

            if (reason !== 'time_pass') {
                const attending = typeof MiragePhoneUX?.operatorAttendingChat === 'function'
                    && MiragePhoneUX.operatorAttendingChat();
                if (attending) {
                    MiragePhoneUX.markAllAiRead?.();
                } else {
                    MiragePhoneUX?.markAiUnread?.();
                }
            }

            const outcome = pickSocialOutcome(reason);
            if (outcome === 'ditch') {
                if (sheIsAtStreakCap() || isUnresponsiveCap()) {
                    setUnresponsiveCap();
                    return;
                }
                setDitchHold(reason);
                return;
            }
            fireSocialBeat(reason, outcome);
        }, noReplyWaitMs());
    }

    /** @deprecated use armNoReplyWatch */
    function armUnseenWatch() {
        armNoReplyWatch();
    }

    /** @deprecated use armNoReplyWatch */
    function onMessageLeftUnread() {
        armNoReplyWatch();
    }

    function onOperatorAttending() {
        // Seeing the thread clears Unread chrome — does NOT cancel the no-reply clock
        MiragePhoneUX?.markAllAiRead?.();
    }

    function announceSilence(simMs) {
        const ms = Math.max(60 * 1000, Number(simMs) || 0);
        MiragePhoneUX?.advanceClock?.(ms);
        const sess = S()?.session;
        if (sess) {
            sess.lastTimeSkipMs = ms;
            sess.lastTimeSkipReason = 'silence';
        }
        MiragePhoneUX?.syncClockChrome?.();
        const label = formatDuration(ms);
        MirageSimulation?.appendCaption?.(`${label} passed without a reply.`);
    }

    /**
     * Schedule ditch / follow-up DM / Story for RT and instant.
     * Instant: short beat then fire (clock already advanced for ignore notices).
     */
    function scheduleSocialBeat({ reason, outcome = null, waitMs = null } = {}) {
        if (reason === 'wait' || reason === 'world_skip' || reason === 'time_pass') {
            resetUnresponsiveStreak();
        } else if (sheIsAtStreakCap() || isUnresponsiveCap()) {
            setUnresponsiveCap();
            return 'unresponsive_cap';
        }
        let picked = outcome || pickSocialOutcome(reason);
        if (picked === 'story' && !proactiveStoriesEnabled()) {
            const gp = currentGhostProfile();
            picked = (gp.tier === 'high' && gp.engagement < 46) ? 'ditch' : 'follow_up';
            if (picked === 'ditch') {
                if (MirageSimulation?.isEngineBusy?.() || MirageSimulation?.isTurnInProgress?.()) {
                    clearProactive();
                    proactivePending = {
                        reason,
                        run: () => fireSocialBeat(reason, 'ditch')
                    };
                    proactiveTimer = setTimeout(() => {
                        proactiveTimer = null;
                        const pending = proactivePending;
                        proactivePending = null;
                        pending?.run?.();
                    }, randBetween(2500, 7000));
                    return picked;
                }
                setDitchHold(reason);
                return picked;
            }
        }
        if (picked === 'ditch') {
            if (MirageSimulation?.isEngineBusy?.() || MirageSimulation?.isTurnInProgress?.()) {
                clearProactive();
                proactivePending = {
                    reason,
                    run: () => fireSocialBeat(reason, 'ditch')
                };
                proactiveTimer = setTimeout(() => {
                    proactiveTimer = null;
                    const pending = proactivePending;
                    proactivePending = null;
                    pending?.run?.();
                }, randBetween(2500, 7000));
                return picked;
            }
            setDitchHold(reason);
            return picked;
        }

        const run = () => fireSocialBeat(reason, picked);

        const ghostComeback = reason === 'ghost'
            || reason === 'type_delete'
            || reason === 'left_on_read'
            || reason === 'ignore';

        if (ghostComeback) {
            setComeBackHold(reason, picked);
            let wait;
            if (waitMs != null && Number.isFinite(waitMs) && waitMs > 0) {
                wait = waitMs;
            } else if (pacingMode() === 'realtime') {
                wait = toRealWaitMs(randBetween(2 * 60 * 1000, 14 * 60 * 1000));
            } else {
                wait = noReplyWaitMs();
            }
            beginSkippableWallWait({
                reason,
                waitMs: wait,
                label: 'Waiting…',
                silentUi: true,
                onFire: () => run()
            });
            return picked;
        }

        // Instant: always brief. Hybrid: brief except world_skip / wait (time-jump waits).
        const skipLongWait = pacingMode() === 'instant'
            || reason === 'time_pass'
            || (pacingMode() === 'hybrid' && reason !== 'world_skip' && reason !== 'wait');

        if (skipLongWait) {
            clearProactive();
            // Instant /time pass: yield one tick so the slash command can return,
            // then fire — never sit on the 3-min quiet-chase clock.
            const delay = (reason === 'time_pass' && pacingMode() === 'instant')
                ? 0
                : randBetween(500, 1600);
            proactivePending = { run, reason };
            proactiveTimer = setTimeout(() => {
                proactiveTimer = null;
                const pending = proactivePending;
                proactivePending = null;
                pending?.run?.();
            }, delay);
            return picked;
        }

        let min;
        let max;
        if (waitMs != null && Number.isFinite(waitMs) && waitMs > 0) {
            min = waitMs * 0.85;
            max = waitMs * 1.15;
        } else if (reason === 'unread') {
            min = 90 * 1000;
            max = 10 * 60 * 1000;
        } else if (reason === 'left_on_read' || reason === 'ignore' || reason === 'ghost') {
            min = 2 * 60 * 1000;
            max = 14 * 60 * 1000;
        } else if (reason === 'world_skip') {
            min = 35 * 1000;
            max = 7 * 60 * 1000;
        } else if (reason === 'idle_long') {
            min = 15 * 1000;
            max = 80 * 1000;
        } else {
            min = 2 * 60 * 1000;
            max = 12 * 60 * 1000;
        }
        const wait = toRealWaitMs(randBetween(min, max));
        clearProactive();

        const beat = S()?.session?.pendingWorldBeat;
        const skipMs = Math.max(
            0,
            Number(beat?.clockAdvanceMs) || 0,
            Number(S()?.session?.lastTimeSkipMs) || 0
        );
        const span = formatTimeJumpSpan(
            skipMs,
            beat?.duration || beat?.scenario || null
        );
        const longJump = skipMs >= 24 * 60 * 60 * 1000;
        let label = null;
        if (reason === 'world_skip' || reason === 'wait') {
            label = reason === 'world_skip'
                ? (longJump
                    ? `Time passing — ${span}…`
                    : (beat?.duration
                        ? `Time passing (${beat.duration})…`
                        : 'Time passing — she\'ll be back soon…'))
                : 'Waiting for her to text first…';
        }

        beginSkippableWallWait({
            reason,
            waitMs: wait,
            label: label || 'Waiting for her…',
            onFire: () => run()
        });
        return picked;
    }

    function fireSocialBeat(reason, outcome) {
        if (isClockResumeHold()) return;
        if (reason === 'wait' || reason === 'world_skip' || reason === 'time_pass') {
            resetUnresponsiveStreak();
        } else if (sheIsAtStreakCap() || isUnresponsiveCap()) {
            setUnresponsiveCap();
            return;
        }
        if (reason === 'world_skip' && outcome === 'ditch') {
            outcome = 'follow_up';
        }
        if (outcome === 'ditch') {
            if (sheIsAtStreakCap() || isUnresponsiveCap()) {
                setUnresponsiveCap();
                return;
            }
            setDitchHold(reason || 'ditch');
            return;
        }
        if (isDitchHold() && reason !== 'wait') {
            return;
        }
        if (isComeBackHold()) {
            const sess = S()?.session;
            if (sess && sess.socialHold?.kind !== 'unresponsive_cap') sess.socialHold = null;
        }
        // Realtime releases turnInProgress during Delivered/Seen waits — still treat as busy
        // so idle/ditch beats can't stomp an in-flight delivery.
        if (MirageSimulation?.isEngineBusy?.() || MirageSimulation?.isTurnInProgress?.()) {
            // Defer with a timer — do NOT call scheduleSocialBeat (ditch applies immediately there).
            clearProactive();
            proactivePending = {
                reason,
                run: () => fireSocialBeat(reason, outcome)
            };
            proactiveTimer = setTimeout(() => {
                proactiveTimer = null;
                const pending = proactivePending;
                proactivePending = null;
                pending?.run?.();
            }, randBetween(2500, 7000));
            return;
        }

        // Settings gate — never proactive-Story when disabled (manual / protocol openers untouched)
        if (outcome === 'story' && !proactiveStoriesEnabled()) {
            const gp = currentGhostProfile();
            const canDitch = reason !== 'world_skip' && gp.tier === 'high' && gp.engagement < 46;
            outcome = canDitch ? 'ditch' : 'follow_up';
            if (outcome === 'ditch') {
                setDitchHold(reason || 'ditch');
                return;
            }
        }

        const drift = planIdleDrift(reason);
        if (drift.preferFollowUp && outcome === 'story' && reason !== 'world_skip') {
            outcome = 'follow_up';
        }
        if (drift.allowSceneShift && outcome === 'follow_up' && consecutiveProactiveStories() >= 2
            && proactiveStoriesEnabled() && Math.random() < 0.35) {
            outcome = 'story';
        }

        if (reason === 'world_skip') {
            // Clock advances provisionally inside executeTurn (consumePendingWorldBeat)
            // and rolls back if thinking fails — do not commit it here.
        }

        const silence = silenceSinceUserMs();
        const skipMs = Number(S()?.session?.lastTimeSkipMs) || 0;
        const skipNote = skipMs >= 60 * 1000
            ? ` LIVE STATE clock already jumped ${formatDuration(skipMs)} — write and shoot from the NEW time, not the last bubble.`
            : '';
        const directorSkip = reason === 'time_pass' || reason === 'world_skip';
        const silenceNote = (!directorSkip && silence > 2 * 60 * 1000)
            ? ` Real-world silence since his last text: ${formatDuration(silence)}.`
            : '';
        const newDaySkip = skipMs >= 18 * 60 * 60 * 1000;
        const monthSkip = skipMs >= 28 * 24 * 60 * 60 * 1000;
        const wardrobeNote = monthSkip
            ? ' Months/years passed: new season of her life. NEW clothes and a place that fits TODAY — not last night. She has been living; this is not the same conversation paused.'
            : (newDaySkip
            ? ' New calendar day: she MUST be in different clothes (new tracking.outfit) and a different place type (not a renamed bedroom). Lighting must match the new clock. A clock jump is not ghosting.'
            : (skipMs >= 3 * 60 * 60 * 1000
                ? ' Hours passed — she should have left that exact room if the hour changed. Do not reuse a renamed bedroom.'
                : (skipMs >= 45 * 60 * 1000
                    ? ' If the skip was long she may have changed clothes or moved; that is her day, not an order.'
                    : '')));
        const driftNote = drift.clockAdvanceMs > 0
            ? (drift.allowSceneShift
                ? ' TIME DRIFT: some time has passed (see LIVE STATE clock). She may have moved to a nearby activity that fits her life — this is NOT a /next scene hard cut. Keep the same clothes unless the hour clearly demands otherwise. Do not post from the same minute as the last Story.'
                : ' TIME DRIFT: some time has passed (see LIVE STATE clock). Same clothes, same-ish scene unless the hour changed. Do not stack another post from the exact same timestamp.')
            : '';
        const waitVsScene = reason === 'wait'
            ? ' This is Wait for her (operator yielded the floor) — not /next scene. Soft continuation, not a teleport + wardrobe refresh.'
            : '';

        const turnOpts = {
            internal: true,
            proactive: true,
            proactiveReason: reason,
            // Stories always photo. Follow-up DMs (lottery, wait, time pass, /next scene) follow the checkbox.
            wantImage: outcome === 'story' ? true : null,
            forceInstant: isInstantLike(),
            forceDeliver: reason === 'world_skip',
            clockAdvanceMs: reason === 'world_skip' || reason === 'time_pass' ? 0 : (drift.clockAdvanceMs || 0),
            waitDrift: reason !== 'world_skip' && reason !== 'time_pass' && drift.clockAdvanceMs > 0,
            skipSceneRef: (reason === 'time_pass' && (Number(S()?.session?.lastTimeSkipMs) || 0) >= 45 * 60 * 1000)
                || (reason !== 'world_skip' && reason !== 'time_pass' && !!drift.skipSceneRef)
        };

        if (outcome === 'story') {
            MirageUI?.toast?.('She posted a story…', 'info');
            const prompts = {
                no_reply: `PROACTIVE STORY: He didn't reply to her last DM for a few minutes (seen or unread — same vibe). She posts an Instagram Story instead of chasing — vibe/fit/mood that fits persona + ledger. Broadcast tone, not a DM. Do not mention this instruction.${driftNote}`,
                unread: `PROACTIVE STORY: He left her last DM unread. She posts an Instagram Story instead of chasing — vibe/fit/mood that fits persona + ledger. Broadcast tone, not a DM. Do not mention this instruction.${driftNote}`,
                left_on_read: `PROACTIVE STORY: She left him on read, then posted an Instagram Story — vibe/fit/mood that fits. Broadcast tone, not a DM reply.${skipNote} Do not mention this instruction.`,
                ignore: `PROACTIVE STORY: She ignored his last message for a while, then posted an Instagram Story. Broadcast tone.${skipNote} Do not mention this instruction.`,
                ghost: `PROACTIVE STORY: After almost texting then backing off, she posts an Instagram Story instead. Broadcast tone.${skipNote} Do not mention this instruction.`,
                type_delete: `PROACTIVE STORY: After almost texting then backing off, she posts an Instagram Story instead. Broadcast tone.${skipNote} Do not mention this instruction.`,
                world_skip: `PROACTIVE STORY: After the time/scene jump she posts from the NEW beat — new place type, not a renamed bedroom. Broadcast tone. Do not mention this instruction.`,
                time_pass: `PROACTIVE STORY: Time has passed — LIVE STATE clock is later. Post from where she is NOW. Light, energy, outfit, and place must match the new hour.${wardrobeNote} Broadcast caption. Do not mention a time skip or this instruction.${skipNote}`,
                wait: `PROACTIVE STORY: Operator clicked Wait for her.${waitVsScene} She posts an Instagram Story while he's waiting. Broadcast tone, not a DM. Do not mention this instruction.${driftNote}`,
                idle: `PROACTIVE STORY: Natural pause — she posts an Instagram Story (life update / fit / mood). Broadcast tone, not a DM. Do not mention this instruction.${driftNote}`,
                idle_long: `PROACTIVE STORY: Long quiet.${silenceNote} She posts an Instagram Story rather than texting first. Broadcast tone. Do not mention this instruction.${driftNote}`
            };
            MirageSimulation?.executeTurn?.(
                prompts[reason] || prompts.idle,
                { ...turnOpts, storyLaunch: true }
            );
            return;
        }

        // follow_up DM — she's in the thread
        markThreadSeen();
        MirageUI?.toast?.('She\'s messaging you…', 'info');
        const dmPrompts = {
            no_reply: `PROACTIVE BEAT: He didn't reply to her last DM for a few minutes (whether he saw it or not).${silenceNote}${driftNote} She double-texts / follows up — tone matches heat (soft nudge if warm, cooler if not). Do not mention this instruction.`,
            unread: `PROACTIVE BEAT: He left her on unread for a bit.${silenceNote}${driftNote} She double-texts / follows up — tone matches heat (soft nudge if warm, cooler if not). Do not mention this instruction.`,
            left_on_read: `PROACTIVE BEAT: She left him on read earlier, then texts again.${silenceNote}${skipNote} Do not mention this instruction.`,
            ignore: `PROACTIVE BEAT: After a stretch of silence she finally replies or reopens.${silenceNote}${skipNote} Do not mention this instruction.`,
            ghost: `PROACTIVE BEAT: She typed earlier then deleted it. Now she finally texts.${silenceNote}${skipNote} Do not mention the deleted draft unless it fits. Do not mention this instruction.`,
            type_delete: `PROACTIVE BEAT: She typed earlier then deleted it. Now she finally texts.${silenceNote}${skipNote} Do not mention the deleted draft unless it fits. Do not mention this instruction.`,
            world_skip: `PROACTIVE BEAT: The operator advanced time/scene (see WORLD STATE UPDATE if present). She DMs from the NEW place — not a renamed version of the last room.${silenceNote} Do not mention this instruction.`,
            time_pass: `PROACTIVE BEAT: Time has passed (see LIVE STATE clock). She texts from the new beat.${silenceNote}${skipNote}${wardrobeNote} Match activity, clothes, and setting to how much time passed. Any wardrobe or location change is her own reason. Do not mention a time skip or this instruction.`,
            wait: `PROACTIVE BEAT: Operator clicked Wait for her.${waitVsScene}${driftNote} She initiates — selfie bait, question, tease. Do not mention this instruction.`,
            idle: `PROACTIVE BEAT: She texts first after a natural pause.${silenceNote}${driftNote} Bored, curious, thirsty, or checking in — pick what fits. Do not mention this instruction.`,
            idle_long: `PROACTIVE BEAT: He has been quiet a long time (${formatDuration(silence)}).${driftNote} She notices — miss him, petty, soft check-in. Do not mention this instruction.`
        };
        MirageSimulation?.executeTurn?.(
            dmPrompts[reason] || dmPrompts.idle,
            turnOpts
        );
    }

    /**
     * She ignored / left-on-read his message — silence notice + aftermath.
     * Works in real-time (after hold) and instant (immediate clock jump).
     */
    function handleIgnoreAftermath(kind, { silenceSimMs = null, waitMs = null, openedThread = false } = {}) {
        clearPendingDelivery();
        const flavor = kind === 'ghost' || kind === 'type_delete'
            ? 'ghost'
            : (kind === 'went_quiet' ? 'went_quiet' : 'left_on_read');
        if (flavor === 'went_quiet') {
            if (openedThread) {
                const age = randBetween(2 * 60 * 1000, 22 * 60 * 1000);
                MiragePhoneUX?.advanceClock?.(age);
                const sess = S()?.session;
                if (sess) sess.lastSeenAt = simNowMs() - randBetween(30 * 1000, 8 * 60 * 1000);
                MiragePhoneUX?.syncClockChrome?.();
            }
            if (sheIsAtStreakCap() || isUnresponsiveCap()) {
                setUnresponsiveCap();
                return;
            }
            setDitchHold('went_quiet');
            return;
        }
        const gap = silenceSimMs > 0 ? silenceSimMs : pickSilenceGapMs(flavor);
        announceSilence(gap);
        if (sheIsAtStreakCap() || isUnresponsiveCap()) {
            setUnresponsiveCap();
            return;
        }
        scheduleSocialBeat({
            reason: flavor === 'ghost' ? 'ghost' : 'left_on_read',
            waitMs
        });
    }

    function armProactive({ reason = 'idle', waitMs = null, outcome = null } = {}) {
        if (isClockResumeHold()) return;
        if (reason === 'wait' || reason === 'world_skip' || reason === 'time_pass') {
            resetUnresponsiveStreak();
        } else if (sheIsAtStreakCap() || isUnresponsiveCap()) {
            setUnresponsiveCap();
            return;
        }
        if (isDitchHold()) return;
        if (S()?.session?.phase !== 'active') return;

        // Instant + Hybrid: only intentional waits / world skips (no idle chase spam)
        if (isInstantLike()) {
            if (reason === 'world_skip' || reason === 'wait' || reason === 'time_pass') {
                scheduleSocialBeat({ reason, waitMs: waitMs ?? randBetween(400, 1200), outcome });
            }
            return;
        }

        scheduleSocialBeat({ reason, waitMs, outcome });
    }

    function clearProactive() {
        // beginSkippableWallWait reuses proactiveTimer — never clearTimeout that wall wait.
        const wallOwnsTimer = !!(
            skippableWallWait
            && skippableWallWait.timer
            && skippableWallWait.timer === proactiveTimer
        );
        if (!wallOwnsTimer) {
            if (proactiveTimer) {
                clearTimeout(proactiveTimer);
                proactiveTimer = null;
            }
            proactivePending = null;
        }
        // Don't silently kill an armed world_skip wall wait from unrelated clearProactive
        // callers that only meant to clear idle chase — only clear micro proactive timers.
        // World skips use beginSkippableWallWait; clear those via clearSkippableWallWait / cancel.
        if (skippableWallWait && skippableWallWait.reason !== 'world_skip' && skippableWallWait.reason !== 'wait' && skippableWallWait.reason !== 'narrative') {
            clearSkippableWallWait({ silent: true });
        }
    }

    function clearAllWaits() {
        clearProactive();
        clearSkippableWallWait({ silent: false });
        clearNoReplyWatch();
    }

    /** @deprecated — fireSocialBeat is the path; kept for any stray callers */
    function fireProactive(reason) {
        fireSocialBeat(reason, pickSocialOutcome(reason));
    }

    function waitForHer() {
        if (isClockResumeHold()) {
            MirageUI?.toast?.('Pick how to handle the time gap first.', 'error');
            return;
        }
        resetUnresponsiveStreak();
        clearSocialHold();
        if (MirageSimulation?.isTurnInProgress?.() || MirageSimulation?.isHardBusy?.()) {
            MirageUI?.toast?.('Wait for the current turn to finish.', 'error');
            return;
        }
        // Wait for her owns this beat — cancel the 3-min no-reply chase so they don't stack
        clearNoReplyWatch();
        clearProactive();

        // Instant: fire a proactive beat immediately (extra reply without you texting).
        if (pacingMode() === 'instant') {
            clearWaitLabel();
            MirageUI?.setStatus?.('ACTIVE', 'active');
            fireSocialBeat('wait', pickSocialOutcome('wait'));
            return;
        }

        MirageUI?.toast?.('Waiting for her to text first…', 'info');
        setWaitLabel('Waiting for her to text first…');
        MirageUI?.setStatus?.('WAITING', 'busy');
        armProactive({ reason: 'wait' });
        // Hybrid: short arm still clears WAITING chrome quickly unless a wall wait took over
        if (isInstantLike()) {
            clearWaitLabel();
            MirageUI?.setStatus?.('ACTIVE', 'active');
        } else {
            waitStatusTimer = setTimeout(() => {
                clearWaitLabel();
                MirageUI?.setStatus?.('ACTIVE', 'active');
            }, 2500);
        }
    }

    function onUserActivity() {
        // Abort idle chase / no-reply watches, but never kill an armed time-jump wall wait.
        if (proactiveTimer && (!skippableWallWait || (skippableWallWait.reason !== 'world_skip' && skippableWallWait.reason !== 'narrative'))) {
            clearProactive();
        }
        clearNoReplyWatch();
        if (S()?.session?.socialHold?.kind !== 'unresponsive_cap') {
            clearSocialHold();
        }
        touchUserActivity();
    }

    function onTurnSettled() {
        touchLastAttended();
        touchAiActivity();
        if (isDitchHold()) return;
        if (sheIsAtStreakCap() || isUnresponsiveCap()) {
            setUnresponsiveCap();
            return;
        }

        // Consume narrative skip flag — her post-skip DM already landed; no-reply watch handles chase
        const skipMs = Number(S()?.session?.lastTimeSkipMs) || 0;
        if (skipMs >= 20 * 60 * 1000) {
            S().session.lastTimeSkipMs = 0;
        }

        // No-reply watch owns the next beat
        if (unreadAftermathTimer) return;

        // Idle chase only in full Realtime — never while another wait/delivery is live
        if (!enabled()) return;
        if (MirageSimulation?.isEngineBusy?.()) return;
        const presence = assessPresence();
        if (presence.heat >= 3) {
            armProactive({ reason: 'idle', waitMs: randBetween(75 * 1000, 4 * 60 * 1000) });
        } else if (presence.band === 'warm') {
            armProactive({ reason: 'idle', waitMs: randBetween(3 * 60 * 1000, 10 * 60 * 1000) });
        } else {
            armProactive({ reason: 'idle' });
        }
    }

    /** Tab visible again after a long gap → she may reach out. */
    function onVisibilityResume() {
        if (S()?.session?.phase !== 'active') return;
        if (MirageSimulation?.isTurnInProgress?.()) return;
        if (resumeAfterAbsence()) return;
        if (typeof MiragePhoneUX?.operatorAttendingChat === 'function'
            && MiragePhoneUX.operatorAttendingChat()) {
            onOperatorAttending();
            MiragePhoneUX.markAllAiRead?.();
        }
        if (!enabled()) return;
        if (isDitchHold()) return;
        if (S()?.session?.socialHold?.kind === 'unresponsive_cap') return;
        const gap = silenceSinceAnyMs();
        if (gap >= 25 * 60 * 1000) {
            armProactive({ reason: 'idle_long', waitMs: randBetween(15 * 1000, 75 * 1000) });
        }
    }

    /**
     * Returning after real-world absence. Sim clock already includes wall time
     * (herNow = Date.now() + offset) — do NOT add the gap onto clockOffsetMs.
     * Cool heat / last-seen so she isn't "online" after eight hours away.
     */
    function decayEngagementOnResume() {
        const sess = S()?.session;
        if (!sess || sess.phase !== 'active') return null;
        if (typeof MirageLoyaltyUX?.decayEngagementForSilence !== 'function') return null;
        const result = MirageLoyaltyUX.decayEngagementForSilence(sess);
        if (result?.changed) {
            try { MirageChatStore.saveActiveChat?.(S()); } catch { /* ignore */ }
            try { MirageSimulation?.updateHud?.(); } catch { /* ignore */ }
        }
        return result;
    }

    /**
     * In-memory 3-min no-reply timer dies when the engine is shut down.
     * After restore / clock-resume: re-arm it, or fire now if her last bubble
     * is already past the quiet-chase window on the sim clock.
     */
    function resumeQuietChase() {
        const sess = S()?.session;
        if (!sess || sess.phase !== 'active') return;
        if (sess.clockResumeHold) return;
        if (isDitchHold(sess) || isUnresponsiveCap()) return;
        if (MirageSimulation?.isTurnInProgress?.()) return;
        if (unreadAftermathTimer) return;
        if (isComeBackHold(sess)) {
            const hold = sess.socialHold || {};
            const waited = Math.max(0, simNowMs() - (Number(hold.at) || 0));
            const windowMs = noReplyWaitMs();
            const outcome = hold.outcome || pickSocialOutcome(hold.reason || 'ghost');
            if (waited >= windowMs) {
                fireSocialBeat(hold.reason || 'ghost', outcome);
            } else {
                scheduleSocialBeat({
                    reason: hold.reason || 'ghost',
                    outcome,
                    waitMs: Math.max(800, windowMs - waited)
                });
            }
            return;
        }
        const lastAi = Number(sess.lastAiMessageAt) || 0;
        if (!lastAi) return;
        const lastUser = Number(sess.lastUserMessageAt) || 0;
        // He already replied after her (2s slop for double-text same-stamp)
        if (lastUser > lastAi + 2000) return;

        const waited = Math.max(0, simNowMs() - lastAi);
        const windowMs = noReplyWaitMs();
        if (waited >= windowMs) {
            const outcome = pickSocialOutcome('no_reply');
            emitDecision({
                kind: 'resume',
                summary: `Quiet chase catch-up after ${formatDuration(waited)} — ${outcome}`,
                detail: { waitedMs: waited, outcome }
            });
            if (outcome === 'ditch') {
                setDitchHold('no_reply');
                return;
            }
            scheduleSocialBeat({ reason: 'no_reply', outcome });
            return;
        }
        armNoReplyWatch('no_reply');
    }

    function catchUpAfterAbsence() {
        const sess = S()?.session;
        if (!sess || sess.phase !== 'active') return null;
        decayEngagementOnResume();
        if (sess.clockResumeHold) return null;
        const gap = silenceSinceAnyMs();
        const LONG = 20 * 60 * 1000;
        if (!(gap >= LONG)) return { gap, caughtUp: false };

        sess.chatHeat = 0;
        sess.lastReplyLagMs = gap;
        sess.presence = 'idle';
        const lastAi = Number(sess.lastAiMessageAt) || 0;
        const lastUser = Number(sess.lastUserMessageAt) || 0;
        const lastMsg = Math.max(lastAi, lastUser);
        if (lastAi > 0) sess.lastSeenAt = lastAi;

        try { MiragePhoneUX?.showTyping?.(false); } catch { /* ignore */ }
        try {
            MiragePhoneUX?.setPresence?.('idle', { touchSeen: false });
        } catch { /* ignore */ }
        if (lastAi > 0) sess.lastSeenAt = lastAi;
        try { MiragePhoneUX?.updateChrome?.(); } catch { /* ignore */ }

        // Same transcript silence already handled — a refresh must not log another
        // [DECISION] or treat restore as a new absence.
        if (lastMsg > 0 && Number(sess.catchUpForMessageAt) === lastMsg) {
            return { gap, caughtUp: false, skipped: true };
        }
        sess.catchUpForMessageAt = lastMsg || null;

        emitDecision({
            kind: 'resume',
            summary: `Returned after ${formatDuration(gap)} — clock already live, presence cooled`,
            detail: { gapMs: gap, clockOffsetMs: Number(sess.clockOffsetMs) || 0 }
        });
        return { gap, caughtUp: true };
    }

    function bind() {
        document.getElementById('simInput')?.addEventListener('input', () => {
            if (proactiveTimer) clearProactive();
            clearUnreadAftermath();
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                touchLastAttended();
                return;
            }
            if (document.visibilityState === 'visible') onVisibilityResume();
        });
        window.addEventListener('pagehide', () => touchLastAttended());
    }

    global.MirageImmersion = {
        enabled,
        pacingMode,
        waitsOnTimeJumps,
        isInstantLike,
        planDelivery,
        choreograph,
        sleep,
        cancelDelivery,
        skipWallWaits,
        hasActiveWallWait,
        getPendingDelivery,
        setPendingDelivery,
        clearPendingDelivery,
        armProactive,
        clearProactive,
        clearAllWaits,
        beginSkippableWallWait,
        scheduleSocialBeat,
        handleIgnoreAftermath,
        armNoReplyWatch,
        clearNoReplyWatch,
        armUnseenWatch,
        clearUnseenWatch,
        onMessageLeftUnread,
        onOperatorAttending,
        clearSocialHold,
        pickSocialOutcome,
        proactiveStoriesEnabled,
        waitForHer,
        maybeOfferClockResume,
        resumeAfterAbsence,
        isClockResumeHold,
        resetUnresponsiveStreak,
        isUnresponsiveCap,
        countsTowardUnresponsiveCap,
        touchLastAttended,
        wallAbsenceMs,
        CLOCK_RESUME_MS,
        onPacingModeChanged,
        accelerateInFlightWaits,
        onUserActivity,
        onTurnSettled,
        onVisibilityResume,
        catchUpAfterAbsence,
        resumeQuietChase,
        decayEngagementOnResume,
        silenceSinceUserMs,
        silenceSinceAnyMs,
        lastReplyLagMs,
        assessPresence,
        simNowMs,
        formatDuration,
        formatRelativeAgo,
        formatTimeJumpSpan,
        normalizeReactionEmoji,
        isDitchHold,
        isComeBackHold,
        HER_STREAK_CAP,
        herUnansweredStreak,
        touchUserActivity,
        touchAiActivity,
        bind,
        typingMsFor,
        toRealWaitMs,
        capRealWaitMs,
        realWaitCapMs,
        noReplyWaitMs,
        REAL_WAIT_CAP_MS,
        emitDecision,
        debugSnapshot() {
            const sess = S()?.session;
            const presence = assessPresence(sess);
            return {
                enabled: enabled(),
                clockResumeHold: !!sess?.clockResumeHold,
                wallAbsenceMs: wallAbsenceMs(),
                pacingMode: pacingMode(),
                routineMode: typeof MirageRoutine?.currentMode === 'function'
                    ? MirageRoutine.currentMode()
                    : (S()?.routineMode || 'stories'),
                waitsOnTimeJumps: waitsOnTimeJumps(),
                realTimeChat: pacingMode() === 'realtime',
                proactiveStories: S()?.proactiveStories !== false,
                realWaitCapMs: realWaitCapMs(),
                noReplyWaitMs: noReplyWaitMs(),
                unseenUnreadMs: noReplyWaitMs(),
                deliveryGen,
                hasProactiveTimer: !!proactiveTimer,
                hasWaitStatusTimer: !!waitStatusTimer,
                pendingDelivery: pendingDelivery
                    ? {
                        style: pendingDelivery.style || pendingDelivery.plan?.style || null,
                        preReadMs: pendingDelivery.preReadMs ?? pendingDelivery.plan?.preReadMs ?? null,
                        gapMs: pendingDelivery.gapMs ?? pendingDelivery.plan?.gapMs ?? null,
                        typingMs: pendingDelivery.typingMs ?? pendingDelivery.plan?.typingMs ?? null,
                        leftOnReadHoldMs: pendingDelivery.leftOnReadHoldMs
                            ?? pendingDelivery.plan?.leftOnReadHoldMs
                            ?? null,
                        timeSkipMs: pendingDelivery.plan?.timeSkipMs ?? null,
                        timeSkipReason: pendingDelivery.plan?.timeSkipReason ?? null,
                        narrativeWaitMs: pendingDelivery.plan?.narrativeWaitMs ?? null
                    }
                    : null,
                presence,
                session: sess
                    ? {
                        chatHeat: sess.chatHeat,
                        engagement: sess.engagement,
                        lastReplyLagMs: sess.lastReplyLagMs,
                        lastUserMessageAt: sess.lastUserMessageAt,
                        lastAiMessageAt: sess.lastAiMessageAt,
                        lastStoryAt: sess.lastStoryAt,
                        herStreak: Number(sess.herStreak) || 0,
                        _storyActive: !!sess._storyActive,
                        pendingWorldBeat: sess.pendingWorldBeat,
                        directorScene: sess.directorScene,
                        startInstruction: sess.startInstruction,
                        sessionEpoch: sess.sessionEpoch,
                        awakeningActive: !!sess.awakeningActive,
                        awakeningStage: sess.awakeningStage,
                        lastTimeSkipMs: sess.lastTimeSkipMs ?? null,
                        lastTimeSkipReason: sess.lastTimeSkipReason ?? null,
                        routineBand: sess._routineBand || null,
                        routineAt: sess._routineAt || null,
                        presencePhoneUx: sess.presence,
                        socialHold: sess.socialHold || null
                    }
                    : null
            };
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);
