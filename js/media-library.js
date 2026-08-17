/**
 * MIRAGE ENGINE v2 — Persisted photo reference library (IndexedDB)
 *
 * Photos only (no videos). Blobs live in IDB; character snapshot keeps lean metadata.
 * Used to re-send wardrobe/outfit stills when tracking.outfit matches the library.
 */
(function (global) {
    'use strict';

    const DB_NAME = 'mirage_v2_media_library';
    const DB_VERSION = 1;
    const STORE = 'photos';

    /** Hard caps for the ingest photo pool (videos stay separate / ephemeral). */
    const MAX_PHOTOS = 20;
    const MAX_PHOTO_POOL_BYTES = 80 * 1024 * 1024; // 80 MB total

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

    function photoKey(characterId, photoId) {
        return `char-${characterId}-photo-${photoId}`;
    }

    function makePhotoId(fileName) {
        const slug = String(fileName || 'photo')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 32) || 'photo';
        return `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    }

    function formatBytes(n) {
        const v = Number(n) || 0;
        if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
        return `${(v / (1024 * 1024)).toFixed(1)} MB`;
    }

    function photoPoolBytes(files) {
        return (files || [])
            .filter(f => f && String(f.type || '').startsWith('image/'))
            .reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    }

    function listPhotos(files) {
        return (files || []).filter(f => f && String(f.type || '').startsWith('image/'));
    }

    async function putPhoto(characterId, { id, fileName, mimeType, blob, size }) {
        if (!characterId || !id || !blob) return null;
        const db = await openDb();
        const key = photoKey(characterId, id);
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();
            tx.objectStore(STORE).put({
                key,
                characterId,
                id,
                fileName: fileName || 'photo.jpg',
                mimeType: mimeType || blob.type || 'image/jpeg',
                size: size || blob.size || 0,
                blob,
                savedAt: Date.now()
            });
        });
        return key;
    }

    async function getPhotoRecord(characterId, photoId) {
        if (!characterId || !photoId) return null;
        const db = await openDb();
        const key = photoKey(characterId, photoId);
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            tx.onerror = () => reject(tx.error);
            const req = tx.objectStore(STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function getPhotoFile(characterId, photoId) {
        const rec = await getPhotoRecord(characterId, photoId);
        if (!rec?.blob) return null;
        return new File(
            [rec.blob],
            rec.fileName || 'photo.jpg',
            { type: rec.mimeType || rec.blob.type || 'image/jpeg' }
        );
    }

    async function listByCharacter(characterId) {
        if (!characterId) return [];
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            tx.onerror = () => reject(tx.error);
            const idx = tx.objectStore(STORE).index('characterId');
            const req = idx.getAll(characterId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async function removeCharacter(characterId) {
        if (!characterId) return;
        const rows = await listByCharacter(characterId);
        if (!rows.length) return;
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();
            const store = tx.objectStore(STORE);
            rows.forEach(row => store.delete(row.key));
        });
    }

    /**
     * Persist current image mediaFiles for a character. Replaces prior library for that id.
     * @returns {Promise<Array<{id, fileName, mimeType, size}>>}
     */
    async function savePhotosFromMediaFiles(characterId, mediaFiles) {
        if (!characterId) return [];
        await removeCharacter(characterId);
        const photos = listPhotos(mediaFiles);
        const meta = [];
        for (const file of photos) {
            const id = makePhotoId(file.name);
            await putPhoto(characterId, {
                id,
                fileName: file.name,
                mimeType: file.type || 'image/jpeg',
                blob: file,
                size: file.size || 0
            });
            meta.push({
                id,
                fileName: file.name,
                mimeType: file.type || 'image/jpeg',
                size: file.size || 0
            });
        }
        return meta;
    }

    /**
     * Restore Files into EngineState.mediaFiles (photos only) + in-memory library map.
     */
    async function restoreToState(state, characterId, metaList) {
        if (!state) return [];
        const meta = Array.isArray(metaList) ? metaList : [];
        const restored = [];
        const files = [];

        for (const item of meta) {
            let file = null;
            try {
                file = await getPhotoFile(characterId, item.id);
            } catch { /* ignore */ }
            if (!file && item.fileName) {
                // Fallback: scan IDB by filename if id drifted
                const rows = await listByCharacter(characterId);
                const hit = rows.find(r => r.fileName === item.fileName);
                if (hit?.blob) {
                    file = new File(
                        [hit.blob],
                        hit.fileName || item.fileName,
                        { type: hit.mimeType || 'image/jpeg' }
                    );
                    item.id = hit.id;
                }
            }
            if (!file) continue;
            files.push(file);
            restored.push({
                id: item.id,
                fileName: file.name,
                mimeType: file.type,
                size: file.size,
                file
            });
        }

        // Keep any existing non-image (shouldn't happen) out; restore photos for face picker
        const videos = (state.mediaFiles || []).filter(f => String(f.type || '').startsWith('video/'));
        state.mediaFiles = [...files, ...videos];
        state.mediaLibrary = restored;
        return restored;
    }

    /**
     * Find a File for an outfit label using EDF OUTFIT_LIBRARY sourceFile + media library.
     */
    function resolveOutfitPhoto(state, outfitLabel) {
        const label = String(outfitLabel || '').trim();
        if (!label) return null;

        const edf = state?.edf;
        const lib = edf?.VISUAL_ANCHORS?.OUTFIT_LIBRARY;
        const entry = typeof MiragePrompt?.findOutfitLibraryEntry === 'function'
            ? MiragePrompt.findOutfitLibraryEntry(lib, label)
            : null;

        const sourceFile = entry
            ? String(entry.sourceFile || entry.SourceFile || entry.Ref_Pointer || entry.source || '').trim()
            : '';

        const pool = Array.isArray(state.mediaLibrary) && state.mediaLibrary.length
            ? state.mediaLibrary
            : listPhotos(state.mediaFiles).map(f => ({ fileName: f.name, file: f }));

        if (sourceFile) {
            const hit = pool.find(p => {
                const name = p.fileName || p.file?.name || '';
                return name === sourceFile
                    || name.toLowerCase() === sourceFile.toLowerCase()
                    || name.includes(sourceFile)
                    || sourceFile.includes(name);
            });
            if (hit?.file) return hit.file;
        }

        // Soft fallback: label text mentions a photo filename in the pool
        const lower = label.toLowerCase();
        for (const p of pool) {
            const name = p.fileName || p.file?.name || '';
            if (name && lower.includes(name.toLowerCase()) && p.file) return p.file;
        }
        return null;
    }

    /**
     * Normalize OUTFIT_LIBRARY so each entry is an object with Label + sourceFile when possible.
     */
    function linkOutfitLibraryToMedia(edf, mediaFiles) {
        if (!edf?.VISUAL_ANCHORS) return edf;
        const photos = listPhotos(mediaFiles);
        const names = photos.map(f => f.name);
        const raw = edf.VISUAL_ANCHORS.OUTFIT_LIBRARY;
        if (!raw) return edf;

        const list = Array.isArray(raw)
            ? raw
            : (typeof raw === 'object'
                ? Object.entries(raw).map(([k, v]) => (typeof v === 'object' ? { Label: k, ...v } : { Label: k, Description: String(v) }))
                : [{ Label: String(raw) }]);

        edf.VISUAL_ANCHORS.OUTFIT_LIBRARY = list.map(entry => {
            let obj;
            if (typeof entry === 'string') {
                obj = { Label: entry.trim() };
            } else if (entry && typeof entry === 'object') {
                obj = { ...entry };
                if (!obj.Label && !obj.label && !obj.Style_Label && !obj.Name) {
                    obj.Label = MiragePrompt?.entryLabel?.(entry) || 'Outfit';
                }
            } else {
                obj = { Label: String(entry ?? 'Outfit') };
            }

            let source = String(obj.sourceFile || obj.SourceFile || obj.Ref_Pointer || '').trim();
            if (!source || !names.some(n => n === source || n.toLowerCase() === source.toLowerCase())) {
                const blob = JSON.stringify(obj).toLowerCase();
                const hit = names.find(n => blob.includes(n.toLowerCase()));
                if (hit) source = hit;
            }
            if (source) obj.sourceFile = source;
            return obj;
        });

        return edf;
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

    global.MirageMediaLibrary = {
        MAX_PHOTOS,
        MAX_PHOTO_POOL_BYTES,
        formatBytes,
        photoPoolBytes,
        listPhotos,
        makePhotoId,
        savePhotosFromMediaFiles,
        restoreToState,
        removeCharacter,
        resolveOutfitPhoto,
        linkOutfitLibraryToMedia,
        getPhotoFile,
        listByCharacter,
        wipeDatabase
    };
})(typeof window !== 'undefined' ? window : globalThis);
