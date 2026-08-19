/**
 * MIRAGE ENGINE v2 — IndexedDB storage for generated images (resume / browser save mode)
 */
(function (global) {
    'use strict';

    const DB_NAME = 'mirage_v2_images';
    const DB_VERSION = 1;
    const STORE = 'images';

    const connection = MirageIDB.createConnection({
        name: DB_NAME,
        version: DB_VERSION,
        upgrade(db) {
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'key' });
            }
        }
    });

    function openDb() {
        return connection.open();
    }

    function dataUrlToBlob(dataUrl) {
        const [header, b64] = dataUrl.split(',');
        const mime = (header.match(/data:([^;]+)/) || [])[1] || 'image/png';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    function extFromMime(mime) {
        const m = String(mime || '').toLowerCase();
        if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
        if (m.includes('webp')) return 'webp';
        return 'png';
    }

    /** Convert a data URL into a File suitable for image reference uploads. */
    function dataUrlToFile(dataUrl, name = 'scene-continuity.jpg') {
        if (!dataUrl?.startsWith('data:')) return null;
        const blob = dataUrlToBlob(dataUrl);
        const ext = extFromMime(blob.type);
        const base = String(name || 'scene-continuity').replace(/\.[^.]+$/, '');
        return new File([blob], `${base}.${ext}`, { type: blob.type || 'image/jpeg' });
    }

    async function saveDataUrl(key, dataUrl) {
        if (!key || !dataUrl?.startsWith('data:')) return null;
        const db = await openDb();
        const blob = dataUrlToBlob(dataUrl);
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();
            tx.objectStore(STORE).put({
                key,
                blob,
                mime: blob.type,
                savedAt: Date.now()
            });
        });
        return key;
    }

    async function getRecord(key) {
        if (!key) return null;
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            tx.onerror = () => reject(tx.error);
            const req = tx.objectStore(STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function getObjectUrl(key) {
        const record = await getRecord(key);
        if (!record?.blob) return null;
        return URL.createObjectURL(record.blob);
    }

    /** Load a stored image as a File (for SCENE continuity refs). */
    async function getFile(key, name = 'scene-continuity.jpg') {
        const record = await getRecord(key);
        if (!record?.blob) return null;
        const mime = record.mime || record.blob.type || 'image/jpeg';
        const ext = extFromMime(mime);
        const base = String(name || 'scene-continuity').replace(/\.[^.]+$/, '');
        return new File([record.blob], `${base}.${ext}`, { type: mime });
    }

    async function remove(key) {
        if (!key) return;
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();
            tx.objectStore(STORE).delete(key);
        });
    }

    async function removeByPrefix(prefix) {
        if (!prefix) return;
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve();
            const store = tx.objectStore(STORE);
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) return;
                if (String(cursor.key).startsWith(prefix)) cursor.delete();
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    function downloadDataUrl(dataUrl, fileName) {
        if (!dataUrl?.startsWith('data:')) return;
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = fileName || 'mirage-image.png';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function slugFilePart(value, fallback = '') {
        const s = String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\p{L}\p{N}_-]+/gu, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40);
        return s || fallback;
    }

    /**
     * Live character name always wins the stem (so switching characters cannot
     * stay stuck on an old auto-filled prefix like "maayan"). Optional downloadPrefix
     * is only an extra tag when it differs from the live name.
     * Trailing stamp is local date_time when the file was saved (avoids overwrites).
     */
    function formatDownloadStamp(d = new Date()) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }

    function buildDownloadName(state, ext = 'png') {
        const liveName = slugFilePart(state?.profile?.name, '');
        const prefix = slugFilePart(state?.downloadPrefix, '');
        const tag = prefix && prefix.toLowerCase() !== liveName.toLowerCase() ? prefix : '';
        const outfit = slugFilePart(state?.session?.outfit, '');
        const stem = [liveName || 'mirage', tag, outfit].filter(Boolean).join('-');
        return `${stem}-${formatDownloadStamp()}.${ext}`;
    }

    function wipeDatabase() {
        connection.reset();
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

    function extFromDataUrl(dataUrl) {
        const mime = (dataUrl.match(/^data:([^;]+)/) || [])[1] || 'image/png';
        return extFromMime(mime);
    }

    global.MirageImageStore = {
        saveDataUrl,
        getObjectUrl,
        getFile,
        dataUrlToFile,
        remove,
        removeByPrefix,
        downloadDataUrl,
        buildDownloadName,
        extFromDataUrl,
        wipeDatabase
    };
})(typeof window !== 'undefined' ? window : globalThis);
