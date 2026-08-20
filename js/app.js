/**
 * MIRAGE ENGINE v2 — App bootstrap
 */
(function (global) {
    'use strict';

    const S = () => EngineState;

    function formatModelOptionLabel(m) {
        return typeof MirageModels.formatOptionLabel === 'function'
            ? MirageModels.formatOptionLabel(m)
            : [m.label, m.costLabel, m.tag === 'recommended' ? '★' : ''].filter(Boolean).join(' · ');
    }

    function engineSettingsSnapshot() {
        return {
            apiProvider: S().apiProvider,
            thinkingModel: S().thinkingModel,
            sceneThinkingModel: S().sceneThinkingModel,
            imageModel: S().imageModel,
            referenceMode: S().effectiveReferenceMode?.() || S().referenceMode,
            pacing: S().getPacingMode?.() || S().pacingMode,
            mockImages: !!S().mockImages,
            mockThinking: !!S().mockThinking,
            developerMode: !!S().developerMode,
            sceneContinuityRef: !!S().sceneContinuityRef,
            saveGeneratedImages: !!S().saveGeneratedImages,
            imageSaveMode: S().imageSaveMode,
            maxReplyChars: S().maxReplyChars || 0,
            maxThinkingInputTokens: S().maxThinkingInputTokens || 0,
            realTimeMaxWaitMs: S().realTimeMaxWaitMs,
            noReplyWaitMs: S().noReplyWaitMs,
            proactiveStories: !!S().proactiveStories,
            routineMode: S().routineMode || 'stories',
            chatImageSaveCount: S().chatImageSaveCount
        };
    }

    function populateModelSelects(provider) {
        const prov = MirageModels.normalizeProvider(provider || S().apiProvider);
        const thinkingSelect = document.getElementById('selectThinkingModel');
        const sceneThinkingSelect = document.getElementById('selectSceneThinkingModel');
        const imageSelect = document.getElementById('selectImageModel');
        const thinkingList = MirageModels.thinkingModels(prov);
        const imageList = MirageModels.imageModels(prov);
        const thinkingId = MirageModels.resolveThinkingModel(S().thinkingModel, prov);
        const sceneThinkingId = MirageModels.resolveThinkingModel(
            S().sceneThinkingModel || MirageModels.defaultSceneThinking?.(prov),
            prov
        );
        const imageId = MirageModels.resolveImageModel(S().imageModel, prov);
        const htmlFor = (list, selected) => (typeof MirageModels.optionsHtml === 'function'
            ? MirageModels.optionsHtml(list, selected)
            : list.map(m => {
                const selectedAttr = m.id === selected ? ' selected' : '';
                return `<option value="${m.id}"${selectedAttr}>${formatModelOptionLabel(m)}</option>`;
            }).join(''));

        if (thinkingSelect) thinkingSelect.innerHTML = htmlFor(thinkingList, thinkingId);
        if (sceneThinkingSelect) sceneThinkingSelect.innerHTML = htmlFor(thinkingList, sceneThinkingId);
        if (imageSelect) imageSelect.innerHTML = htmlFor(imageList, imageId);
    }

    function bindConfigModal() {
        const modal = document.getElementById('configModal');
        const openBtn = document.getElementById('btnOpenConfig');
        const closeBtn = document.getElementById('btnCloseConfig');
        const cancelBtn = document.getElementById('btnCancelConfig');
        const saveBtn = document.getElementById('btnSaveConfig');
        const testBtn = document.getElementById('btnTestConfig');

        const providerSelect = document.getElementById('selectApiProvider');
        const apiInput = document.getElementById('inputApiKey');
        const kieApiInput = document.getElementById('inputKieApiKey');
        const fieldGoogleKey = document.getElementById('fieldGoogleApiKey');
        const fieldKieKey = document.getElementById('fieldKieApiKey');
        const noteGoogle = document.getElementById('settingsConnNoteGoogle');
        const noteKie = document.getElementById('settingsConnNoteKie');
        const thinkingSelect = document.getElementById('selectThinkingModel');
        const sceneThinkingSelect = document.getElementById('selectSceneThinkingModel');
        const imageSelect = document.getElementById('selectImageModel');
        const devModeCheck = document.getElementById('checkDeveloperMode');
        const mockImagesCheck = document.getElementById('checkMockImages');
        const mockThinkingCheck = document.getElementById('checkMockThinking');
        const devSettingsOptions = document.getElementById('devSettingsOptions');
        const pacingSelect = document.getElementById('selectPacingMode');
        const routineSelect = document.getElementById('selectRoutineMode');
        const maxWaitInput = document.getElementById('inputMaxWaitMin');
        const quietChaseInput = document.getElementById('inputQuietChaseMin');
        const proactiveStoriesCheck = document.getElementById('checkProactiveStories');
        const saveImagesCheck = document.getElementById('checkSaveImages');
        const imageSaveOptions = document.getElementById('imageSaveOptionsExtra');
        const imageSaveModeSelect = document.getElementById('selectImageSaveMode');
        const downloadPrefixInput = document.getElementById('inputDownloadPrefix');
        const chatImageSaveCountInput = document.getElementById('inputChatImageSaveCountAlways');
        const referenceModeSelect = document.getElementById('selectReferenceMode');
        const sceneContinuityCheck = document.getElementById('checkSceneContinuityRef');
        const maxReplyCharsSelect = document.getElementById('selectMaxReplyChars');
        const maxThinkingInputSelect = document.getElementById('selectMaxThinkingInput');
        const testRunnerBtn = document.getElementById('btnOpenTestRunner');
        const resetMemoryBtn = document.getElementById('btnResetMemory');
        const resetMemoryOverlay = document.getElementById('resetMemoryOverlay');
        const resetMemoryCancel = document.getElementById('btnResetMemoryCancel');
        const resetMemoryConfirm = document.getElementById('btnResetMemoryConfirm');
        const resetWipeLibraryCheck = document.getElementById('checkResetWipeLibrary');
        const btnUnlockSceneModel = document.getElementById('btnUnlockSceneModel');
        const sceneModelLockHint = document.getElementById('sceneModelLockHint');
        const btnOpenModelGuide = document.getElementById('btnOpenModelGuide');
        const modelGuideOverlay = document.getElementById('modelGuideOverlay');
        const btnCloseModelGuide = document.getElementById('btnCloseModelGuide');
        const modelGuideBody = document.getElementById('modelGuideBody');
        const backupAllBtn = document.getElementById('btnBackupAll');
        const restoreBtn = document.getElementById('btnRestoreBackup');
        const backupFileInput = document.getElementById('backupFileInput');
        const backupPhotosCheck = document.getElementById('checkBackupPhotos');
        const backupStatus = document.getElementById('backupStatus');
        let sceneThinkingUnlocked = false;

        function formatBytes(bytes) {
            const n = Number(bytes) || 0;
            if (n < 1024) return `${n} B`;
            if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
            return `${(n / (1024 * 1024)).toFixed(1)} MB`;
        }

        function setBackupStatus(text, tone) {
            if (!backupStatus) return;
            backupStatus.textContent = text || '';
            backupStatus.dataset.tone = tone || '';
        }

        async function runBackupAll() {
            // A silent return here is how a stale cached app.js presents: the card
            // renders, the button does nothing, and nothing says why. Say why.
            if (!window.MirageBackup) {
                setBackupStatus(
                    'Backup code did not load. Reload the page with Ctrl+Shift+R (Cmd+Shift+R on a Mac) '
                    + 'to clear a stale cached copy.',
                    'error'
                );
                return;
            }
            const count = MirageProfileStore?.list?.().length || 0;
            if (!count) {
                setBackupStatus('Nothing to back up yet — save a character first.', 'warn');
                return;
            }
            const includeImages = backupPhotosCheck?.checked !== false;
            backupAllBtn.disabled = true;
            backupAllBtn.textContent = 'Preparing…';
            setBackupStatus('Collecting characters, chats and images…');
            try {
                const res = await MirageBackup.exportEverything({
                    includePhotos: includeImages,
                    includeTurnImages: includeImages
                });
                setBackupStatus(
                    `Saved ${res.characters} character${res.characters === 1 ? '' : 's'} `
                    + `(${formatBytes(res.bytes)}). Keep this file somewhere outside the browser.`,
                    'ok'
                );
            } catch (err) {
                console.error('[Mirage] Backup failed', err);
                setBackupStatus(err?.message || 'Backup failed — see the browser console.', 'error');
            } finally {
                backupAllBtn.disabled = false;
                backupAllBtn.textContent = 'Back up everything';
            }
        }

        async function runRestore(file) {
            if (!file) return;
            if (!window.MirageBackup) {
                setBackupStatus(
                    'Backup code did not load. Reload the page with Ctrl+Shift+R (Cmd+Shift+R on a Mac) '
                    + 'to clear a stale cached copy.',
                    'error'
                );
                return;
            }
            restoreBtn.disabled = true;
            restoreBtn.textContent = 'Restoring…';
            setBackupStatus(`Reading ${file.name}…`);
            try {
                const res = await MirageBackup.importFromFile(file, {
                    onProgress: msg => setBackupStatus(msg)
                });
                const bits = [
                    `${res.imported} character${res.imported === 1 ? '' : 's'}`,
                    `${res.chats} chat${res.chats === 1 ? '' : 's'}`,
                    `${res.photos} photo${res.photos === 1 ? '' : 's'}`,
                    `${res.images} generated image${res.images === 1 ? '' : 's'}`
                ];
                const renamed = res.renamed
                    ? ` ${res.renamed} arrived under a new name because a character with that id was already here — nothing was replaced.`
                    : '';
                setBackupStatus(`Restored ${bits.join(', ')}.${renamed}`, 'ok');
                MirageCharactersUI?.renderList?.();
                MirageCharactersUI?.refreshWelcome?.();
                MirageUserProfilesUI?.refresh?.();
                MirageSetupProfile?.updateProfileSaveUi?.();
            } catch (err) {
                console.error('[Mirage] Restore failed', err);
                setBackupStatus(err?.message || 'Restore failed — see the browser console.', 'error');
            } finally {
                restoreBtn.disabled = false;
                restoreBtn.textContent = 'Restore from file…';
                if (backupFileInput) backupFileInput.value = '';
            }
        }

        backupAllBtn?.addEventListener('click', runBackupAll);
        restoreBtn?.addEventListener('click', () => backupFileInput?.click());
        backupFileInput?.addEventListener('change', (e) => runRestore(e.target.files?.[0]));

        function expectedSceneThinkingId(prov, thinkingId) {
            if (typeof MirageModels.pairedSceneThinking === 'function') {
                return MirageModels.pairedSceneThinking(thinkingId, prov);
            }
            return MirageModels.defaultSceneThinking?.(prov) || thinkingId;
        }

        function syncSceneThinkingLock() {
            const locked = !sceneThinkingUnlocked;
            if (sceneThinkingSelect) sceneThinkingSelect.disabled = locked;
            if (btnUnlockSceneModel) btnUnlockSceneModel.hidden = !locked;
            if (sceneModelLockHint) {
                sceneModelLockHint.hidden = !locked;
            }
        }

        function syncImageSaveUi() {
            const on = saveImagesCheck?.checked;
            if (imageSaveOptions) imageSaveOptions.hidden = !on;
        }

        function syncDevMockFormUi() {
            const devOn = !!devModeCheck?.checked;
            if (devSettingsOptions) devSettingsOptions.hidden = !devOn;
            if (devOn && mockThinkingCheck?.checked && mockImagesCheck) {
                mockImagesCheck.checked = true;
            }
        }

        function syncProviderFormUi() {
            const prov = MirageModels.normalizeProvider(providerSelect?.value || 'google');
            const isKie = prov === 'kie';
            if (fieldGoogleKey) fieldGoogleKey.hidden = isKie;
            if (fieldKieKey) fieldKieKey.hidden = !isKie;
            if (noteGoogle) noteGoogle.hidden = isKie;
            if (noteKie) noteKie.hidden = !isKie;
            populateModelSelects(prov);
        }

        function syncDeveloperUi() {
            MirageDebugPanel?.setVisible?.(!!S().developerMode);
            MirageDebugPanel?.refresh?.();
            MirageSimulation?.syncChatDevVisibility?.();
        }

        function syncFormFromState() {
            const prov = MirageModels.normalizeProvider(S().apiProvider);
            S().thinkingModel = MirageModels.resolveThinkingModel(S().thinkingModel, prov);
            if (typeof MirageModels.isGrokThinking === 'function' && MirageModels.isGrokThinking(S().thinkingModel)) {
                S().sceneThinkingModel = S().thinkingModel;
            } else {
                S().sceneThinkingModel = MirageModels.resolveThinkingModel(
                    S().sceneThinkingModel || MirageModels.defaultSceneThinking?.(prov),
                    prov
                );
            }
            S().imageModel = MirageModels.resolveImageModel(S().imageModel, prov);
            if (providerSelect) providerSelect.value = prov;
            populateModelSelects(prov);
            const expectedScene = expectedSceneThinkingId(prov, S().thinkingModel);
            sceneThinkingUnlocked = S().sceneThinkingModel !== expectedScene;
            syncSceneThinkingLock();
            if (apiInput) apiInput.value = S().apiKey;
            if (kieApiInput) kieApiInput.value = S().kieApiKey;
            syncProviderFormUi();
            if (devModeCheck) devModeCheck.checked = !!S().developerMode;
            if (mockImagesCheck) mockImagesCheck.checked = !!S().mockImages;
            if (mockThinkingCheck) mockThinkingCheck.checked = !!S().mockThinking;
            syncDevMockFormUi();
            if (pacingSelect) {
                pacingSelect.value = S().getPacingMode?.() || S().pacingMode || 'instant';
            }
            if (routineSelect) {
                const rm = typeof MirageRoutine?.normalizeMode === 'function'
                    ? MirageRoutine.normalizeMode(S().routineMode)
                    : (S().routineMode || 'stories');
                routineSelect.value = rm;
            }
            if (maxWaitInput) {
                const fallbackMs = S().DEFAULT_MAX_WAIT_MS || 10 * 60 * 1000;
                const ms = Number(S().realTimeMaxWaitMs);
                const minutes = Number.isFinite(ms) && ms >= 60 * 1000
                    ? Math.round(ms / 60000)
                    : Math.round(fallbackMs / 60000);
                maxWaitInput.value = String(Math.max(1, Math.min(30, minutes || 10)));
            }
            if (quietChaseInput) {
                const fallbackMs = S().DEFAULT_NO_REPLY_WAIT_MS || 3 * 60 * 1000;
                const ms = Number(S().noReplyWaitMs);
                const minutes = Number.isFinite(ms) && ms >= 60 * 1000
                    ? Math.round(ms / 60000)
                    : Math.round(fallbackMs / 60000);
                quietChaseInput.value = String(Math.max(1, Math.min(30, minutes || 3)));
            }
            if (proactiveStoriesCheck) {
                proactiveStoriesCheck.checked = S().proactiveStories !== false;
            }
            if (saveImagesCheck) saveImagesCheck.checked = !!S().saveGeneratedImages;
            if (imageSaveModeSelect) {
                imageSaveModeSelect.value = S().imageSaveMode || 'browser';
            }
            if (downloadPrefixInput) {
                const live = String(S().profile?.name || '').trim();
                const stored = String(S().downloadPrefix || '').trim();
                downloadPrefixInput.value = stored && stored.toLowerCase() !== live.toLowerCase()
                    ? stored
                    : '';
                downloadPrefixInput.placeholder = live || 'Optional extra tag';
            }
            if (chatImageSaveCountInput) {
                chatImageSaveCountInput.value = String(S().chatImageSaveCount ?? 3);
            }
            if (referenceModeSelect) {
                referenceModeSelect.value = S().referenceMode || 'face+body';
            }
            if (sceneContinuityCheck) {
                sceneContinuityCheck.checked = S().sceneContinuityRef !== false;
            }
            if (maxReplyCharsSelect) {
                const cap = Number(S().maxReplyChars);
                const allowed = ['80', '140', '240', '0'];
                const key = Number.isFinite(cap) && cap <= 0 ? '0' : String(Math.round(cap || 240));
                maxReplyCharsSelect.value = allowed.includes(key) ? key : '240';
            }
            if (maxThinkingInputSelect) {
                const n = Number(S().maxThinkingInputTokens);
                const allowed = ['2500', '4500', '8000', '0'];
                const key = Number.isFinite(n) && n <= 0 ? '0' : String(Math.round(n || 4500));
                maxThinkingInputSelect.value = allowed.includes(key) ? key : '4500';
            }
            syncImageSaveUi();
            syncDeveloperUi();
        }

        function closeModal() {
            modal.hidden = true;
            try {
                if (MiragePhoneUX?.operatorAttendingChat?.()) {
                    MiragePhoneUX.onOperatorAttending();
                }
            } catch { /* ignore */ }
        }

        function openModal() {
            syncFormFromState();
            MirageUserProfilesUI?.refresh?.();
            modal.hidden = false;
        }

        openBtn.addEventListener('click', openModal);
        closeBtn.addEventListener('click', closeModal);
        cancelBtn?.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        modal.querySelector('.modal')?.addEventListener('click', (e) => e.stopPropagation());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !modal.hidden) closeModal();
        });

        saveImagesCheck?.addEventListener('change', syncImageSaveUi);
        devModeCheck?.addEventListener('change', syncDevMockFormUi);
        mockThinkingCheck?.addEventListener('change', () => {
            if (mockThinkingCheck.checked && mockImagesCheck) mockImagesCheck.checked = true;
        });

        // Apply model picks immediately so mid-chat switches work before Save
        // (Save still persists keys / pacing / etc.)
        function applyModelsFromForm() {
            const prov = MirageModels.normalizeProvider(providerSelect?.value || S().apiProvider || 'google');
            S().apiProvider = prov;
            if (thinkingSelect?.value) {
                S().thinkingModel = MirageModels.resolveThinkingModel(thinkingSelect.value, prov);
            }
            const paired = expectedSceneThinkingId(prov, S().thinkingModel);
            if (!sceneThinkingUnlocked || MirageModels.isGrokThinking?.(S().thinkingModel)) {
                S().sceneThinkingModel = paired;
                if (sceneThinkingSelect && sceneThinkingSelect.value !== paired) {
                    sceneThinkingSelect.value = paired;
                }
            } else if (sceneThinkingSelect?.value) {
                S().sceneThinkingModel = MirageModels.resolveThinkingModel(sceneThinkingSelect.value, prov);
                if (MirageModels.isGrokThinking?.(S().sceneThinkingModel)) {
                    S().thinkingModel = S().sceneThinkingModel;
                    if (thinkingSelect) thinkingSelect.value = S().thinkingModel;
                }
            }
            if (imageSelect?.value) {
                S().imageModel = MirageModels.resolveImageModel(imageSelect.value, prov);
            }
            syncSceneThinkingLock();
        }
        thinkingSelect?.addEventListener('change', applyModelsFromForm);
        sceneThinkingSelect?.addEventListener('change', applyModelsFromForm);
        imageSelect?.addEventListener('change', applyModelsFromForm);
        providerSelect?.addEventListener('change', () => {
            sceneThinkingUnlocked = false;
            syncProviderFormUi();
            applyModelsFromForm();
            MirageUI.refreshKieCredits?.();
        });
        btnUnlockSceneModel?.addEventListener('click', () => {
            sceneThinkingUnlocked = true;
            syncSceneThinkingLock();
            sceneThinkingSelect?.focus();
        });

        function renderModelGuide() {
            const prov = MirageModels.normalizeProvider(providerSelect?.value || S().apiProvider);
            const pack = typeof MirageModels.modelGuideEntries === 'function'
                ? MirageModels.modelGuideEntries(prov)
                : { thinking: MirageModels.thinkingModels(prov), images: MirageModels.imageModels(prov) };
            const esc = (s) => MirageUI.escapeHtml(s || '');
            const priceBlock = (m) => {
                const html = typeof MirageModels.formatPriceHtml === 'function'
                    ? MirageModels.formatPriceHtml(m, esc)
                    : '';
                if (html) return html;
                const note = m.costNote || m.costLabel || '';
                return note ? `<p class="model-guide-price">${esc(note)}</p>` : '';
            };
            const card = (m) => `
                <article class="model-guide-card" data-kind="${esc(m.kind || '')}" data-vendor="${esc(m.vendor || '')}">
                    <header>
                        <h4>${esc(m.label)}</h4>
                        <span class="model-guide-tags">
                            ${m.tag === 'recommended' ? '<em>★ recommended</em>' : ''}
                            ${m.tag === 'new' ? '<em>new</em>' : ''}
                        </span>
                    </header>
                    <p class="model-guide-kind">${esc(m.kindLabel || m.kind || '')}${m.product ? ` · ${esc(m.product)}` : ''}</p>
                    <p><strong>Best for:</strong> ${esc(m.bestFor || '—')}</p>
                    <p><strong>What it does:</strong> ${esc(m.capability || m.product || '—')}</p>
                    ${m.caution ? `<p><strong>Watch out:</strong> ${esc(m.caution)}</p>` : ''}
                    ${priceBlock(m)}
                </article>`;
            const labSection = (kindLabel, models) => {
                const groups = typeof MirageModels.groupedModels === 'function'
                    ? MirageModels.groupedModels(models)
                    : [{ vendor: 'other', label: 'Models', models: models || [] }];
                const labs = groups.map((g) => `
                    <div class="model-guide-lab">
                        <h4>${esc(g.label)}</h4>
                        <div class="model-guide-grid">${(g.models || []).map(card).join('')}</div>
                    </div>`).join('');
                return `
                    <section class="model-guide-column">
                        <h3 class="model-guide-section-title">${esc(kindLabel)}</h3>
                        ${labs}
                    </section>`;
            };
            if (modelGuideBody) {
                const providerName = prov === 'kie' ? 'kie.ai Market' : 'Google AI Studio';
                modelGuideBody.innerHTML = `
                    <p class="model-guide-lead">
                        Prices for <strong>${esc(providerName)}</strong> as of August 2026.
                        Figures in bold are <strong>approx. credits per typical Mirage turn</strong>
                        (thinking ≈ 6k input + 500 output tokens; image = one still).
                        A photo turn is thinking + image. Text-only is thinking only.
                        ${prov === 'kie' ? '1 credit ≈ $0.005. kie Market is often cheaper than the official list shown underneath.' : 'Official Google / lab list is shown under the turn estimate.'}
                    </p>
                    <div class="model-guide-columns">
                        ${labSection('Thinking — chat turns & scene commands', pack.thinking || [])}
                        ${labSection('Image — photos', pack.images || [])}
                    </div>
                `;
            }
        }

        function openModelGuide() {
            renderModelGuide();
            if (modelGuideOverlay) {
                modelGuideOverlay.hidden = false;
                modelGuideOverlay.setAttribute('aria-hidden', 'false');
            }
        }
        function closeModelGuide() {
            if (modelGuideOverlay) {
                modelGuideOverlay.hidden = true;
                modelGuideOverlay.setAttribute('aria-hidden', 'true');
            }
        }
        btnOpenModelGuide?.addEventListener('click', openModelGuide);
        btnCloseModelGuide?.addEventListener('click', closeModelGuide);
        modelGuideOverlay?.addEventListener('click', (e) => {
            if (e.target === modelGuideOverlay) closeModelGuide();
        });

        saveBtn.addEventListener('click', () => {
            const beforeSettings = engineSettingsSnapshot();
            const prov = MirageModels.normalizeProvider(providerSelect?.value || 'google');
            const googleKey = apiInput?.value?.trim() || '';
            const kieKey = kieApiInput?.value?.trim() || '';
            const activeKey = prov === 'kie' ? kieKey : googleKey;
            const wantDev = !!devModeCheck?.checked;
            const wantMockThinking = !!mockThinkingCheck?.checked;
            const wantMockImages = !!mockImagesCheck?.checked || wantMockThinking;
            if (!activeKey && !(wantDev && wantMockThinking)) {
                MirageUI.toast(
                    prov === 'kie' ? 'Enter a kie.ai API key first.' : 'Enter an API key first.',
                    'error'
                );
                return;
            }
            S().apiProvider = prov;
            S().apiKey = googleKey;
            S().kieApiKey = kieKey;
            S().thinkingModel = MirageModels.resolveThinkingModel(thinkingSelect.value, prov);
            if (MirageModels.isGrokThinking?.(S().thinkingModel)) {
                S().sceneThinkingModel = S().thinkingModel;
            } else if (sceneThinkingUnlocked && sceneThinkingSelect?.value) {
                S().sceneThinkingModel = MirageModels.resolveThinkingModel(sceneThinkingSelect.value, prov);
                if (MirageModels.isGrokThinking?.(S().sceneThinkingModel)) {
                    S().thinkingModel = S().sceneThinkingModel;
                }
            } else {
                S().sceneThinkingModel = expectedSceneThinkingId(prov, S().thinkingModel);
            }
            S().imageModel = MirageModels.resolveImageModel(imageSelect.value, prov);
            S().developerMode = wantDev;
            S().mockThinking = wantMockThinking;
            S().mockImages = wantMockImages;
            const wasMode = S().getPacingMode?.() || S().pacingMode || 'instant';
            const nextMode = pacingSelect?.value || 'instant';
            S().setPacingMode?.(nextMode);
            const maxMin = parseInt(maxWaitInput?.value, 10);
            S().realTimeMaxWaitMs = Number.isFinite(maxMin) && maxMin > 0
                ? Math.max(60 * 1000, Math.min(30 * 60 * 1000, maxMin * 60 * 1000))
                : (S().DEFAULT_MAX_WAIT_MS || 10 * 60 * 1000);
            const quietMin = parseInt(quietChaseInput?.value, 10);
            S().noReplyWaitMs = Number.isFinite(quietMin) && quietMin > 0
                ? Math.max(60 * 1000, Math.min(30 * 60 * 1000, quietMin * 60 * 1000))
                : (S().DEFAULT_NO_REPLY_WAIT_MS || 3 * 60 * 1000);
            S().proactiveStories = !!proactiveStoriesCheck?.checked;
            S().routineMode = typeof MirageRoutine?.normalizeMode === 'function'
                ? MirageRoutine.normalizeMode(routineSelect?.value)
                : (routineSelect?.value || 'stories');
            if (wasMode !== nextMode) {
                MirageImmersion?.onPacingModeChanged?.(wasMode, nextMode);
            } else {
                MirageControlDeck?.sync?.();
            }
            S().saveGeneratedImages = !!saveImagesCheck?.checked;
            S().imageSaveMode = S().saveGeneratedImages
                ? (imageSaveModeSelect?.value || 'browser')
                : 'none';
            const liveName = String(S().profile?.name || '').trim();
            const typedPrefix = downloadPrefixInput?.value?.trim() || '';
            S().downloadPrefix = typedPrefix && typedPrefix.toLowerCase() !== liveName.toLowerCase()
                ? typedPrefix
                : '';
            const chatImgCount = parseInt(chatImageSaveCountInput?.value, 10);
            S().chatImageSaveCount = Number.isFinite(chatImgCount)
                ? Math.max(1, Math.min(20, chatImgCount))
                : 3;
            if (referenceModeSelect?.value === 'face' || referenceModeSelect?.value === 'face+body') {
                S().referenceMode = referenceModeSelect.value;
            }
            if (sceneContinuityCheck) {
                S().sceneContinuityRef = !!sceneContinuityCheck.checked;
            }
            if (maxReplyCharsSelect) {
                const n = parseInt(maxReplyCharsSelect.value, 10);
                S().maxReplyChars = Number.isFinite(n) && n > 0
                    ? Math.max(80, Math.min(4000, n))
                    : 0;
            }
            if (maxThinkingInputSelect) {
                const n = parseInt(maxThinkingInputSelect.value, 10);
                S().maxThinkingInputTokens = Number.isFinite(n) && n > 0 ? n : 0;
            }
            S().saveConfig();
            MirageUI.updateApiKeyBadge(!!S().activeApiKey() || !!(S().developerMode && S().mockThinking));
            MirageUI.refreshEngineStatus?.();
            MirageUI.refreshKieCredits?.();
            syncDeveloperUi();
            try {
                const afterSettings = engineSettingsSnapshot();
                const changed = Object.keys(afterSettings).filter(
                    (k) => String(beforeSettings[k]) !== String(afterSettings[k])
                );
                if (changed.length) {
                    MirageDebugPanel?.pushNotice?.({
                        kind: 'settings',
                        summary: `Settings changed: ${changed.map((k) => `${k} ${beforeSettings[k]} → ${afterSettings[k]}`).join('; ')}`,
                        detail: { changed, before: beforeSettings, after: afterSettings }
                    });
                }
            } catch { /* ignore */ }
            if (S().developerMode && S().mockThinking) {
                MirageUI.toast('Saved — full mock API (no credits).', 'success', { essential: true });
            } else if (S().developerMode && S().mockImages) {
                MirageUI.toast('Saved — mock images on (thinking still uses credits).', 'success', { essential: true });
            } else if (prov === 'kie') {
                MirageUI.toast('Saved — using kie.ai provider.', 'success', { essential: true });
            } else {
                MirageUI.toast('Configuration saved.', 'success', { essential: true });
            }
            closeModal();
        });

        testBtn.addEventListener('click', () => {
            const prov = MirageModels.normalizeProvider(providerSelect?.value || S().apiProvider);
            const key = (prov === 'kie' ? kieApiInput?.value : apiInput?.value)?.trim() || '';
            runFullConnectionTest(key, thinkingSelect.value, imageSelect.value, testBtn, prov);
        });

        function closeResetMemoryOverlay() {
            if (resetMemoryOverlay) {
                resetMemoryOverlay.hidden = true;
                resetMemoryOverlay.setAttribute('aria-hidden', 'true');
            }
        }

        function openResetMemoryOverlay() {
            if (resetWipeLibraryCheck) resetWipeLibraryCheck.checked = false;
            if (resetMemoryOverlay) {
                resetMemoryOverlay.hidden = false;
                resetMemoryOverlay.setAttribute('aria-hidden', 'false');
            }
        }

        /**
         * Open the test runner in its own window, on the *other* host alias.
         *
         * localhost:8080 and 127.0.0.1:8080 are the same server but different
         * storage origins, so the sandbox the suite wipes and re-seeds can never
         * reach the library on this one. The runner refuses to run if it lands on
         * the same origin anyway — belt and braces, since a wrong answer here costs
         * the user every character they have.
         */
        function testRunnerUrl() {
            const alias = location.hostname === 'localhost' ? '127.0.0.1'
                : (location.hostname === '127.0.0.1' ? 'localhost' : null);
            if (!alias) return null;
            const port = location.port ? `:${location.port}` : '';
            return `${location.protocol}//${alias}${port}/tests/ui/runner.html`
                + `?from=${encodeURIComponent(location.origin)}`;
        }

        testRunnerBtn?.addEventListener('click', () => {
            const url = testRunnerUrl();
            if (!url) {
                MirageUI.toast(
                    `The test runner needs the app served from localhost or 127.0.0.1 — this is ${location.hostname}. `
                    + 'Run it from the terminal instead: node tests/run.js all',
                    'error'
                );
                return;
            }
            const win = window.open(url, 'mirageTestRunner');
            if (!win) MirageUI.toast('Your browser blocked the runner window. Allow pop-ups for Mirage and try again.', 'error');
        });

        resetMemoryBtn?.addEventListener('click', openResetMemoryOverlay);
        resetMemoryCancel?.addEventListener('click', closeResetMemoryOverlay);
        resetMemoryOverlay?.addEventListener('click', (e) => {
            if (e.target === resetMemoryOverlay) closeResetMemoryOverlay();
        });
        resetMemoryConfirm?.addEventListener('click', () => {
            const wipeLibrary = !!resetWipeLibraryCheck?.checked;
            closeResetMemoryOverlay();
            closeModal();
            void runResetMemory({ wipeLibrary });
        });
    }

    async function runResetMemory({ wipeLibrary }) {
        MirageUI.setLoading(true, wipeLibrary ? 'Wiping library…' : 'Resetting settings…');
        try {
            localStorage.removeItem('mirage_v2_config');
            localStorage.removeItem('mirage_v2_pending_turn');
            localStorage.removeItem('mirage_v2_safety');
            try {
                MirageUserProfiles?.resetSeedToFactory?.();
            } catch (e) {
                console.warn('[Mirage] Default user profile reset failed', e);
            }
            if (wipeLibrary) {
                localStorage.removeItem('mirage_v2_chats');
                localStorage.removeItem('mirage_v2_sessions');
                localStorage.removeItem('mirage_v2_characters');
                localStorage.removeItem('mirage_v2_user_profiles');
                await Promise.all([
                    MirageImageStore?.wipeDatabase?.() || Promise.resolve(),
                    MirageAnchorStore?.wipeDatabase?.() || Promise.resolve(),
                    MirageMediaLibrary?.wipeDatabase?.() || Promise.resolve()
                ]);
            }
        } catch (err) {
            console.warn('[Mirage] Reset memory failed', err);
        }
        location.reload();
    }

    async function runFullConnectionTest(apiKey, thinkingModel, imageModel, btn, provider) {
        const prov = MirageModels.normalizeProvider(provider || S().apiProvider);
        if (!apiKey) {
            MirageUI.toast(
                prov === 'kie' ? 'Enter a kie.ai API key first.' : 'Enter an API key first.',
                'error'
            );
            return;
        }

        if (S().developerMode && (S().mockImages || S().mockThinking)) {
            MirageUI.toast('Test Connection always hits the live provider — this uses real credits.', 'info', {
                essential: true,
                duration: 5000
            });
        }

        const original = btn.textContent;
        btn.disabled = true;
        MirageUI.setLoading(true, `Testing ${prov === 'kie' ? 'kie.ai' : 'Google'}…`);

        const results = [];

        try {
            btn.textContent = 'Key…';
            await MirageAPI.testApiKey(apiKey, prov);
            results.push(prov === 'kie' ? 'kie key valid' : 'API key valid');

            btn.textContent = 'Thinking…';
            MirageUI.setLoading(true, 'Testing thinking model…');
            const think = await MirageAPI.testThinkingModel(apiKey, thinkingModel, prov);
            const route = prov === 'kie'
                ? 'kie chat'
                : (MirageModels.usesGenerateContent(think.model, 'google') ? 'generateContent' : 'interactions');
            results.push(`Thinking OK (${think.model} via ${route})`);

            btn.textContent = 'Image…';
            MirageUI.setLoading(
                true,
                prov === 'kie'
                    ? 'Testing kie image job (upload → generate → poll)…'
                    : 'Testing image model (up to 5 min — Lite is usually fast, Pro can be slow)…'
            );
            const img = await MirageAPI.testImageModel(apiKey, imageModel, prov);
            results.push(`Image OK (${img.label})`);

            MirageUI.toast(results.join(' · '), 'success', { essential: true, duration: 8000 });
        } catch (err) {
            const partial = results.length ? `${results.join(' · ')} · ` : '';
            MirageUI.toast(`${partial}FAILED: ${err.message}`, 'error', 10000);
        } finally {
            btn.disabled = false;
            btn.textContent = original;
            MirageUI.setLoading(false);
        }
    }

    function getMaxUnlockedStep() {
        const s = S();
        if (!s.hasApiAccess()) return 0;

        // Live sim — never lock the operator out of the chat they are already in.
        if (s.session.phase === 'active') return 6;

        let max = 1;
        if (s.edf) max = Math.max(max, 2);
        if (s.edf && s.masterFaceFile) max = Math.max(max, 3);
        if (s.edf && s.masterFaceFile && MirageSetupProfile?.identityReady?.(s.profile)) {
            max = Math.max(max, 4);
        }
        if (s.session.protocol && max >= 4) {
            if (s.session.phase === 'standby') max = 5;
        }
        // Already initialized — don't trap the operator off Standby if Auto-Fill
        // identity flickered after they locked the protocol.
        if (s.session.phase === 'standby') max = Math.max(max, 5);
        return max;
    }

    function isStepUnlocked(step) {
        const n = Number(step);
        return Number.isInteger(n) && n >= 0 && n <= getMaxUnlockedStep();
    }

    function isReviewNavigation() {
        return S().session.phase === 'active';
    }

    function refreshStepperNav() {
        const current = S().session.setupStep ?? 0;
        document.querySelectorAll('.stepper li[data-step]').forEach(li => {
            const step = parseInt(li.dataset.step, 10);
            if (Number.isNaN(step)) return;
            const unlocked = isStepUnlocked(step);
            li.classList.toggle('step-locked', !unlocked);
            li.classList.toggle('step-navigable', unlocked && step !== current);
            li.title = !unlocked
                ? 'Complete earlier steps first'
                : (isReviewNavigation() && step !== 6 && step !== current
                    ? 'Review setup — simulation stays active'
                    : '');
        });
    }

    function goToSetupStep(step, { force = false } = {}) {
        const target = Number(step);
        if (!Number.isInteger(target) || target < 0 || target > 6) return false;

        if (!force && !isStepUnlocked(target)) {
            MirageUI.toast('Complete earlier setup steps first.', 'error');
            return false;
        }

        S().session.setupStep = target;
        MirageUI.updateStepper(target);
        MirageUI.showPanel(`step-${target}`);
        document.querySelector('.layout')?.classList.toggle('layout-sim', target === 6);
        document.querySelector('.sidebar')?.classList.toggle('sidebar-collapsed', target === 6);
        if (target === 2) MirageSetupFace.onEnterStep();
        if (target === 3) MirageSetupProfile.onEnterStep();
        if (target === 4) MirageSetupProtocol.onEnterStep4();
        if (target === 5) MirageSetupProtocol.onEnterStep5();
        if (target === 6) {
            MirageSimulation.onEnter();
            window.MirageApp?.syncDeveloperUi?.();
            try {
                MiragePhoneUX?.onOperatorAttending?.();
            } catch { /* ignore */ }
        }
        // Leaving sim does not instantly mark Unread — that only happens after 3 min unseen
        refreshStepperNav();
        updateHeaderNav();
        try { S().markUiResume?.(); } catch { /* ignore */ }

        const reviewBanner = document.getElementById('reviewModeBanner');
        if (reviewBanner) {
            reviewBanner.hidden = !(isReviewNavigation() && target !== 6);
        }

        return true;
    }

    async function restoreUiSession() {
        const resume = S().uiResume;
        if (!resume?.characterId) return false;
        const entry = typeof MirageProfileStore?.get === 'function'
            ? MirageProfileStore.get(resume.characterId)
            : null;
        if (!entry) return false;

        try {
            await MirageProfileStore.applyToState(S(), entry);
            MirageSetupMedia?.refresh?.();
            MirageSetupFace?.renderFaceGrid?.();
            MirageSetupProfile?.syncFormFromState?.();
            MirageSetupProfile?.updateProfileSaveUi?.();
            MirageCharactersUI?.refreshWelcome?.();

            const chatId = resume.chatId
                || MirageChatStore.getMostRecentChat?.(entry.id)?.id
                || null;
            if (chatId) MirageChatStore.setActiveChat(S(), chatId);
            MirageSetupProtocol.syncProtocolFromSession?.();

            if (resume.phase) S().session.phase = resume.phase;
            const step = Number(resume.setupStep);
            const target = Number.isInteger(step) && step >= 0 && step <= 6
                ? step
                : (S().session.phase === 'active' ? 6 : 0);

            goToSetupStep(target, { force: true });
            if (target === 6 && S().session.phase === 'active') {
                await MirageSimulation.restoreChatUi?.();
                MirageSimulation.updateStoryControls?.();
            }
            MirageUI.refreshEngineStatus?.();
            return true;
        } catch (err) {
            console.warn('[Mirage] Session restore failed', err);
            return false;
        }
    }

    function navigateStepper(step) {
        const target = Number(step);
        if (target === S().session.setupStep) return;
        if (!isStepUnlocked(target)) {
            MirageUI.toast('Complete earlier setup steps first.', 'error');
            return;
        }
        goToSetupStep(target, { force: true });
    }

    function updateHeaderNav() {
        const simBtn = document.getElementById('btnReturnSimulation');
        if (!simBtn) return;
        const canReturn = S().session.phase === 'active'
            && !!S().activeCharacterId
            && S().session.setupStep !== 6;
        simBtn.hidden = !canReturn;
    }

    function bindHeaderNav() {
        document.getElementById('btnReturnSimulation')?.addEventListener('click', () => {
            if (S().session.phase !== 'active') {
                MirageUI.toast('No active simulation to return to.', 'error');
                return;
            }
            goToSetupStep(6);
        });

        document.getElementById('btnReviewReturnSim')?.addEventListener('click', () => {
            if (S().session.phase === 'active') goToSetupStep(6);
        });

        document.querySelectorAll('.stepper li[data-step]').forEach(li => {
            li.addEventListener('click', () => {
                const step = parseInt(li.dataset.step, 10);
                if (Number.isNaN(step)) return;
                navigateStepper(step);
            });
        });
    }

    function bindWelcome() {
        document.getElementById('btnBeginSetup')?.addEventListener('click', () => {
            if (!S().hasApiAccess()) {
                MirageUI.toast('Configure your API key in Settings first.', 'error');
                document.getElementById('configModal').hidden = false;
                return;
            }
            MirageCharactersUI.startNewCharacterDraft({ goToStep: 1, toast: false });
        });
    }

    function verifyPromptArchitecture() {
        if (typeof MiragePrompt?.buildThinkingSystemInstruction !== 'function') {
            console.error('[Mirage] MiragePrompt failed to load — check mirage-prompt.js for a syntax error.');
            return;
        }
        const ctx = S().getRuntimeContext();
        const thinkingSys = MiragePrompt.buildThinkingSystemInstruction('turn', ctx);
        const fakeDirective = { shotType: 'Front Selfie', crop: 'Face', uiTag: 'SNAPCHAT STRIP' };
        const imageSys = MiragePrompt.buildImageSystemInstruction(ctx, fakeDirective);

        console.group('[Mirage v2] API routing');
        console.log('Thinking:', `${MirageAPI.BASE}/models/{id}:generateContent`);
        console.log('Image (Nano Banana):', `${MirageAPI.BASE}/interactions (via local proxy)`);
        console.log('Thinking model:', MirageModels.resolveThinkingModel(S().thinkingModel));
        console.log('Image model:', MirageModels.resolveImageModel(S().imageModel));
        console.log('System prompt chars — thinking:', thinkingSys.length, 'image:', imageSys.length);
        console.groupEnd();
    }

    function checkFileProtocol() {
        if (location.protocol !== 'file:') return;

        const banner = document.createElement('div');
        banner.className = 'file-protocol-banner';
        banner.innerHTML = `
            <strong>Opened incorrectly.</strong>
            Browsers block Google API calls from double-clicked HTML files.
            Close this tab and double-click <strong>START MIRAGE.bat</strong> in the v2 folder instead.
        `;
        document.body.prepend(banner);
    }

    async function init() {
        checkFileProtocol();
        MirageSafetyGates?.bind?.();

        // 1.1 / 1.2 — block the product until age + fiction consent clear
        try {
            await MirageSafetyGates?.runBootGates?.();
        } catch (err) {
            console.error('[Mirage] Safety gates failed', err);
            MirageUI?.toast?.('Safety verification failed. Reload the page.', 'error');
            return;
        }

        S().thinkingModel = MirageModels.resolveThinkingModel(S().thinkingModel, S().apiProvider);
        if (MirageModels.isGrokThinking?.(S().thinkingModel)) {
            S().sceneThinkingModel = S().thinkingModel;
        } else {
            S().sceneThinkingModel = MirageModels.resolveThinkingModel(
                S().sceneThinkingModel || MirageModels.defaultSceneThinking?.(S().apiProvider),
                S().apiProvider
            );
        }
        S().imageModel = MirageModels.resolveImageModel(S().imageModel, S().apiProvider);
        S().saveConfig();

        try {
            MirageUserProfiles?.ensureSeed?.();
        } catch (e) {
            console.warn('[Mirage] User profile seed failed', e);
        }

        try {
            const mig = await MirageProfileStore?.migrateLegacyAnchorsToIdb?.();
            if (mig?.migrated > 0) {
                const mb = mig.freedApproxBytes
                    ? ` (~${Math.max(1, Math.round(mig.freedApproxBytes / (1024 * 1024)))} MB freed)`
                    : '';
                MirageUI.toast(
                    `Moved ${mig.migrated} character face/body ref${mig.migrated === 1 ? '' : 's'} out of browser storage${mb}.`,
                    'success',
                    7000
                );
            }
        } catch (e) {
            console.warn('[Mirage] Anchor migration failed', e);
        }

        populateModelSelects(S().apiProvider);
        MirageUI.updateApiKeyBadge(!!S().activeApiKey() || !!(S().developerMode && S().mockThinking));
        MirageUI.updateStepper(0);
        MirageUI.showPanel('step-0');
        MirageUI.refreshEngineStatus?.();
        updateHeaderNav();
        refreshStepperNav();

        const bindSafely = (label, fn) => {
            try {
                fn?.();
            } catch (err) {
                console.error(`[Mirage] ${label} bind failed`, err);
                MirageUI?.toast?.(
                    `${label} failed to start — check the browser console. Other features may still work.`,
                    'error',
                    9000
                );
            }
        };

        bindConfigModal();
        bindHeaderNav();
        bindWelcome();
        bindSafely('Media setup', () => MirageSetupMedia.bindMediaStep());
        bindSafely('Face setup', () => MirageSetupFace.bindFaceStep());
        bindSafely('Profile setup', () => MirageSetupProfile.bindProfileStep());
        bindSafely('Protocol setup', () => MirageSetupProtocol.bindProtocolStep());
        bindSafely('Characters', () => MirageCharactersUI.bind());
        bindSafely('User profiles', () => MirageUserProfilesUI?.bind?.());
        bindSafely('Chats', () => MirageChatsUI.bind());
        bindSafely('Simulation', () => MirageSimulation.bind());
        bindSafely('Control deck', () => MirageControlDeck.bind());
        bindSafely('Command autocomplete', () => MirageCommandAutocomplete.bind());
        bindSafely('Phone UX', () => MiragePhoneUX?.bind?.());
        bindSafely('Calendar', () => {
            const ready = MirageCalendar?.ensureReady?.(S()?.profile);
            if (ready && typeof ready.then === 'function') {
                ready.catch((err) => {
                    console.warn('[Mirage] Holiday catalog', err);
                });
            }
        });
        bindSafely('Immersion', () => MirageImmersion.bind());
        bindSafely('Debug panel', () => MirageDebugPanel.bind());

        global.MirageApp = {
            goToSetupStep,
            navigateStepper,
            getMaxUnlockedStep,
            isStepUnlocked,
            isReviewNavigation,
            refreshStepperNav,
            updateHeaderNav,
            restoreUiSession,
            verifyPromptArchitecture,
            runFullConnectionTest,
            syncDeveloperUi: () => {
                MirageDebugPanel?.setVisible?.(!!S().developerMode);
                MirageDebugPanel?.refresh?.();
                MirageSimulation?.syncChatDevVisibility?.();
            }
        };
        verifyPromptArchitecture();
        MirageDebugPanel.setVisible(!!S().developerMode);
        try {
            await restoreUiSession();
        } catch (err) {
            console.warn('[Mirage] Session restore failed', err);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        init().catch(err => console.error('[Mirage] Init failed', err));
    });
})(typeof window !== 'undefined' ? window : globalThis);
