/**
 * MIRAGE ENGINE v2 — Memory ledger + callback injector
 *
 * Sticky continuity facts the thinking model always sees (nicknames, promises,
 * unresolved tension). Every few turns a CALLBACK NOTE forces one natural reference.
 */
(function (global) {
    'use strict';

    const S = () => global.EngineState;

    const MAX_ITEMS = 8;
    const CALLBACK_EVERY = 3;
    const KINDS = new Set([
        'nickname', 'promise', 'plan', 'tension', 'preference', 'fact', 'callback'
    ]);

    function emptyLedger() {
        return [];
    }

    function normalizeKind(kind) {
        const k = String(kind || 'fact').trim().toLowerCase();
        return KINDS.has(k) ? k : 'fact';
    }

    function clip(text, max = 140) {
        const s = String(text || '').trim().replace(/\s+/g, ' ');
        return s.length > max ? `${s.slice(0, max)}…` : s;
    }

    function ensure(session) {
        if (!session) return emptyLedger();
        if (!Array.isArray(session.memoryLedger)) session.memoryLedger = emptyLedger();
        if (!Number.isFinite(session.turnsSinceCallback)) session.turnsSinceCallback = 0;
        return session.memoryLedger;
    }

    function listOpen(session) {
        return ensure(session).filter(item => item && !item.resolved && item.text);
    }

    function add(session, { kind, text }) {
        const ledger = ensure(session);
        const body = clip(text);
        if (!body) return null;

        // Dedupe near-identical open facts
        const dup = ledger.find(i =>
            !i.resolved && i.text.toLowerCase() === body.toLowerCase());
        if (dup) return dup;

        const item = {
            id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            kind: normalizeKind(kind),
            text: body,
            at: Date.now(),
            resolved: false
        };
        ledger.unshift(item);
        // Keep newest open items + a few resolved for context
        session.memoryLedger = ledger.slice(0, MAX_ITEMS);
        return item;
    }

    function resolve(session, matcher) {
        const ledger = ensure(session);
        const q = String(matcher || '').trim().toLowerCase();
        if (!q) return false;
        const hit = ledger.find(i =>
            !i.resolved && (i.id === matcher || i.text.toLowerCase().includes(q)));
        if (!hit) return false;
        hit.resolved = true;
        return true;
    }

    function applyUpdates(session, updates) {
        if (!Array.isArray(updates) || !updates.length) return;
        updates.forEach(u => {
            if (!u || typeof u !== 'object') return;
            const op = String(u.op || 'add').toLowerCase();
            if (op === 'resolve' || op === 'remove') {
                resolve(session, u.text || u.id || u.kind);
            } else {
                add(session, { kind: u.kind, text: u.text });
            }
        });
    }

    /** Block for system / userParts — only open items. */
    function formatForPrompt(session) {
        const open = listOpen(session);
        if (!open.length) return '';
        const lines = open.slice(0, MAX_ITEMS).map((item, i) =>
            `${i + 1}. [${item.kind}] ${item.text}`);
        return [
            'MEMORY LEDGER (sticky continuity — treat as true; do not contradict):',
            ...lines,
            'Update via memoryUpdates when something new sticks or an item resolves.'
        ].join('\n');
    }

    /**
     * Every CALLBACK_EVERY turns with open ledger items, return a CLIENT NOTE
     * that forces a natural callback. Returns '' when not due.
     */
    function consumeCallbackNote(session) {
        const open = listOpen(session);
        if (!open.length) {
            session.turnsSinceCallback = 0;
            return '';
        }

        session.turnsSinceCallback = (Number(session.turnsSinceCallback) || 0) + 1;
        if (session.turnsSinceCallback < CALLBACK_EVERY) return '';

        session.turnsSinceCallback = 0;
        // Prefer tension / promise / plan over dry facts
        const ranked = [...open].sort((a, b) => {
            const rank = k => ({ tension: 0, promise: 1, plan: 2, nickname: 3, preference: 4, callback: 5, fact: 6 }[k] ?? 9);
            return rank(a.kind) - rank(b.kind);
        });
        const pick = ranked[0];
        return [
            'CLIENT NOTE: CALLBACK — naturally weave this memory into characterResponse this turn.',
            'Do not quote the ledger, do not say "as I remember", just let it colour the message:',
            `→ (${pick.kind}) ${pick.text}`
        ].join('\n');
    }

    function resetSessionFields(session) {
        if (!session) return;
        session.memoryLedger = emptyLedger();
        session.turnsSinceCallback = 0;
    }

    function exportFields(session) {
        return {
            memoryLedger: ensure(session).map(i => ({
                id: i.id,
                kind: i.kind,
                text: i.text,
                at: i.at,
                resolved: !!i.resolved
            })).slice(0, MAX_ITEMS),
            turnsSinceCallback: Number(session.turnsSinceCallback) || 0
        };
    }

    function applyFields(session, data) {
        if (!session || !data) return;
        session.memoryLedger = Array.isArray(data.memoryLedger)
            ? data.memoryLedger.slice(0, MAX_ITEMS).map(i => ({
                id: i.id || `m_${Date.now().toString(36)}`,
                kind: normalizeKind(i.kind),
                text: clip(i.text),
                at: i.at || Date.now(),
                resolved: !!i.resolved
            }))
            : emptyLedger();
        session.turnsSinceCallback = Number(data.turnsSinceCallback) || 0;
    }

    global.MirageMemoryLedger = {
        MAX_ITEMS,
        CALLBACK_EVERY,
        ensure,
        listOpen,
        add,
        resolve,
        applyUpdates,
        formatForPrompt,
        consumeCallbackNote,
        resetSessionFields,
        exportFields,
        applyFields
    };
})(typeof window !== 'undefined' ? window : globalThis);
