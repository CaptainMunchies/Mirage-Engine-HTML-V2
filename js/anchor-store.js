/**
 * MIRAGE ENGINE v2 — Master face / body anchors in IndexedDB
 *
 * Keeps large identity images out of localStorage (~5 MB origin cap).
 * Character snapshots store lean metadata only; blobs live here.
 */
(function (global) {
    'use strict';

    const DB_NAME = 'mirage_v2_anchors';
    const DB_VERSION = 1;
    const STORE = 'anchors';

    let dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(req.error);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'key' });
                    store.createIndex('characterId', 'characterId', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
        return dbPromise;
    }

    function anchorKey(characterId, kind) {
        return `char-${characterId}-${kind}`;
    }

    function base64ToBlob(base64, mimeType) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mimeType || 'image/jpeg' });
    }

    async function putAnchor(characterId, kind, { fileName, mimeType, blob, size }) {
        if (!characterId || !kind || !blob) return null;
        const db = await openDb();
        const key = anchorKey(characterId, kind);
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();
            tx.objectStore(STORE).put({
                key,
                characterId,
                kind,
                fileName: fileName || `${kind}.jpg`,
                mimeType: mimeType || blob.type || 'image/jpeg',
                size: size || blob.size || 0,
                blob,
                savedAt: Date.now()
            });
        });
        return key;
    }

    async function getAnchorRecord(characterId, kind) {
        if (!characterId || !kind) return null;
        const db = await openDb();
        const key = anchorKey(characterId, kind);
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            tx.onerror = () => reject(tx.error);
            const req = tx.objectStore(STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function getAnchorFile(characterId, kind) {
        const rec = await getAnchorRecord(characterId, kind);
        if (!rec?.blob) return null;
        return new File(
            [rec.blob],
            rec.fileName || `${kind}.jpg`,
            { type: rec.mimeType || rec.blob.type || 'image/jpeg' }
        );
    }

    async function removeAnchor(characterId, kind) {
        if (!characterId || !kind) return;
        const db = await openDb();
        const key = anchorKey(characterId, kind);
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();
            tx.objectStore(STORE).delete(key);
        });
    }

    async function removeCharacter(characterId) {
        if (!characterId) return;
        const db = await openDb();
        const rows = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            tx.onerror = () => reject(tx.error);
            const idx = tx.objectStore(STORE).index('characterId');
            const req = idx.getAll(characterId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        if (!rows.length) return;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();
            const store = tx.objectStore(STORE);
            rows.forEach(row => store.delete(row.key));
        });
    }

    function leanMetaFromFile(file, fallbackName) {
        if (!file) return null;
        return {
            fileName: file.name || fallbackName || 'anchor.jpg',
            mimeType: file.type || 'image/jpeg',
            size: file.size || 0,
            storage: 'idb'
        };
    }

    function leanMetaFromLegacy(anchor, fallbackName) {
        if (!anchor) return null;
        return {
            fileName: anchor.fileName || fallbackName || 'anchor.jpg',
            mimeType: anchor.mimeType || 'image/jpeg',
            size: Number(anchor.size) || 0,
            storage: 'idb'
        };
    }

    /**
     * Persist current in-memory face/body Files (or legacy base64) for a character.
     */
    async function persistCharacter(characterId, state) {
        if (!characterId || !state) return { face: null, body: null };

        let faceMeta = null;
        let bodyMeta = null;

        if (state.masterFaceFile) {
            await putAnchor(characterId, 'face', {
                fileName: state.masterFaceFile.name,
                mimeType: state.masterFaceFile.type || 'image/jpeg',
                blob: state.masterFaceFile,
                size: state.masterFaceFile.size || 0
            });
            faceMeta = leanMetaFromFile(state.masterFaceFile, 'master-face.jpg');
        } else if (state.masterFaceBase64) {
            const mime = 'image/jpeg';
            const blob = base64ToBlob(state.masterFaceBase64, mime);
            const fileName = state.edf?.VISUAL_ANCHORS?.MASTER_FACE_REF || 'master-face.jpg';
            await putAnchor(characterId, 'face', {
                fileName,
                mimeType: mime,
                blob,
                size: blob.size
            });
            faceMeta = { fileName, mimeType: mime, size: blob.size, storage: 'idb' };
        } else {
            await removeAnchor(characterId, 'face');
        }

        if (state.masterBodyFile) {
            await putAnchor(characterId, 'body', {
                fileName: state.masterBodyFile.name,
                mimeType: state.masterBodyFile.type || 'image/jpeg',
                blob: state.masterBodyFile,
                size: state.masterBodyFile.size || 0
            });
            bodyMeta = leanMetaFromFile(state.masterBodyFile, 'master-body.jpg');
        } else if (state.masterBodyBase64) {
            const mime = 'image/jpeg';
            const blob = base64ToBlob(state.masterBodyBase64, mime);
            const fileName = 'master-body.jpg';
            await putAnchor(characterId, 'body', {
                fileName,
                mimeType: mime,
                blob,
                size: blob.size
            });
            bodyMeta = { fileName, mimeType: mime, size: blob.size, storage: 'idb' };
        } else {
            await removeAnchor(characterId, 'body');
        }

        return { face: faceMeta, body: bodyMeta };
    }

    /**
     * Migrate a legacy snapshot anchor (base64) into IDB and return lean meta.
     */
    async function migrateLegacyAnchor(characterId, kind, legacy) {
        if (!characterId || !legacy?.base64) return leanMetaFromLegacy(legacy, `${kind}.jpg`);
        const mime = legacy.mimeType || 'image/jpeg';
        const blob = base64ToBlob(legacy.base64, mime);
        const fileName = legacy.fileName || `master-${kind}.jpg`;
        await putAnchor(characterId, kind, {
            fileName,
            mimeType: mime,
            blob,
            size: blob.size
        });
        return {
            fileName,
            mimeType: mime,
            size: blob.size,
            storage: 'idb'
        };
    }

    function wipeDatabase() {
        dbPromise = null;
        return new Promise((resolve) => {
            try {
                const req = indexedDB.deleteDatabase(DB_NAME);
                req.onsuccess = () => resolve(true);
                req.onerror = () => resolve(false);
                req.onblocked = () => resolve(false);
            } catch {
                resolve(false);
            }
        });
    }

    global.MirageAnchorStore = {
        persistCharacter,
        getAnchorFile,
        getAnchorRecord,
        removeCharacter,
        removeAnchor,
        migrateLegacyAnchor,
        leanMetaFromFile,
        leanMetaFromLegacy,
        wipeDatabase
    };
})(typeof window !== 'undefined' ? window : globalThis);
