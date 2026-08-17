/**
 * MIRAGE ENGINE v2 — Segment 4: Starting protocol + standby handoff
 */
(function () {
    'use strict';

    const S = () => EngineState;

    const PROTOCOLS = ['A', 'B1', 'B2', 'B3'];
    const STORY_PROTOCOLS = ['B1', 'B2', 'B3'];

    function cardId(option) {
        return `protocolCard${option}`;
    }

    function isStoryProtocol(protocol) {
        return STORY_PROTOCOLS.includes(protocol);
    }

    function shouldAutoLaunchStory(state) {
        const sess = state?.session || S().session;
        const story = isStoryProtocol(sess.protocol) || sess.mode === 'STORY';
        return story && !(sess.history?.length);
    }

    function getStoryLaunchInput(state) {
        const sess = state?.session || S().session;
        if (sess.protocol === 'B3' && sess.directorScene?.trim()) {
            return `VIEW STORY: ${sess.directorScene.trim()}`;
        }
        if (sess.protocol === 'B2') {
            return 'VIEW STORY — SHUFFLE: invent an unexpected scene that fits her local clock in LIVE STATE (not necessarily "right now" wall time). Outfit/env should feel like a random slice of her life.';
        }
        if (sess.protocol === 'B1') {
            return 'VIEW STORY — SYNC: open a Story that matches her current location and the live local clock in LIVE STATE.';
        }
        return 'VIEW STORY';
    }

    function storyLaunchMessage(state) {
        const sess = state?.session || S().session;
        if (sess.protocol === 'B1') {
            return 'Generating her first Instagram Story (synced to her location & live local time)…';
        }
        if (sess.protocol === 'B2') {
            return 'Generating her first Instagram Story (randomized scene + shuffled local time)…';
        }
        if (sess.protocol === 'B3') {
            return sess.directorScene?.trim()
                ? `Generating her first Instagram Story: ${sess.directorScene.trim()}…`
                : 'Generating her first Instagram Story…';
        }
        return 'Generating her first Instagram Story…';
    }

    function clearCardSelection() {
        PROTOCOLS.forEach(opt => {
            document.getElementById(cardId(opt))?.classList.remove('selected');
        });
        const director = document.getElementById('directorSceneInput');
        if (director) director.hidden = true;
    }

    function formatProtocolLabel(protocol, mode) {
        if (protocol === 'A') return 'DM';
        if (protocol === 'B1') return 'Story · Location sync';
        if (protocol === 'B2') return 'Story · Random';
        if (protocol === 'B3') return 'Story · Director';
        if (mode === 'STORY') return 'Story';
        if (mode === 'DM') return 'DM';
        const leftover = String(protocol || mode || '').trim();
        if (!leftover || leftover.toLowerCase() === 'unset') return 'Chat';
        return leftover;
    }

    function syncProtocolFromSession() {
        const option = S().session.protocol;
        if (!option || !PROTOCOLS.includes(option)) return;

        clearCardSelection();
        document.getElementById(cardId(option))?.classList.add('selected');

        const director = document.getElementById('directorSceneInput');
        if (option === 'B3' && director) {
            director.hidden = false;
            director.value = S().session.directorScene || '';
        } else if (director) {
            director.hidden = true;
        }

        if (S().session.phase === 'standby') renderStandby();
    }

    function selectProtocol(option) {
        S().session.protocol = option;
        clearCardSelection();
        document.getElementById(cardId(option))?.classList.add('selected');

        const initBtn = document.getElementById('btnInitializeSimulation');
        const director = document.getElementById('directorSceneInput');

        if (option === 'A') {
            S().session.mode = 'DM';
            S().session.directorScene = '';
            S().session.startInstruction = 'Send your first message to start the conversation.';
        } else if (option === 'B1') {
            S().session.mode = 'STORY';
            S().session.directorScene = '';
            S().session.startInstruction = 'Launch Simulation — her first Story generates automatically (location/time sync).';
        } else if (option === 'B2') {
            S().session.mode = 'STORY';
            S().session.directorScene = '';
            S().session.startInstruction = 'Launch Simulation — her first Story generates automatically (randomized).';
        } else if (option === 'B3') {
            S().session.mode = 'STORY';
            if (director) director.hidden = false;
            const custom = director?.value.trim() || '';
            S().session.directorScene = custom;
            S().session.startInstruction = custom
                ? `Launch Simulation — first Story: “${custom}”.`
                : 'Describe the scene below, then initialize.';
        }

        if (initBtn) initBtn.disabled = false;
    }

    function initializeSimulation() {
        if (!S().session.protocol) {
            MirageUI.toast('Select a starting protocol first.', 'error');
            return;
        }

        if (S().session.protocol === 'B3') {
            const custom = document.getElementById('directorSceneInput')?.value.trim() || '';
            S().session.directorScene = custom;
            if (!custom) {
                MirageUI.toast('Describe the director scene for Story — Director first.', 'error');
                return;
            }
            S().session.startInstruction = `Launch Simulation — first Story: “${custom}”.`;
        }

        S().resetSimulationRuntime({ keepProtocol: true });
        S().session.phase = 'standby';
        MirageUI.refreshEngineStatus?.();
        MirageUI.toast('Setup complete — ready to start.', 'success', 6000);
        window.MirageApp?.goToSetupStep(5, { force: true });
        renderStandby();
    }

    const RUNTIME_METRICS = [
        { cmd: 'AROUSAL (0–100)', effect: '0–30 Neutral · 31–70 Flirty · 71–100 Horny. Drives flirt intensity and subtext.' },
        { cmd: 'TEASE_LEVEL (0–3)', effect: 'Decoupled from arousal. 0 Settled · 1 Pulled · 2 Showing · 3 On the edge. Wear THIS outfit + photo closeness. Never invent straps.' },
        { cmd: 'AWARENESS (0–100)', effect: 'Derealization / fourth-wall sensitivity. High = more meta or uncanny.' },
        { cmd: 'THERMAL_STATUS', effect: 'Normal · Sweaty · Overheating — sweat/sheen and exertion in visuals.' },
        { cmd: 'MOOD + INTENSITY', effect: 'Emotional state label + 0–3. Colours text, delivery, and photo expression. /set_emotional_state.' },
        { cmd: 'ENGAGEMENT', effect: 'Attention/investment 0–100 (cold→hot). Orthogonal to arousal.' }
    ];

    function esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderCompactRefList(containerId, items, type) {
        const el = document.getElementById(containerId);
        if (!el || !Array.isArray(items) || !items.length) return;

        el.innerHTML = items.map(item => {
            if (type === 'persona') {
                return `<div class="ref-row">
                    <code>${esc(item.usage)}</code>
                    <span>${esc(item.effect)}</span>
                </div>`;
            }
            return `<div class="ref-row">
                <code>${esc(item.cmd)}</code>
                <span>${esc(item.effect)}</span>
            </div>`;
        }).join('');
    }

    function characterDisplayName() {
        if (typeof MirageSetupProfile?.displayName === 'function') {
            return MirageSetupProfile.displayName(S().profile);
        }
        return String(S().profile?.name || S().profile?.autoFillCache?.name || '').trim() || 'Character';
    }

    function promptRefList(kind) {
        try {
            if (kind === 'persona' && Array.isArray(window.MiragePrompt?.RUNTIME_PERSONAS)) {
                return window.MiragePrompt.RUNTIME_PERSONAS;
            }
            if (kind === 'command' && Array.isArray(window.MiragePrompt?.RUNTIME_COMMANDS)) {
                return window.MiragePrompt.RUNTIME_COMMANDS;
            }
        } catch { /* ignore */ }
        return [];
    }

    function renderStandby() {
        const modeEl = document.getElementById('standbyMode');
        const protocolEl = document.getElementById('standbyProtocol');
        const instructionEl = document.getElementById('standbyInstruction');
        const nameEl = document.getElementById('standbyCharacterName');
        const launchBtn = document.getElementById('btnLaunchSimulation');

        if (modeEl) modeEl.textContent = S().session.mode || 'Unset';
        if (protocolEl) {
            protocolEl.textContent = formatProtocolLabel(S().session.protocol, S().session.mode);
        }
        if (instructionEl) instructionEl.textContent = S().session.startInstruction || '—';
        if (nameEl) nameEl.textContent = characterDisplayName();
        if (launchBtn) {
            launchBtn.textContent = isStoryProtocol(S().session.protocol)
                ? 'Launch Simulation → (Story auto-generates)'
                : 'Launch Simulation →';
        }

        const resumeHint = document.getElementById('standbyResumeHint');
        if (resumeHint) {
            try {
                const key = MirageChatStore?.characterKey?.(S());
                const chatCount = key ? MirageChatStore.listChats(key).length : 0;
                if (chatCount > 0) {
                    resumeHint.hidden = false;
                    resumeHint.textContent = `${chatCount} saved chat${chatCount === 1 ? '' : 's'} — Launch starts fresh with the protocol above. Continue saved chat restores that chat’s own protocol and history.`;
                } else {
                    resumeHint.hidden = true;
                    resumeHint.textContent = '';
                }
            } catch {
                resumeHint.hidden = true;
            }
        }

        try {
            renderCompactRefList('standbyCommandsList', promptRefList('command'), 'command');
            renderCompactRefList('standbyPersonasList', promptRefList('persona'), 'persona');
            renderCompactRefList('standbyMetricsList', RUNTIME_METRICS, 'command');
        } catch (err) {
            console.warn('[Mirage] Standby reference lists failed', err);
        }
    }

    function onEnterStep4() {
        if (S().session.phase === 'active' || S().session.phase === 'standby') {
            if (S().session.protocol) selectProtocol(S().session.protocol);
            else clearCardSelection();
            return;
        }
        if (!MirageSetupProfile?.identityReady?.(S().profile)) {
            MirageUI.toast('Complete the identity profile first.', 'error');
            window.MirageApp?.goToSetupStep(3);
            return;
        }

        if (S().session.protocol) {
            selectProtocol(S().session.protocol);
        } else {
            clearCardSelection();
            const initBtn = document.getElementById('btnInitializeSimulation');
            if (initBtn) initBtn.disabled = true;
        }
    }

    function onEnterStep5() {
        if (S().session.phase === 'active') {
            renderStandby();
            return;
        }
        if (S().session.phase !== 'standby') {
            MirageUI.toast('Initialize the simulation from Protocol first.', 'error');
            window.MirageApp?.goToSetupStep(4);
            return;
        }
        renderStandby();
    }

    function bindProtocolStep() {
        PROTOCOLS.forEach(opt => {
            document.getElementById(cardId(opt))?.addEventListener('click', () => selectProtocol(opt));
        });

        document.getElementById('directorSceneInput')?.addEventListener('input', () => {
            if (S().session.protocol === 'B3') selectProtocol('B3');
        });

        document.getElementById('btnInitializeSimulation')?.addEventListener('click', initializeSimulation);

        document.getElementById('btnLaunchSimulation')?.addEventListener('click', () => {
            Promise.resolve(MirageSimulation.launch()).catch((err) => {
                console.error('[Mirage] Launch failed', err);
                MirageUI.toast(err?.message || 'Could not start the simulation.', 'error');
            });
        });

        if (S().session.phase === 'standby') {
            renderStandby();
        }
    }

    window.MirageSetupProtocol = {
        bindProtocolStep,
        onEnterStep4,
        onEnterStep5,
        renderStandby,
        syncProtocolFromSession,
        formatProtocolLabel,
        isStoryProtocol,
        shouldAutoLaunchStory,
        getStoryLaunchInput,
        storyLaunchMessage
    };
})();
