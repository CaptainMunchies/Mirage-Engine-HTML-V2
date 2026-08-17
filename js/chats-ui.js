/**
 * MIRAGE ENGINE v2 — Saved chats UI (list / load / new per character)
 */
(function () {
    'use strict';

    const S = () => EngineState;

    function formatDate(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleString(undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
        } catch {
            return iso;
        }
    }

    function openModal() {
        const modal = document.getElementById('chatsModal');
        if (!modal) return;
        modal.hidden = false;

        const hint = document.getElementById('chatsModalHint');
        const newBtn = document.getElementById('btnNewChat');
        const onStandby = S().session.phase === 'standby';

        if (hint) {
            hint.textContent = onStandby
                ? 'Each chat keeps its own protocol and history. Continue one to jump in — Launch on standby starts a fresh sim with your selected protocol.'
                : 'Each chat saves metrics, message history, and her latest turn image. Continue another chat or start fresh with current session settings.';
        }
        if (newBtn) newBtn.hidden = onStandby;

        renderList();
    }

    function closeModal() {
        const modal = document.getElementById('chatsModal');
        if (modal) modal.hidden = true;
        try {
            if (MiragePhoneUX?.operatorAttendingChat?.()) MiragePhoneUX.onOperatorAttending();
        } catch { /* ignore */ }
    }

    function charKey() {
        return MirageChatStore.characterKey(S());
    }

    function protocolBadge(chat) {
        return MirageSetupProtocol?.formatProtocolLabel?.(chat.protocol, chat.mode)
            || chat.mode
            || 'Chat';
    }

    function renderList() {
        const list = document.getElementById('chatsList');
        const empty = document.getElementById('chatsEmpty');
        const title = document.getElementById('chatsModalTitle');
        if (!list) return;

        const key = charKey();
        const name = S().profile?.name || 'Character';
        if (title) title.textContent = `Saved Chats · ${name}`;

        const chats = key ? MirageChatStore.listChats(key) : [];
        list.innerHTML = '';

        if (empty) empty.hidden = chats.length > 0;

        chats.forEach(chat => {
            const item = document.createElement('div');
            item.className = 'chat-save-item';
            if (chat.id === S().session.activeChatId) item.classList.add('active');

            const preview = chat.lastTurn?.ai
                || (chat.history?.length ? chat.history[chat.history.length - 1].ai : 'Empty chat');

            const meta = document.createElement('div');
            meta.className = 'chat-save-meta';
            meta.innerHTML = `
                <strong>${MirageUI.escapeHtml(chat.label || 'Untitled chat')}</strong>
                <span>${protocolBadge(chat)} · ${chat.history?.length || 0} turns · ${formatDate(chat.updatedAt)}</span>
                <p class="chat-save-preview">${MirageUI.escapeHtml(String(preview || '').slice(0, 120))}</p>
            `;

            const actions = document.createElement('div');
            actions.className = 'chat-save-actions';

            const loadBtn = document.createElement('button');
            loadBtn.type = 'button';
            loadBtn.className = 'btn btn-sm';
            loadBtn.textContent = chat.id === S().session.activeChatId && S().session.phase === 'active'
                ? 'Active'
                : 'Continue';
            loadBtn.disabled = chat.id === S().session.activeChatId && S().session.phase === 'active';
            loadBtn.addEventListener('click', () => loadChat(chat.id));

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'btn btn-ghost btn-sm';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => deleteChat(chat.id, chat.label));

            actions.appendChild(loadBtn);
            actions.appendChild(delBtn);
            item.appendChild(meta);
            item.appendChild(actions);
            list.appendChild(item);
        });
    }

    async function loadChat(chatId) {
        const key = charKey();
        if (!key) {
            MirageUI.toast('Name or save your character first.', 'error');
            return;
        }
        if (!S().hasApiAccess()) {
            MirageUI.refreshEngineStatus?.();
            MirageUI.toast('Configure your API key in Settings before continuing a chat.', 'error');
            const cfg = document.getElementById('configModal');
            if (cfg) cfg.hidden = false;
            return;
        }

        MirageSimulation?.quarantineChatBoundary?.();

        const chat = MirageChatStore.setActiveChat(S(), chatId);
        if (!chat) {
            MirageUI.toast('Chat not found.', 'error');
            renderList();
            return;
        }

        MirageSetupProtocol.syncProtocolFromSession?.();
        closeModal();

        S().session.phase = 'active';
        MirageDebugPanel?.syncChatScope?.();
        MirageUI.refreshEngineStatus?.();
        const reachedSim = window.MirageApp?.goToSetupStep(6, { force: true });
        if (!reachedSim) MirageSimulation.onEnter?.();
        await MirageSimulation.restoreChatUi();
        MirageSimulation.updateStoryControls?.();

        const badge = protocolBadge({
            protocol: S().session.protocol,
            mode: S().session.mode
        });
        MirageUI.toast(`Continued “${chat.label}” (${badge}).`, 'success');
    }

    function startNewChat() {
        const key = charKey();
        if (!key) {
            MirageUI.toast('Name or save your character first.', 'error');
            return;
        }

        try {
            MirageSimulation?.quarantineChatBoundary?.();
            MirageChatStore.createChat(S(), { resetMetrics: true });
            MiragePendingTurn.clear();
            MirageUI.toast('New chat started.', 'success');
            closeModal();

            if (S().session.phase === 'active') {
                MirageSimulation.resetChatUi();
                MirageSimulation.updateStoryControls?.();
                MirageSimulation.syncUserProfileUi?.();
            } else {
                MirageSimulation.syncUserProfileUi?.();
            }
        } catch (err) {
            MirageUI.toast(err.message || 'Could not start chat.', 'error');
        }
    }

    function deleteChat(chatId, label) {
        const key = charKey();
        if (!key) return;
        const name = label || 'this chat';
        if (!confirm(`Delete saved chat “${name}”?`)) return;

        const wasActive = S().session.activeChatId === chatId;
        MirageChatStore.deleteChat(key, chatId);
        if (wasActive) {
            MirageSimulation?.quarantineChatBoundary?.();
            const remaining = MirageChatStore.listChats(key);
            if (remaining[0]) {
                MirageChatStore.setActiveChat(S(), remaining[0].id);
                if (S().session.phase === 'active') {
                    MirageSimulation.resetChatUi?.();
                    MirageSimulation.restoreChatUi?.();
                }
            } else {
                S().resetSimulationRuntime?.({ keepProtocol: true });
                S().session.activeChatId = null;
                if (S().session.phase === 'active') {
                    MirageSimulation.resetChatUi?.();
                }
            }
        }

        MirageUI.toast('Chat deleted.', 'success');
        renderList();
    }

    function bind() {
        document.getElementById('btnOpenChats')?.addEventListener('click', openModal);
        document.getElementById('btnOpenChatsStandby')?.addEventListener('click', openModal);
        document.getElementById('btnCloseChats')?.addEventListener('click', closeModal);
        document.getElementById('btnCloseChatsFooter')?.addEventListener('click', closeModal);
        document.getElementById('btnNewChat')?.addEventListener('click', startNewChat);

        const modal = document.getElementById('chatsModal');
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        modal?.querySelector('.modal')?.addEventListener('click', (e) => e.stopPropagation());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal && !modal.hidden) closeModal();
        });
    }

    window.MirageChatsUI = { bind, openModal, renderList, startNewChat, continueChat: loadChat };
})();
