/**
 * MIRAGE ENGINE v2 — Settings UI for operator / user profiles
 */
(function (global) {
    'use strict';

    let editingId = null;

    function el(id) {
        return document.getElementById(id);
    }

    function readForm() {
        return {
            label: el('userProfLabel')?.value?.trim() || '',
            fields: {
                displayName: el('userProfDisplayName')?.value || '',
                nickname: el('userProfNickname')?.value || '',
                age: el('userProfAge')?.value || '',
                gender: el('userProfGender')?.value || 'male',
                appearance: el('userProfAppearance')?.value || '',
                personality: el('userProfPersonality')?.value || '',
                interests: el('userProfInterests')?.value || '',
                notes: el('userProfNotes')?.value || ''
            }
        };
    }

    function fillForm(entry) {
        const blank = MirageUserProfiles.EMPTY_FIELDS;
        const src = entry || { label: '', ...blank };
        if (el('userProfLabel')) el('userProfLabel').value = src.label || '';
        if (el('userProfDisplayName')) el('userProfDisplayName').value = src.displayName || '';
        if (el('userProfNickname')) el('userProfNickname').value = src.nickname || '';
        if (el('userProfAge')) el('userProfAge').value = src.age || '';
        if (el('userProfGender')) {
            el('userProfGender').value = MirageUserProfiles.normalizeGender?.(src.gender, {
                pronouns: src.pronouns
            }) || src.gender || 'male';
        }
        if (el('userProfAppearance')) el('userProfAppearance').value = src.appearance || '';
        if (el('userProfPersonality')) el('userProfPersonality').value = src.personality || '';
        if (el('userProfInterests')) el('userProfInterests').value = src.interests || '';
        if (el('userProfNotes')) el('userProfNotes').value = src.notes || '';
    }

    function clearForm() {
        editingId = null;
        fillForm(null);
        const hint = el('userProfFormHint');
        if (hint) hint.textContent = 'New profile — save to add it to the library.';
        const saveBtn = el('btnUserProfSave');
        if (saveBtn) saveBtn.textContent = 'Save profile';
    }

    function renderList() {
        const list = el('userProfilesList');
        const empty = el('userProfilesEmpty');
        if (!list) return;

        MirageUserProfiles.ensureSeed();
        const profiles = MirageUserProfiles.list();
        const activeId = MirageUserProfiles.getActiveId();
        list.innerHTML = '';

        if (empty) empty.hidden = profiles.length > 0;

        profiles.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'user-profile-item';
            if (entry.id === activeId) item.classList.add('is-active');
            if (entry.id === editingId) item.classList.add('is-editing');

            const meta = document.createElement('div');
            meta.className = 'user-profile-item-meta';

            const title = document.createElement('strong');
            title.textContent = entry.label || 'Unnamed';
            meta.appendChild(title);

            const sub = document.createElement('span');
            const bits = [];
            if (entry.id === activeId) bits.push('Active for new chats');
            if (entry.displayName) bits.push(entry.displayName);
            if (entry.age) bits.push(`${entry.age}`);
            if (entry.nickname) {
                const himHer = MirageUserProfiles.normalizeGender?.(entry.gender, {
                    pronouns: entry.pronouns
                }) === 'female' ? 'her' : 'him';
                bits.push(`she calls ${himHer} “${entry.nickname}”`);
            }
            if (entry.gender || entry.pronouns) {
                bits.push(MirageUserProfiles.genderLabel?.(entry.gender)
                    || (MirageUserProfiles.normalizeGender?.(entry.gender, { pronouns: entry.pronouns }) === 'female'
                        ? 'Female'
                        : 'Male'));
            }
            sub.textContent = bits.join(' · ') || 'No details yet';
            meta.appendChild(sub);

            const actions = document.createElement('div');
            actions.className = 'user-profile-item-actions';

            if (entry.id !== activeId) {
                const useBtn = document.createElement('button');
                useBtn.type = 'button';
                useBtn.className = 'btn btn-sm';
                useBtn.textContent = 'Use';
                useBtn.title = 'Apply to this chat (if open) and to new chats';
                useBtn.addEventListener('click', () => {
                    MirageUserProfiles.setActive(entry.id);
                    const phase = EngineState?.session?.phase;
                    if (phase === 'active' || phase === 'standby') {
                        void MirageSimulation?.setChatUserProfile?.(entry.id);
                    } else {
                        MirageUI.toast(`New chats will use “${entry.label}”.`, 'success');
                        MirageSimulation?.syncUserProfileUi?.();
                    }
                    renderList();
                });
                actions.appendChild(useBtn);
            } else {
                const badge = document.createElement('span');
                badge.className = 'user-profile-active-badge';
                badge.textContent = 'Active';
                actions.appendChild(badge);
            }

            // The Default preset is a fixed fallback, not a profile you shape —
            // it has no Edit and no Delete. Make your own and it becomes the one
            // you edit; Default stays put at the bottom as the thing chats fall
            // back to.
            const locked = !!MirageUserProfiles.isProtected?.(entry);

            if (locked) {
                const note = document.createElement('span');
                note.className = 'user-profile-locked-note';
                note.textContent = 'Preset';
                note.title = 'The Default preset cannot be edited or deleted. Add your own profile to change how she sees you.';
                actions.appendChild(note);
            } else {
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'btn btn-ghost btn-sm';
                editBtn.textContent = 'Edit';
                editBtn.addEventListener('click', () => {
                    editingId = entry.id;
                    fillForm(entry);
                    const hint = el('userProfFormHint');
                    if (hint) hint.textContent = `Editing “${entry.label}”.`;
                    const saveBtn = el('btnUserProfSave');
                    if (saveBtn) saveBtn.textContent = 'Update profile';
                    el('userProfDisplayName')?.focus();
                });
                actions.appendChild(editBtn);
            }

            if (!locked) {
                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'btn btn-ghost btn-sm';
                delBtn.textContent = 'Delete';
                delBtn.addEventListener('click', () => {
                    if (!confirm(`Delete user profile “${entry.label}”? Existing chats keep a “(deleted)” tag until you switch them.`)) {
                        return;
                    }
                    try {
                        MirageUserProfiles.remove(entry.id);
                    } catch (e) {
                        MirageUI.toast(e.message || 'Could not delete profile.', 'error');
                        return;
                    }
                    if (editingId === entry.id) clearForm();
                    MirageUI.toast('User profile deleted.', 'success');
                    renderList();
                    MirageSimulation?.syncUserProfileUi?.();
                });
                actions.appendChild(delBtn);
            }

            item.appendChild(meta);
            item.appendChild(actions);
            list.appendChild(item);
        });
    }

    function saveForm() {
        const data = readForm();

        // Belt and braces behind the missing Edit button: nothing reaches the store
        // that would rewrite the Default preset.
        if (editingId && MirageUserProfiles.isProtected?.(editingId)) {
            MirageUI.toast(
                'The Default preset cannot be edited. Save this as a new profile instead.',
                'error'
            );
            editingId = null;
            return;
        }

        // A new profile must not be named "Default" either — that name is what
        // identifies the preset on installs predating the reserved id.
        if (!editingId && String(data.label || '').trim().toLowerCase() === 'default') {
            MirageUI.toast('“Default” is reserved for the built-in preset. Pick another name.', 'error');
            return;
        }

        try {
            const entry = MirageUserProfiles.save({
                id: editingId,
                label: data.label,
                fields: data.fields
            });
            editingId = entry.id;
            MirageUI.toast(`Saved “${entry.label}”.`, 'success');
            renderList();
            fillForm(entry);
            const hint = el('userProfFormHint');
            if (hint) hint.textContent = `Editing “${entry.label}”.`;
            const saveBtn = el('btnUserProfSave');
            if (saveBtn) saveBtn.textContent = 'Update profile';
            MirageSimulation?.syncUserProfileUi?.();
        } catch (e) {
            MirageUI.toast(e.message || 'Could not save user profile.', 'error');
        }
    }

    function refresh() {
        MirageUserProfiles.ensureSeed();
        renderList();
        if (editingId) {
            const entry = MirageUserProfiles.get(editingId);
            if (entry) fillForm(entry);
            else clearForm();
            return;
        }
        // Nothing being edited: open a blank form rather than pre-loading Default.
        // Default is no longer editable, so filling the form with it would offer an
        // Update that has to be refused.
        clearForm();
        const hint = el('userProfFormHint');
        if (hint) {
            hint.textContent = MirageUserProfiles.list().length > 1
                ? 'New profile — save to add it to the library.'
                : 'New profile — tell her who you are. Default stays as the fallback.';
        }
    }

    function bind() {
        el('btnUserProfSave')?.addEventListener('click', saveForm);
        el('btnUserProfNew')?.addEventListener('click', () => {
            clearForm();
            el('userProfLabel')?.focus();
        });
    }

    global.MirageUserProfilesUI = {
        bind,
        refresh,
        renderList
    };
})(typeof window !== 'undefined' ? window : globalThis);
