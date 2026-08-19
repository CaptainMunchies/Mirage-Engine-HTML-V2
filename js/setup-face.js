/**
 * MIRAGE ENGINE v2 — Segment 2: Master face selection & lock
 */
(function () {
    'use strict';

    const S = () => EngineState;

    let gridUrls = [];
    let bodyGridUrls = [];
    let selectedSource = null; // 'media' | 'dedicated'
    let selectedFile = null;
    let dedicatedFile = null;
    let dedicatedUrl = null;

    function revokeGridUrls() {
        gridUrls.forEach(u => URL.revokeObjectURL(u));
        gridUrls = [];
    }

    function revokeBodyGridUrls() {
        bodyGridUrls.forEach(u => URL.revokeObjectURL(u));
        bodyGridUrls = [];
    }

    function trackBodyGridUrl(url) {
        bodyGridUrls.push(url);
        return url;
    }

    function resetDedicatedPreviewUi() {
        const preview = document.getElementById('dedicatedFacePreview');
        const img = document.getElementById('dedicatedFaceImg');
        const name = document.getElementById('dedicatedFaceName');

        if (img) img.removeAttribute('src');
        if (name) name.textContent = '';
        if (preview) preview.hidden = true;
    }

    function clearDedicated() {
        if (dedicatedUrl) URL.revokeObjectURL(dedicatedUrl);
        dedicatedFile = null;
        dedicatedUrl = null;
        resetDedicatedPreviewUi();
    }

    function clearFaceSelection() {
        const wasLocked = !!S().masterFaceFile;

        if (wasLocked) {
            S().clearMasterFace();
            if (S().edf?.VISUAL_ANCHORS) {
                S().edf.VISUAL_ANCHORS.MASTER_FACE_REF = '';
            }
            MirageUI.setStatus('FACE LOCK STANDBY', 'idle');
            updateContinueButton();
        }

        if (selectedSource === 'dedicated') {
            clearDedicated();
        }

        selectedFile = null;
        selectedSource = null;
        document.querySelectorAll('.face-option.selected').forEach(el => el.classList.remove('selected'));
        updateSelectionPreview();
        updateLockButton();
    }

    function clearDedicatedSelection() {
        clearDedicated();
        if (selectedSource === 'dedicated') {
            selectedFile = null;
            selectedSource = null;
            document.querySelectorAll('.face-option.selected').forEach(el => el.classList.remove('selected'));
        }
        if (S().masterFaceFile && !selectedFile) {
            S().clearMasterFace();
            if (S().edf?.VISUAL_ANCHORS) S().edf.VISUAL_ANCHORS.MASTER_FACE_REF = '';
            MirageUI.setStatus('FACE LOCK STANDBY', 'idle');
            updateContinueButton();
        }
        updateSelectionPreview();
        updateLockButton();
    }

    function getImageFiles() {
        return S().mediaFiles.filter(f => f.type.startsWith('image/'));
    }

    function updateLockButton() {
        const lockBtn = document.getElementById('btnLockMasterFace');
        if (lockBtn) lockBtn.disabled = !selectedFile || !!S().masterFaceFile;
    }

    function updateContinueButton() {
        const btn = document.getElementById('btnContinueProfile');
        if (btn) btn.disabled = !S().masterFaceFile;
    }

    function updateSelectionPreview() {
        const card = document.getElementById('faceLockPreview');
        const title = document.getElementById('faceLockPreviewTitle');
        const clearBtn = document.getElementById('btnClearFaceSelection');
        const img = document.getElementById('faceLockPreviewImg');
        const name = document.getElementById('faceLockPreviewName');

        if (!card || !img || !name) return;

        const isLocked = !!S().masterFaceFile;
        const hasPending = selectedFile && !isLocked;

        if (hasPending || isLocked) {
            card.hidden = false;
            if (title) title.textContent = isLocked ? 'Locked master face' : 'Selected for lock';
            if (clearBtn) {
                clearBtn.hidden = false;
                clearBtn.textContent = isLocked ? 'Unlock' : 'Clear';
            }

            if (isLocked && S().masterFaceObjectUrl) {
                img.src = S().masterFaceObjectUrl;
                name.textContent = S().masterFaceFile.name;
            } else if (selectedSource === 'dedicated' && dedicatedUrl) {
                img.src = dedicatedUrl;
                name.textContent = selectedFile.name;
            } else {
                const card = [...document.querySelectorAll('.face-option')]
                    .find(el => el.mirageFile === selectedFile);
                img.src = card?.querySelector('img')?.src
                    || trackGridUrl(URL.createObjectURL(selectedFile));
                name.textContent = selectedFile.name;
            }
        } else {
            card.hidden = true;
            img.removeAttribute('src');
            name.textContent = '';
            if (clearBtn) clearBtn.hidden = true;
        }
    }

    function trackGridUrl(url) {
        gridUrls.push(url);
        return url;
    }

    function selectFace(file, source) {
        if (S().masterFaceFile && S().masterFaceFile !== file) {
            S().clearMasterFace();
            if (S().edf?.VISUAL_ANCHORS) S().edf.VISUAL_ANCHORS.MASTER_FACE_REF = '';
            updateContinueButton();
        }

        if (source === 'media') {
            clearDedicated();
        }

        selectedFile = file;
        selectedSource = source;

        document.querySelectorAll('.face-option').forEach(el => {
            el.classList.toggle('selected', source === 'media' && el.mirageFile === file);
        });

        updateSelectionPreview();
        updateLockButton();
    }

    function showDedicatedPreview(file, url) {
        const preview = document.getElementById('dedicatedFacePreview');
        const img = document.getElementById('dedicatedFaceImg');
        const name = document.getElementById('dedicatedFaceName');

        if (preview) preview.hidden = false;
        if (img) img.src = url;
        if (name) name.textContent = file.name;
    }

    function renderFaceGrid() {
        const grid = document.getElementById('faceSelectionGrid');
        const emptyHint = document.getElementById('faceGridEmpty');
        if (!grid) return;

        revokeGridUrls();
        grid.innerHTML = '';

        const images = getImageFiles();
        if (emptyHint) emptyHint.hidden = images.length > 0;

        images.forEach((file) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'face-option';
            card.dataset.source = 'media';
            card.dataset.name = file.name;
            // Identity, not filename: duplicates like IMG_0001.jpg collide by name.
            card.mirageFile = file;

            const img = document.createElement('img');
            img.src = trackGridUrl(URL.createObjectURL(file));
            img.alt = file.name;
            card.appendChild(img);

            const label = document.createElement('span');
            label.className = 'face-option-label';
            label.textContent = file.name;
            card.appendChild(label);

            card.addEventListener('click', () => selectFace(file, 'media'));
            grid.appendChild(card);
        });

        if (selectedSource === 'media' && selectedFile) {
            document.querySelectorAll('.face-option').forEach(el => {
                el.classList.toggle('selected', el.mirageFile === selectedFile);
            });
        }

        if (S().masterFaceFile) {
            selectedFile = S().masterFaceFile;
            selectedSource = dedicatedFile && S().masterFaceFile === dedicatedFile ? 'dedicated' : 'media';
            if (selectedSource === 'dedicated' && dedicatedFile && dedicatedUrl) {
                showDedicatedPreview(dedicatedFile, dedicatedUrl);
            }
        }

        updateSelectionPreview();
        updateLockButton();
        updateContinueButton();
        renderBodyGrid();
    }

    async function lockMasterFace() {
        if (!selectedFile) {
            MirageUI.toast('Select a face reference first.', 'error');
            return;
        }
        if (!S().edf) {
            MirageUI.toast('Complete the forensic scan first.', 'error');
            return;
        }

        const btn = document.getElementById('btnLockMasterFace');
        if (btn) btn.disabled = true;

        try {
            S().setMasterFace(selectedFile);
            S().masterFaceBase64 = await MirageAPI.readFileBase64(selectedFile);

            if (!S().edf.VISUAL_ANCHORS) S().edf.VISUAL_ANCHORS = {};
            S().edf.VISUAL_ANCHORS.MASTER_FACE_REF = selectedFile.name;

            MirageUI.setStatus('FACE LOCKED', 'active');
            MirageUI.toast('Face locked.', 'success');
            updateSelectionPreview();
            updateLockButton();
            updateContinueButton();
        } catch (err) {
            MirageUI.toast(err.message || 'Failed to lock face.', 'error');
            updateLockButton();
        }
    }

    function handleDedicatedUpload(file) {
        if (!file || !file.type.startsWith('image/')) {
            MirageUI.toast('Upload a JPG, PNG, or WEBP image.', 'error');
            return;
        }

        const run = () => {
            clearDedicated();
            dedicatedFile = file;
            dedicatedUrl = URL.createObjectURL(file);
            showDedicatedPreview(file, dedicatedUrl);
            selectFace(file, 'dedicated');
        };

        if (typeof MirageSafetyGates?.confirmMediaUpload === 'function') {
            MirageSafetyGates.confirmMediaUpload({ context: 'face' }).then(ok => {
                if (ok) run();
            });
            return;
        }
        run();
    }

    function pickImageFromDataTransfer(dataTransfer) {
        const files = Array.from(dataTransfer?.files || []);
        return files.find(f => f.type.startsWith('image/')) || null;
    }

    function bindImageDropzone(zone, onFile) {
        if (!zone) return;

        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('drag-over');
        });
        zone.addEventListener('dragleave', (e) => {
            if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
        });
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.remove('drag-over');
            const file = pickImageFromDataTransfer(e.dataTransfer);
            if (file) onFile(file);
            else MirageUI.toast('Drop a JPG, PNG, or WEBP image.', 'error');
        });
    }

    function renderBodyGrid() {
        const grid = document.getElementById('bodySelectionGrid');
        const emptyHint = document.getElementById('bodyGridEmpty');
        if (!grid) return;

        revokeBodyGridUrls();
        grid.innerHTML = '';

        const images = getImageFiles();
        if (emptyHint) emptyHint.hidden = images.length > 0;

        const selectedBody = S().masterBodyFile || null;

        images.forEach((file) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'face-option';
            card.dataset.source = 'media';
            card.dataset.name = file.name;
            card.mirageFile = file;
            card.classList.toggle('selected', !!selectedBody && file === selectedBody);

            const img = document.createElement('img');
            img.src = trackBodyGridUrl(URL.createObjectURL(file));
            img.alt = file.name;
            card.appendChild(img);

            const label = document.createElement('span');
            label.className = 'face-option-label';
            label.textContent = file.name;
            card.appendChild(label);

            card.addEventListener('click', () => selectBodyFromMedia(file));
            grid.appendChild(card);
        });
    }

    async function selectBodyFromMedia(file) {
        if (!file) return;
        S().setBodyReference(file);
        try {
            S().masterBodyBase64 = await MirageAPI.readFileBase64(file);
        } catch (err) {
            S().clearBodyReference();
            MirageUI.toast(err.message || 'Failed to read body reference.', 'error');
        }
        renderBodyReference();
        renderBodyGrid();
    }

    function renderBodyReference() {
        const preview = document.getElementById('bodyRefPreview');
        const img = document.getElementById('bodyRefImg');
        const name = document.getElementById('bodyRefName');
        if (!preview || !img || !name) return;

        if (S().masterBodyFile && S().masterBodyObjectUrl) {
            preview.hidden = false;
            img.src = S().masterBodyObjectUrl;
            name.textContent = S().masterBodyFile.name;
        } else {
            preview.hidden = true;
            img.removeAttribute('src');
            name.textContent = '';
        }
    }

    async function handleBodyUpload(file) {
        if (!file || !file.type.startsWith('image/')) {
            MirageUI.toast('Upload a JPG, PNG, or WEBP image.', 'error');
            return;
        }
        if (typeof MirageSafetyGates?.confirmMediaUpload === 'function') {
            const ok = await MirageSafetyGates.confirmMediaUpload({ context: 'body' });
            if (!ok) return;
        }
        S().setBodyReference(file);
        try {
            S().masterBodyBase64 = await MirageAPI.readFileBase64(file);
        } catch (err) {
            S().clearBodyReference();
            MirageUI.toast(err.message || 'Failed to read body reference.', 'error');
        }
        renderBodyReference();
        renderBodyGrid();
    }

    function onEnterStep() {
        renderBodyReference();
        if (S().session.phase === 'active' || S().session.phase === 'standby') {
            renderFaceGrid();
            return;
        }
        if (!S().edf) {
            MirageUI.toast('Complete media ingest and forensic scan first.', 'error');
            window.MirageApp?.goToSetupStep(1);
            return;
        }
        renderFaceGrid();
    }

    function bindFaceStep() {
        const uploadZone = document.getElementById('faceUploadZone');
        const uploadInput = document.getElementById('faceUploadInput');
        const clearDedicatedBtn = document.getElementById('btnClearDedicatedFace');
        const clearSelectionBtn = document.getElementById('btnClearFaceSelection');
        const lockBtn = document.getElementById('btnLockMasterFace');
        const continueBtn = document.getElementById('btnContinueProfile');

        uploadZone?.addEventListener('click', (e) => {
            if (e.target.closest('#btnClearDedicatedFace')) return;
            uploadInput?.click();
        });
        bindImageDropzone(uploadZone, handleDedicatedUpload);
        uploadInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) handleDedicatedUpload(file);
            e.target.value = '';
        });

        const bodyZone = document.getElementById('bodyUploadZone');
        const bodyInput = document.getElementById('bodyUploadInput');
        bodyZone?.addEventListener('click', () => bodyInput?.click());
        bindImageDropzone(bodyZone, handleBodyUpload);
        bodyInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) handleBodyUpload(file);
            e.target.value = '';
        });
        document.getElementById('btnClearBodyRef')?.addEventListener('click', () => {
            S().clearBodyReference();
            renderBodyReference();
            renderBodyGrid();
        });

        clearDedicatedBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            clearDedicatedSelection();
        });

        clearSelectionBtn?.addEventListener('click', clearFaceSelection);

        lockBtn?.addEventListener('click', lockMasterFace);

        continueBtn?.addEventListener('click', () => {
            if (!S().masterFaceFile) return;
            window.MirageApp?.goToSetupStep(3);
        });
    }

    window.MirageSetupFace = { bindFaceStep, onEnterStep, renderFaceGrid, renderBodyReference, renderBodyGrid };
})();
