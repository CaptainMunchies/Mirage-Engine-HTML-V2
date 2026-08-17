/**
 * MIRAGE ENGINE v2 — Product safety gates (Phase 1.1–1.3)
 *
 * 1.1 Hard 18+ age gate (DOB + acknowledgment) — first screen until verified
 * 1.2 Fiction / consent checklist — once, localStorage
 * 1.3 Upload interstitial on media / face / body ingest
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'mirage_v2_safety';
    const CONSENT_VERSION = 1;
    const UPLOAD_COPY_VERSION = 1;

    let bootReady = false;
    let uploadResolver = null;

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return {};
            const data = JSON.parse(raw);
            return data && typeof data === 'object' ? data : {};
        } catch {
            return {};
        }
    }

    function save(patch) {
        const next = { ...load(), ...patch };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
    }

    function isAgeVerified() {
        const age = load().ageGate;
        return !!(age && age.verified === true && age.dob);
    }

    function isFictionConsented() {
        const c = load().fictionConsent;
        return !!(c && c.accepted === true && Number(c.version) === CONSENT_VERSION);
    }

    function isBootComplete() {
        return isAgeVerified() && isFictionConsented();
    }

    function ageFromDob(dobStr) {
        const m = String(dobStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        const dob = new Date(y, mo - 1, d);
        if (dob.getFullYear() !== y || dob.getMonth() !== mo - 1 || dob.getDate() !== d) return null;
        const today = new Date();
        let age = today.getFullYear() - y;
        const beforeBirthday =
            today.getMonth() < dob.getMonth()
            || (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate());
        if (beforeBirthday) age -= 1;
        return age;
    }

    function setGateVisible(id, on) {
        const el = document.getElementById(id);
        if (!el) return;
        el.hidden = !on;
        if (on) {
            el.setAttribute('aria-hidden', 'false');
        } else {
            el.setAttribute('aria-hidden', 'true');
        }
    }

    function hideAllBootGates() {
        setGateVisible('ageGateOverlay', false);
        setGateVisible('fictionConsentOverlay', false);
    }

    function fillDobYearOptions() {
        const yearSel = document.getElementById('ageGateYear');
        if (!yearSel || yearSel.options.length > 1) return;
        const now = new Date().getFullYear();
        // Adults only UI range — still validated server-side style in JS
        for (let y = now - 18; y >= now - 100; y -= 1) {
            const opt = document.createElement('option');
            opt.value = String(y);
            opt.textContent = String(y);
            yearSel.appendChild(opt);
        }
    }

    function readDobFromForm() {
        const y = document.getElementById('ageGateYear')?.value;
        const m = document.getElementById('ageGateMonth')?.value;
        const d = document.getElementById('ageGateDay')?.value;
        if (!y || !m || !d) return '';
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    function syncAgeGateButton() {
        const btn = document.getElementById('btnAgeGateContinue');
        const err = document.getElementById('ageGateError');
        const ack = document.getElementById('ageGateAck')?.checked;
        const dob = readDobFromForm();
        const age = ageFromDob(dob);
        let message = '';
        let ok = false;
        if (!dob || age == null) {
            message = dob ? 'Enter a valid date of birth.' : '';
        } else if (age < 18) {
            message = 'You must be 18 or older to use Mirage Engine.';
        } else if (!ack) {
            message = '';
        } else {
            ok = true;
        }
        if (err) {
            err.textContent = message;
            err.hidden = !message;
        }
        if (btn) btn.disabled = !ok;
    }

    function showAgeGate() {
        return new Promise((resolve) => {
            fillDobYearOptions();
            hideAllBootGates();
            setGateVisible('ageGateOverlay', true);
            syncAgeGateButton();

            const btn = document.getElementById('btnAgeGateContinue');
            let settled = false;
            const onContinue = () => {
                if (settled) return;
                const dob = readDobFromForm();
                const age = ageFromDob(dob);
                const ack = document.getElementById('ageGateAck')?.checked;
                if (age == null || age < 18 || !ack) {
                    syncAgeGateButton();
                    return;
                }
                settled = true;
                save({
                    ageGate: {
                        verified: true,
                        dob,
                        ageAtVerify: age,
                        acknowledgedAt: new Date().toISOString()
                    }
                });
                btn?.removeEventListener('click', onContinue);
                setGateVisible('ageGateOverlay', false);
                resolve(true);
            };
            btn?.addEventListener('click', onContinue);
        });
    }

    function syncFictionButton() {
        const btn = document.getElementById('btnFictionConsentContinue');
        const boxes = [
            'fictionCheckRights',
            'fictionCheckFiction',
            'fictionCheckAdult',
            'fictionCheckLiability'
        ];
        const ok = boxes.every(id => document.getElementById(id)?.checked);
        if (btn) btn.disabled = !ok;
    }

    function showFictionConsent() {
        return new Promise((resolve) => {
            hideAllBootGates();
            setGateVisible('fictionConsentOverlay', true);
            syncFictionButton();

            const btn = document.getElementById('btnFictionConsentContinue');
            let settled = false;
            const onContinue = () => {
                if (settled) return;
                const boxes = {
                    rights: !!document.getElementById('fictionCheckRights')?.checked,
                    fictionOnly: !!document.getElementById('fictionCheckFiction')?.checked,
                    adultSubjects: !!document.getElementById('fictionCheckAdult')?.checked,
                    liability: !!document.getElementById('fictionCheckLiability')?.checked
                };
                if (!Object.values(boxes).every(Boolean)) {
                    syncFictionButton();
                    return;
                }
                settled = true;
                save({
                    fictionConsent: {
                        accepted: true,
                        version: CONSENT_VERSION,
                        items: boxes,
                        acknowledgedAt: new Date().toISOString()
                    }
                });
                btn?.removeEventListener('click', onContinue);
                setGateVisible('fictionConsentOverlay', false);
                resolve(true);
            };
            btn?.addEventListener('click', onContinue);
        });
    }

    function syncUploadButton() {
        const btn = document.getElementById('btnUploadGateConfirm');
        const boxes = [
            'uploadCheckRights',
            'uploadCheckFiction',
            'uploadCheckAdult'
        ];
        const ok = boxes.every(id => document.getElementById(id)?.checked);
        if (btn) btn.disabled = !ok;
    }

    function resetUploadChecks() {
        ['uploadCheckRights', 'uploadCheckFiction', 'uploadCheckAdult'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = false;
        });
        syncUploadButton();
    }

    /**
     * Interstitial before media / face / body ingest.
     * @param {{ context?: 'media'|'face'|'body' }} [opts]
     * @returns {Promise<boolean>}
     */
    function confirmMediaUpload(opts = {}) {
        const context = opts.context || 'media';
        return new Promise((resolve) => {
            if (uploadResolver) {
                // Stacked prompts — reject the previous waiter as cancelled
                uploadResolver(false);
                uploadResolver = null;
            }
            uploadResolver = resolve;

            const lead = document.getElementById('uploadGateLead');
            if (lead) {
                if (context === 'face') {
                    lead.textContent = 'Before you upload a face reference, confirm the following:';
                } else if (context === 'body') {
                    lead.textContent = 'Before you upload a body reference, confirm the following:';
                } else {
                    lead.textContent = 'Before you add reference media, confirm the following:';
                }
            }

            resetUploadChecks();
            setGateVisible('uploadGateOverlay', true);
        });
    }

    function closeUploadGate(ok) {
        setGateVisible('uploadGateOverlay', false);
        if (ok) {
            save({
                uploadAck: {
                    version: UPLOAD_COPY_VERSION,
                    lastAcknowledgedAt: new Date().toISOString()
                }
            });
        }
        const resolve = uploadResolver;
        uploadResolver = null;
        if (typeof resolve === 'function') resolve(!!ok);
    }

    /**
     * Run age + fiction gates before the app is usable.
     * @returns {Promise<boolean>}
     */
    async function runBootGates() {
        // Paint the correct gate immediately (avoids a flash of Welcome)
        if (!isAgeVerified()) {
            fillDobYearOptions();
            setGateVisible('ageGateOverlay', true);
            syncAgeGateButton();
        } else if (!isFictionConsented()) {
            setGateVisible('fictionConsentOverlay', true);
            syncFictionButton();
        }

        if (!isAgeVerified()) {
            await showAgeGate();
        }
        if (!isFictionConsented()) {
            await showFictionConsent();
        }
        bootReady = true;
        hideAllBootGates();
        document.documentElement.classList.add('safety-gates-passed');
        return true;
    }

    function bind() {
        fillDobYearOptions();

        ['ageGateYear', 'ageGateMonth', 'ageGateDay'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', syncAgeGateButton);
        });
        document.getElementById('ageGateAck')?.addEventListener('change', syncAgeGateButton);

        [
            'fictionCheckRights',
            'fictionCheckFiction',
            'fictionCheckAdult',
            'fictionCheckLiability'
        ].forEach(id => {
            document.getElementById(id)?.addEventListener('change', syncFictionButton);
        });

        [
            'uploadCheckRights',
            'uploadCheckFiction',
            'uploadCheckAdult'
        ].forEach(id => {
            document.getElementById(id)?.addEventListener('change', syncUploadButton);
        });

        document.getElementById('btnUploadGateConfirm')?.addEventListener('click', () => {
            const ok = ['uploadCheckRights', 'uploadCheckFiction', 'uploadCheckAdult']
                .every(id => document.getElementById(id)?.checked);
            if (!ok) {
                syncUploadButton();
                return;
            }
            closeUploadGate(true);
        });
        document.getElementById('btnUploadGateCancel')?.addEventListener('click', () => {
            closeUploadGate(false);
        });
    }

    global.MirageSafetyGates = {
        bind,
        runBootGates,
        confirmMediaUpload,
        isAgeVerified,
        isFictionConsented,
        isBootComplete,
        CONSENT_VERSION
    };
})(typeof window !== 'undefined' ? window : globalThis);
