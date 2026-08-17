/**
 * MIRAGE ENGINE v2 — Command autocomplete for the chat bar
 *
 * Every runtime command is discoverable by typing "/". The catalogue is derived from
 * MiragePrompt.RUNTIME_COMMANDS so it can never drift from what the router actually accepts.
 */
(function (global) {
    'use strict';

    const INPUT_ID = 'simInput';
    const LIST_ID = 'cmdAutocomplete';

    let matches = [];
    let activeIndex = 0;
    let isOpen = false;

    const input = () => document.getElementById(INPUT_ID);
    const list = () => document.getElementById(LIST_ID);

    /** Split "/time pass [duration]" into its base command and placeholder. */
    function parseEntry(entry) {
        const raw = String(entry.cmd || '').trim();
        const bracket = raw.indexOf('[');
        return {
            base: (bracket === -1 ? raw : raw.slice(0, bracket)).trim(),
            hasArg: bracket !== -1,
            effect: entry.effect || ''
        };
    }

    /**
     * Enum-style commands expand into one ready-to-send row per value; free-text commands insert
     * the base plus a space so the operator can type the argument.
     */
    function buildCatalogue() {
        const commands = global.MiragePrompt?.RUNTIME_COMMANDS || [];
        const personas = global.MiragePrompt?.RUNTIME_PERSONAS || [];
        const thermals = global.EngineState?.THERMAL_VALUES || [];
        const moods = global.MiragePrompt?.MOOD_VALUES || [];
        const out = [];

        commands.forEach(entry => {
            const { base, hasArg, effect } = parseEntry(entry);

            if (base === '/persona' && personas.length) {
                personas.forEach(p => out.push({
                    value: `/persona ${p.id.toLowerCase()}`,
                    label: `/persona ${p.id.toLowerCase()}`,
                    hint: p.effect
                }));
                return;
            }

            if (base === '/thermal' && thermals.length) {
                thermals.forEach(t => out.push({
                    value: `/thermal ${String(t).toLowerCase()}`,
                    label: `/thermal ${String(t).toLowerCase()}`,
                    hint: effect
                }));
                return;
            }

            if ((base === '/set_emotional_state' || base === '/mood') && moods.length) {
                moods.forEach(m => out.push({
                    value: `${base} ${m}`,
                    label: `${base} ${m}`,
                    hint: effect
                }));
                return;
            }

            out.push({
                value: hasArg ? `${base} ` : base,
                label: entry.cmd,
                hint: effect
            });
        });

        return out;
    }

    function findMatches(text) {
        const q = text.toLowerCase();
        if (!q.startsWith('/')) return [];

        // Only ever suggest something that adds to what is already typed. Once the text is a
        // complete command there is nothing left to complete, so the list closes and Enter sends.
        const all = buildCatalogue().filter(e => e.value.toLowerCase() !== q);

        // Past the first space the operator is typing an argument of their own.
        if (/\s/.test(text)) {
            return all.filter(e =>
                e.value.length > text.length && e.value.toLowerCase().startsWith(q));
        }

        const prefix = all.filter(e => e.value.toLowerCase().startsWith(q));
        if (prefix.length) return prefix;

        const token = q.slice(1);
        return token ? all.filter(e => e.label.toLowerCase().includes(token)) : all;
    }

    function render() {
        const ul = list();
        if (!ul) return;

        ul.textContent = '';
        matches.forEach((entry, i) => {
            const li = document.createElement('li');
            li.className = 'cmd-option' + (i === activeIndex ? ' is-active' : '');
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', String(i === activeIndex));

            const code = document.createElement('code');
            code.textContent = entry.label;

            const hint = document.createElement('span');
            hint.textContent = entry.hint;

            li.append(code, hint);
            // mousedown, not click — the input must not blur before the value is applied.
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                accept(i);
            });
            ul.appendChild(li);
        });

        ul.scrollTop = 0;
        ul.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    }

    function open() {
        const ul = list();
        if (!ul) return;
        ul.hidden = false;
        isOpen = true;
        input()?.setAttribute('aria-expanded', 'true');
    }

    function close() {
        const ul = list();
        if (!ul) return;
        ul.hidden = true;
        ul.textContent = '';
        isOpen = false;
        matches = [];
        activeIndex = 0;
        input()?.setAttribute('aria-expanded', 'false');
    }

    function refresh() {
        const el = input();
        if (!el || el.disabled) return close();

        const text = el.value;
        if (!text.startsWith('/')) return close();

        matches = findMatches(text);
        if (!matches.length) return close();

        activeIndex = 0;
        open();
        render();
    }

    function accept(index) {
        const entry = matches[index];
        const el = input();
        if (!entry || !el) return;

        el.value = entry.value;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        refresh();
    }

    function move(delta) {
        if (!matches.length) return;
        activeIndex = (activeIndex + delta + matches.length) % matches.length;
        render();
    }

    function onKeyDown(e) {
        if (!isOpen || e.target !== input()) return;

        switch (e.key) {
            case 'ArrowDown':
            case 'ArrowUp':
                e.preventDefault();
                e.stopPropagation();
                move(e.key === 'ArrowDown' ? 1 : -1);
                break;
            case 'Enter':
            case 'Tab':
                // Consume before the send handler — Enter completes the suggestion instead.
                e.preventDefault();
                e.stopPropagation();
                accept(activeIndex);
                break;
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                close();
                break;
            default:
                break;
        }
    }

    function bind() {
        const el = input();
        if (!el || !list()) return;

        el.addEventListener('input', refresh);
        el.addEventListener('blur', () => setTimeout(close, 0));
        el.addEventListener('focus', refresh);

        // Capture on document so this runs before the send-on-Enter handler bound to the input,
        // regardless of module bind order.
        document.addEventListener('keydown', onKeyDown, true);
    }

    global.MirageCommandAutocomplete = { bind, close };
})(typeof window !== 'undefined' ? window : globalThis);
