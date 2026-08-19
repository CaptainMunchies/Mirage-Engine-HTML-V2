/**
 * MIRAGE ENGINE v2 — Saved characters UI (save / load / delete)
 */
(function (global) {
    'use strict';

    const S = () => EngineState;

    function formatDate(iso) {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleString(undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
        } catch {
            return iso;
        }
    }

    function openModal() {
        const modal = document.getElementById('charactersModal');
        if (modal) modal.hidden = false;
        renderList();
    }

    function closeModal() {
        const modal = document.getElementById('charactersModal');
        if (modal) modal.hidden = true;
        try {
            if (MiragePhoneUX?.operatorAttendingChat?.()) MiragePhoneUX.onOperatorAttending();
        } catch { /* ignore */ }
    }

    function readProfileFromForm() {
        if (typeof MirageSetupProfile?.readForm === 'function') {
            return MirageSetupProfile.readForm();
        }
        return S().profile || {};
    }

    function renderList() {
        const list = document.getElementById('charactersList');
        const empty = document.getElementById('charactersEmpty');
        if (!list) return;

        const profiles = MirageProfileStore.list();
        list.innerHTML = '';

        if (empty) empty.hidden = profiles.length > 0;

        profiles.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'character-item';
            if (entry.id === S().activeCharacterId) item.classList.add('active');

            const meta = document.createElement('div');
            meta.className = 'character-item-meta';

            const title = document.createElement('strong');
            title.textContent = entry.label || entry.snapshot?.profile?.name || 'Unnamed';
            meta.appendChild(title);

            const sub = document.createElement('span');
            const archetype = entry.snapshot?.profile?.archetype
                || (entry.snapshot?.profile?.autoFill?.archetype ? 'Auto-Fill' : '—');
            sub.textContent = `${archetype} · ${formatDate(entry.updatedAt || entry.savedAt)}`;
            meta.appendChild(sub);

            const actions = document.createElement('div');
            actions.className = 'character-item-actions';

            const loadBtn = document.createElement('button');
            loadBtn.type = 'button';
            loadBtn.className = 'btn btn-sm';
            loadBtn.textContent = 'Load';
            loadBtn.addEventListener('click', () => loadCharacter(entry.id));

            const exportBtn = document.createElement('button');
            exportBtn.type = 'button';
            exportBtn.className = 'btn btn-ghost btn-sm';
            exportBtn.textContent = 'Export';
            exportBtn.title = 'Save this character, its chats, face lock and photos to a .mirage file';
            exportBtn.addEventListener('click', () => exportCharacter(entry.id, entry.label, exportBtn));

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'btn btn-ghost btn-sm';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => deleteCharacter(entry.id, entry.label));

            actions.appendChild(loadBtn);
            actions.appendChild(exportBtn);
            actions.appendChild(delBtn);

            item.appendChild(meta);
            item.appendChild(actions);
            list.appendChild(item);
        });
    }

    function refreshSetupUi() {
        MirageSetupMedia?.refresh?.();
        MirageSetupFace?.renderFaceGrid?.();
        MirageSetupProfile?.syncFormFromState?.();
        MirageSetupProfile?.updateProfileSaveUi?.();
    }

    function isEditingLoadedCharacter() {
        return !!S().activeCharacterId;
    }

    function startNewCharacterDraft({ goToStep = 1, toast = true } = {}) {
        S().activeCharacterId = null;
        S().activeCharacterLabel = null;
        S().profile = {};
        S().edf = null;
        S().mediaFiles = [];
        S().mediaLibrary = [];
        S().clearCharacterAnchors();
        S().resetSimulationRuntime({ keepProtocol: false });
        S().session.phase = 'setup';

        if (!S().hasApiAccess()) {
            MirageUI.refreshEngineStatus?.();
            MirageUI.toast('Configure your API key in Settings to continue setup.', 'error');
            const cfg = document.getElementById('configModal');
            if (cfg) cfg.hidden = false;
            return;
        }

        MirageSetupProfile?.syncFormFromState?.();
        MirageSetupProfile?.updateProfileSaveUi?.();
        MirageSetupMedia?.refresh?.();
        MirageSetupFace?.renderFaceGrid?.();
        window.MirageApp?.refreshStepperNav?.();

        if (goToStep != null) {
            window.MirageApp?.goToSetupStep(goToStep);
        }
        if (toast) {
            MirageUI.toast('New character draft — not linked to any saved entry.', 'success');
        }
    }

    function resolveSetupStep(state) {
        if (MirageSetupProfile?.identityReady?.(state.profile)) return 4;
        if (state.masterFaceFile && state.edf) return 3;
        if (state.edf) return 2;
        return 1;
    }

    function beginNewSimulation() {
        MirageSimulation?.quarantineChatBoundary?.();
        S().resetSimulationRuntime({ keepProtocol: false });
        S().session.phase = 'idle';
        MirageLoyaltyUX?.resetSession?.();
        MirageDebugPanel?.setLastTurn?.(null);
        MirageDebugPanel?.setLastPrompt?.(null);
        MirageDebugPanel?.syncChatScope?.();
        if (!S().hasApiAccess()) {
            MirageUI.refreshEngineStatus?.();
            MirageUI.toast('Configure your API key in Settings to continue setup.', 'error');
            const cfg = document.getElementById('configModal');
            if (cfg) cfg.hidden = false;
            return;
        }
        const step = resolveSetupStep(S());
        window.MirageApp?.goToSetupStep(step >= 4 ? 4 : step);
        MirageUI.refreshEngineStatus?.();
    }

    async function continueLatestChat(charKey) {
        const chat = MirageChatStore.getMostRecentChat(charKey);
        if (!chat) {
            MirageUI.toast('No saved chats found.', 'error');
            return false;
        }
        await MirageChatsUI.continueChat(chat.id);
        return true;
    }

    function openSessionChoice(entry) {
        const modal = document.getElementById('sessionChoiceModal');
        if (!modal) {
            beginNewSimulation();
            return;
        }

        const chats = MirageChatStore.listChats(entry.id);
        const latest = MirageChatStore.getMostRecentChat(entry.id) || chats[0];
        const name = entry.label || entry.snapshot?.profile?.name || 'Character';

        const title = document.getElementById('sessionChoiceTitle');
        const lead = document.getElementById('sessionChoiceLead');
        const latestTag = document.getElementById('sessionChoiceLatestTag');
        const latestMeta = document.getElementById('sessionChoiceLatestMeta');
        const continueBtn = document.getElementById('btnSessionContinue');

        if (title) title.textContent = `${name} — how do you want to play?`;
        if (lead) {
            lead.textContent = chats.length === 1
                ? '1 saved chat on file. Start a new simulation or continue where you left off.'
                : `${chats.length} saved chats on file. Start fresh or pick up an existing conversation.`;
        }

        // The null check used to sit three lines below the first dereference of
        // `latest`. Safe only because the one caller checks chatCount > 0 first —
        // a second caller would throw here. Check before reading, not after.
        if (continueBtn) continueBtn.disabled = !latest;
        if (latest) {
            const badge = MirageSetupProtocol?.formatProtocolLabel?.(latest.protocol, latest.mode)
                || latest.mode || 'Chat';
            const preview = latest.lastTurn?.ai
                || (latest.history?.length ? latest.history[latest.history.length - 1].ai : 'Empty chat');
            if (latestTag) latestTag.textContent = badge;
            if (latestMeta) {
                latestMeta.textContent = `“${(latest.label || 'Untitled').slice(0, 48)}” · `
                    + `${MirageChatStore.formatTurnCount(latest)} · ${String(preview || '').slice(0, 80)}`;
            }
        } else {
            if (latestTag) latestTag.textContent = '';
            if (latestMeta) latestMeta.textContent = 'No saved chats yet.';
        }

        modal.hidden = false;
        modal.dataset.characterId = entry.id;
    }

    function closeSessionChoice() {
        const modal = document.getElementById('sessionChoiceModal');
        if (modal) modal.hidden = true;
    }

    function finishCharacterLoad(entry, { skipChoice = false } = {}) {
        const chatCount = MirageChatStore.listChats(entry.id).length;
        if (!skipChoice && chatCount > 0) {
            openSessionChoice(entry);
            return;
        }

        beginNewSimulation();
        MirageUI.toast(
            resolveSetupStep(S()) >= 4
                ? `Loaded ${entry.label}. Pick your starting protocol.`
                : `Loaded ${entry.label}.`,
            'success'
        );
    }

    async function loadCharacter(id) {
        const entry = MirageProfileStore.get(id);
        if (!entry) {
            MirageUI.toast('Character not found.', 'error');
            renderList();
            return;
        }

        try {
            await MirageProfileStore.applyToState(S(), entry);
            MirageChatStore.onCharacterLoaded(S(), entry.id);
            refreshSetupUi();
            MirageSetupProfile?.updateProfileSaveUi?.();
            MirageUI.refreshEngineStatus?.();
            renderWelcomeCharacters();
            closeModal();
            finishCharacterLoad(entry);
        } catch (err) {
            MirageUI.toast(err.message || 'Failed to load character.', 'error');
        }
    }

    function bindSessionChoice() {
        const modal = document.getElementById('sessionChoiceModal');
        if (!modal) return;

        document.getElementById('btnSessionNew')?.addEventListener('click', () => {
            closeSessionChoice();
            beginNewSimulation();
            MirageUI.toast('New simulation — pick your starting protocol.', 'success');
        });

        document.getElementById('btnSessionContinue')?.addEventListener('click', async () => {
            const charId = modal.dataset.characterId || S().activeCharacterId;
            closeSessionChoice();
            if (!charId) return;
            await continueLatestChat(charId);
        });

        document.getElementById('btnSessionBrowse')?.addEventListener('click', () => {
            closeSessionChoice();
            beginNewSimulation();
            MirageChatsUI.openModal();
        });

        document.getElementById('btnCloseSessionChoice')?.addEventListener('click', () => {
            closeSessionChoice();
            beginNewSimulation();
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeSessionChoice();
                beginNewSimulation();
            }
        });
        modal.querySelector('.modal')?.addEventListener('click', (e) => e.stopPropagation());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal && !modal.hidden) {
                closeSessionChoice();
                beginNewSimulation();
            }
        });
    }

    /** Save one character — profile, chats, anchors, photos, turn images — to a file. */
    async function exportCharacter(id, label, btn) {
        const original = btn?.textContent;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Saving…';
        }
        try {
            const includeImages = document.getElementById('checkBackupPhotos')?.checked !== false;
            const res = await MirageBackup.exportCharacter(id, {
                includePhotos: includeImages,
                includeTurnImages: includeImages,
                includeUserProfiles: false
            });
            MirageUI.toast(
                `Exported “${label || 'character'}” (${MirageBackup ? formatBytes(res.bytes) : ''}).`,
                'success'
            );
        } catch (err) {
            console.error('[Mirage] Character export failed', err);
            MirageUI.toast(err?.message || 'Export failed.', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = original || 'Export';
            }
        }
    }

    function formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    function deleteCharacter(id, label) {
        const name = label || 'this character';
        // Say what actually goes. This destroys her chats, her face lock, her anchors
        // and her whole photo library — a five-step wizard plus a photo ingest — and
        // there is no undo. Now that export exists, point at it.
        const chats = MirageChatStore.listChats(id).length;
        if (!confirm(
            `Delete “${name}” permanently?\n\n`
            + `This removes her ${chats} saved chat${chats === 1 ? '' : 's'}, her face lock, `
            + 'her body reference and every photo in her library. It cannot be undone.\n\n'
            + 'Cancel and use Export on this character first if you might want her back.'
        )) return;

        MirageProfileStore.remove(id);
        MirageChatStore.removeCharacter(id);
        MirageImageStore.removeByPrefix(`${id}-`).catch(() => {});
        if (S().activeCharacterId === id) {
            S().activeCharacterId = null;
            S().activeCharacterLabel = null;
        }
        MirageUI.toast('Character deleted.', 'success');
        renderList();
        renderWelcomeCharacters();
        MirageSetupProfile?.updateProfileSaveUi?.();
    }

    async function saveCurrentCharacter({ asNew = false } = {}) {
        const snap = MirageProfileStore.exportSnapshot(S(), readProfileFromForm());
        const err = MirageProfileStore.validateSnapshot(snap, S());
        if (err) {
            MirageUI.toast(err, 'error');
            return false;
        }

        const editingId = S().activeCharacterId;
        const saveId = asNew ? null : (editingId || null);

        const saveLabel = String(snap.profile?.name || '').trim()
            || (snap.profile?.autoFill?.name ? 'Auto character' : 'Character');

        try {
            const priorKey = MirageChatStore.characterKey(S());
            const canSavePhotos = typeof MirageMediaLibrary?.savePhotosFromMediaFiles === 'function';
            let mediaMeta = null;

            // One localStorage write, not two: the photo metadata is folded into the
            // same snapshot the record is saved from. Previously a quota failure on
            // the second write left the anchors persisted and the metadata lost.
            const entry = await MirageProfileStore.saveWithAnchors({
                id: saveId,
                label: saveLabel,
                snapshot: snap,
                state: S(),
                async enrich(entryId, resolvedSnapshot) {
                    if (!canSavePhotos) return resolvedSnapshot;
                    mediaMeta = await MirageMediaLibrary.savePhotosFromMediaFiles(
                        entryId,
                        S().mediaFiles
                    );
                    return { ...resolvedSnapshot, mediaLibrary: mediaMeta };
                }
            });

            if (mediaMeta) {
                const photos = (typeof MirageMediaLibrary.listPhotos === 'function'
                    ? MirageMediaLibrary.listPhotos(S().mediaFiles)
                    : S().mediaFiles.filter(f => String(f.type || '').startsWith('image/')));
                S().mediaLibrary = mediaMeta.map((m, i) => ({
                    ...m,
                    file: photos[i] || null
                })).filter(p => p.file);
            }

            if (!asNew && priorKey && priorKey !== entry.id) {
                MirageChatStore.migrate(priorKey, entry.id);
            }

            S().activeCharacterId = entry.id;
            S().activeCharacterLabel = entry.label;
            S().profile = { ...snap.profile };

            MirageSetupProfile?.syncFormFromState?.();
            MirageSetupProfile?.updateProfileSaveUi?.();

            if (asNew && editingId) {
                MirageUI.toast(`Saved new character “${entry.label}”.`, 'success');
            } else if (editingId && !asNew) {
                MirageUI.toast(`Updated “${entry.label}”.`, 'success');
            } else {
                MirageUI.toast(`Saved “${entry.label}”.`, 'success');
            }

            renderList();
            renderWelcomeCharacters();
            return true;
        } catch (e) {
            if (typeof MirageUI?.isStorageQuotaError === 'function' && MirageUI.isStorageQuotaError(e)) {
                MirageUI.showStorageFullDialog({
                    context: 'Your character was not saved.'
                });
            } else {
                MirageUI.toast(e.message || 'Save failed.', 'error', 8000);
            }
            return false;
        }
    }

    function bind() {
        document.getElementById('btnOpenCharacters')?.addEventListener('click', openModal);
        document.getElementById('btnOpenCharactersWelcome')?.addEventListener('click', openModal);
        document.getElementById('btnCloseCharacters')?.addEventListener('click', closeModal);
        document.getElementById('btnCloseCharactersFooter')?.addEventListener('click', closeModal);

        const modal = document.getElementById('charactersModal');
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        modal?.querySelector('.modal')?.addEventListener('click', (e) => e.stopPropagation());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal && !modal.hidden) closeModal();
        });

        renderWelcomeCharacters();
        bindSessionChoice();
    }

    function renderWelcomeCharacters() {
        const card = document.getElementById('welcomeCharactersCard');
        const list = document.getElementById('welcomeCharactersList');
        if (!card || !list) return;

        const profiles = MirageProfileStore.list();
        if (!profiles.length) {
            card.hidden = true;
            return;
        }

        card.hidden = false;
        list.innerHTML = '';

        profiles.slice(0, 6).forEach(entry => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn character-quick-load';
            btn.textContent = entry.label || entry.snapshot?.profile?.name || 'Unnamed';
            btn.addEventListener('click', () => loadCharacter(entry.id));
            list.appendChild(btn);
        });
    }

    global.MirageCharactersUI = {
        bind,
        open: openModal,
        saveCurrentCharacter,
        startNewCharacterDraft,
        isEditingLoadedCharacter,
        renderList,
        refreshWelcome: renderWelcomeCharacters
    };
})(typeof window !== 'undefined' ? window : globalThis);
