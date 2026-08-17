/**
 * MIRAGE ENGINE v2 — Flag in-flight turns (refresh/crash discards them)
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'mirage_v2_pending_turn';

    function save(payload) {
        if (!payload?.charKey || !payload?.chatId) return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                ...payload,
                savedAt: Date.now()
            }));
        } catch (e) {
            console.warn('[Mirage] Pending turn save failed', e);
        }
    }

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data?.charKey || !data?.chatId) return null;
            // Drop stale pending (> 2 hours)
            if (data.savedAt && Date.now() - data.savedAt > 2 * 60 * 60 * 1000) {
                clear();
                return null;
            }
            return data;
        } catch (e) {
            console.warn('[Mirage] Pending turn load failed', e);
            return null;
        }
    }

    function clear() {
        localStorage.removeItem(STORAGE_KEY);
    }

    function matches(state, pending) {
        if (!pending || !state) return false;
        const ck = MirageChatStore?.characterKey?.(state);
        return ck === pending.charKey && state.session?.activeChatId === pending.chatId;
    }

    global.MiragePendingTurn = { save, load, clear, matches };
})(typeof window !== 'undefined' ? window : globalThis);
