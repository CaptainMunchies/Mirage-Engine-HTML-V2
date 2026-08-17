/**
 * MIRAGE ENGINE v2 — Segment 1: Media ingest + forensic scrape
 */
(function () {
    'use strict';

    const MAX_VIDEOS = 3;
    const MAX_PHOTOS = (typeof MirageMediaLibrary !== 'undefined' && MirageMediaLibrary.MAX_PHOTOS) || 20;
    const MAX_VIDEO_SEC = 30;
    const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
    const MAX_PHOTO_POOL_BYTES = (typeof MirageMediaLibrary !== 'undefined' && MirageMediaLibrary.MAX_PHOTO_POOL_BYTES)
        || (80 * 1024 * 1024);

    const S = () => EngineState;

    let objectUrls = [];

    function revokeObjectUrls() {
        objectUrls.forEach(u => URL.revokeObjectURL(u));
        objectUrls = [];
    }

    function trackObjectUrl(url) {
        objectUrls.push(url);
        return url;
    }

    function countVideos() {
        return S().mediaFiles.filter(f => f.type.startsWith('video/')).length;
    }

    function countPhotos() {
        return S().mediaFiles.filter(f => f.type.startsWith('image/')).length;
    }

    function photoPoolBytes() {
        if (typeof MirageMediaLibrary?.photoPoolBytes === 'function') {
            return MirageMediaLibrary.photoPoolBytes(S().mediaFiles);
        }
        return S().mediaFiles
            .filter(f => f.type.startsWith('image/'))
            .reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    }

    function getVideoDuration(file) {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.onloadedmetadata = () => {
                URL.revokeObjectURL(video.src);
                resolve(video.duration);
            };
            video.onerror = () => {
                URL.revokeObjectURL(video.src);
                reject(new Error('Could not read video metadata'));
            };
            video.src = URL.createObjectURL(file);
        });
    }

    function invalidateEdf() {
        if (S().edf) {
            S().edf = null;
            updateEdfPreview();
            updateContinueButton();
        }
    }

    async function handleMediaFiles(incoming) {
        const files = Array.from(incoming || []);
        if (!files.length) return;

        if (typeof MirageSafetyGates?.confirmMediaUpload === 'function') {
            const ok = await MirageSafetyGates.confirmMediaUpload({ context: 'media' });
            if (!ok) return;
        }

        let videoCount = countVideos();
        let photoCount = countPhotos();
        let added = 0;

        for (const file of files) {
            if (file.type.startsWith('video/')) {
                if (videoCount >= MAX_VIDEOS) {
                    MirageUI.toast(`Video limit reached (max ${MAX_VIDEOS}).`, 'error');
                    continue;
                }
                if (file.size > MAX_VIDEO_BYTES) {
                    MirageUI.toast(`${file.name} exceeds 25 MB.`, 'error');
                    continue;
                }
                try {
                    const duration = await getVideoDuration(file);
                    if (duration > MAX_VIDEO_SEC) {
                        MirageUI.toast(`${file.name} is ${Math.round(duration)}s — max ${MAX_VIDEO_SEC}s.`, 'error');
                        continue;
                    }
                } catch {
                    MirageUI.toast(`Could not read ${file.name}.`, 'error');
                    continue;
                }
                videoCount++;
                S().mediaFiles.push(file);
                added++;
            } else if (file.type.startsWith('image/')) {
                if (photoCount >= MAX_PHOTOS) {
                    MirageUI.toast(`Photo limit reached (max ${MAX_PHOTOS}).`, 'error');
                    continue;
                }
                const nextPool = photoPoolBytes() + (Number(file.size) || 0);
                if (nextPool > MAX_PHOTO_POOL_BYTES) {
                    const cap = typeof MirageMediaLibrary?.formatBytes === 'function'
                        ? MirageMediaLibrary.formatBytes(MAX_PHOTO_POOL_BYTES)
                        : '80 MB';
                    MirageUI.toast(
                        `${file.name} would exceed the photo pool cap (${cap} total).`,
                        'error'
                    );
                    continue;
                }
                photoCount++;
                S().mediaFiles.push(file);
                added++;
            } else {
                MirageUI.toast(`Unsupported file: ${file.name}`, 'error');
            }
        }

        if (added) {
            syncMediaLibraryFromFiles();
            invalidateEdf();
            renderMediaGrid();
        }
    }

    function syncMediaLibraryFromFiles() {
        const photos = typeof MirageMediaLibrary?.listPhotos === 'function'
            ? MirageMediaLibrary.listPhotos(S().mediaFiles)
            : S().mediaFiles.filter(f => f.type.startsWith('image/'));
        const prev = Array.isArray(S().mediaLibrary) ? S().mediaLibrary : [];
        S().mediaLibrary = photos.map(f => {
            const hit = prev.find(p => p.file === f || p.fileName === f.name);
            return {
                id: hit?.id || (typeof MirageMediaLibrary?.makePhotoId === 'function'
                    ? MirageMediaLibrary.makePhotoId(f.name)
                    : f.name),
                fileName: f.name,
                mimeType: f.type || 'image/jpeg',
                size: f.size || 0,
                file: f
            };
        });
    }

    function removeMedia(index) {
        S().mediaFiles.splice(index, 1);
        syncMediaLibraryFromFiles();
        invalidateEdf();
        renderMediaGrid();
    }

    function formatBytes(n) {
        if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    function renderMediaGrid() {
        const container = document.getElementById('uploadedMediaContainer');
        const grid = document.getElementById('mediaGrid');
        const countEl = document.getElementById('mediaCount');
        const ingestBtn = document.getElementById('btnIngestMedia');
        const videoBadge = document.getElementById('videoCountBadge');
        const photoBadge = document.getElementById('photoCountBadge');
        const poolBadge = document.getElementById('photoPoolBadge');

        if (!grid) return;

        revokeObjectUrls();
        grid.innerHTML = '';

        const files = S().mediaFiles;
        const videos = files.filter(f => f.type.startsWith('video/'));
        const photos = files.filter(f => f.type.startsWith('image/'));

        if (countEl) countEl.textContent = String(files.length);
        if (videoBadge) videoBadge.textContent = `${videos.length}/${MAX_VIDEOS} videos`;
        if (photoBadge) photoBadge.textContent = `${photos.length}/${MAX_PHOTOS} photos`;
        if (poolBadge) {
            const used = photoPoolBytes();
            const fmt = typeof MirageMediaLibrary?.formatBytes === 'function'
                ? MirageMediaLibrary.formatBytes
                : formatBytes;
            poolBadge.textContent = `${fmt(used)} / ${fmt(MAX_PHOTO_POOL_BYTES)}`;
        }

        if (container) container.hidden = files.length === 0;

        if (ingestBtn) {
            ingestBtn.disabled = files.length === 0;
        }

        files.forEach((file, index) => {
            const item = document.createElement('div');
            item.className = 'media-item';

            if (file.type.startsWith('image/')) {
                const img = document.createElement('img');
                img.src = trackObjectUrl(URL.createObjectURL(file));
                img.alt = file.name;
                item.appendChild(img);
            } else {
                const icon = document.createElement('div');
                icon.className = 'media-video-icon';
                icon.textContent = '▶';
                item.appendChild(icon);
            }

            const meta = document.createElement('span');
            meta.className = 'media-item-name';
            meta.title = file.name;
            meta.textContent = file.name;
            item.appendChild(meta);

            const size = document.createElement('span');
            size.className = 'media-item-size';
            size.textContent = formatBytes(file.size);
            item.appendChild(size);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'media-remove';
            removeBtn.setAttribute('aria-label', `Remove ${file.name}`);
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeMedia(index);
            });
            item.appendChild(removeBtn);

            grid.appendChild(item);
        });

        updateContinueButton();
    }

    function edfSummary(edf) {
        if (!edf) return '';
        const anchors = edf.VISUAL_ANCHORS || {};
        const outfits = Array.isArray(anchors.OUTFIT_LIBRARY)
            ? anchors.OUTFIT_LIBRARY.length
            : (anchors.OUTFIT_LIBRARY ? Object.keys(anchors.OUTFIT_LIBRARY).length : 0);
        const tattoos = anchors.TATTOO_INDEX?.length ?? 0;
        const envKeys = Object.keys(edf.ENV_ATLAS_TOP_5 || {}).length;
        const assets = Object.keys(edf.ASSET_LIBRARY || {}).length;
        const speech = edf.LINGUISTIC_DNA?.Speech_Pattern || '—';
        return [
            `Outfits indexed: ${outfits}`,
            `Environments: ${envKeys}`,
            `Assets: ${assets}`,
            `Tattoos / marks: ${tattoos}`,
            `Speech pattern: ${speech.slice(0, 80)}${speech.length > 80 ? '…' : ''}`
        ].join(' · ');
    }

    function updateEdfPreview() {
        const card = document.getElementById('edfResultCard');
        const summary = document.getElementById('edfSummary');
        const preview = document.getElementById('edfPreview');

        if (!card) return;

        if (S().edf) {
            card.hidden = false;
            if (summary) summary.textContent = edfSummary(S().edf);
            if (preview) preview.textContent = JSON.stringify(S().edf, null, 2);
        } else {
            card.hidden = true;
            if (preview) preview.textContent = '';
        }
    }

    function updateContinueButton() {
        const btn = document.getElementById('btnContinueFaceLock');
        if (!btn) return;
        btn.disabled = !S().edf;
    }

    async function runForensicScrape() {
        if (!S().activeApiKey()) {
            MirageUI.toast('Configure your API key in Settings first.', 'error');
            return;
        }
        if (!S().mediaFiles.length) {
            MirageUI.toast('Add at least one photo or video.', 'error');
            return;
        }

        const btn = document.getElementById('btnIngestMedia');
        if (btn) btn.disabled = true;

        MirageUI.setLoading(true, 'Running forensic scan — best thinking model…');
        MirageUI.setStatus('ANALYZING', 'busy');

        try {
            const ctx = S().getRuntimeContext();
            const systemInstruction = MiragePrompt.buildThinkingSystemInstruction('forensic', ctx);
            const schemaHint = JSON.stringify(MiragePrompt.EDF_JSON_SCHEMA_HINT, null, 2);
            const setupModel = typeof MirageModels?.bestThinkingModel === 'function'
                ? MirageModels.bestThinkingModel(S().apiProvider)
                : S().thinkingModel;

            const userParts = [{
                text: [
                    'Analyze ALL attached reference images and videos.',
                    'Build the complete Entity Definition File (EDF).',
                    'Match this JSON schema exactly:',
                    schemaHint
                ].join('\n\n')
            }];

            for (const file of S().mediaFiles) {
                userParts.push(await MirageAPI.fileToInlinePart(file));
            }

            const raw = await MirageAPI.thinkingGenerate({
                apiKey: S().activeApiKey(),
                model: setupModel,
                systemInstruction,
                userParts,
                jsonMode: true
            });

            S().edf = MirageAPI.parseJsonResponse(raw);
            if (typeof MirageLoyaltyUX?.ensureLibido === 'function') {
                MirageLoyaltyUX.ensureLibido(S().profile, S().edf);
            }
            if (typeof MirageMediaLibrary?.linkOutfitLibraryToMedia === 'function') {
                MirageMediaLibrary.linkOutfitLibraryToMedia(S().edf, S().mediaFiles);
            }
            syncMediaLibraryFromFiles();
            updateEdfPreview();
            updateContinueButton();

            MirageUI.setStatus('EDF READY', 'active');
            MirageUI.toast('Photo scan complete.', 'success', 6000);
        } catch (err) {
            MirageUI.setStatus('SCAN FAILED', 'error');
            MirageUI.toast(err.message || 'Photo scan failed.', 'error', 8000);
        } finally {
            MirageUI.setLoading(false);
            if (btn) btn.disabled = S().mediaFiles.length === 0;
        }
    }

    function bindMediaStep() {
        const dropzone = document.getElementById('mediaDropzone');
        const input = document.getElementById('mediaInput');
        const ingestBtn = document.getElementById('btnIngestMedia');
        const continueBtn = document.getElementById('btnContinueFaceLock');
        const toggleEdf = document.getElementById('btnToggleEdfRaw');

        if (!dropzone || !input) return;

        dropzone.addEventListener('click', () => input.click());
        input.addEventListener('change', (e) => {
            handleMediaFiles(e.target.files);
            input.value = '';
        });

        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('drag-over');
        });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('drag-over');
            handleMediaFiles(e.dataTransfer.files);
        });

        ingestBtn?.addEventListener('click', runForensicScrape);

        continueBtn?.addEventListener('click', () => {
            if (!S().edf) return;
            window.MirageApp?.goToSetupStep(2);
        });

        toggleEdf?.addEventListener('click', () => {
            const pre = document.getElementById('edfPreview');
            if (pre) pre.hidden = !pre.hidden;
        });

        renderMediaGrid();
        updateEdfPreview();
    }

    window.MirageSetupMedia = { bindMediaStep, runForensicScrape, refresh: () => { renderMediaGrid(); updateEdfPreview(); updateContinueButton(); } };
})();
