/**
 * MIRAGE ENGINE v2 — Export / import / backup
 *
 * Everything a character is lives across five stores: the profile record in
 * localStorage, its chats in localStorage, its face/body anchors in one IndexedDB
 * database, its photo library in a second, and its generated turn images in a third.
 * Until this module there was no way to get any of it out — one "Clear site data",
 * one profile reset, one browser reinstall and a character built through a five-step
 * wizard plus a photo ingest was gone permanently.
 *
 * A bundle is a single self-contained JSON file (.mirage). Blobs ride as base64,
 * which makes the file large but means it needs no library to read and no build step
 * to produce — the same constraints the rest of the engine works under.
 *
 * Import always MERGES. It never replaces a character that is already present: a
 * collision creates a new id and keeps both. That is deliberate — a restore should
 * not be able to destroy work the way the legacy chat migration used to.
 */
(function (global) {
    'use strict';

    const FORMAT = 'mirage-engine-backup';
    const FORMAT_VERSION = 1;

    const S = () => global.EngineState;

    // ---------------------------------------------------------------- helpers

    function nowIso() {
        return new Date().toISOString();
    }

    function safeName(text, fallback) {
        const cleaned = String(text || '')
            .normalize('NFKD')
            .replace(/[^\w\-. ]+/g, '')
            .trim()
            .replace(/\s+/g, '-');
        return cleaned || fallback;
    }

    /** Blob → base64 (no data: prefix). */
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error || new Error('Could not read blob'));
            reader.onload = () => {
                const result = String(reader.result || '');
                const comma = result.indexOf(',');
                resolve(comma >= 0 ? result.slice(comma + 1) : result);
            };
            reader.readAsDataURL(blob);
        });
    }

    function base64ToBlob(base64, mimeType) {
        const bin = atob(String(base64 || ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
    }

    function base64ToDataUrl(base64, mimeType) {
        return `data:${mimeType || 'image/png'};base64,${base64}`;
    }

    async function dataUrlToParts(dataUrl) {
        const raw = String(dataUrl || '');
        const match = raw.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
        if (!match) return null;
        const mimeType = match[1] || 'image/png';
        if (match[2]) return { mimeType, base64: match[3] };
        // Rare, but a non-base64 data URL still has to survive the round trip.
        return { mimeType, base64: btoa(unescape(encodeURIComponent(decodeURIComponent(match[3])))) };
    }

    // ---------------------------------------------------------------- export

    async function collectAnchors(characterId) {
        const out = {};
        for (const kind of ['face', 'body']) {
            let rec = null;
            try {
                rec = await MirageAnchorStore?.getAnchorRecord?.(characterId, kind);
            } catch (err) {
                console.warn(`[Mirage] Could not read ${kind} anchor for ${characterId}`, err);
            }
            if (!rec?.blob) continue;
            out[kind] = {
                fileName: rec.fileName || `master-${kind}.jpg`,
                mimeType: rec.mimeType || 'image/jpeg',
                size: rec.size || rec.blob.size || 0,
                base64: await blobToBase64(rec.blob)
            };
        }
        return out;
    }

    async function collectPhotos(characterId) {
        let records = [];
        try {
            records = await MirageMediaLibrary?.listByCharacter?.(characterId) || [];
        } catch (err) {
            console.warn(`[Mirage] Could not read photo library for ${characterId}`, err);
            return [];
        }
        const out = [];
        for (const rec of records) {
            if (!rec?.blob) continue;
            out.push({
                id: rec.id,
                fileName: rec.fileName || 'photo.jpg',
                mimeType: rec.mimeType || 'image/jpeg',
                size: rec.size || rec.blob.size || 0,
                base64: await blobToBase64(rec.blob)
            });
        }
        return out;
    }

    /** Every image key a chat's turns reference, in one flat list. */
    function imageKeysForChat(chat) {
        const keys = [];
        const push = (k) => { if (k && !keys.includes(k)) keys.push(k); };
        push(chat?.lastTurn?.imageKey);
        (Array.isArray(chat?.turnImages) ? chat.turnImages : []).forEach(t => push(t?.imageKey));
        (Array.isArray(chat?.history) ? chat.history : []).forEach(h => push(h?.imageKey));
        return keys;
    }

    async function collectTurnImages(chats) {
        const images = {};
        for (const chat of chats) {
            for (const key of imageKeysForChat(chat)) {
                if (images[key]) continue;
                try {
                    const file = await MirageImageStore?.getFile?.(key);
                    if (!file) continue;
                    images[key] = {
                        mimeType: file.type || 'image/png',
                        base64: await blobToBase64(file)
                    };
                } catch (err) {
                    console.warn(`[Mirage] Could not read turn image ${key}`, err);
                }
            }
        }
        return images;
    }

    /**
     * Build one character's portion of a bundle.
     * @param {string} characterId
     * @param {{includeChats?: boolean, includePhotos?: boolean, includeTurnImages?: boolean}} opts
     */
    async function buildCharacterBundle(characterId, opts = {}) {
        const includeChats = opts.includeChats !== false;
        const includePhotos = opts.includePhotos !== false;
        const includeTurnImages = opts.includeTurnImages !== false;

        const entry = MirageProfileStore?.get?.(characterId);
        if (!entry) throw new Error(`Character ${characterId} not found`);

        const chats = includeChats
            ? (MirageChatStore?.listChats?.(characterId) || [])
            : [];

        return {
            id: entry.id,
            label: entry.label,
            savedAt: entry.savedAt || null,
            updatedAt: entry.updatedAt || null,
            snapshot: entry.snapshot,
            anchors: await collectAnchors(characterId),
            photos: includePhotos ? await collectPhotos(characterId) : [],
            chats,
            turnImages: includeTurnImages ? await collectTurnImages(chats) : {}
        };
    }

    /**
     * @param {string[]|null} characterIds  null exports every saved character.
     */
    async function buildBundle(characterIds, opts = {}) {
        const all = MirageProfileStore?.list?.() || [];
        const ids = Array.isArray(characterIds) && characterIds.length
            ? characterIds
            : all.map(e => e.id);

        const characters = [];
        for (const id of ids) {
            characters.push(await buildCharacterBundle(id, opts));
        }

        return {
            format: FORMAT,
            formatVersion: FORMAT_VERSION,
            exportedAt: nowIso(),
            // Deliberately excludes mirage_v2_config: it holds both API keys, and a
            // backup file is the last place they should travel.
            userProfiles: opts.includeUserProfiles === false
                ? null
                : (MirageUserProfiles?.exportAll?.() || null),
            characters
        };
    }

    function downloadJson(obj, fileName) {
        const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return blob.size;
    }

    async function exportCharacter(characterId, opts = {}) {
        const bundle = await buildBundle([characterId], opts);
        const label = bundle.characters[0]?.label || 'character';
        const stamp = nowIso().slice(0, 10);
        const size = downloadJson(bundle, `mirage-${safeName(label, 'character')}-${stamp}.mirage`);
        return { characters: 1, bytes: size };
    }

    async function exportEverything(opts = {}) {
        const bundle = await buildBundle(null, opts);
        const stamp = nowIso().slice(0, 10);
        const size = downloadJson(bundle, `mirage-backup-${stamp}.mirage`);
        return { characters: bundle.characters.length, bytes: size };
    }

    // ---------------------------------------------------------------- import

    function validateBundle(data) {
        if (!data || typeof data !== 'object') return 'That file is not a Mirage backup.';
        if (data.format !== FORMAT) return 'That file is not a Mirage backup.';
        const version = Number(data.formatVersion);
        if (!Number.isFinite(version) || version < 1) return 'Backup file has no usable version.';
        if (version > FORMAT_VERSION) {
            return `Backup was made by a newer version of Mirage (format ${version}). Update first.`;
        }
        if (!Array.isArray(data.characters)) return 'Backup contains no characters.';
        return null;
    }

    function existingIds() {
        return new Set((MirageProfileStore?.list?.() || []).map(e => e.id));
    }

    function uniqueLabel(label, taken) {
        const base = String(label || 'Imported character').trim() || 'Imported character';
        if (!taken.has(base)) return base;
        for (let n = 2; n < 500; n++) {
            const candidate = `${base} (${n})`;
            if (!taken.has(candidate)) return candidate;
        }
        return `${base} (${Date.now()})`;
    }

    function anchorToFile(anchor, kind) {
        if (!anchor?.base64) return null;
        return new File(
            [base64ToBlob(anchor.base64, anchor.mimeType)],
            anchor.fileName || `master-${kind}.jpg`,
            { type: anchor.mimeType || 'image/jpeg' }
        );
    }

    /**
     * One call with both anchors, not one per kind: persistCharacter removes whichever
     * anchor its state argument lacks, so writing them separately would delete the
     * first one while writing the second.
     */
    async function restoreAnchors(characterId, anchors) {
        if (!anchors || typeof anchors !== 'object') return;
        const face = anchorToFile(anchors.face, 'face');
        const body = anchorToFile(anchors.body, 'body');
        if (!face && !body) return;
        return MirageAnchorStore.persistCharacter(characterId, {
            masterFaceFile: face,
            masterBodyFile: body,
            masterFaceBase64: null,
            masterBodyBase64: null,
            edf: null
        });
    }

    async function restorePhotos(characterId, photos) {
        const list = Array.isArray(photos) ? photos : [];
        if (!list.length) return [];
        const files = list.map(p => new File(
            [base64ToBlob(p.base64, p.mimeType)],
            p.fileName || 'photo.jpg',
            { type: p.mimeType || 'image/jpeg' }
        ));
        return MirageMediaLibrary.savePhotosFromMediaFiles(characterId, files);
    }

    async function restoreTurnImages(turnImages, keyMap) {
        const entries = Object.entries(turnImages || {});
        for (const [oldKey, img] of entries) {
            if (!img?.base64) continue;
            const newKey = keyMap[oldKey] || oldKey;
            try {
                await MirageImageStore.saveDataUrl(newKey, base64ToDataUrl(img.base64, img.mimeType));
            } catch (err) {
                console.warn(`[Mirage] Could not restore turn image ${newKey}`, err);
            }
        }
    }

    /** Rewrite a chat's image keys onto the new character id. */
    function remapChatImageKeys(chat, oldId, newId, keyMap) {
        if (oldId === newId) return chat;
        const remap = (key) => {
            if (!key) return key;
            if (!key.startsWith(`${oldId}:`) && !key.includes(oldId)) return key;
            const next = key.split(oldId).join(newId);
            keyMap[key] = next;
            return next;
        };
        const next = { ...chat };
        if (next.lastTurn?.imageKey) {
            next.lastTurn = { ...next.lastTurn, imageKey: remap(next.lastTurn.imageKey) };
        }
        if (Array.isArray(next.turnImages)) {
            next.turnImages = next.turnImages.map(t => (
                t?.imageKey ? { ...t, imageKey: remap(t.imageKey) } : t
            ));
        }
        if (Array.isArray(next.history)) {
            next.history = next.history.map(h => (
                h?.imageKey ? { ...h, imageKey: remap(h.imageKey) } : h
            ));
        }
        return next;
    }

    /**
     * Merge a bundle into the library. Never overwrites: a character whose id is
     * already present is imported under a fresh id, so both survive.
     */
    async function importBundle(data, { onProgress } = {}) {
        const problem = validateBundle(data);
        if (problem) throw new Error(problem);

        const taken = existingIds();
        const labels = new Set((MirageProfileStore?.list?.() || []).map(e => e.label));
        const result = { imported: 0, renamed: 0, chats: 0, photos: 0, images: 0, skipped: [] };

        for (const char of data.characters) {
            if (!char?.snapshot) {
                result.skipped.push(char?.label || char?.id || 'unnamed character');
                continue;
            }

            const oldId = char.id;
            let newId = oldId;
            let label = char.label || 'Imported character';
            if (!newId || taken.has(newId)) {
                newId = MirageProfileStore.makeId();
                label = uniqueLabel(label, labels);
                result.renamed += 1;
            }
            taken.add(newId);
            labels.add(label);

            onProgress?.(`Importing ${label}…`);

            // Blobs first, then the record that points at them: if a restore dies
            // halfway it leaves orphaned blobs (harmless, cleaned on delete) rather
            // than a character whose face lock is missing.
            await restoreAnchors(newId, char.anchors);
            MirageProfileStore.save({ id: newId, label, snapshot: char.snapshot });

            const photoMeta = await restorePhotos(newId, char.photos);
            result.photos += photoMeta.length;

            const keyMap = {};
            const chats = (Array.isArray(char.chats) ? char.chats : [])
                .map(chat => remapChatImageKeys(chat, oldId, newId, keyMap));
            if (chats.length) {
                MirageChatStore.importChats(newId, chats);
                result.chats += chats.length;
            }

            const imageCount = Object.keys(char.turnImages || {}).length;
            await restoreTurnImages(char.turnImages, keyMap);
            result.images += imageCount;

            result.imported += 1;
        }

        if (data.userProfiles && typeof MirageUserProfiles?.importAll === 'function') {
            try {
                MirageUserProfiles.importAll(data.userProfiles);
            } catch (err) {
                console.warn('[Mirage] User profile import failed', err);
            }
        }

        return result;
    }

    async function importFromFile(file, opts = {}) {
        const text = await file.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error('That file is not valid JSON — it may be corrupted or not a Mirage backup.');
        }
        return importBundle(data, opts);
    }

    /** Rough size estimate so the UI can warn before producing a 200 MB file. */
    async function estimateBundleBytes(characterIds) {
        const all = MirageProfileStore?.list?.() || [];
        const ids = Array.isArray(characterIds) && characterIds.length
            ? characterIds
            : all.map(e => e.id);
        let bytes = 0;
        for (const id of ids) {
            try {
                for (const rec of (await MirageMediaLibrary?.listByCharacter?.(id)) || []) {
                    bytes += rec?.size || rec?.blob?.size || 0;
                }
                for (const kind of ['face', 'body']) {
                    const rec = await MirageAnchorStore?.getAnchorRecord?.(id, kind);
                    bytes += rec?.size || rec?.blob?.size || 0;
                }
            } catch { /* estimate only */ }
        }
        // base64 inflates by ~4/3, plus JSON overhead.
        return Math.round(bytes * 1.37);
    }

    global.MirageBackup = {
        FORMAT,
        FORMAT_VERSION,
        buildBundle,
        exportCharacter,
        exportEverything,
        validateBundle,
        importBundle,
        importFromFile,
        estimateBundleBytes,
        // exposed for tests / reuse
        blobToBase64,
        base64ToBlob,
        dataUrlToParts
    };
})(typeof window !== 'undefined' ? window : globalThis);
