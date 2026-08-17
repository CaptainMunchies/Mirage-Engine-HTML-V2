/**
 * MIRAGE ENGINE — Image Failure UX enhancements (grok/image-failure-ux)
 * Progressive enhancement on top of core simulation.js.
 * Safe to remove; core engine still works without it.
 */
(function () {
    'use strict';

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&')
            .replace(/</g, '<')
            .replace(/>/g, '>');
    }

    function canRetryFace() {
        const btn = document.getElementById('btnRetryFace');
        return !!(btn && !btn.disabled);
    }

    function canRetryPrompt() {
        const btn = document.getElementById('btnRetryPrompt');
        return !!(btn && !btn.disabled);
    }

    function pulseRetryButtons() {
        const face = document.getElementById('btnRetryFace');
        const prompt = document.getElementById('btnRetryPrompt');
        [face, prompt].forEach((btn) => {
            if (!btn || btn.disabled) return;
            btn.classList.add('is-attention');
            setTimeout(() => btn.classList.remove('is-attention'), 4200);
        });
    }

    function bindActions(root) {
        if (!root) return;
        root.querySelectorAll('[data-image-fail-action]').forEach((btn) => {
            if (btn.dataset.bound === '1') return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const action = btn.getAttribute('data-image-fail-action');
                if (action === 'face') {
                    MirageSimulation?.retryFace?.();
                } else if (action === 'prompt') {
                    MirageSimulation?.retryPrompt?.();
                }
            });
        });
    }

    function enrichAlert(entry, reason) {
        if (!entry) return;
        const box = entry.querySelector('.chat-alert-box');
        if (!box || box.querySelector('.chat-alert-actions')) return;

        const filtered = reason === 'filtered' || /safety filter|blocked by safety/i.test(
            (entry.querySelector('.chat-alert-text strong')?.textContent || '')
            + (entry.querySelector('.chat-alert-text p')?.textContent || '')
        );

        const hint = filtered
            ? 'Text was still delivered. Try Face Recovery first, or Retry Last Image with the same prompt.'
            : 'Text was still delivered. You can retry the photo without re-sending the message.';

        const actions = document.createElement('div');
        actions.className = 'chat-alert-actions';
        actions.innerHTML =
            `<p class="chat-alert-hint">${escapeHtml(hint)}</p>`
            + `<div class="chat-alert-btns">`
            + `<button type="button" class="btn btn-sm btn-primary" data-image-fail-action="face"`
            + ` ${canRetryFace() ? '' : 'disabled'} title="Regenerate with Face Recovery">Retry Face Recovery</button>`
            + `<button type="button" class="btn btn-sm btn-ghost" data-image-fail-action="prompt"`
            + ` ${canRetryPrompt() ? '' : 'disabled'} title="Regenerate using the exact same prompt">Retry same prompt</button>`
            + `</div>`;
        box.appendChild(actions);
        bindActions(actions);
        pulseRetryButtons();
    }

    function enrichFailedCard(card) {
        if (!card || card.querySelector('.phone-card-fail-actions')) return;
        const ph = card.querySelector('.phone-card-failed');
        if (!ph) return;

        const label = (ph.textContent || '').trim() || 'Image blocked / failed';
        ph.innerHTML =
            `<span class="phone-card-fail-label">${escapeHtml(label)}</span>`
            + `<div class="phone-card-fail-actions">`
            + `<button type="button" class="btn btn-sm btn-primary" data-image-fail-action="face"`
            + ` ${canRetryFace() ? '' : 'disabled'} title="Retry with Face Recovery">Face Recovery</button>`
            + `<button type="button" class="btn btn-sm btn-ghost" data-image-fail-action="prompt"`
            + ` ${canRetryPrompt() ? '' : 'disabled'} title="Retry with same prompt">Same prompt</button>`
            + `</div>`;
        bindActions(ph);
    }

    function scan() {
        document.querySelectorAll('#chatLog .chat-alert-image-fail, #chatLog .chat-alert.chat-alert-image-fail').forEach((el) => {
            enrichAlert(el);
        });
        document.querySelectorAll('#chatLog .chat-alert-image-fail, #chatLog .chat-entry.chat-alert-image-fail').forEach((el) => {
            enrichAlert(el);
        });
        document.querySelectorAll('#chatLog .chat-alert').forEach((el) => {
            if (el.classList.contains('chat-alert-image-fail') || el.querySelector('.chat-alert-box')) {
                const title = el.querySelector('.chat-alert-text strong')?.textContent || '';
                if (/image|photo|blocked|filter|timed out|failed/i.test(title)) {
                    enrichAlert(el);
                }
            }
        });
        document.querySelectorAll('#phoneFeed .phone-card-failed').forEach((ph) => {
            enrichFailedCard(ph.closest('.phone-card') || ph);
        });
    }

    function observe() {
        const log = document.getElementById('chatLog');
        const feed = document.getElementById('phoneFeed');
        const opts = { childList: true, subtree: true };
        const cb = () => {
            try { scan(); } catch (e) { console.warn('[Mirage] image-failure-ux scan', e); }
        };
        if (log) new MutationObserver(cb).observe(log, opts);
        if (feed) new MutationObserver(cb).observe(feed, opts);
        setTimeout(cb, 400);
        setTimeout(cb, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observe);
    } else {
        observe();
    }

    window.MirageImageFailureUX = { scan, pulseRetryButtons, enrichAlert, enrichFailedCard };
})();
