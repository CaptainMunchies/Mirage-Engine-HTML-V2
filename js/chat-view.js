/**
 * MIRAGE ENGINE — chat and phone markup, as pure functions
 *
 * The first brick of Phase 4's wall, laid from the UI side.
 *
 * `appendChat` and `renderPhoneCard` each did four jobs at once: decide the
 * markup, read engine state (`S().profile.name`, the master face, the clock),
 * mutate the DOM, and persist to the chat store. Only the first of those is a
 * view, and only the first is something a gallery can call — which is why a
 * gallery built before this extraction would have had to hand-write its own
 * copy of the markup and drift from the app within a week.
 *
 * So: everything the markup needs arrives as data. No `EngineState`, no
 * `document`, no persistence, no listeners. Give it a description of what
 * should be on screen and it returns the html for it — which is the
 * Engine → UI crossing the wall is meant to be, arrived at bottom-up.
 *
 * The callers keep the other three jobs.
 *
 * Two different things guard the split, and they cover different halves. The
 * Layer 2 baselines record real transcripts, so drift in the *text* shows up
 * there as a diff — but they were measured against a deliberately broken class
 * name and passed, so they do not cover markup at all. The class names the CSS
 * hangs on are pinned by their own test in the Layer 3 suite instead.
 */
(function (global) {
    'use strict';

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Master-face photo when one is locked, otherwise the name's initial.
     * The photo arrives as a url rather than being read from state, because a
     * gallery has no master face and still has to render this honestly.
     *
     * @param {{className?: string, name?: string, photoUrl?: string|null}} [opts]
     */
    function avatarHtml({ className = 'phone-avatar', name = 'Character', photoUrl = null } = {}) {
        const label = name || 'Character';
        const initial = String(label).charAt(0).toUpperCase() || '?';
        if (photoUrl) {
            return `<span class="${escapeHtml(className)} ${escapeHtml(className)}--photo" aria-hidden="true">`
                + `<img src="${escapeHtml(photoUrl)}" alt="" class="char-avatar-img">`
                + `</span>`;
        }
        return `<span class="${escapeHtml(className)}" aria-hidden="true">${escapeHtml(initial)}</span>`;
    }

    /**
     * One entry in the chat log.
     *
     * @typedef {object} ChatEntryView
     * @property {'user'|'ai'|'system'} [role]
     * @property {string} [text]
     * @property {'bubble'|'caption'|'command'|'story'|'alert'} [kind] Defaults to bubble.
     * @property {string} [timeLabel] Already formatted — this module owns no clock.
     * @property {string} [name] Hers, for the avatar's initial.
     * @property {string|null} [photoUrl] Master face, when locked.
     * @property {string} [alertType] warn | image-fail
     * @property {string} [title] Alert heading.
     * @property {string} [body] Alert body.
     * @property {string} [clockNote] The `7:24 AM → 10:24 AM` on a command bubble.
     *
     * @param {ChatEntryView} view
     * @returns {{className: string, html: string}}
     */
    function chatEntry(view) {
        const v = view || {};
        const role = v.role || 'ai';
        const kind = v.kind || 'bubble';
        const text = v.text || '';
        const timeHtml = v.timeLabel
            ? `<span class="chat-time">${escapeHtml(v.timeLabel)}</span>`
            : '';

        if (kind === 'alert') {
            const alertType = v.alertType || 'warn';
            return {
                className: `chat-entry chat-alert chat-alert-${alertType}`,
                html: `
                <div class="chat-alert-box">
                    <span class="chat-alert-icon">${alertType === 'image-fail' ? '⚠' : 'ℹ'}</span>
                    <div class="chat-alert-text">
                        <strong>${escapeHtml(v.title || 'Notice')}</strong>
                        <p>${escapeHtml(v.body || text || '')}</p>
                    </div>
                </div>`
            };
        }

        if (kind === 'caption') {
            return {
                className: 'chat-entry chat-caption',
                html: `<span class="chat-caption-text">${escapeHtml(text)}</span>`
            };
        }

        if (kind === 'command') {
            const clockNote = v.clockNote ? String(v.clockNote).trim() : '';
            return {
                className: 'chat-entry chat-command chat-user',
                html: `
                <span class="chat-command-text">${escapeHtml(text)}</span>
                ${clockNote ? `<span class="chat-command-clock">${escapeHtml(clockNote)}</span>` : ''}
                ${timeHtml}`
            };
        }

        if (kind === 'story') {
            // Only this turn's Story caption — never paint DMs as STORY because mode is still STORY
            return {
                className: `chat-entry chat-story chat-${role}`,
                html: `
                <span class="chat-story-badge">STORY</span>
                <div class="chat-story-body">${escapeHtml(text)}</div>
                ${timeHtml}`
            };
        }

        // Instagram-style DM bubbles
        const isUser = role === 'user';
        const name = v.name || 'Her';
        return {
            className: `chat-entry chat-${role} chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-ai'}`,
            html: isUser
                ? `<div class="chat-bubble-stack chat-bubble-stack-out">
                     <div class="ig-bubble ig-bubble-out">${escapeHtml(text)}</div>
                     ${timeHtml}
                   </div>`
                : `${avatarHtml({ className: 'ig-avatar', name, photoUrl: v.photoUrl })}
                   <div class="chat-bubble-stack chat-bubble-stack-in">
                     <div class="ig-bubble ig-bubble-in">${escapeHtml(text)}</div>
                     ${timeHtml}
                   </div>`
        };
    }

    /**
     * One card in the phone feed.
     *
     * @typedef {object} PhoneCardView
     * @property {string} [text] Caption / DM text.
     * @property {string|null} [imageUrl]
     * @property {'DM'|'STORY'} [mode]
     * @property {boolean} [imageFailed]
     * @property {string|null} [imageFailReason] `filtered` names the safety filter.
     * @property {boolean} [textOnly]
     * @property {boolean} [mock] Dev mock image — badged, never saved.
     * @property {string} [name]
     * @property {string|null} [photoUrl]
     * @property {string} [timeLabel] Already formatted.
     *
     * @param {PhoneCardView} view
     * @returns {{className: string, html: string, hasImage: boolean}}
     */
    function phoneCard(view) {
        const v = view || {};
        const text = v.text || '';
        const isStory = v.mode === 'STORY';
        const isMock = !!v.mock;
        const textOnly = !!v.textOnly;
        const imageFailed = !!v.imageFailed;
        const name = v.name || 'Character';
        const avatar = avatarHtml({ className: 'phone-avatar', name, photoUrl: v.photoUrl });

        const className = `phone-card ${isStory ? 'phone-card-story' : 'phone-card-dm'}`
            + `${imageFailed ? ' phone-card-no-image' : ''}`
            + `${textOnly ? ' phone-card-text-only' : ''}`
            + `${isMock ? ' phone-card-mock' : ''}`;

        const mockBadge = isMock
            ? '<span class="phone-card-mock-badge" title="Dev mock — not saved">MOCK</span>'
            : '';

        let imgBlock;
        let hasImage = false;
        if (textOnly) {
            imgBlock = '';
        } else if (v.imageUrl && !imageFailed) {
            hasImage = true;
            imgBlock = mockBadge
                + `<img src="${v.imageUrl}" alt="Generated visual" class="phone-card-img">`
                + `<button type="button" class="phone-card-expand" title="View larger" aria-label="View larger">`
                + `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">`
                + `<path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>`
                + `</svg></button>`;
        } else if (isMock) {
            imgBlock = mockBadge
                + `<div class="phone-card-img phone-card-placeholder phone-card-mock-ph">Mock image · not saved</div>`;
        } else if (imageFailed) {
            const failLabel = v.imageFailReason === 'filtered'
                ? 'Blocked by safety filter'
                : 'Image blocked / failed';
            imgBlock = `<div class="phone-card-img phone-card-placeholder phone-card-failed">${failLabel}</div>`;
        } else {
            imgBlock = `<div class="phone-card-img phone-card-placeholder">No image</div>`;
        }

        let html;
        if (isStory) {
            html = `
                <div class="phone-card-header story">
                    <span class="story-ring" aria-hidden="true">${avatarHtml({ className: 'story-avatar', name, photoUrl: v.photoUrl })}</span>
                    <div class="story-header-text">
                        <span class="story-kicker">INSTAGRAM STORY</span>
                        <strong>${escapeHtml(name)}</strong>
                    </div>
                </div>
                ${textOnly ? '' : `<div class="phone-card-media">${imgBlock}</div>`}
                <div class="phone-card-caption story-caption">${escapeHtml(text)}</div>
            `;
        } else if (textOnly) {
            html = `
                <div class="phone-card-header dm phone-card-header-slim">
                    ${avatar}
                    <div class="dm-header-text">
                        <strong>${escapeHtml(name)}</strong>
                    </div>
                </div>
                <div class="phone-card-text-only-body">${escapeHtml(text)}</div>
            `;
        } else {
            html = `
                <div class="phone-card-header dm phone-card-header-slim">
                    ${avatar}
                    <div class="dm-header-text">
                        <strong>${escapeHtml(name)}</strong>
                    </div>
                </div>
                <div class="phone-card-media">${imgBlock}
                    <div class="snap-overlay">${escapeHtml(text)}</div>
                </div>
            `;
        }

        return { className, html, hasImage };
    }

    global.MirageChatView = {
        escapeHtml,
        avatarHtml,
        chatEntry,
        phoneCard
    };
})(typeof window !== 'undefined' ? window : globalThis);
