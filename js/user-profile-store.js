/**
 * MIRAGE ENGINE v2 — Operator / user profiles (localStorage)
 *
 * Settings holds the library + which profile is active for *new* chats.
 * Each chat pins a userProfileId (+ label snapshot) so mid-chat switches are explicit
 * and deleted profiles still show as "(deleted)".
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'mirage_v2_user_profiles';
    const VERSION = 1;

    const SEED_ID = 'user-default';
    const EMPTY_FIELDS = {
        displayName: '',
        nickname: '',
        age: '',
        gender: 'male',
        appearance: '',
        personality: '',
        interests: '',
        notes: ''
    };
    const SEED_FIELDS = {
        ...EMPTY_FIELDS,
        gender: 'male',
        age: '21'
    };

    function normalizeGender(raw, { pronouns } = {}) {
        const g = String(raw || '').trim().toLowerCase();
        if (g === 'female' || g === 'f' || g === 'woman' || g === 'girl') return 'female';
        if (g === 'male' || g === 'm' || g === 'man' || g === 'boy') return 'male';
        // Legacy pronouns field migration
        const p = String(pronouns || '').trim().toLowerCase();
        if (/\bshe\b|\bher\b|\bhers\b/.test(p)) return 'female';
        return 'male';
    }

    function genderLabel(gender) {
        return normalizeGender(gender) === 'female' ? 'Female' : 'Male';
    }

    function pronounsForGender(gender) {
        return normalizeGender(gender) === 'female' ? 'she/her' : 'he/him';
    }

    function hydrateProfile(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const fields = normalizeFields(raw);
        const label = String(raw.label || '').trim();
        const seed = !!(raw.seed || raw.id === SEED_ID || label.toLowerCase() === 'default');
        const protectedProfile = !!(raw.protected || seed);
        return {
            id: raw.id,
            label,
            savedAt: raw.savedAt,
            updatedAt: raw.updatedAt,
            seed,
            protected: protectedProfile,
            ...fields
        };
    }

    function readStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { version: VERSION, activeId: null, profiles: [] };
            const data = JSON.parse(raw);
            if (!Array.isArray(data.profiles)) {
                return { version: VERSION, activeId: null, profiles: [] };
            }
            return {
                version: VERSION,
                activeId: data.activeId || null,
                profiles: data.profiles.map(hydrateProfile).filter(Boolean)
            };
        } catch (e) {
            console.warn('[Mirage] User profile store load failed', e);
            return { version: VERSION, activeId: null, profiles: [] };
        }
    }

    function writeStore(data) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            version: VERSION,
            activeId: data.activeId || null,
            profiles: data.profiles || []
        }));
    }

    /** Snapshot for a backup bundle. */
    function exportAll() {
        const store = readStore();
        return { version: VERSION, activeId: store.activeId, profiles: store.profiles };
    }

    /**
     * Merge restored operator profiles in. Existing profiles win on an id collision —
     * a restore adds what is missing, it never rewrites who you currently are. The
     * active selection is likewise left alone unless nothing is active yet.
     */
    function importAll(data) {
        const incoming = Array.isArray(data?.profiles) ? data.profiles : [];
        if (!incoming.length) return { added: 0 };
        const store = readStore();
        const taken = new Set(store.profiles.map(p => p.id));
        let added = 0;
        incoming.forEach(raw => {
            const profile = hydrateProfile(raw);
            if (!profile || taken.has(profile.id)) return;
            taken.add(profile.id);
            store.profiles.push(profile);
            added += 1;
        });
        if (!store.activeId && data?.activeId && taken.has(data.activeId)) {
            store.activeId = data.activeId;
        }
        if (added) writeStore(store);
        return { added };
    }

    function makeId(label) {
        const slug = String(label || 'user')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 24) || 'user';
        return `${slug}-${Date.now().toString(36)}`;
    }

    function normalizeFields(input) {
        const src = input && typeof input === 'object' ? input : {};
        const out = { ...EMPTY_FIELDS };
        Object.keys(EMPTY_FIELDS).forEach(key => {
            if (key === 'gender') return;
            if (src[key] != null) out[key] = String(src[key]).trim();
        });
        out.gender = normalizeGender(src.gender, { pronouns: src.pronouns });
        return out;
    }

    function list() {
        return readStore().profiles
            .slice()
            .sort((a, b) => {
                const aSeed = a.seed || a.id === SEED_ID || String(a.label || '').toLowerCase() === 'default';
                const bSeed = b.seed || b.id === SEED_ID || String(b.label || '').toLowerCase() === 'default';
                if (aSeed !== bSeed) return aSeed ? -1 : 1;
                return (b.updatedAt || b.savedAt || '').localeCompare(a.updatedAt || a.savedAt || '');
            });
    }

    function get(id) {
        if (!id) return null;
        return readStore().profiles.find(p => p.id === id) || null;
    }

    function getActiveId() {
        const store = readStore();
        if (store.activeId && store.profiles.some(p => p.id === store.activeId)) {
            return store.activeId;
        }
        return store.profiles[0]?.id || null;
    }

    function getActive() {
        return get(getActiveId());
    }

    function setActive(id) {
        const store = readStore();
        if (id && !store.profiles.some(p => p.id === id)) {
            throw new Error('User profile not found.');
        }
        store.activeId = id || null;
        writeStore(store);
        return getActive();
    }

    function isProtected(entryOrId) {
        const entry = typeof entryOrId === 'string' ? get(entryOrId) : entryOrId;
        if (!entry) return false;
        if (entry.protected) return true;
        return String(entry.label || '').trim().toLowerCase() === 'default';
    }

    function save({ id, label, fields }) {
        const name = String(label || '').trim();
        if (!name) throw new Error('User profile needs a name.');

        const store = readStore();
        const now = new Date().toISOString();
        const existingIdx = id ? store.profiles.findIndex(p => p.id === id) : -1;
        const existing = existingIdx >= 0 ? store.profiles[existingIdx] : null;
        const keepSeed = !!(
            (id && id === SEED_ID)
            || (existing && (existing.seed || existing.id === SEED_ID))
        );
        const keepProtected = keepSeed || !!(existing && isProtected(existing));
        const entry = {
            id: keepSeed ? (existing?.id || SEED_ID) : (id || makeId(name)),
            label: name,
            savedAt: existing ? existing.savedAt : now,
            updatedAt: now,
            seed: keepSeed,
            protected: keepProtected,
            ...normalizeFields(fields)
        };

        if (existingIdx >= 0) store.profiles[existingIdx] = entry;
        else store.profiles.push(entry);

        if (!store.activeId) store.activeId = entry.id;
        writeStore(store);
        return entry;
    }

    function remove(id) {
        if (!id) return;
        const store = readStore();
        const target = store.profiles.find(p => p.id === id);
        if (isProtected(target)) {
            throw new Error('The Default user profile cannot be deleted.');
        }
        store.profiles = store.profiles.filter(p => p.id !== id);
        if (store.activeId === id) {
            store.activeId = store.profiles[0]?.id || null;
        }
        writeStore(store);
    }

    /**
     * Snapshot of the settings-active profile for a newly created chat.
     */
    function pinActiveForChat() {
        const active = getActive();
        if (!active) return { userProfileId: null, userProfileLabel: null };
        return {
            userProfileId: active.id,
            userProfileLabel: active.label
        };
    }

    /**
     * Resolve profile for the current chat/session (handles deleted).
     */
    function resolveForSession(session) {
        const id = session?.userProfileId || null;
        const cachedLabel = String(session?.userProfileLabel || '').trim();

        if (!id) {
            const active = getActive();
            return {
                id: active?.id || null,
                label: active?.label || 'None',
                deleted: false,
                missing: !active,
                profile: active
            };
        }

        const live = get(id);
        if (live) {
            return {
                id: live.id,
                label: live.label,
                deleted: false,
                missing: false,
                profile: live
            };
        }

        return {
            id,
            label: cachedLabel ? `${cachedLabel} (deleted)` : 'User (deleted)',
            deleted: true,
            missing: false,
            profile: null,
            cachedLabel: cachedLabel || 'User'
        };
    }

    function findSeed(store) {
        return (store.profiles || []).find(p =>
            p.id === SEED_ID
            || p.seed
            || String(p.label || '').trim().toLowerCase() === 'default'
        ) || null;
    }

    function ensureSeed() {
        const store = readStore();
        if (!store.profiles.length) {
            return save({
                id: SEED_ID,
                label: 'Default',
                fields: { ...SEED_FIELDS }
            });
        }
        const seed = findSeed(store);
        if (seed) {
            const ageBlank = !String(seed.age || '').trim();
            const genderBlank = !String(seed.gender || '').trim();
            if (ageBlank || genderBlank) {
                return save({
                    id: seed.id,
                    label: seed.label || 'Default',
                    fields: {
                        ...seed,
                        gender: seed.gender || 'male',
                        age: seed.age || '21'
                    }
                });
            }
        }
        return getActive();
    }

    /** Factory-reset the Default operator preset (male, 21). Other profiles stay. */
    function resetSeedToFactory() {
        const store = readStore();
        const seed = findSeed(store);
        return save({
            id: seed?.id || SEED_ID,
            label: 'Default',
            fields: { ...SEED_FIELDS }
        });
    }

    global.MirageUserProfiles = {
        EMPTY_FIELDS,
        SEED_FIELDS,
        SEED_ID,
        list,
        get,
        exportAll,
        importAll,
        getActive,
        getActiveId,
        setActive,
        save,
        remove,
        isProtected,
        pinActiveForChat,
        resolveForSession,
        ensureSeed,
        resetSeedToFactory,
        normalizeFields,
        normalizeGender,
        genderLabel,
        pronounsForGender
    };
})(typeof window !== 'undefined' ? window : globalThis);
