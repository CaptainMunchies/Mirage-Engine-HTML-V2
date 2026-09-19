/**
 * MIRAGE ENGINE — the live-state HUD, as a pure function
 *
 * Behind Phase 4's wall, same contract as chat-view.js and setup-view.js: it is
 * handed a description of the turn's state and returns what should be on screen.
 * No EngineState, no document, no engine modules.
 *
 * `updateHud` used to do the whole job in one pass — read eleven fields off the
 * session, ask MirageLoyaltyUX for the engagement label, band and colour, and write
 * each result straight onto an element by id. Only the middle of that is a view.
 *
 * The engagement trio arrives already resolved rather than being looked up here,
 * and that is deliberate rather than a shortcut: "Hot (72)", band `hot`, this
 * colour *is* the plain description of what should be on screen. Deciding what 72
 * means is the engine's call, and loyalty-ux.js is not behind the wall yet.
 *
 * `outfitSet` / `envSet` arrive the same way. Whether a scene field counts as set
 * is `isSceneFieldSet`'s rule and stays on the engine side; this only knows whether
 * to print the value or a dash.
 */
(function (global) {
    'use strict';

    /**
     * @typedef {object} HudEngagement
     * @property {string} [label] e.g. "Hot (72)"
     * @property {string} [band] cold | cool | warm | hot — drives the wrap class
     * @property {string|null} [color]
     *
     * @typedef {object} HudState
     * @property {string} [persona]
     * @property {string} [mode] DM | STORY
     * @property {number|string} [arousal]
     * @property {number|string} [tease]
     * @property {number|string} [awareness]
     * @property {boolean} [awakeningActive]
     * @property {string} [awakeningStage] crack | fracture | spill | awakened
     * @property {string} [thermal]
     * @property {string} [mood]
     * @property {number} [moodIntensity]
     * @property {string} [outfit]
     * @property {boolean} [outfitSet]
     * @property {string} [env]
     * @property {boolean} [envSet]
     * @property {HudEngagement} [engagement]
     *
     * @param {HudState} state
     * @returns {{fields: Record<string, string>, modeClass: string,
     *            engagementWrapClass: string, engagementColor: string|null}}
     */
    function hudView(state) {
        const s = state || {};
        // The HUD has always printed an em dash for "nothing here", and an empty
        // cell reads as a broken HUD rather than an empty value.
        const dash = (v) => (v == null ? '—' : String(v));

        const mode = s.mode || 'DM';
        const awareness = s.awakeningActive
            ? `${s.awareness} · ${s.awakeningStage || 'crack'}`
            : s.awareness;
        const mood = s.mood || 'Neutral';
        const moodIntensity = Number.isFinite(Number(s.moodIntensity)) ? Number(s.moodIntensity) : 1;
        const engagement = s.engagement || {};

        return {
            fields: {
                hudPersona: dash(s.persona),
                hudMode: mode,
                hudArousal: dash(s.arousal),
                hudTease: dash(s.tease),
                hudAwareness: dash(awareness),
                hudThermal: dash(s.thermal),
                hudMood: `${mood} · ${moodIntensity}`,
                hudOutfit: s.outfitSet ? dash(s.outfit) : '—',
                hudEnv: s.envSet ? dash(s.env) : '—',
                hudCompliance: dash(engagement.label)
            },
            modeClass: mode === 'STORY' ? 'hud-mode-story' : 'hud-mode-dm',
            engagementWrapClass: `hud-compliance hud-compliance-${engagement.band || 'warm'}`,
            engagementColor: engagement.color || null
        };
    }

    global.MirageHudView = { hudView };
})(typeof window !== 'undefined' ? window : globalThis);
