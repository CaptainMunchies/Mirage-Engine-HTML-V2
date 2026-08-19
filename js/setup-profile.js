/**
 * MIRAGE ENGINE v2 — Segment 3: Identity profile
 */
(function () {
    'use strict';

    const S = () => EngineState;

    const INFER_DISPLAY = 'Infer using available media and context';
    const LOYALTY_INFER = '__autofill__';
    const PROFILE_FIELDS = [
        { key: 'name', id: 'profName', type: 'input' },
        { key: 'age', id: 'profAge', type: 'input' },
        { key: 'archetype', id: 'profArchetype', type: 'input' },
        { key: 'relationship', id: 'profRelationship', type: 'input' },
        { key: 'location', id: 'profLocation', type: 'input' },
        { key: 'timezone', id: 'profTimezone', type: 'select', defaultValue: '' },
        { key: 'personality', id: 'profPersonality', type: 'input' },
        { key: 'loyalty', id: 'profLoyalty', type: 'select', defaultValue: 'Medium (Balanced)' },
        { key: 'notes', id: 'profNotes', type: 'textarea' }
    ];

    /** Used when Intl.supportedValuesOf is unavailable — covers the CITY_TZ range. */
    const FALLBACK_ZONES = [
        'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Tijuana',
        'America/Phoenix', 'America/Denver', 'America/Edmonton', 'America/Chicago',
        'America/Mexico_City', 'America/Winnipeg', 'America/New_York', 'America/Detroit',
        'America/Toronto', 'America/Bogota', 'America/Lima', 'America/Santiago',
        'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'Atlantic/Reykjavik',
        'Europe/Dublin', 'Europe/Lisbon', 'Europe/London', 'Europe/Amsterdam', 'Europe/Berlin',
        'Europe/Brussels', 'Europe/Budapest', 'Europe/Copenhagen', 'Europe/Madrid', 'Europe/Oslo',
        'Europe/Paris', 'Europe/Prague', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Vienna',
        'Europe/Warsaw', 'Europe/Zurich', 'Europe/Athens', 'Europe/Helsinki', 'Europe/Istanbul',
        'Europe/Kyiv', 'Europe/Moscow', 'Africa/Casablanca', 'Africa/Lagos', 'Africa/Cairo',
        'Africa/Johannesburg', 'Africa/Nairobi', 'Asia/Jerusalem', 'Asia/Riyadh', 'Asia/Qatar',
        'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Jakarta',
        'Asia/Ho_Chi_Minh', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Manila',
        'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Taipei', 'Asia/Seoul', 'Asia/Tokyo',
        'Australia/Perth', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Melbourne',
        'Australia/Sydney', 'Pacific/Auckland', 'UTC'
    ];

    let timezoneSelectFilled = false;

    /** Populate the zone picker once, from the runtime's own IANA list where available. */
    function fillTimezoneSelect() {
        const select = document.getElementById('profTimezone');
        if (!select || timezoneSelectFilled) return;

        let zones = [];
        try {
            if (typeof Intl.supportedValuesOf === 'function') {
                zones = Intl.supportedValuesOf('timeZone') || [];
            }
        } catch { /* fall through to the curated list */ }
        if (!zones.length) zones = FALLBACK_ZONES;

        const frag = document.createDocumentFragment();
        zones.forEach(zone => {
            const opt = document.createElement('option');
            opt.value = zone;
            opt.textContent = zone.replace(/_/g, ' ');
            frag.appendChild(opt);
        });
        select.appendChild(frag);
        timezoneSelectFilled = true;
    }

    /**
     * Show which zone is actually in force and what her clock reads right now, so a wrong
     * Auto guess is visible at setup rather than three hours into a chat.
     */
    function updateTimezoneHint() {
        const hint = document.getElementById('profTimezoneHint');
        if (!hint) return;

        const base = 'Drives her bezel clock, last-seen, daily routine and every time-of-day cue.';
        const chosen = String(document.getElementById('profTimezone')?.value || '').trim();
        const location = isAutoFillOn('location')
            ? cachedValue('location')
            : (document.getElementById('profLocation')?.value || '');

        let zone = chosen;
        let source = 'Set';
        if (!zone) {
            zone = MiragePhoneUX?.inferTimeZoneFromLocation?.(location) || '';
            source = zone ? 'Auto' : '';
            if (!zone) {
                zone = MiragePhoneUX?.browserTimeZone?.() || 'UTC';
                source = 'Fallback';
            }
        }

        let clock = '';
        try {
            clock = new Intl.DateTimeFormat('en-US', {
                timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true
            }).format(new Date());
        } catch { /* leave the clock off if the zone is unusable */ }

        const zoneLabel = zone.replace(/_/g, ' ');
        if (source === 'Fallback') {
            hint.textContent = `${base} No match for that location — falling back to your own timezone `
                + `(${zoneLabel}${clock ? `, ${clock}` : ''}). Pick her zone explicitly.`;
        } else {
            hint.textContent = `${base} ${source}: ${zoneLabel}`
                + `${clock ? ` — ${clock} her time.` : '.'}`;
        }
    }

    /** Hidden typed values while Auto-Fill is showing the infer placeholder. */
    let autoFillCache = {};

    /** Split legacy "Mia, 22" / "גילי חגי, בת 22" into separate name + age. */
    function splitLegacyNameAge(raw) {
        const s = String(raw || '').trim();
        if (!s) return { name: '', age: '' };
        const m = s.match(/^(.*?),\s*(?:בת\s*)?(\d{1,2})\s*$/u)
            || s.match(/^(.*?)\s+[·\-–]\s*(?:בת\s*)?(\d{1,2})\s*$/u);
        if (m) return { name: m[1].trim(), age: m[2] };
        return { name: s, age: '' };
    }

    function fieldSpec(key) {
        return PROFILE_FIELDS.find(f => f.key === key) || null;
    }

    function checkboxEl(key) {
        return document.getElementById(`profAutoFill-${key}`);
    }

    function isAutoFillOn(key) {
        return !!checkboxEl(key)?.checked;
    }

    function controlEl(spec) {
        return document.getElementById(spec.id);
    }

    function readLiveValue(spec) {
        const el = controlEl(spec);
        if (!el) return '';
        if (spec.type === 'select') {
            if (el.value === LOYALTY_INFER) return '';
            return el.value || '';
        }
        const v = String(el.value || '').trim();
        return v === INFER_DISPLAY ? '' : v;
    }

    function cachedValue(key) {
        const v = autoFillCache[key];
        return v == null ? '' : String(v);
    }

    function setCachedValue(key, value) {
        autoFillCache[key] = value == null ? '' : String(value);
    }

    function ensureLoyaltyInferOption(select, show) {
        if (!select) return;
        let opt = select.querySelector('option[data-autofill-opt]');
        if (show) {
            if (!opt) {
                opt = document.createElement('option');
                opt.dataset.autofillOpt = '1';
                opt.value = LOYALTY_INFER;
                opt.textContent = INFER_DISPLAY;
                select.insertBefore(opt, select.firstChild);
            }
            select.value = LOYALTY_INFER;
        } else if (opt) {
            opt.remove();
        }
    }

    function applyAutoFillUi(key, on) {
        const spec = fieldSpec(key);
        const el = spec && controlEl(spec);
        if (!el) return;
        const wrap = el.closest('.field');
        if (wrap) wrap.classList.toggle('autofill-on', !!on);
        el.disabled = !!on;
        if (on) {
            if (spec.type === 'select') ensureLoyaltyInferOption(el, true);
            else el.value = INFER_DISPLAY;
        } else if (spec.type === 'select') {
            ensureLoyaltyInferOption(el, false);
            el.value = cachedValue(key) || spec.defaultValue || '';
        } else {
            el.value = cachedValue(key);
        }
    }

    function setAutoFill(key, on, { capture = true } = {}) {
        const spec = fieldSpec(key);
        const box = checkboxEl(key);
        if (box) box.checked = !!on;
        if (on && capture && spec) {
            setCachedValue(key, readLiveValue(spec) || cachedValue(key));
        }
        applyAutoFillUi(key, on);
    }

    function fieldSatisfied(data, key) {
        if (data?.autoFill?.[key]) return true;
        return !!(data?.[key] && String(data[key]).trim());
    }

    function identityReady(profile) {
        const p = profile || {};
        return fieldSatisfied(p, 'name') && fieldSatisfied(p, 'archetype');
    }

    function displayName(profile) {
        const p = profile || {};
        return String(p.name || p.autoFillCache?.name || '').trim() || 'Character';
    }

    function readForm() {
        const nameRaw = isAutoFillOn('name')
            ? cachedValue('name')
            : (document.getElementById('profName')?.value.trim() || '');
        let age = isAutoFillOn('age')
            ? cachedValue('age')
            : (document.getElementById('profAge')?.value.trim() || '');
        let name = nameRaw;
        if (!isAutoFillOn('name') && !age && /,\s*(?:בת\s*)?\d{1,2}\s*$/u.test(nameRaw)) {
            const split = splitLegacyNameAge(nameRaw);
            name = split.name;
            age = split.age;
        }

        const autoFill = {};
        PROFILE_FIELDS.forEach(spec => {
            autoFill[spec.key] = isAutoFillOn(spec.key);
            if (!autoFill[spec.key] && spec.key !== 'name' && spec.key !== 'age') {
                setCachedValue(spec.key, readLiveValue(spec));
            }
        });
        if (!autoFill.name) setCachedValue('name', name);
        if (!autoFill.age) setCachedValue('age', age);

        const relationship = autoFill.relationship
            ? cachedValue('relationship')
            : (readLiveValue(fieldSpec('relationship')) || 'Stranger');
        const location = autoFill.location
            ? cachedValue('location')
            : (readLiveValue(fieldSpec('location')) || 'Unset');
        // '' means "infer from location" — resolveTimeZone treats a blank as no override.
        const timezone = readLiveValue(fieldSpec('timezone'));
        const personality = autoFill.personality
            ? cachedValue('personality')
            : (readLiveValue(fieldSpec('personality')) || 'Bratty/Slang');
        const loyalty = autoFill.loyalty
            ? (cachedValue('loyalty') || 'Medium (Balanced)')
            : (readLiveValue(fieldSpec('loyalty')) || 'Medium (Balanced)');
        const archetype = autoFill.archetype
            ? cachedValue('archetype')
            : readLiveValue(fieldSpec('archetype'));
        const notes = autoFill.notes
            ? cachedValue('notes')
            : readLiveValue(fieldSpec('notes'));

        return {
            name,
            age,
            archetype,
            relationship,
            location,
            timezone,
            personality,
            loyalty,
            notes,
            autoFill,
            autoFillCache: { ...autoFillCache },
            ...(Number.isFinite(Number(S()?.profile?.libido))
                ? { libido: Math.round(Number(S().profile.libido)) }
                : {})
        };
    }

    function syncFormFromState() {
        const p = S().profile || {};
        autoFillCache = { ...(p.autoFillCache || {}) };
        fillTimezoneSelect();

        let name = p.name || autoFillCache.name || '';
        let age = p.age != null && p.age !== '' ? String(p.age) : (autoFillCache.age || '');
        if (!age && name) {
            const split = splitLegacyNameAge(name);
            if (split.age) {
                name = split.name;
                age = split.age;
            }
        }

        const values = {
            name,
            age,
            archetype: p.archetype || '',
            relationship: p.relationship || '',
            location: p.location || '',
            timezone: p.timezone || '',
            personality: p.personality || '',
            loyalty: p.loyalty || 'Medium (Balanced)',
            notes: p.notes || ''
        };
        PROFILE_FIELDS.forEach(spec => {
            if (autoFillCache[spec.key] == null || autoFillCache[spec.key] === '') {
                setCachedValue(spec.key, values[spec.key] || '');
            } else if (values[spec.key]) {
                setCachedValue(spec.key, values[spec.key]);
            }
        });

        const flags = p.autoFill || {};
        PROFILE_FIELDS.forEach(spec => {
            const on = !!flags[spec.key];
            const box = checkboxEl(spec.key);
            if (box) box.checked = on;
            const el = controlEl(spec);
            if (!el) return;
            if (!on) {
                el.disabled = false;
                if (spec.type === 'select') {
                    ensureLoyaltyInferOption(el, false);
                    el.value = cachedValue(spec.key) || spec.defaultValue || '';
                } else {
                    el.value = cachedValue(spec.key);
                }
            }
            applyAutoFillUi(spec.key, on);
        });

        updateTimezoneHint();
    }

    function updateProfileSaveUi() {
        const hint = document.getElementById('profileLibraryHint');
        const status = document.getElementById('profileCharacterStatus');
        const saveNewBtn = document.getElementById('btnSaveCharacterProfile');
        const saveUpdateBtn = document.getElementById('btnUpdateCharacterProfile');
        const saveAsNewBtn = document.getElementById('btnSaveCharacterAsNew');

        const editing = MirageCharactersUI?.isEditingLoadedCharacter?.();

        if (status) {
            if (editing) {
                status.textContent = `Editing saved character: “${S().activeCharacterLabel || S().profile?.name || 'Character'}” — Save changes updates this entry. Save as new creates a separate copy.`;
                status.className = 'profile-character-status profile-character-status-editing';
            } else {
                status.textContent = 'New character draft — not linked to any saved entry until you save.';
                status.className = 'profile-character-status profile-character-status-draft';
            }
        }

        if (saveNewBtn) saveNewBtn.hidden = !!editing;
        if (saveUpdateBtn) saveUpdateBtn.hidden = !editing;
        if (saveAsNewBtn) saveAsNewBtn.hidden = !editing;

        if (!hint) return;

        const data = readForm();
        if (!fieldSatisfied(data, 'name') || !fieldSatisfied(data, 'archetype')) {
            hint.textContent = 'Enter name and archetype (or Auto-Fill them) to save this character.';
            return;
        }

        const snap = MirageProfileStore.exportSnapshot(S(), data);
        const err = MirageProfileStore.validateSnapshot(snap, S());

        if (err) {
            hint.textContent = err;
        } else if (editing) {
            hint.textContent = 'Ready — Save changes overwrites this character. Save as new keeps the original and stores a copy.';
        } else {
            hint.textContent = 'Ready — Save character creates a new library entry.';
        }
    }

    function continueToProtocol() {
        const data = readForm();
        if (!fieldSatisfied(data, 'name') || !fieldSatisfied(data, 'archetype')) {
            MirageUI.toast('Enter a name and role/archetype, or Auto-Fill them.', 'error');
            return;
        }

        S().profile = data;
        MirageUI.setStatus('PROFILE SET', 'active');
        window.MirageApp?.goToSetupStep(4);
    }

    function saveCharacter() {
        const data = readForm();
        if (!fieldSatisfied(data, 'name') || !fieldSatisfied(data, 'archetype')) {
            MirageUI.toast('Enter name and archetype (or Auto-Fill them) before saving.', 'error');
            return;
        }
        S().profile = data;
        void MirageCharactersUI.saveCurrentCharacter({ asNew: false });
    }

    function updateCharacter() {
        const data = readForm();
        if (!fieldSatisfied(data, 'name') || !fieldSatisfied(data, 'archetype')) {
            MirageUI.toast('Enter name and archetype (or Auto-Fill them) before saving.', 'error');
            return;
        }
        if (!MirageCharactersUI.isEditingLoadedCharacter()) {
            saveCharacter();
            return;
        }
        S().profile = data;
        void MirageCharactersUI.saveCurrentCharacter({ asNew: false });
    }

    function saveCharacterAsNew() {
        const data = readForm();
        if (!fieldSatisfied(data, 'name') || !fieldSatisfied(data, 'archetype')) {
            MirageUI.toast('Enter name and archetype (or Auto-Fill them) before saving.', 'error');
            return;
        }
        S().profile = data;
        void MirageCharactersUI.saveCurrentCharacter({ asNew: true });
    }

    function onEnterStep() {
        if (S().session.phase === 'active' || S().session.phase === 'standby') {
            syncFormFromState();
            updateProfileSaveUi();
            return;
        }
        if (!S().edf) {
            MirageUI.toast('Complete media ingest first.', 'error');
            window.MirageApp?.goToSetupStep(1);
            return;
        }
        if (!S().masterFaceFile) {
            MirageUI.toast('Lock a master face first.', 'error');
            window.MirageApp?.goToSetupStep(2);
            return;
        }
        syncFormFromState();
        updateProfileSaveUi();
    }

    function bindProfileStep() {
        document.getElementById('btnSaveCharacterProfile')?.addEventListener('click', saveCharacter);
        document.getElementById('btnUpdateCharacterProfile')?.addEventListener('click', updateCharacter);
        document.getElementById('btnSaveCharacterAsNew')?.addEventListener('click', saveCharacterAsNew);
        document.getElementById('btnNewCharacterDraft')?.addEventListener('click', () => {
            if (MirageCharactersUI.isEditingLoadedCharacter()) {
                if (!confirm('Start a new character draft? Unsaved edits to the loaded character will be discarded.')) {
                    return;
                }
            }
            autoFillCache = {};
            MirageCharactersUI.startNewCharacterDraft({ goToStep: 1 });
        });
        document.getElementById('btnContinueProtocol')?.addEventListener('click', continueToProtocol);
        document.getElementById('btnLoadCharacterProfile')?.addEventListener('click', () => {
            MirageCharactersUI?.open?.();
        });

        PROFILE_FIELDS.forEach(spec => {
            checkboxEl(spec.key)?.addEventListener('change', (e) => {
                setAutoFill(spec.key, !!e.target.checked, { capture: true });
                const data = readForm();
                S().profile = { ...(S().profile || {}), ...data };
                updateProfileSaveUi();
                window.MirageApp?.refreshStepperNav?.();
            });
        });

        const onProfileFieldEdited = (e) => {
            if (e.target?.dataset?.autofill) return;
            const spec = PROFILE_FIELDS.find(f => f.id === e.target?.id);
            if (spec && !isAutoFillOn(spec.key)) {
                setCachedValue(spec.key, readLiveValue(spec));
            }
            // Location and zone both change which clock she lives on — keep the hint honest.
            if (spec && (spec.key === 'location' || spec.key === 'timezone')) updateTimezoneHint();
            updateProfileSaveUi();
        };
        document.getElementById('profileForm')?.addEventListener('input', onProfileFieldEdited);
        document.getElementById('profileForm')?.addEventListener('change', onProfileFieldEdited);
        document.getElementById('profileForm')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
                continueToProtocol();
            }
        });
    }

    window.MirageSetupProfile = {
        bindProfileStep,
        onEnterStep,
        readForm,
        syncFormFromState,
        updateProfileLibraryHint: updateProfileSaveUi,
        updateProfileSaveUi,
        saveCharacter,
        continueToProtocol,
        identityReady,
        displayName,
        fieldSatisfied,
        INFER_DISPLAY,
        INFER_PROMPT: 'Infer using media and other details present'
    };
})();
