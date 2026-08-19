/**
 * In-page instrumentation for Layer 2.
 *
 * Wraps the engine's own reporting surfaces rather than reading private state, so
 * the recording is of what the engine *says it did* — the decision log, the notices
 * the player sees, the chat entries — plus a metric snapshot per turn. If a
 * refactor changes those surfaces the recording changes, which is the point.
 */

/** Installed with page.evaluate once the app has booted. */
const INSTALL = () => {
    if (window.__mirageRec) return;

    const rec = {
        decisions: [],
        notices: [],
        turns: []
    };
    window.__mirageRec = rec;

    const wrap = (owner, name, onCall) => {
        const original = owner?.[name];
        if (typeof original !== 'function') return;
        owner[name] = function (...args) {
            try { onCall(...args); } catch { /* never let instrumentation break a turn */ }
            return original.apply(this, args);
        };
    };

    wrap(MirageSimulation, 'appendDebugDecision', (evt) => {
        if (!evt) return;
        rec.decisions.push({
            kind: evt.kind || null,
            summary: evt.summary || null,
            detail: evt.detail ?? null
        });
    });
    wrap(MirageSimulation, 'appendCaption', (text) => {
        rec.notices.push({ via: 'caption', text: String(text) });
    });
    wrap(MirageSimulation, 'appendSystemNote', (text, opts) => {
        rec.notices.push({ via: 'systemNote', essential: !!opts?.essential, text: String(text) });
    });
    wrap(MirageUI, 'toast', (msg, type, opts) => {
        const o = opts && typeof opts === 'object' ? opts : null;
        const player = type === 'error' || type === 'ok' || !!o?.essential || o?.lane === 'player';
        rec.notices.push({
            via: `toast:${o?.lane === 'dev' ? 'dev' : (player ? 'player' : 'inferred')}`,
            text: String(msg)
        });
    });

    /** Everything the operator can see about her state, in one flat shape. */
    window.__mirageSnapshot = () => {
        const s = EngineState.session || {};
        return {
            persona: s.persona ?? null,
            mode: s.mode ?? null,
            arousal: s.arousal ?? null,
            tease: s.tease ?? null,
            awareness: s.awareness ?? null,
            thermal: s.thermal ?? null,
            mood: s.mood ?? null,
            moodIntensity: s.moodIntensity ?? null,
            engagement: s.engagement ?? null,
            outfit: s.outfit ?? null,
            env: s.env ?? null,
            lastShotType: s.lastShotType ?? null,
            shotHistory: Array.isArray(s.shotHistory) ? s.shotHistory.slice() : [],
            herStreak: s.herStreak ?? 0,
            socialHold: s.socialHold?.kind ?? null,
            awakeningActive: !!s.awakeningActive,
            awakeningStage: s.awakeningStage ?? null,
            historyLength: Array.isArray(s.history) ? s.history.length : 0,
            memoryLedger: (Array.isArray(s.memoryLedger) ? s.memoryLedger : [])
                .map(i => ({ kind: i.kind, text: i.text, resolved: !!i.resolved }))
        };
    };

    /** Close off one turn: what changed, what was decided, what was shown. */
    window.__mirageCloseTurn = (label) => {
        const before = rec.turns.length
            ? rec.turns[rec.turns.length - 1].after
            : null;
        const after = window.__mirageSnapshot();
        const changed = {};
        if (before) {
            for (const key of Object.keys(after)) {
                const a = JSON.stringify(before[key]);
                const b = JSON.stringify(after[key]);
                if (a !== b) changed[key] = { from: before[key], to: after[key] };
            }
        }
        rec.turns.push({
            label,
            changed: before ? changed : { '(initial)': after },
            after,
            decisions: rec.decisions.splice(0),
            notices: rec.notices.splice(0)
        });
        return rec.turns[rec.turns.length - 1];
    };
};

async function installRecorder(page) {
    await page.evaluate(INSTALL);
}

async function closeTurn(page, label) {
    return page.evaluate(l => window.__mirageCloseTurn(l), label);
}

async function readRecording(page) {
    return page.evaluate(() => ({ turns: window.__mirageRec.turns }));
}

module.exports = { installRecorder, closeTurn, readRecording };
