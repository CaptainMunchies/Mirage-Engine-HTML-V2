/**
 * MIRAGE ENGINE — setup-wizard markup, as pure functions
 *
 * Behind Phase 4's wall, same contract as chat-view.js: everything arrives as data,
 * nothing is read, nothing is touched. No EngineState, no document, no listeners.
 *
 * This exists because the gallery needs to show the media step at 0, 1, 19 and 20
 * photos — the counts where the grid layout and the limit actually get interesting —
 * and the tile markup lived inside a loop in setup-media.js that reads the real file
 * list and wires a click handler. A gallery cannot call that, and hand-copying the
 * tile would have put a second copy of it one directory away from the first.
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
     * One tile in the media grid.
     *
     * The remove button is markup only — binding it stays with the caller, which is
     * what keeps this side of the wall free of listeners and of any idea that a tile
     * has an index in a list.
     *
     * @typedef {object} MediaTileView
     * @property {string} [name] File name, shown and used as the remove label.
     * @property {string} [sizeLabel] Already formatted — this module owns no units.
     * @property {string|null} [url] Object URL for an image; omit for a video.
     * @property {boolean} [isVideo] Draws the play glyph instead of a thumbnail.
     *
     * @param {MediaTileView} view
     * @returns {{className: string, html: string}}
     */
    function mediaTile(view) {
        const v = view || {};
        const name = v.name || '';
        const thumb = v.isVideo || !v.url
            ? '<div class="media-video-icon">▶</div>'
            : `<img src="${escapeHtml(v.url)}" alt="${escapeHtml(name)}">`;

        return {
            className: 'media-item',
            html: thumb
                + `<span class="media-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`
                + `<span class="media-item-size">${escapeHtml(v.sizeLabel || '')}</span>`
                + `<button type="button" class="media-remove" aria-label="Remove ${escapeHtml(name)}">×</button>`
        };
    }

    global.MirageSetupView = {
        escapeHtml,
        mediaTile
    };
})(typeof window !== 'undefined' ? window : globalThis);
