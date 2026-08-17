/* MIRAGE ENGINE v2 — UI helpers */
(function (global) {
    'use strict';

    let playerToastEl = null;
    const PLAYER_STATUS = {
        'NEED KEY': 'Needs API key',
        'ACTIVE': 'Ready',
        'GENERATING': 'Working',
        'WAITING': 'Waiting',
        'STANDBY': 'Standby',
        'SYSTEM STANDBY': 'Standby',
        'LOADED': 'Loaded',
        'OFFLINE': 'Offline',
        'ERROR': 'Error',
        'ANALYZING': 'Scanning photos',
        'EDF READY': 'Scan complete',
        'SCAN FAILED': 'Scan failed',
        'FACE LOCKED': 'Face locked',
        'FACE LOCK STANDBY': 'Pick a face',
        'PROFILE SET': 'Profile saved'
    };

    function isDevMode() {
        return !!(typeof EngineState !== 'undefined' && EngineState.developerMode);
    }

    function isSimActive() {
        const phase = typeof EngineState !== 'undefined' ? EngineState.session?.phase : '';
        return phase === 'active' || phase === 'standby';
    }

    function simPanelVisible() {
        const panel = document.querySelector('[data-panel="step-6"]');
        return !!(panel && !panel.hidden);
    }

    function ensureToastRoot(id, className, parent) {
        let el = document.getElementById(id);
        if (el) return el;
        el = document.createElement('div');
        el.id = id;
        el.className = className;
        el.setAttribute('aria-live', 'polite');
        (parent || document.body).appendChild(el);
        return el;
    }

    function playerToastHost() {
        if (simPanelVisible()) {
            const local = document.getElementById('toast-root-player');
            if (local) return local;
        }
        return ensureToastRoot(
            'toast-root-player-global',
            'toast-root toast-root-player-global',
            document.body
        );
    }

    function devToastHost() {
        return ensureToastRoot('toast-root-dev', 'toast-root toast-root-dev', document.body);
    }

    function toneFromType(type) {
        if (type === 'error') return 'error';
        if (type === 'success' || type === 'ok') return 'ok';
        if (type === 'warn' || type === 'warning') return 'warn';
        return 'info';
    }

    function parseToastOpts(durationOrOpts) {
        const opts = { duration: null, essential: false, lane: null };
        if (durationOrOpts && typeof durationOrOpts === 'object') {
            if (Number.isFinite(Number(durationOrOpts.duration))) {
                opts.duration = Number(durationOrOpts.duration);
            }
            opts.essential = !!durationOrOpts.essential;
            if (durationOrOpts.lane === 'dev' || durationOrOpts.lane === 'player') {
                opts.lane = durationOrOpts.lane;
            }
        } else if (Number.isFinite(Number(durationOrOpts))) {
            opts.duration = Number(durationOrOpts);
        }
        return opts;
    }

    function inferLane(tone, essential) {
        if (tone === 'error' || tone === 'ok' || essential) return 'player';
        if (isSimActive()) return 'dev';
        return 'player';
    }

    function dismissEl(el) {
        if (!el) return;
        el.classList.remove('show');
        setTimeout(() => el.remove(), 280);
    }

    function showToastEl(host, el, duration) {
        host.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => dismissEl(el), duration);
    }

    /**
     * Two visual lanes:
     *   player — plain English, sim column (or bottom-center during setup)
     *   dev    — persisted in the debug panel DEV log (no vanishing toast)
     */
    function notify({
        lane = 'player',
        surface = 'toast',
        tone = 'info',
        title = '',
        body = '',
        duration = null,
        essential = false
    } = {}) {
        const text = String(body || title || '').trim();
        if (!text) return;

        if (surface === 'caption') {
            if (typeof window.MirageSimulation?.appendCaption === 'function') {
                window.MirageSimulation.appendCaption(text);
            }
            return;
        }
        if (surface !== 'toast') return;

        const resolvedLane = lane === 'dev' ? 'dev' : 'player';
        if (resolvedLane === 'dev') {
            if (typeof window.MirageDebugPanel?.pushNotice === 'function') {
                window.MirageDebugPanel.pushNotice({
                    kind: 'notice',
                    tone,
                    summary: text
                });
            }
            return;
        }

        const host = playerToastHost();
        if (playerToastEl) dismissEl(playerToastEl);
        const el = document.createElement('div');
        el.className = `toast toast-player toast-${tone}`;
        el.textContent = text;
        playerToastEl = el;
        const ms = duration
            || (tone === 'error' ? 6000 : 3000);
        showToastEl(host, el, ms);
        setTimeout(() => {
            if (playerToastEl === el) playerToastEl = null;
        }, ms + 300);
    }

    /**
     * Toast popup.
     * toast(msg, type, duration)
     * toast(msg, type, { duration, essential, lane: 'player'|'dev' })
     *
     * Errors and essential confirmations are player-lane.
     * Other info toasts during a live sim are developer-lane (hidden unless Dev Mode).
     */
    function toast(message, type = 'info', durationOrOpts = 4000) {
        const parsed = parseToastOpts(durationOrOpts);
        const tone = toneFromType(type);
        const lane = parsed.lane || inferLane(tone, parsed.essential);
        notify({
            lane,
            surface: 'toast',
            tone,
            body: message,
            duration: parsed.duration,
            essential: parsed.essential
        });
    }

    function displayStatusLabel(text) {
        const raw = String(text || '').trim() || 'STANDBY';
        if (isDevMode()) return raw;
        const mapped = PLAYER_STATUS[raw.toUpperCase()];
        if (mapped) return mapped;
        return raw.charAt(0) + raw.slice(1).toLowerCase();
    }

    function applyStatus(text, variant = 'idle') {
        const badge = document.getElementById('engineStatus');
        if (!badge) return;
        badge.textContent = displayStatusLabel(text);
        badge.dataset.variant = variant;
    }

    function canRunSimulation() {
        return !!(typeof EngineState !== 'undefined' && EngineState.hasApiAccess?.());
    }

    /**
     * ACTIVE / green playable states only when a turn can actually run.
     * No key (and no mock thinking) → NEED KEY, even if a character/chat was loaded.
     */
    function setStatus(text, variant = 'idle') {
        const label = String(text || '').trim();
        const upper = label.toUpperCase();
        const claimsReady = upper === 'ACTIVE'
            || upper === 'GENERATING'
            || upper === 'WAITING'
            || upper === 'SYSTEM STANDBY'
            || variant === 'active';
        if (!canRunSimulation() && claimsReady) {
            applyStatus('NEED KEY', 'error');
            return;
        }
        applyStatus(label || 'STANDBY', variant);
    }

    function refreshEngineStatus() {
        const s = typeof EngineState !== 'undefined' ? EngineState : null;
        if (!s) {
            applyStatus('OFFLINE', 'idle');
            return;
        }
        if (!s.hasApiAccess?.()) {
            applyStatus('NEED KEY', 'error');
            return;
        }
        const phase = s.session?.phase;
        if (phase === 'active') {
            applyStatus('ACTIVE', 'active');
            return;
        }
        if (phase === 'standby') {
            applyStatus('STANDBY', 'idle');
            return;
        }
        if (s.activeCharacterId || s.profile?.name) {
            applyStatus('LOADED', 'idle');
            return;
        }
        applyStatus('STANDBY', 'idle');
    }

    function setLoading(isLoading, label = 'Working…') {
        const overlay = document.getElementById('loadingOverlay');
        if (!overlay) return;
        overlay.hidden = !isLoading;
        const labelEl = overlay.querySelector('.loading-label');
        if (labelEl) labelEl.textContent = label;
    }

    function setSimGenerating(isActive, { phase = 'thinking', label } = {}) {
        const bar = document.getElementById('simGenBar');
        if (bar) {
            bar.hidden = !isActive;
            bar.dataset.phase = phase;
            const labelEl = bar.querySelector('.sim-gen-label');
            if (labelEl) {
                labelEl.textContent = label || (
                    phase === 'image' ? 'Taking a photo… this can take a few minutes'
                        : phase === 'waiting' ? 'Waiting for her…'
                            : 'She’s thinking…'
                );
            }
        }
        document.querySelector('.phone-shell')?.classList.toggle('phone-generating', isActive);
        document.querySelector('.sim-console')?.classList.toggle('sim-console-busy', isActive);
    }

    function updateApiKeyBadge(isSet) {
        const el = document.getElementById('apiKeyBadge');
        if (!el) return;
        const provider = (typeof EngineState !== 'undefined' && EngineState.apiProvider === 'kie')
            ? 'kie.ai'
            : 'Google';
        if (isSet) {
            el.textContent = `API: ${provider}`;
            el.classList.add('ok');
        } else {
            el.textContent = 'API Key: Required';
            el.classList.remove('ok');
        }
        refreshKieCredits();
    }

    function formatKieCredits(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return '—';
        if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
        if (v >= 10) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
        return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    let creditsFetchSeq = 0;

    async function refreshKieCredits() {
        const el = document.getElementById('kieCreditsBadge');
        if (!el) return;
        const kie = typeof EngineState !== 'undefined' && EngineState.apiProvider === 'kie';
        const key = kie ? (EngineState.kieApiKey || '') : '';
        if (!kie || !key) {
            el.hidden = true;
            el.textContent = '';
            el.removeAttribute('title');
            return;
        }
        el.hidden = false;
        const seq = ++creditsFetchSeq;
        try {
            const n = await MirageKieAPI?.getCredits?.(key);
            if (seq !== creditsFetchSeq) return;
            if (n == null) {
                el.textContent = 'Credits: —';
                return;
            }
            el.textContent = `Credits: ${formatKieCredits(n)}`;
            el.classList.toggle('low', Number(n) < 20);
            el.title = 'kie.ai account balance';
        } catch (err) {
            if (seq !== creditsFetchSeq) return;
            el.textContent = 'Credits: —';
            el.title = err?.message || 'Could not load kie credits';
        }
    }

    function updateStepper(stepIndex) {
        document.querySelectorAll('[data-step]').forEach((node) => {
            const n = parseInt(node.dataset.step, 10);
            node.classList.remove('active', 'done');
            if (n < stepIndex) node.classList.add('done');
            if (n === stepIndex) node.classList.add('active');
        });
    }

    function showPanel(panelId) {
        document.querySelectorAll('[data-panel]').forEach(p => {
            p.hidden = p.dataset.panel !== panelId;
        });
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function isStorageQuotaError(err) {
        if (!err) return false;
        if (err.code === 'STORAGE_QUOTA' || err.name === 'QuotaExceededError') return true;
        const msg = String(err.message || err);
        return /quotaexceeded|storage full|browser storage is full/i.test(msg);
    }

    function makeStorageQuotaError(message) {
        const err = new Error(message || 'Browser storage is full.');
        err.code = 'STORAGE_QUOTA';
        err.name = 'QuotaExceededError';
        return err;
    }

    let storageFullBound = false;

    function closeStorageFullDialog() {
        const modal = document.getElementById('storageFullModal');
        if (modal) modal.hidden = true;
    }

    function bindStorageFullDialog() {
        if (storageFullBound) return;
        storageFullBound = true;
        const modal = document.getElementById('storageFullModal');
        if (!modal) return;

        document.getElementById('btnCloseStorageFull')?.addEventListener('click', closeStorageFullDialog);
        document.getElementById('btnStorageFullOk')?.addEventListener('click', closeStorageFullDialog);
        document.getElementById('btnStorageFullManageChars')?.addEventListener('click', () => {
            closeStorageFullDialog();
            try {
                MirageCharactersUI?.open?.();
            } catch { /* ignore */ }
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeStorageFullDialog();
        });
        modal.querySelector('.modal')?.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal && !modal.hidden) closeStorageFullDialog();
        });
    }

    /**
     * @param {{ context?: string }} [opts]
     * context — short line like "Couldn’t save this character."
     */
    function showStorageFullDialog({ context } = {}) {
        bindStorageFullDialog();
        const modal = document.getElementById('storageFullModal');
        const ctxEl = document.getElementById('storageFullContext');
        if (ctxEl) {
            if (context) {
                ctxEl.hidden = false;
                ctxEl.textContent = context;
            } else {
                ctxEl.hidden = true;
                ctxEl.textContent = '';
            }
        }
        if (modal) modal.hidden = false;
        else {
            toast(
                'Browser storage is full (~5 MB). Delete unused characters or chats, or use a smaller face/body image.',
                'error',
                12000
            );
        }
    }

    global.MirageUI = {
        toast,
        notify,
        setStatus,
        refreshEngineStatus,
        setLoading,
        setSimGenerating,
        updateApiKeyBadge,
        refreshKieCredits,
        updateStepper,
        showPanel,
        escapeHtml,
        isStorageQuotaError,
        makeStorageQuotaError,
        showStorageFullDialog,
        closeStorageFullDialog
    };
})(window);
