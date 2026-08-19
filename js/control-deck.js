/**
 * MIRAGE ENGINE v2 — Control deck
 *
 * Sticky state the operator owns outright (persona, thermal) gets a control here and reaches the
 * model through the LIVE STATE block on the next turn. Directive controls send a turn immediately.
 * Numeric metrics are deliberately absent — they are text commands with autocomplete.
 */
(function (global) {
    'use strict';

    const S = () => global.EngineState;

    const personas = () => (global.MiragePrompt?.RUNTIME_PERSONAS || []).map(p => ({ value: p.id, hint: p.effect }));

    const commandEffect = (cmd) =>
        (global.MiragePrompt?.RUNTIME_COMMANDS || [])
            .find(c => c.cmd === cmd || c.cmd.startsWith(`${cmd} [`))?.effect || '';

    const DIRECTIVES = [
        { label: 'Next scene', cmd: '/next scene' },
        {
            label: 'Change outfit',
            cmd: '/change outfit',
            arg: 'Describe the new outfit — leave blank and she picks',
            requireArg: false
        },
        {
            label: 'God mode…',
            cmd: '/instruct',
            arg: 'Tell her what to do (Enter to send, Shift+Enter for a new line)',
            requireArg: true,
            multiline: true
        },
        { label: 'Fit check', cmd: '/fit check' },
        { label: 'Fourth wall', cmd: '/fourth wall' },
        {
            label: 'Time pass…',
            cmd: '/time pass',
            arg: 'How long? e.g. 2 hours, 1 month, 1 year',
            preview: 'time_pass',
            requireArg: true
        },
        {
            label: 'Jump to…',
            cmd: '/jump',
            arg: 'Describe the scenario to jump into',
            preview: 'jump',
            requireArg: true
        }
    ];

    let pendingArg = null;

    function el(id) {
        return document.getElementById(id);
    }

    function pill(label, { hint = '', onClick } = {}) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'deck-pill';
        btn.textContent = label;
        if (hint) btn.title = hint;
        btn.addEventListener('click', onClick);
        return btn;
    }

    function buildPills(container, items, onPick) {
        if (!container) return;
        container.textContent = '';
        items.forEach(item => {
            const btn = pill(item.value, {
                hint: item.hint,
                onClick: () => onPick(item.value)
            });
            btn.dataset.value = item.value;
            container.appendChild(btn);
        });
    }

    function buildDirectives() {
        const wrap = el('deckDirectives');
        if (!wrap) return;
        wrap.textContent = '';

        // Always available: let her text first (proactive beat). Instant fires right away.
        const waitBtn = document.createElement('button');
        waitBtn.type = 'button';
        waitBtn.className = 'btn btn-ghost btn-sm deck-queue';
        waitBtn.id = 'btnWaitForHer';
        waitBtn.textContent = 'Wait for her…';
        waitBtn.title = 'Let her take the next beat (DM, Story, or a small time skip if she would have moved on). Soft continuation — same clothes. Not /next scene (that one hard-cuts to a new outfit and location). Cancels the 3-min no-reply chase for this click; the chase arms again after she posts if you still stay quiet.';
        waitBtn.addEventListener('click', () => MirageImmersion?.waitForHer?.());
        wrap.appendChild(waitBtn);

        DIRECTIVES.forEach(directive => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-ghost btn-sm deck-action';
            btn.textContent = directive.label;
            const hint = commandEffect(directive.cmd);
            if (hint) btn.title = hint;
            btn.dataset.directive = directive.cmd;
            if (directive.cmd === '/fourth wall') {
                btn.dataset.fourthWall = '1';
            }
            btn.addEventListener('click', () => {
                if (directive.arg != null || directive.preview) {
                    openArgPrompt(directive);
                } else {
                    send(directive.cmd);
                }
            });
            wrap.appendChild(btn);
        });
    }

    function updateArgPreview() {
        const preview = el('deckArgPreview');
        if (!preview) return;
        if (!pendingArg?.preview) {
            preview.hidden = true;
            preview.textContent = '';
            return;
        }
        const input = el('deckArgInput');
        const text = input?.value.trim() || '';
        const ms = typeof MiragePhoneUX?.estimateDirectiveAdvanceMs === 'function'
            ? MiragePhoneUX.estimateDirectiveAdvanceMs(pendingArg.preview, text)
            : null;
        if (ms == null || !(ms > 0)) {
            const now = typeof MiragePhoneUX?.herNow === 'function' ? MiragePhoneUX.herNow() : new Date();
            const tz = MiragePhoneUX?.resolveTimeZone?.(S()?.profile?.location);
            const clock = typeof MiragePhoneUX?.formatClock === 'function'
                ? MiragePhoneUX.formatClock(now, tz)
                : '';
            preview.hidden = !clock;
            preview.textContent = clock ? `${clock} → …` : '';
            return;
        }
        const arrow = typeof MiragePhoneUX?.formatClockArrow === 'function'
            ? MiragePhoneUX.formatClockArrow(ms, MiragePhoneUX.herNow?.()?.getTime?.())
            : '';
        preview.hidden = !arrow;
        preview.textContent = arrow || '';
    }

    function openArgPrompt(directive) {
        pendingArg = directive;
        const row = el('deckArgRow');
        const input = el('deckArgInput');
        if (!row || !input) return;
        row.hidden = false;
        input.placeholder = directive.arg || '';
        input.value = '';
        input.classList.toggle('is-multiline', !!directive.multiline);
        if ('rows' in input) input.rows = directive.multiline ? 5 : 1;
        updateArgPreview();
        input.focus();
    }

    function closeArgPrompt() {
        pendingArg = null;
        const row = el('deckArgRow');
        if (row) row.hidden = true;
        const input = el('deckArgInput');
        if (input) {
            input.classList.remove('is-multiline');
            if ('rows' in input) input.rows = 1;
            input.value = '';
        }
        const preview = el('deckArgPreview');
        if (preview) {
            preview.hidden = true;
            preview.textContent = '';
        }
    }

    function submitArgPrompt() {
        const input = el('deckArgInput');
        const value = input?.value.trim() || '';
        if (!pendingArg) return;
        const optional = pendingArg.requireArg === false;
        if (!optional && !value) {
            MirageUI?.toast?.(
                `${pendingArg.label} needs something to work with — type it or press Escape.`,
                'error'
            );
            input?.focus();
            return;
        }
        const cmd = value ? `${pendingArg.cmd} ${value}` : pendingArg.cmd;
        closeArgPrompt();
        send(cmd);
    }

    function send(command) {
        // Hard busy only — soft waits can still be interrupted by a directive.
        if (MirageSimulation?.isHardBusy?.() ?? MirageSimulation?.isTurnInProgress?.()) return;
        MirageSimulation?.executeTurn?.(command);
    }

    function setPersona(value) {
        S().session.persona = MiragePrompt.normalizePersonaId?.(value) || value;
        MirageSimulation?.updateHud?.();
        MirageUI?.toast?.(`Persona locked to ${S().session.persona} — absolute, next turn.`, 'info', {
            essential: true
        });
        sync();
    }

    function setThermal(value) {
        S().setOperatorOverride('thermal', value);
        MirageSimulation?.updateHud?.();
    }

    function markActive(container, activeValue) {
        if (!container) return;
        Array.from(container.children).forEach(child => {
            child.classList.toggle('is-active', child.dataset.value === activeValue);
            child.setAttribute('aria-pressed', String(child.dataset.value === activeValue));
        });
    }

    function pendingSummary(sess) {
        const overrides = sess.operatorOverrides || {};
        const parts = Object.entries(overrides).map(([key, val]) => `${key} ${val}`);
        return parts;
    }

    /** Reflect live session state into the deck. Safe to call on every HUD update. */
    function sync() {
        const deck = el('controlDeck');
        if (!deck) return;
        const sess = S().session;

        markActive(el('deckPersonas'), sess.persona);
        markActive(el('deckThermal'), sess.thermal);

        // Match simulation syncSimControls: grey out (don't hide) while the engine is busy.
        // Hard busy = thinking/image; soft busy = delivery / wall wait.
        const clockHold = !!S()?.session?.clockResumeHold;
        const hardBusy = !!(MirageSimulation?.isHardBusy?.() ?? MirageSimulation?.isTurnInProgress?.());
        const engineBusy = !!(MirageSimulation?.isEngineBusy?.() ?? hardBusy) || clockHold;

        deck.querySelectorAll('.deck-action').forEach(btn => {
            if (btn.dataset.fourthWall === '1' && sess.awakeningActive) {
                btn.disabled = true;
                btn.textContent = sess.awakeningStage === 'awakened' ? 'Awakened' : 'Awakening…';
                btn.title = 'Awakening Sequence is irreversible and already running.';
            } else {
                btn.disabled = hardBusy || clockHold;
                if (btn.dataset.fourthWall === '1') {
                    btn.textContent = 'Fourth wall';
                    btn.title = commandEffect('/fourth wall');
                }
            }
        });

        deck.querySelectorAll('.deck-pill').forEach(btn => {
            btn.disabled = hardBusy || clockHold;
        });

        const argInput = el('deckArgInput');
        const argSend = el('btnDeckArgSend');
        if (argInput) argInput.disabled = hardBusy || clockHold;
        if (argSend) argSend.disabled = hardBusy || clockHold;

        const waitBtn = el('btnWaitForHer');
        if (waitBtn) {
            waitBtn.hidden = false;
            waitBtn.disabled = engineBusy;
            waitBtn.title = clockHold
                ? 'Pick how to handle the time gap first.'
                : MirageImmersion?.pacingMode?.() === 'instant'
                    ? 'Generate another message from her without texting first.'
                    : 'Let her text (or Story) first — no need to send a message.';
        }

        const pending = el('deckPending');
        if (pending) {
            const parts = pendingSummary(sess);
            pending.hidden = parts.length === 0;
            pending.textContent = parts.length
                ? `Queued: ${parts.join(' · ')}`
                : '';
        }
    }

    function toggleDeck(force) {
        const body = el('controlDeckBody');
        const toggle = el('btnToggleDeck');
        if (!body || !toggle) return;
        const open = force != null ? force : body.hidden;
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
    }

    function bind() {
        if (!el('controlDeck')) return;

        buildPills(el('deckPersonas'), personas(), setPersona);
        buildPills(
            el('deckThermal'),
            S().THERMAL_VALUES.map(v => ({ value: v })),
            setThermal
        );
        buildDirectives();

        el('btnToggleDeck')?.addEventListener('click', () => toggleDeck());
        el('btnDeckArgSend')?.addEventListener('click', submitArgPrompt);
        el('btnDeckArgCancel')?.addEventListener('click', closeArgPrompt);
        el('deckArgInput')?.addEventListener('input', updateArgPreview);
        el('deckArgInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeArgPrompt();
                return;
            }
            if (e.key === 'Enter') {
                if (e.shiftKey) return;
                e.preventDefault();
                submitArgPrompt();
            }
        });

        sync();
    }

    global.MirageControlDeck = { bind, sync, toggleDeck };
})(typeof window !== 'undefined' ? window : globalThis);
