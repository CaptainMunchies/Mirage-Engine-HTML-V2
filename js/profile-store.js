/**
 * MIRAGE ENGINE v2 — Persistent character profile storage (localStorage)
 *
 * Snapshots stay lean: EDF + profile + face/body metadata.
 * Master face/body blobs live in IndexedDB via MirageAnchorStore.
 * Photo pool lives in MirageMediaLibrary (also IndexedDB).
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'mirage_v2_characters';
    const VERSION = 2;

    function readStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { version: VERSION, profiles: [] };
            const data = JSON.parse(raw);
            if (!Array.isArray(data.profiles)) return { version: VERSION, profiles: [] };
            return data;
        } catch (e) {
            console.warn('[Mirage] Character store load failed', e);
            return { version: VERSION, profiles: [] };
        }
    }

    function writeStore(data) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            version: VERSION,
            profiles: data.profiles || []
        }));
    }

    function makeId(name) {
        const slug = String(name || 'character')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 24) || 'character';
        return `${slug}-${Date.now().toString(36)}`;
    }

    function base64ToFile(base64, fileName, mimeType) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new File([bytes], fileName || 'master-face.jpg', { type: mimeType || 'image/jpeg' });
    }

    function stripBase64(anchor) {
        if (!anchor || typeof anchor !== 'object') return null;
        const { base64, ...rest } = anchor;
        return {
            fileName: rest.fileName || 'anchor.jpg',
            mimeType: rest.mimeType || 'image/jpeg',
            size: Number(rest.size) || 0,
            storage: 'idb'
        };
    }

    function hasUsableFace(anchor, state) {
        if (state?.masterFaceFile) return true;
        if (state?.masterFaceBase64) return true;
        if (!anchor) return false;
        if (anchor.base64) return true;
        if (anchor.storage === 'idb' || anchor.fileName) return true;
        return false;
    }

    function exportSnapshot(state, profileOverride) {
        const profile = profileOverride || state.profile || {};
        if (typeof MirageLoyaltyUX?.ensureLibido === 'function') {
            MirageLoyaltyUX.ensureLibido(profile, state.edf);
        }

        const masterFace = state.masterFaceFile
            ? (typeof MirageAnchorStore?.leanMetaFromFile === 'function'
                ? MirageAnchorStore.leanMetaFromFile(state.masterFaceFile, 'master-face.jpg')
                : {
                    fileName: state.masterFaceFile.name || 'master-face.jpg',
                    mimeType: state.masterFaceFile.type || 'image/jpeg',
                    size: state.masterFaceFile.size || 0,
                    storage: 'idb'
                })
            : (state.masterFaceBase64
                ? {
                    fileName: state.edf?.VISUAL_ANCHORS?.MASTER_FACE_REF || 'master-face.jpg',
                    mimeType: 'image/jpeg',
                    size: 0,
                    storage: 'idb'
                }
                : null);

        const masterBody = state.masterBodyFile
            ? (typeof MirageAnchorStore?.leanMetaFromFile === 'function'
                ? MirageAnchorStore.leanMetaFromFile(state.masterBodyFile, 'master-body.jpg')
                : {
                    fileName: state.masterBodyFile.name || 'master-body.jpg',
                    mimeType: state.masterBodyFile.type || 'image/jpeg',
                    size: state.masterBodyFile.size || 0,
                    storage: 'idb'
                })
            : (state.masterBodyBase64
                ? {
                    fileName: 'master-body.jpg',
                    mimeType: 'image/jpeg',
                    size: 0,
                    storage: 'idb'
                }
                : null);

        return {
            profile,
            edf: state.edf || null,
            masterFace,
            masterBody,
            mediaLibrary: leanMediaLibrary(state),
            session: {
                protocol: state.session?.protocol ?? null,
                mode: state.session?.mode ?? 'Unset',
                startInstruction: state.session?.startInstruction ?? ''
            }
        };
    }

    function leanMediaLibrary(state) {
        if (Array.isArray(state.mediaLibrary) && state.mediaLibrary.length) {
            return state.mediaLibrary.map(p => ({
                id: p.id,
                fileName: p.fileName || p.file?.name || 'photo.jpg',
                mimeType: p.mimeType || p.file?.type || 'image/jpeg',
                size: p.size || p.file?.size || 0
            }));
        }
        return (state.mediaFiles || [])
            .filter(f => f && String(f.type || '').startsWith('image/'))
            .map(f => ({
                id: null,
                fileName: f.name,
                mimeType: f.type || 'image/jpeg',
                size: f.size || 0
            }));
    }

    function validateSnapshot(snapshot, state) {
        if (!snapshot?.profile?.name?.trim() && !snapshot?.profile?.autoFill?.name) {
            return 'Character needs a name.';
        }
        if (!snapshot?.edf) {
            return 'Character needs a completed forensic scan (EDF).';
        }
        if (!hasUsableFace(snapshot.masterFace, state)) {
            return 'Character needs a locked master face.';
        }
        return null;
    }

    function list() {
        return readStore().profiles
            .slice()
            .sort((a, b) => (b.updatedAt || b.savedAt).localeCompare(a.updatedAt || a.savedAt));
    }

    function get(id) {
        return readStore().profiles.find(p => p.id === id) || null;
    }

    function remove(id) {
        const store = readStore();
        store.profiles = store.profiles.filter(p => p.id !== id);
        writeStore(store);
        try {
            MirageMediaLibrary?.removeCharacter?.(id);
        } catch { /* ignore */ }
        try {
            MirageAnchorStore?.removeCharacter?.(id);
        } catch { /* ignore */ }
    }

    function save({ id, label, snapshot }) {
        const lean = {
            ...snapshot,
            masterFace: stripBase64(snapshot.masterFace),
            masterBody: snapshot.masterBody ? stripBase64(snapshot.masterBody) : null
        };

        const err = validateSnapshot(lean);
        if (err) throw new Error(err);

        const store = readStore();
        const now = new Date().toISOString();
        const displayName = label
            || String(lean.profile.name || '').trim()
            || (lean.profile.autoFill?.name ? 'Auto character' : 'Character');
        const existingIdx = id ? store.profiles.findIndex(p => p.id === id) : -1;

        const entry = {
            id: id || makeId(displayName),
            label: displayName,
            savedAt: existingIdx >= 0 ? store.profiles[existingIdx].savedAt : now,
            updatedAt: now,
            snapshot: lean
        };

        if (existingIdx >= 0) {
            store.profiles[existingIdx] = entry;
        } else {
            store.profiles.push(entry);
        }

        try {
            writeStore(store);
        } catch (e) {
            if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014) {
                throw (typeof MirageUI?.makeStorageQuotaError === 'function'
                    ? MirageUI.makeStorageQuotaError(
                        'Browser storage is full — couldn’t save this character.'
                    )
                    : e);
            }
            throw e;
        }

        return entry;
    }

    /**
     * Persist face/body to IndexedDB, then write a lean localStorage snapshot.
     */
    async function saveWithAnchors({ id, label, snapshot, state }) {
        const err = validateSnapshot(snapshot, state);
        if (err) throw new Error(err);

        const displayName = label || snapshot.profile.name.trim();
        const entryId = id || makeId(displayName);

        let faceMeta = snapshot.masterFace ? stripBase64(snapshot.masterFace) : null;
        let bodyMeta = snapshot.masterBody ? stripBase64(snapshot.masterBody) : null;

        if (typeof MirageAnchorStore?.persistCharacter === 'function') {
            const persisted = await MirageAnchorStore.persistCharacter(entryId, state);
            if (persisted.face) faceMeta = persisted.face;
            if (persisted.body) bodyMeta = persisted.body;
            else if (!state?.masterBodyFile && !state?.masterBodyBase64) bodyMeta = null;
        }

        return save({
            id: entryId,
            label: displayName,
            snapshot: {
                ...snapshot,
                masterFace: faceMeta,
                masterBody: bodyMeta
            }
        });
    }

    function persistLibidoQuietly(id, libido, edf) {
        if (!id || !Number.isFinite(Number(libido))) return;
        try {
            const store = readStore();
            const rec = store.profiles.find(p => p.id === id);
            if (!rec?.snapshot?.profile) return;
            rec.snapshot.profile = { ...rec.snapshot.profile, libido: Math.round(Number(libido)) };
            if (rec.snapshot.edf && typeof rec.snapshot.edf === 'object') {
                if (!rec.snapshot.edf.DYNAMICS || typeof rec.snapshot.edf.DYNAMICS !== 'object') {
                    rec.snapshot.edf.DYNAMICS = {};
                }
                rec.snapshot.edf.DYNAMICS.LIBIDO = rec.snapshot.profile.libido;
            }
            writeStore(store);
        } catch (e) {
            console.warn('[Mirage] libido backfill persist failed', e);
        }
    }

    async function applyToState(state, entry) {
        if (!entry?.snapshot) throw new Error('Invalid character save.');

        const snap = entry.snapshot;
        state.profile = { ...snap.profile };
        // Legacy snapshots stored "Name, 22" in profile.name
        if (state.profile && (state.profile.age == null || state.profile.age === '') && state.profile.name) {
            const raw = String(state.profile.name).trim();
            const m = raw.match(/^(.*?),\s*(?:בת\s*)?(\d{1,2})\s*$/u);
            if (m) {
                state.profile.name = m[1].trim();
                state.profile.age = m[2];
            }
        }
        state.edf = snap.edf ? JSON.parse(JSON.stringify(snap.edf)) : null;

        const hadLibido = Number.isFinite(Number(state.profile?.libido));
        if (typeof MirageLoyaltyUX?.ensureLibido === 'function') {
            MirageLoyaltyUX.ensureLibido(state.profile, state.edf);
        }
        if (!hadLibido && Number.isFinite(Number(state.profile?.libido))) {
            persistLibidoQuietly(entry.id, state.profile.libido, state.edf);
        }

        MirageChatStore?.resetSessionVolatile?.(state);

        state.clearMasterFace();
        state.clearBodyReference?.();

        let faceFile = null;
        let bodyFile = null;
        let migrated = false;
        let nextFace = snap.masterFace ? stripBase64(snap.masterFace) : null;
        let nextBody = snap.masterBody ? stripBase64(snap.masterBody) : null;

        if (snap.masterFace?.base64) {
            faceFile = base64ToFile(
                snap.masterFace.base64,
                snap.masterFace.fileName,
                snap.masterFace.mimeType
            );
            if (typeof MirageAnchorStore?.migrateLegacyAnchor === 'function') {
                nextFace = await MirageAnchorStore.migrateLegacyAnchor(
                    entry.id,
                    'face',
                    snap.masterFace
                );
                migrated = true;
            }
        } else if (typeof MirageAnchorStore?.getAnchorFile === 'function') {
            faceFile = await MirageAnchorStore.getAnchorFile(entry.id, 'face');
        }

        if (snap.masterBody?.base64) {
            bodyFile = base64ToFile(
                snap.masterBody.base64,
                snap.masterBody.fileName,
                snap.masterBody.mimeType
            );
            if (typeof MirageAnchorStore?.migrateLegacyAnchor === 'function') {
                nextBody = await MirageAnchorStore.migrateLegacyAnchor(
                    entry.id,
                    'body',
                    snap.masterBody
                );
                migrated = true;
            }
        } else if (snap.masterBody && typeof MirageAnchorStore?.getAnchorFile === 'function') {
            bodyFile = await MirageAnchorStore.getAnchorFile(entry.id, 'body');
        }

        if (faceFile) {
            state.setMasterFace(faceFile);
            try {
                state.masterFaceBase64 = await MirageAPI.readFileBase64(faceFile);
            } catch {
                state.masterFaceBase64 = null;
            }
        }

        if (bodyFile) {
            state.setBodyReference?.(bodyFile);
            try {
                state.masterBodyBase64 = await MirageAPI.readFileBase64(bodyFile);
            } catch {
                state.masterBodyBase64 = null;
            }
        }

        if (migrated) {
            try {
                save({
                    id: entry.id,
                    label: entry.label,
                    snapshot: {
                        ...snap,
                        masterFace: nextFace,
                        masterBody: nextBody
                    }
                });
            } catch (e) {
                console.warn('[Mirage] Failed to rewrite lean character snapshot after migrate', e);
            }
        }

        if (snap.session) {
            state.session.protocol = snap.session.protocol ?? null;
            state.session.mode = snap.session.mode || 'Unset';
            state.session.startInstruction = snap.session.startInstruction || '';
        }

        if (typeof state.resetSimulationRuntime === 'function') {
            state.resetSimulationRuntime({ keepProtocol: !!snap.session?.protocol });
        } else {
            state.session.persona = 'Standard';
            state.session.outfit = null;
            state.session.env = null;
        }

        state.mediaFiles = [];
        state.mediaLibrary = [];
        state.activeCharacterId = entry.id;
        state.activeCharacterLabel = entry.label;

        if (typeof MirageMediaLibrary?.restoreToState === 'function') {
            try {
                await MirageMediaLibrary.restoreToState(state, entry.id, snap.mediaLibrary || []);
            } catch (e) {
                console.warn('[Mirage] Media library restore failed', e);
            }
        }

        return resolveSetupStep(state);
    }

    /**
     * One-shot: move any leftover face/body base64 out of localStorage into IndexedDB.
     * @returns {Promise<{ migrated: number, freedApproxBytes: number }>}
     */
    async function migrateLegacyAnchorsToIdb() {
        const store = readStore();
        let migrated = 0;
        let freedApproxBytes = 0;
        let dirty = false;

        for (const entry of store.profiles) {
            const snap = entry?.snapshot;
            if (!snap) continue;

            let changed = false;
            let face = snap.masterFace || null;
            let body = snap.masterBody || null;

            if (face?.base64 && typeof MirageAnchorStore?.migrateLegacyAnchor === 'function') {
                freedApproxBytes += String(face.base64).length;
                face = await MirageAnchorStore.migrateLegacyAnchor(entry.id, 'face', face);
                changed = true;
            } else if (face) {
                face = stripBase64(face);
            }

            if (body?.base64 && typeof MirageAnchorStore?.migrateLegacyAnchor === 'function') {
                freedApproxBytes += String(body.base64).length;
                body = await MirageAnchorStore.migrateLegacyAnchor(entry.id, 'body', body);
                changed = true;
            } else if (body) {
                const stripped = stripBase64(body);
                if (body.base64) changed = true;
                body = stripped;
            }

            if (changed) {
                entry.snapshot = { ...snap, masterFace: face, masterBody: body };
                entry.updatedAt = new Date().toISOString();
                migrated++;
                dirty = true;
            }
        }

        if (dirty) {
            try {
                writeStore(store);
            } catch (e) {
                console.warn('[Mirage] Legacy anchor migration write failed', e);
                return { migrated: 0, freedApproxBytes: 0 };
            }
        }

        return { migrated, freedApproxBytes };
    }

    function resolveSetupStep(state) {
        const identityOk = typeof MirageSetupProfile?.identityReady === 'function'
            ? MirageSetupProfile.identityReady(state.profile)
            : !!(state.profile?.name && state.profile?.archetype);
        if (identityOk) {
            return state.session?.protocol ? 4 : 3;
        }
        if (state.masterFaceFile && state.edf) return 3;
        if (state.edf) return 2;
        return 1;
    }

    global.MirageProfileStore = {
        list,
        get,
        save,
        saveWithAnchors,
        remove,
        exportSnapshot,
        validateSnapshot,
        applyToState,
        resolveSetupStep,
        migrateLegacyAnchorsToIdb,
        makeId
    };
})(typeof window !== 'undefined' ? window : globalThis);
