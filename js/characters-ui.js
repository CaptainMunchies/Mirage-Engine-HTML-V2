/**
 * MIRAGE ENGINE v2 — Saved characters UI (save / load / delete)
 */
(function () {
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

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'btn btn-ghost btn-sm';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => deleteCharacter(entry.id, entry.label));

            actions.appendChild(loadBtn);
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

        const badge = MirageSetupProtocol?.formatProtocolLabel?.(latest.protocol, latest.mode) || latest.mode || 'Chat';
        const preview = latest.lastTurn?.ai
            || (latest.history?.length ? latest.history[latest.history.length - 1].ai : 'Empty chat');

        if (latestTag) latestTag.textContent = badge;
        if (latestMeta) {
            latestMeta.textContent = `“${(latest.label || 'Untitled').slice(0, 48)}” · ${latest.history?.length || 0} turns · ${String(preview || '').slice(0, 80)}`;
        }
        if (continueBtn) continueBtn.disabled = !latest;

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

    function deleteCharacter(id, label) {
        const name = label || 'this character';
        if (!confirm(`Delete saved character “${name}”?`)) return;

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
            let entry = typeof MirageProfileStore.saveWithAnchors === 'function'
                ? await MirageProfileStore.saveWithAnchors({
                    id: saveId,
                    label: saveLabel,
                    snapshot: snap,
                    state: S()
                })
                : MirageProfileStore.save({
                    id: saveId,
                    label: saveLabel,
                    snapshot: snap
                });

            if (typeof MirageMediaLibrary?.savePhotosFromMediaFiles === 'function') {
                const meta = await MirageMediaLibrary.savePhotosFromMediaFiles(
                    entry.id,
                    S().mediaFiles
                );
                snap.mediaLibrary = meta;
                snap.masterFace = entry.snapshot?.masterFace || snap.masterFace;
                snap.masterBody = entry.snapshot?.masterBody || snap.masterBody;
                entry = MirageProfileStore.save({
                    id: entry.id,
                    label: entry.label,
                    snapshot: snap
                });
                const photos = (typeof MirageMediaLibrary.listPhotos === 'function'
                    ? MirageMediaLibrary.listPhotos(S().mediaFiles)
                    : S().mediaFiles.filter(f => String(f.type || '').startsWith('image/')));
                S().mediaLibrary = meta.map((m, i) => ({
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

    window.MirageCharactersUI = {
        bind,
        open: openModal,
        saveCurrentCharacter,
        startNewCharacterDraft,
        isEditingLoadedCharacter,
        renderList,
        refreshWelcome: renderWelcomeCharacters
    };
})();
