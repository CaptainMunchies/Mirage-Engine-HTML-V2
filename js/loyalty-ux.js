/**
 * MIRAGE ENGINE v2 — Engagement (0–100) + stale-loop nudges
 * Engagement = attention / investment. Orthogonal to arousal.
 */
(function (global) {
    'use strict';

    const BANDS = [
        { id: 'cold', min: 0, max: 25, label: 'Cold' },
        { id: 'cool', min: 26, max: 45, label: 'Cool' },
        { id: 'warm', min: 46, max: 70, label: 'Warm' },
        { id: 'hot', min: 71, max: 100, label: 'Hot' }
    ];

    /** Legacy compliance → approximate engagement. */
    const COMPLIANCE_TO_ENGAGEMENT = {
        engaged: 65,
        reluctant: 40,
        refusing: 20,
        ignoring: 15
    };

    let lastBand = 'warm';
    let shortUserStreak = 0;

    function snapshotDynamics() {
        return { lastBand, shortUserStreak };
    }

    function restoreDynamics(snap) {
        if (!snap || typeof snap !== 'object') return;
        if (typeof snap.lastBand === 'string') lastBand = snap.lastBand;
        if (Number.isFinite(Number(snap.shortUserStreak))) {
            shortUserStreak = Math.max(0, Math.round(Number(snap.shortUserStreak)));
        }
    }

    function clampEngagement(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return null;
        return Math.max(0, Math.min(100, Math.round(v)));
    }

    function bandOf(score) {
        const n = clampEngagement(score) ?? 55;
        return BANDS.find(b => n >= b.min && n <= b.max) || BANDS[2];
    }

    function labelOf(score) {
        const band = bandOf(score);
        return `${band.label} (${clampEngagement(score) ?? 55})`;
    }

    function profileText(profile, key) {
        if (profile?.autoFill?.[key]) return '';
        return String(profile?.[key] || '');
    }

    function isHighLoyalty(profile) {
        return /high|hard|resist/i.test(profileText(profile, 'loyalty'));
    }

    function isSoftLoyalty(profile) {
        return /low|eager|easy|soft/i.test(profileText(profile, 'loyalty'));
    }

    /**
     * Seed engagement for a new chat from character / relationship context.
     * Clamped 15–85 so openings never start at extremes.
     */
    function seedEngagement(profile, edf, protocol) {
        let score = 55;
        const loyalty = profileText(profile, 'loyalty');
        const notes = profileText(profile, 'notes').toLowerCase();
        const rel = profileText(profile, 'relationship').toLowerCase();
        const personality = profileText(profile, 'personality').toLowerCase();
        const edfNotes = String(
            edf?.PERSONALITY?.SUMMARY
            || edf?.PERSONALITY?.notes
            || edf?.RELATIONSHIP
            || ''
        ).toLowerCase();
        const blob = `${loyalty} ${notes} ${rel} ${personality} ${edfNotes}`;

        if (isHighLoyalty(profile) || /hard.?to.?get|distant|cold|guarded|aloof/.test(blob)) {
            score = 38;
        } else if (isSoftLoyalty(profile) || /eager|clingy|obsess|in love|girlfriend|wife|devoted/.test(blob)) {
            score = 68;
        }

        if (/ex|awkward|tense|fight|break|resent/.test(blob)) score -= 8;
        if (/close|best friend|dating|partner|married|crush|hooking up/.test(blob)) score += 6;
        if (/long.?distance|busy|career/.test(blob)) score -= 4;
        if (/flirt|thirst|horny|sexual|nsfw|goon/.test(blob)) score += 5;

        const axes = scoreGhostAxes(profile, edf);
        score += Math.round(axes.intimacy * 6);
        score -= Math.round(axes.statusGap * 5);
        if (isHighLoyalty(profile) && axes.statusGap > 0.25 && axes.intimacy < 0.15) {
            score = Math.min(score, 32);
        }

        const proto = String(protocol || '').toUpperCase();
        if (proto === 'A' || proto.startsWith('B')) score += 4; // opening beat / Story bias
        if (proto === 'B3') score -= 3; // colder director open

        return Math.max(15, Math.min(85, Math.round(score)));
    }

    /**
     * Context-seed ALL opening dynamics for a new simulation/chat.
     * Avoids hard defaults (0 arousal / Neutral mood / etc.) when the dossier implies otherwise.
     * Outfit/env stay unset — the model establishes those on the first beat.
     */
    function seedSessionDynamics(session, profile, edf, protocol) {
        if (!session) return null;
        const loyalty = profileText(profile, 'loyalty');
        const notes = profileText(profile, 'notes').toLowerCase();
        const rel = profileText(profile, 'relationship').toLowerCase();
        const personality = profileText(profile, 'personality').toLowerCase();
        const edfNotes = String(
            edf?.PERSONALITY?.SUMMARY
            || edf?.PERSONALITY?.notes
            || edf?.RELATIONSHIP
            || ''
        ).toLowerCase();
        const blob = `${loyalty} ${notes} ${rel} ${personality} ${edfNotes}`;
        const proto = String(protocol || session.protocol || '').toUpperCase();

        const engagement = seedEngagement(profile, edf, proto);

        // Arousal — calm open by default; warmer if relationship/protocol implies heat
        let arousal = 8;
        if (/flirt|thirst|horny|sexual|nsfw|goon|tease|hookup|fwb|friends with benefits/.test(blob)) {
            arousal = 28;
        } else if (/dating|girlfriend|boyfriend|partner|married|crush|in love/.test(blob)) {
            arousal = 18;
        } else if (/ex|awkward|tense|professional|coworker/.test(blob)) {
            arousal = 4;
        }
        if (proto.startsWith('B')) arousal = Math.max(arousal, 16); // Story openers lean presentational/heat-adjacent
        if (proto === 'B3') arousal = Math.max(6, arousal - 8);

        // Tease — clothed unless the open is explicitly spicy / story showcase
        let tease = 0;
        if (/lingerie|nude|nsfw|exhibition|flash/.test(blob) || proto === 'B2') tease = 1;
        if (/goon|explicit|strip/.test(blob)) tease = Math.max(tease, 2);
        if (isGoonPersona(session) && tease < 1) tease = 1;

        // Thermal
        let thermal = 'Normal';
        if (/gym|workout|run|summer|hot|sweat|club|dance/.test(blob)) thermal = 'Sweaty';
        if (/overheat|fever|sauna/.test(blob)) thermal = 'Overheating';

        // Mood + intensity from relationship / protocol
        let mood = 'Neutral';
        let moodIntensity = 1;
        let moodNote = '';
        if (/angry|mad|furious|rage|fight/.test(blob)) {
            mood = 'Annoyed';
            moodIntensity = 2;
            moodNote = 'Opening tension from relationship context';
        } else if (/sad|hurt|cry|heartbroken|lonely/.test(blob)) {
            mood = 'Hurt';
            moodIntensity = 2;
            moodNote = 'Opening soft from relationship context';
        } else if (/happy|giddy|excited|playful|flirt/.test(blob) || proto === 'A') {
            mood = 'Playful';
            moodIntensity = 1;
        } else if (/anxious|nervous|shy|awkward/.test(blob)) {
            mood = 'Nervous';
            moodIntensity = 1;
        } else if (/obsess|cling|jealous/.test(blob)) {
            mood = 'Intense';
            moodIntensity = 2;
        } else if (engagement <= 35) {
            mood = 'Cool';
            moodIntensity = 1;
        } else if (engagement >= 70) {
            mood = 'Warm';
            moodIntensity = 1;
        }
        if (proto === 'B3' && mood === 'Neutral') {
            mood = 'Distant';
            moodIntensity = 1;
            moodNote = 'Director-cold story open';
        }

        session.engagement = engagement;
        session.arousal = Math.max(0, Math.min(100, Math.round(arousal)));
        session.tease = Math.max(0, Math.min(3, Math.round(tease)));
        session.awareness = 0;
        session.thermal = thermal;
        session.mood = mood;
        session.moodIntensity = Math.max(0, Math.min(3, Math.round(moodIntensity)));
        session.moodNote = moodNote;
        session.chatHeat = engagement >= 70 ? 1 : 0;

        return {
            engagement: session.engagement,
            arousal: session.arousal,
            tease: session.tease,
            thermal: session.thermal,
            mood: session.mood,
            moodIntensity: session.moodIntensity
        };
    }

    function migrateComplianceToEngagement(compliance) {
        const key = String(compliance || '').trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(COMPLIANCE_TO_ENGAGEMENT, key)) {
            return COMPLIANCE_TO_ENGAGEMENT[key];
        }
        return null;
    }

    function inferEngagementDrift(characterText, profile, current) {
        const base = clampEngagement(current) ?? 55;
        const text = String(characterText || '').trim();
        const lower = text.toLowerCase();
        const words = lower.split(/\s+/).filter(Boolean);
        let next = base;

        const hard = [
            /\bleave me alone\b/,
            /\bnot talking to you\b/,
            /\bblocked you\b/,
            /\bdon'?t text me\b/,
            /\bstop (texting|messaging|dm)/,
            /\bfuck off\b/,
            /\bgo away\b/,
            /\bi'?m done\b/,
            /\bwe'?re done\b/
        ];
        const coldShort = [
            /^(k|ok|okay|lol|lmao|hm+|mhm|yeah|yep|nope)\.?$/,
            /^seen$/,
            /^\.\.\.$/,
            /^…$/
        ];
        const warm = [
            /\bmiss (you|u)\b/,
            /\blove (you|u)\b/,
            /\bcan'?t wait\b/,
            /\bcome over\b/,
            /\b❤️|💕|😘|🥰/
        ];

        if (hard.some(re => re.test(lower))) next -= 18;
        else if (coldShort.some(re => re.test(lower)) || (words.length <= 2 && !/\?/.test(text))) {
            next -= isHighLoyalty(profile) ? 10 : 6;
        } else if (/\bmaybe later\b|\bnot now\b|\bi'?m busy\b|\bwhatever\b|\bidk\b|\bcan'?t rn\b/.test(lower)) {
            next -= 5;
        } else if (warm.some(re => re.test(lower)) || text.length > 80) {
            next += 4;
        } else if (text.length > 24) {
            next += 2;
        }

        if (isHighLoyalty(profile) && text.length < 36 && !/\?/.test(text)) next -= 3;

        return clampEngagement(next);
    }

    function resolveEngagement(tracking, characterText, profile, sess) {
        const pinned = sess?.operatorOverrides?.engagement;
        if (pinned != null) {
            const p = clampEngagement(pinned);
            if (p != null) return p;
        }
        const fromTracking = clampEngagement(tracking?.engagement);
        if (fromTracking != null) return fromTracking;
        // Legacy model still emitting compliance
        const fromLegacy = migrateComplianceToEngagement(tracking?.compliance);
        if (fromLegacy != null) {
            const drifted = inferEngagementDrift(characterText, profile, fromLegacy);
            return drifted ?? fromLegacy;
        }
        const current = clampEngagement(sess?.engagement) ?? 55;
        return inferEngagementDrift(characterText, profile, current) ?? current;
    }

    function engagementHint(score, profile) {
        const name = profile?.name || 'She';
        const band = bandOf(score).id;
        switch (band) {
            case 'cold':
                return `${name} is cold / checked out (${score}). Try /persona, /next scene, or dial intensity down.`;
            case 'cool':
                return `${name} is only half in (${score}). Build rapport before escalating.`;
            default:
                return '';
        }
    }

    function recordUserMessage(text) {
        const raw = String(text || '').trim();
        if (!raw || raw.startsWith('/')) {
            shortUserStreak = 0;
            return;
        }
        const words = raw.split(/\s+/).filter(Boolean);
        if (words.length <= 2 || raw.length <= 10) {
            shortUserStreak += 1;
        } else {
            shortUserStreak = 0;
        }
    }

    function staleLoopHint() {
        if (shortUserStreak < 3) return '';
        return 'Loop detected — your last few messages were very short. Try /next scene, a concrete action, or /persona to shift energy.';
    }

    function resetSession() {
        lastBand = 'warm';
        shortUserStreak = 0;
    }

    function engagementHueColor(score) {
        const t = Math.max(0, Math.min(1, (clampEngagement(score) ?? 55) / 100));
        const h = 210 - (t * 202);
        const s = 70 + (t * 18);
        const l = 58 - (t * 8);
        return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
    }

    /** Max engagement *rise* per turn from Difficulty / loyalty. Falls are unchanged. */
    function engagementRiseCap(profile) {
        if (isHighLoyalty(profile)) return 10;
        if (isSoftLoyalty(profile)) return 28;
        return 18;
    }

    /** Wider cap when HIS message is a real salience hook. Still scaled by Difficulty. */
    function engagementSpikeCap(profile) {
        if (isHighLoyalty(profile)) return 24;
        if (isSoftLoyalty(profile)) return 50;
        return 36;
    }

    function userMessageLooksTrivial(text) {
        const raw = String(text || '').trim();
        if (!raw) return true;
        if (raw.startsWith('/')) return true;
        const words = raw.split(/\s+/).filter(Boolean);
        const compact = raw
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (/^(hey+|hi+|hii+|hello|yo+|sup|wyd|wru|lol|lmao|ok|okay|k|hmm+|mhm|yea+|yeah|yep|nop+|hiya|heya|hru|how are you|what s up|whats up|wassup|morning|gm|gn|night|okey|hey you|hi you)$/.test(compact)
            && words.length <= 4
            && raw.length <= 24) {
            return true;
        }
        if (words.length <= 2 && raw.length <= 10 && !/[?!]/.test(raw)) return true;
        return false;
    }

    function isAttentionSpikeFlag(tracking) {
        const v = tracking?.attentionSpike;
        if (v === true || v === 1) return true;
        if (typeof v === 'string' && /^(true|yes|hook|shock|intrigue|1)$/i.test(v.trim())) return true;
        return false;
    }

    /**
     * Allow the spike cap when the model proposes a real jump and HIS line isn't small talk.
     * Explicit attentionSpike is preferred; a clearly oversized jump without the flag still counts.
     */
    function shouldAllowEngagementSpike({
        tracking,
        proposed,
        prev,
        profile,
        userText,
        internal,
        proactive,
        isCommand
    } = {}) {
        if (internal || proactive || isCommand) return false;
        if (userMessageLooksTrivial(userText)) return false;
        const from = clampEngagement(prev);
        const to = clampEngagement(proposed);
        if (from == null || to == null || to <= from) return false;
        const riseCap = engagementRiseCap(profile);
        const delta = to - from;
        if (delta <= riseCap) return false;
        if (isAttentionSpikeFlag(tracking)) return true;
        const largeJump = delta >= Math.max(riseCap + 6, Math.round(riseCap * 1.8));
        return largeJump;
    }

    function limitEngagementRise(prev, proposed, profile, { spike = false } = {}) {
        const from = clampEngagement(prev);
        const to = clampEngagement(proposed);
        if (to == null) return from;
        if (from == null) return to;
        if (to <= from) return to;
        const cap = spike ? engagementSpikeCap(profile) : engagementRiseCap(profile);
        let dest = from + Math.min(to - from, cap);
        // High difficulty: a hook can enter Warm, not snap a stranger to Hot.
        if (spike && isHighLoyalty(profile) && from <= 45) {
            dest = Math.min(dest, 70);
        }
        return clampEngagement(dest);
    }

    function dynamicsBlob(profile, edf) {
        const loyalty = profileText(profile, 'loyalty');
        const notes = profileText(profile, 'notes').toLowerCase();
        const rel = profileText(profile, 'relationship').toLowerCase();
        const personality = profileText(profile, 'personality').toLowerCase();
        const archetype = profileText(profile, 'archetype').toLowerCase();
        const edfNotes = String(
            edf?.PERSONALITY?.SUMMARY
            || edf?.PERSONALITY?.notes
            || edf?.RELATIONSHIP
            || edf?.LINGUISTIC_DNA?.Emotional_Tone
            || edf?.LINGUISTIC_DNA?.Speech_Pattern
            || ''
        ).toLowerCase();
        return `${loyalty} ${notes} ${rel} ${personality} ${archetype} ${edfNotes}`.toLowerCase();
    }

    function clampAxis(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return 0;
        return Math.max(-1, Math.min(1, v));
    }

    function difficultyTier(profile) {
        if (isHighLoyalty(profile)) return 'high';
        if (isSoftLoyalty(profile)) return 'low';
        return 'medium';
    }

    /**
     * Inferred social axes from freeform profile/EDF prose.
     * Additive synonym groups — never named-character branches.
     */
    function scoreGhostAxes(profile, edf) {
        const blob = dynamicsBlob(profile, edf);
        let intimacy = 0;
        let statusGap = 0;
        let attachment = 0;
        let publicness = 0;

        if (/wife|husband|girlfriend|boyfriend|partner|married|dating|in love|best friend|together|committed|long.?term|soulmate|fiance/.test(blob)) {
            intimacy += 0.72;
        }
        if (/close|crush|hooking up|fwb|friends with benefits|situationship|ex\b/.test(blob)) {
            intimacy += 0.32;
        }
        if (/stranger|unmatched|just met|never met|acquaintance|random|cold open/.test(blob)) {
            intimacy -= 0.72;
        }
        if (/tinder|hinge|bumble|match|slide into|dm slide/.test(blob)) {
            intimacy -= 0.22;
        }

        if (/famous|celebrity|a.?list|superstar|idol|influencer|public figure|pop.?star|actress|actor|model\b/.test(blob)) {
            statusGap += 0.68;
        }
        if (/boss|ceo|manager|teacher|professor|client|fan\b|one.?sided|out of (?:his|her) league/.test(blob)) {
            statusGap += 0.42;
        }
        if (/coworker|colleague|professional/.test(blob)) {
            statusGap += 0.22;
        }
        if (/peer|classmate|roommate/.test(blob)) {
            statusGap -= 0.18;
        }

        if (/clingy|eager|obsess|devoted|attached|needy|can'?t leave|always texts/.test(blob)) {
            attachment += 0.62;
        }
        if (/aloof|guarded|distant|busy|independent|hard.?to.?get|cold|unavailable|ignores/.test(blob)) {
            attachment -= 0.62;
        }

        if (/influencer|instagram|public|broadcast|content.?creat|onlyfans|famous|celebrity|posts (?:a )?lot/.test(blob)) {
            publicness += 0.62;
        }
        if (/private|low.?key|offline|rarely posts|doesn'?t post/.test(blob)) {
            publicness -= 0.4;
        }

        return {
            intimacy: clampAxis(intimacy),
            statusGap: clampAxis(statusGap),
            attachment: clampAxis(attachment),
            publicness: clampAxis(publicness)
        };
    }

    /**
     * Difficulty-first ghost envelope. Traits and live engagement only modulate.
     */
    function ghostProfile(profile, edf, session) {
        const tier = difficultyTier(profile);
        const axes = scoreGhostAxes(profile, edf);
        const engagement = clampEngagement(session?.engagement) ?? 55;
        const warm = engagement >= 46;
        const hotEng = engagement >= 71;
        const cool = engagement <= 45;

        let ghostMul = 1;
        let storyMul = 1;
        let followUpMul = 1;
        let ditchMul = 1;
        let doubleTextMul = 1;
        let typeDeleteOk = true;
        let presenceVeto = true;
        let textureFloor = 0.38;
        let cooldownTurns = 3;
        let storyDamp = 1;

        if (tier === 'low') {
            ghostMul = 0.22;
            storyMul = 0.42;
            followUpMul = 1.75;
            ditchMul = 0.32;
            doubleTextMul = 1.28;
            typeDeleteOk = true;
            presenceVeto = true;
            textureFloor = 0.26;
            cooldownTurns = 5;
            storyDamp = 1;
        } else if (tier === 'high') {
            const rapport = hotEng ? 0.4 : (warm ? 0.72 : 1.18);
            ghostMul = 2.35 * rapport;
            storyMul = (hotEng ? 0.85 : 2.15) * (cool ? 1.15 : 1);
            followUpMul = hotEng ? 1.05 : 0.32;
            ditchMul = hotEng ? 0.75 : 1.65;
            doubleTextMul = 0.52;
            typeDeleteOk = warm;
            presenceVeto = hotEng;
            textureFloor = hotEng ? 0.38 : (warm ? 0.55 : 0.74);
            cooldownTurns = 1;
            storyDamp = 0.22;
            if (hotEng) ghostMul = 1.05;
        } else {
            ghostMul = 1;
            storyMul = 1;
            followUpMul = 1;
            ditchMul = 1;
            doubleTextMul = 1;
            typeDeleteOk = true;
            presenceVeto = true;
            textureFloor = 0.4;
            cooldownTurns = 3;
            storyDamp = 1;
        }

        ghostMul *= (1 - axes.intimacy * 0.28 + axes.statusGap * 0.22 - axes.attachment * 0.22);
        storyMul *= (1 - axes.intimacy * 0.35 + axes.statusGap * 0.28 + axes.publicness * 0.35);
        followUpMul *= (1 + axes.intimacy * 0.35 - axes.statusGap * 0.3 + axes.attachment * 0.25);
        ditchMul *= (1 - axes.intimacy * 0.25 + axes.statusGap * 0.2 - axes.attachment * 0.2);
        doubleTextMul *= (1 + axes.attachment * 0.3);

        const clampMul = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
        ghostMul = clampMul(ghostMul, 0.08, 4.6);
        storyMul = clampMul(storyMul, 0.12, 4.2);
        followUpMul = clampMul(followUpMul, 0.12, 3.4);
        ditchMul = clampMul(ditchMul, 0.12, 3.6);
        doubleTextMul = clampMul(doubleTextMul, 0.25, 2.2);

        return {
            tier,
            axes,
            engagement,
            ghostMul,
            storyMul,
            followUpMul,
            ditchMul,
            doubleTextMul,
            typeDeleteOk,
            presenceVeto,
            textureFloor,
            cooldownTurns,
            storyDamp
        };
    }

    function ghostDeliveryClientNote(profile, edf, session) {
        const g = ghostProfile(profile, edf, session);
        const eng = g.engagement;
        if (g.tier === 'high' && eng < 71) {
            const band = eng < 46 ? 'Cool/Cold' : 'only Warm';
            return `CLIENT NOTE: Difficulty is High / hard-to-get and rapport is ${band} (${eng}). Stories and silence are in-character. Do not default delivery.style to normal every DM. Prefer left_on_read / went_quiet until engagement is Hot. ghost_type (type then delete) only if engagement is Warm+.\n`;
        }
        if (g.tier === 'low') {
            return `CLIENT NOTE: Difficulty is Low / easy — she usually answers this thread. Use left_on_read / ghost_type / went_quiet only when mood is sharp or wounded at intensity ≥2, or engagement is Cold.\n`;
        }
        return `CLIENT NOTE: Vary delivery.style. Use ghost_type, left_on_read, or went_quiet when it fits mood and engagement — not every turn, not never. Instant/Hybrid/Realtime all honor ignore.\n`;
    }

    /** Tease appetite from description — orthogonal to how much she likes him. */
    function teaseBias(profile, edf) {
        const blob = dynamicsBlob(profile, edf);
        const shy = /shy|modest|reserved|innocent|demure|bashful|timid|prude|vanilla\b|covered/.test(blob);
        const forward = /brat|teas|attention.?seek|exhibition|flash|lingerie|seduc|flirt|prey on|onlyfans|stripper|show.?off/.test(blob);
        if (forward && !shy) return 'forward';
        if (shy && !forward) return 'shy';
        if (forward && shy) return 'forward';
        return 'neutral';
    }

    function isGoonPersona(session) {
        return (session?.persona || (typeof EngineState !== 'undefined' && EngineState.session?.persona)) === 'Goon';
    }

    function limitTeaseChange(prev, proposed, profile, edf) {
        const goon = isGoonPersona();
        const floor = goon ? 1 : 0;
        const from = Math.max(floor, Math.min(3, Math.round(Number(prev) || 0)));
        const to = Math.max(floor, Math.min(3, Math.round(Number(proposed))));
        if (!Number.isFinite(Number(proposed))) return from;
        if (to <= from) return to;
        const cap = goon || teaseBias(profile, edf) === 'forward' ? 2 : 1;
        return Math.max(floor, Math.min(3, from + Math.min(to - from, cap)));
    }

    function clampLibido(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return null;
        return Math.max(8, Math.min(95, Math.round(v)));
    }

    function libidoFromEdf(edf) {
        const raw = edf?.DYNAMICS?.LIBIDO ?? edf?.LIBIDO ?? edf?.DYNAMICS?.libido;
        if (raw == null || raw === '') return null;
        if (typeof raw === 'number') return clampLibido(raw);
        const s = String(raw).toLowerCase();
        if (/very\s*high|extreme|nymph/.test(s)) return 88;
        if (/high/.test(s)) return 72;
        if (/low|asexual|demi/.test(s)) return 22;
        if (/med/.test(s)) return 50;
        return clampLibido(parseInt(s, 10));
    }

    function inferLibido(profile, edf) {
        const fromEdf = libidoFromEdf(edf);
        if (fromEdf != null) return fromEdf;
        const blob = dynamicsBlob(profile, edf);
        let n = 50;
        if (/asexual|demi|low.?libido|modest|shy|innocent|vanilla|prude|reserved/.test(blob)) n -= 20;
        if (/high.?libido|nympho|hypersexual|horny|slut|goon|nsfw|kink|thirst|exhibition|onlyfans/.test(blob)) n += 28;
        if (/flirt|sexual|fwb|hookup|teas/.test(blob)) n += 10;
        if (/religious|conservative/.test(blob)) n -= 8;
        return clampLibido(n) ?? 50;
    }

    /**
     * Stable 0–100 libido. Writes onto profile + EDF when missing so ingest/load persist it.
     */
    function ensureLibido(profile, edf) {
        const existing = clampLibido(profile?.libido);
        if (existing != null) {
            if (edf) {
                if (!edf.DYNAMICS || typeof edf.DYNAMICS !== 'object') edf.DYNAMICS = {};
                if (edf.DYNAMICS.LIBIDO == null) edf.DYNAMICS.LIBIDO = existing;
            }
            return existing;
        }
        const n = inferLibido(profile, edf);
        if (profile && typeof profile === 'object') profile.libido = n;
        if (edf) {
            if (!edf.DYNAMICS || typeof edf.DYNAMICS !== 'object') edf.DYNAMICS = {};
            edf.DYNAMICS.LIBIDO = n;
        }
        return n;
    }

    function arousalRiseCap(libido) {
        const n = clampLibido(libido) ?? 50;
        if (n >= 80) return 28;
        if (n >= 65) return 18;
        if (n <= 32) return 6;
        return 12;
    }

    function limitArousalRise(prev, proposed, libido) {
        const from = Math.max(0, Math.min(100, Math.round(Number(prev) || 0)));
        const to = Math.max(0, Math.min(100, Math.round(Number(proposed))));
        if (!Number.isFinite(Number(proposed))) return from;
        if (to <= from) return to;
        return Math.max(0, Math.min(100, from + Math.min(to - from, arousalRiseCap(libido))));
    }

    const EXERTION_RE = /overheat|sauna|workout|run\b|gym|fever|boiling|cardio|dance|club|beach|sex|hookup/;
    const SKIP_H = 3600000;
    const SKIP_M = 60000;

    /**
     * One step toward rest for every curated mood. Intensity drop is the main cool;
     * this only fires when intensity would fall off the bottom, or after a long/stacked skip.
     */
    const MOOD_COOL_NEXT = {
        Angry: 'Frustrated',
        Frustrated: 'Annoyed',
        Annoyed: 'Annoyed',
        Jealous: 'Hurt',
        Hurt: 'Sad',
        Sad: 'Melancholy',
        Melancholy: 'Lonely',
        Lonely: 'Soft',
        'Missing him': 'Lonely',
        Guilty: 'Vulnerable',
        Anxious: 'Vulnerable',
        Embarrassed: 'Soft',
        Vulnerable: 'Soft',
        Cold: 'Distant',
        Distant: 'Distant',
        Giddy: 'Excited',
        Excited: 'Playful',
        Playful: 'Warm',
        Flirty: 'Warm',
        Hopeful: 'Warm',
        Warm: 'Soft',
        Soft: 'Content',
        Content: 'Content',
        Neutral: 'Neutral'
    };

    const MOOD_FAMILY = {
        Angry: 'sharp', Frustrated: 'sharp', Annoyed: 'sharp',
        Jealous: 'jealous',
        Hurt: 'wound', Sad: 'wound', Melancholy: 'wound', Lonely: 'wound',
        'Missing him': 'wound', Guilty: 'wound', Anxious: 'wound',
        Embarrassed: 'wound', Vulnerable: 'wound',
        Cold: 'closed', Distant: 'closed',
        Giddy: 'bright', Excited: 'bright', Playful: 'bright', Flirty: 'bright',
        Hopeful: 'bright', Warm: 'bright', Soft: 'bright', Content: 'bright',
        Neutral: 'rest'
    };

    function canonMood(mood) {
        if (typeof MiragePrompt?.normalizeMood === 'function') {
            return MiragePrompt.normalizeMood(mood) || String(mood || '').trim();
        }
        return String(mood || '').trim();
    }

    function classifyMood(mood) {
        const m = canonMood(mood);
        if (!m) return 'Neutral';
        if (MOOD_COOL_NEXT[m]) return m;
        const s = m.toLowerCase();
        if (/enrag|furious|livid|rage|fuming|pissed|angry|\bmad\b/.test(s)) return 'Angry';
        if (/frustrat/.test(s)) return 'Frustrated';
        if (/annoy|irritat|aggravat|bother/.test(s)) return 'Annoyed';
        if (/jealous|envious/.test(s)) return 'Jealous';
        if (/giddy|euphor|manic/.test(s)) return 'Giddy';
        if (/excit/.test(s)) return 'Excited';
        if (/flirt|thirst|horny|seduc/.test(s)) return 'Flirty';
        if (/playful|mischief|teas/.test(s)) return 'Playful';
        if (/heartbroken|betray|hurt/.test(s)) return 'Hurt';
        if (/sad|cry|depress|grief/.test(s)) return 'Sad';
        if (/melanchol|wistful|blue\b/.test(s)) return 'Melancholy';
        if (/lonely|alone|isolat/.test(s)) return 'Lonely';
        if (/miss(ing)? him|pining|longing/.test(s)) return 'Missing him';
        if (/anxious|nervous|worry|panic|stress/.test(s)) return 'Anxious';
        if (/guilt|shame|regret/.test(s)) return 'Guilty';
        if (/embarrass|awkward|shy flush/.test(s)) return 'Embarrassed';
        if (/vulnerab|unguarded/.test(s)) return 'Vulnerable';
        if (/\bcold\b|icy|frost/.test(s)) return 'Cold';
        if (/distant|withdraw|checked.?out|shut down/.test(s)) return 'Distant';
        if (/hope/.test(s)) return 'Hopeful';
        if (/warm|fond|affection/.test(s)) return 'Warm';
        if (/\bsoft\b|tender|gentle/.test(s)) return 'Soft';
        if (/content|chill|calm|peace/.test(s)) return 'Content';
        if (/neutral|fine|ok\b|okay|meh/.test(s)) return 'Neutral';
        return null;
    }

    function moodFamilyOf(mood) {
        const key = classifyMood(mood);
        return (key && MOOD_FAMILY[key]) || 'freeform';
    }

    function stepsToRest(mood) {
        let cur = classifyMood(mood);
        if (!cur) return 1;
        let n = 0;
        const seen = new Set();
        while (cur && MOOD_COOL_NEXT[cur] && MOOD_COOL_NEXT[cur] !== cur && !seen.has(cur) && n < 12) {
            seen.add(cur);
            cur = MOOD_COOL_NEXT[cur];
            n += 1;
        }
        return n;
    }

    /** One rung toward rest. Unknown freeform keeps its label (intensity still drops). */
    function stepMoodTowardRest(mood) {
        const key = classifyMood(mood);
        if (!key) return canonMood(mood) || mood;
        const next = MOOD_COOL_NEXT[key];
        return next || key;
    }

    /** Same emotional family and more peaked than the cooled floor — block echo of the old peak. */
    function clampMoodNotSharperThan(proposed, floor) {
        const prop = canonMood(proposed) || proposed;
        const base = canonMood(floor) || floor;
        if (!prop || !base) return prop || base;
        if (moodFamilyOf(prop) === 'freeform' || moodFamilyOf(base) === 'freeform') {
            return prop;
        }
        if (moodFamilyOf(prop) !== moodFamilyOf(base)) return prop;
        if (stepsToRest(prop) > stepsToRest(base)) return base;
        return prop;
    }

    function thermalRankOf(t) {
        const v = String(t || 'Normal');
        if (v === 'Overheating') return 2;
        if (v === 'Sweaty') return 1;
        return 0;
    }

    function thermalFromRankOf(r) {
        if (r >= 2) return 'Overheating';
        if (r >= 1) return 'Sweaty';
        return 'Normal';
    }

    function exertionThermalFromText(blob) {
        const s = String(blob || '').toLowerCase();
        if (/overheat|sauna|fever|boiling/.test(s)) return 'Overheating';
        if (EXERTION_RE.test(s)) return 'Sweaty';
        return null;
    }

    function formatSkipSpan(ms) {
        const n = Math.max(0, Number(ms) || 0);
        const DAY = 24 * SKIP_H;
        if (n >= 365 * DAY) {
            const y = Math.max(1, Math.round(n / (365 * DAY)));
            return y === 1 ? '1 year' : `${y} years`;
        }
        if (n >= 28 * DAY) {
            const m = Math.max(1, Math.round(n / (30 * DAY)));
            return m === 1 ? '1 month' : `${m} months`;
        }
        if (n >= DAY) {
            const d = Math.round(n / DAY);
            return d <= 1 ? 'a day' : `${d} days`;
        }
        if (n >= SKIP_H) {
            const h = n / SKIP_H;
            const rounded = h >= 10 ? Math.round(h) : Math.round(h * 10) / 10;
            return `${String(rounded).replace(/\.0$/, '')}h`;
        }
        if (n >= SKIP_M) return `${Math.max(1, Math.round(n / SKIP_M))}m`;
        return 'a moment';
    }

    /**
     * How far weather should walk after a clock jump.
     * One short cut can keep a fight. Hours / stacked /next scene must cool intensity.
     */
    function planSkipCooling(skipMs, { hardCut = false, streak = 0 } = {}) {
        const ms = Math.max(0, Number(skipMs) || 0);
        const streakN = Math.max(0, Math.round(Number(streak) || 0));
        let intensityCap = 3;
        let intensityDrop = 0;
        let arousalDrop = 0;
        let teaseDrop = 0;
        let thermalDrop = 0;
        let engagementDrop = 0;
        let softenLabel = false;
        const skipEngagementRise = !!(hardCut || ms >= 45 * SKIP_M);

        if (ms >= 8 * SKIP_H) {
            intensityDrop = 2;
            intensityCap = 1;
            arousalDrop = 22;
            teaseDrop = 1;
            thermalDrop = 2;
            engagementDrop = 18;
            softenLabel = true;
        } else if (ms >= 3 * SKIP_H) {
            intensityDrop = 1;
            intensityCap = 2;
            arousalDrop = 14;
            teaseDrop = 1;
            thermalDrop = 1;
            engagementDrop = 10;
        } else if (ms >= SKIP_H) {
            intensityDrop = 1;
            intensityCap = 2;
            arousalDrop = 8;
            thermalDrop = 1;
            engagementDrop = 6;
        } else if (ms >= 45 * SKIP_M) {
            arousalDrop = 4;
        }

        if (hardCut && streakN >= 3) {
            intensityDrop = Math.max(intensityDrop, 2);
            intensityCap = Math.min(intensityCap, 1);
            softenLabel = true;
            if (thermalDrop < 1) thermalDrop = 1;
            if (arousalDrop < 10) arousalDrop = 10;
        } else if (hardCut && streakN >= 2) {
            intensityDrop = Math.max(intensityDrop, 1);
            intensityCap = Math.min(intensityCap, 2);
        }

        const active = skipEngagementRise
            || intensityDrop > 0
            || arousalDrop > 0
            || teaseDrop > 0
            || thermalDrop > 0
            || engagementDrop > 0;
        return {
            active,
            skipMs: ms,
            hardCut: !!hardCut,
            streak: streakN,
            intensityCap,
            intensityDrop,
            arousalDrop,
            teaseDrop,
            thermalDrop,
            engagementDrop,
            softenLabel,
            skipEngagementRise
        };
    }

    function skipWeatherNote(plan, session) {
        if (!plan?.active) return '';
        const bits = [
            `TIME WEATHER: ${formatSkipSpan(plan.skipMs)} passed`
                + (plan.hardCut ? ` (hard cut ×${plan.streak || 1})` : '')
                + '.'
        ];
        bits.push('Do not echo the previous turn\'s mood / thermal / arousal JSON.');
        bits.push(
            `LIVE STATE already cooled. Mood intensity ceiling this turn is ${plan.intensityCap}/3`
            + ' — the feeling can linger at this intensity; peak intensity after hours / stacked scene jumps is not.'
        );
        bits.push(
            'Thermal follows the NEW activity (rest / bed / hours later → Normal unless she just worked out, danced, or similar).'
        );
        if (plan.hardCut) {
            bits.push('Hard scene cut: tracking.env MUST be a different place type than the previous room — not a renamed bedroom.');
        }
        if (plan.skipMs >= 28 * 24 * SKIP_H) {
            bits.push('Months/years passed — new season of her life. NEW clothes and a place that fits TODAY, not last night. She has been living; this is not the same conversation paused. A long skip is not him ghosting — do not dump engagement to Cold.');
        } else if (plan.skipMs >= 18 * SKIP_H) {
            bits.push('New calendar day / multi-day skip: she MUST change clothes (new tracking.outfit) and MUST leave the previous room type (kitchen/living/out is OK; same bedroom label is not). Days passing is not him ghosting this thread — do not dump engagement to Cold.');
        } else if (plan.skipMs >= 3 * SKIP_H) {
            bits.push('Hours passed — she should have left that exact room if the hour/activity changed. Do not reuse a renamed bedroom. A clock jump is not him ignoring her — do not dump engagement to Cold.');
        } else {
            bits.push('A clock jump is not him ignoring her — do not dump engagement to Cold.');
        }
        const mood = session?.mood;
        const intensity = session?.moodIntensity;
        if (mood) bits.push(`Current mood after cooling: ${mood} @${intensity ?? 1}.`);
        return bits.join(' ');
    }

    /**
     * Walk mood / thermal / arousal / tease toward rest after a sim-time jump.
     * Operator /mood /arousal /tease /thermal pins win. Persona and awareness untouched.
     */
    function applySkipCooling(session, {
        skipMs = 0,
        hardCut = false,
        profile = null,
        edf = null
    } = {}) {
        if (!session) return null;
        const pinned = session.operatorOverrides || {};
        if (hardCut) {
            session.hardCutStreak = Math.max(0, Number(session.hardCutStreak) || 0) + 1;
        }
        const plan = planSkipCooling(skipMs, {
            hardCut,
            streak: session.hardCutStreak
        });
        session._skipEngagementRise = !!plan.skipEngagementRise;
        if (!plan.active) {
            session._skipWeather = null;
            return plan;
        }

        const changes = {};
        if (pinned.mood == null && pinned.moodIntensity == null) {
            const beforeMood = session.mood;
            const beforeI = Math.max(0, Math.min(3, Math.round(Number(session.moodIntensity) || 1)));
            let intensity = Math.min(beforeI, plan.intensityCap);
            intensity = Math.max(0, intensity - plan.intensityDrop);
            let mood = session.mood;
            if (intensity < 1) {
                mood = stepMoodTowardRest(mood);
                intensity = 1;
            } else if (plan.softenLabel && intensity <= 1) {
                mood = stepMoodTowardRest(mood);
            }
            session.mood = mood;
            session.moodIntensity = intensity;
            if (beforeMood !== mood || beforeI !== intensity) {
                changes.mood = { from: `${beforeMood} @${beforeI}`, to: `${mood} @${intensity}` };
            }
        }

        if (pinned.arousal == null && plan.arousalDrop > 0) {
            const libido = ensureLibido(profile, edf) ?? 50;
            const floor = Math.round(8 + (libido / 100) * 22);
            const before = Math.max(0, Math.min(100, Math.round(Number(session.arousal) || 0)));
            const next = Math.max(floor, before - plan.arousalDrop);
            if (next !== before) {
                changes.arousal = { from: before, to: next };
                session.arousal = next;
            }
        }

        if (pinned.tease == null && plan.teaseDrop > 0) {
            const goon = isGoonPersona(session);
            const floor = goon ? 1 : 0;
            const before = Math.max(floor, Math.min(3, Math.round(Number(session.tease) || 0)));
            const next = Math.max(floor, before - plan.teaseDrop);
            if (next !== before) {
                changes.tease = { from: before, to: next };
                session.tease = next;
            } else if (goon && (Number(session.tease) || 0) < 1) {
                session.tease = 1;
            }
        } else if (isGoonPersona(session) && pinned.tease == null && (Number(session.tease) || 0) < 1) {
            session.tease = 1;
        }

        if (pinned.engagement == null && (plan.engagementDrop > 0 || plan.skipEngagementRise)) {
            const before = Math.max(0, Math.min(100, Math.round(Number(session.engagement) || 0)));
            const dropped = Math.max(0, before - (plan.engagementDrop || 0));
            const min = Math.max(plan.skipMs >= 8 * SKIP_H ? 35 : 0, dropped);
            plan.engagementMin = min;
            if (min < before) {
                changes.engagement = { from: before, to: min };
                session.engagement = min;
            }
        }

        if (pinned.thermal == null && plan.thermalDrop > 0) {
            const before = session.thermal || 'Normal';
            const next = thermalFromRankOf(Math.max(0, thermalRankOf(before) - plan.thermalDrop));
            if (next !== before) {
                changes.thermal = { from: before, to: next };
                session.thermal = next;
            }
        }

        plan.moodAfterCool = session.mood;
        plan.arousalMax = Math.max(0, Math.min(100, Math.round(Number(session.arousal) || 0)));
        plan.teaseMax = Math.max(0, Math.min(3, Math.round(Number(session.tease) || 0)));
        plan.thermalMaxRank = thermalRankOf(session.thermal);
        plan.note = skipWeatherNote(plan, session);
        plan.changes = changes;
        session._skipWeather = plan;
        return plan;
    }

    /** After the model returns: keep skip cooling; allow heat only if the NEW beat earns it. */
    function enforceSkipWeatherCeiling(session, parsed, { profile = null, edf = null } = {}) {
        const plan = session?._skipWeather;
        if (!plan || !session) return null;
        const pinned = session.operatorOverrides || {};
        const blob = [
            parsed?.tracking?.env,
            parsed?.imageDirective?.envDetail,
            parsed?.imageDirective?.pose,
            parsed?.delivery?.timeSkipReason,
            parsed?.characterResponse
        ].filter(Boolean).join(' ');
        const exertion = exertionThermalFromText(blob);
        const applied = {};

        if (pinned.moodIntensity == null && plan.intensityCap < 3) {
            const i = Math.max(0, Math.min(3, Math.round(Number(session.moodIntensity) || 1)));
            if (i > plan.intensityCap) {
                applied.moodIntensity = { from: i, to: plan.intensityCap };
                session.moodIntensity = plan.intensityCap;
            }
        }
        if (pinned.mood == null && plan.moodAfterCool) {
            const clamped = clampMoodNotSharperThan(session.mood, plan.moodAfterCool);
            if (clamped && clamped !== session.mood) {
                applied.mood = { from: session.mood, to: clamped };
                session.mood = clamped;
            }
        }
        if (pinned.arousal == null && Number.isFinite(plan.arousalMax)) {
            const now = Math.max(0, Math.min(100, Math.round(Number(session.arousal) || 0)));
            if (now > plan.arousalMax) {
                if (exertion) {
                    const libido = ensureLibido(profile, edf);
                    const allowed = limitArousalRise(plan.arousalMax, now, libido);
                    if (allowed !== now) {
                        applied.arousal = { from: now, to: allowed };
                        session.arousal = allowed;
                    }
                } else {
                    applied.arousal = { from: now, to: plan.arousalMax };
                    session.arousal = plan.arousalMax;
                }
            }
        }
        if (pinned.tease == null && Number.isFinite(plan.teaseMax) && !exertion) {
            const goon = isGoonPersona(session);
            const floor = goon ? 1 : 0;
            const now = Math.max(floor, Math.min(3, Math.round(Number(session.tease) || 0)));
            const cap = Math.max(floor, plan.teaseMax);
            if (now > cap) {
                applied.tease = { from: now, to: cap };
                session.tease = cap;
            } else if (goon && now < 1) {
                session.tease = 1;
            }
        }
        if (pinned.thermal == null && Number.isFinite(plan.thermalMaxRank) && !exertion) {
            const nowR = thermalRankOf(session.thermal);
            if (nowR > plan.thermalMaxRank) {
                const next = thermalFromRankOf(plan.thermalMaxRank);
                applied.thermal = { from: session.thermal, to: next };
                session.thermal = next;
            }
        }
        return Object.keys(applied).length ? applied : null;
    }

    function clearSkipWeather(session) {
        if (!session) return;
        delete session._skipWeather;
        delete session._skipEngagementRise;
    }

    function drivePromptLine(profile, edf) {
        const libido = ensureLibido(profile, edf);
        const bias = teaseBias(profile, edf);
        const cap = engagementRiseCap(profile);
        const spikeCap = engagementSpikeCap(profile);
        const goonPersona = isGoonPersona();
        const teaseHint = goonPersona
            ? 'Goon: tease floor 1, rises easily (up to +2/turn)'
            : (bias === 'shy'
                ? 'tease-shy — keep tease low unless the beat is clearly sexual; liking him does not equal stripping'
                : (bias === 'forward'
                    ? 'tease-forward — tease can rise even while engagement stays Cool (attention / brat energy)'
                    : 'tease follows the beat, not engagement'));
        return `DRIVE (hidden): libido ${libido}/100 (arousal rises slowly if low, easily if high). `
            + `Engagement rise capped ~+${cap}/turn from difficulty`
            + ` (~+${spikeCap} if HIS message is a true hook). ${teaseHint}.`;
    }

    /**
     * After a completed turn — returns chat hints to append (may be empty).
     * Engagement rise is clamped here only (not in applyTracking) so deltas do not stack.
     */
    function afterTurn({
        tracking,
        characterText,
        profile,
        session,
        userText = null,
        internal = false,
        proactive = false,
        isCommand = false
    } = {}) {
        const prev = clampEngagement(session?.engagement);
        let engagement = resolveEngagement(tracking, characterText, profile, session);
        let spiked = false;
        if (session?.operatorOverrides?.engagement == null) {
            const spike = shouldAllowEngagementSpike({
                tracking,
                proposed: engagement,
                prev,
                profile,
                userText: userText != null ? userText : session?._lastUserInput,
                internal,
                proactive,
                isCommand
            });
            engagement = limitEngagementRise(prev, engagement, profile, { spike });
            spiked = !!(spike && prev != null && engagement > prev);
            if (session?._skipEngagementRise && !spiked && prev != null) {
                if (engagement > prev) {
                    engagement = prev;
                } else if (engagement < prev) {
                    const min = Number(session._skipWeather?.engagementMin);
                    engagement = Number.isFinite(min) ? Math.max(engagement, min) : prev;
                }
            }
        }
        if (session?.ghostedCold && !spiked) {
            engagement = Math.min(engagement, 30);
        }
        const hints = [];
        const band = bandOf(engagement).id;

        const hint = engagementHint(engagement, profile);
        if (hint && band !== lastBand && (band === 'cold' || band === 'cool')) {
            hints.push(hint);
        }

        const loopHint = staleLoopHint();
        if (loopHint) {
            hints.push(loopHint);
            shortUserStreak = 0;
        }

        lastBand = band;
        if (session && engagement > 25) session.ghostedCold = false;
        return { engagement, band, hints, spiked };
    }

    /**
     * Cool engagement from being left on read — how a real person actually behaves.
     * Never heats. Operator /engagement pin wins. Idempotent for the same gap.
     *
     *   <8m:  still in the thread
     *   8–20m: heat is broken (even Hot drops to Cool)
     *   20–40m: she's not hanging on this chat (Cold)
     *   40–60m: checked out
     *   ≥1h:   gone
     *   ≥3h:   zero
     */
    function decayEngagementForSilence(sess) {
        if (!sess || sess.phase !== 'active') {
            return { engagement: sess?.engagement, changed: false };
        }
        const pinned = sess.operatorOverrides?.engagement;
        if (pinned != null) {
            const p = clampEngagement(pinned);
            return { engagement: p != null ? p : sess.engagement, changed: false, pinned: true };
        }
        const current = clampEngagement(sess.engagement) ?? 55;
        // Sim clock only — wall absence must not crush engagement when they
        // chose "continue from last time" (her world did not skip those hours).
        const simGap = typeof global.MirageImmersion?.silenceSinceAnyMs === 'function'
            ? global.MirageImmersion.silenceSinceAnyMs()
            : 0;
        const wallGap = typeof global.MirageImmersion?.wallAbsenceMs === 'function'
            ? global.MirageImmersion.wallAbsenceMs()
            : 0;
        // Director time-pass jumps sim clock without him ghosting. Use the smaller gap
        // so a 3.5-day /time pass while you're sitting there does not zero engagement.
        const gap = wallGap > 0 ? Math.min(simGap, wallGap) : simGap;
        const M = 60 * 1000;
        const H = 3600000;

        let floor = null;
        if (gap >= 24 * H) floor = 12;
        else if (gap >= 8 * H) floor = 22;
        else if (gap >= 3 * H) floor = 32;
        else if (gap >= 90 * M) floor = 45;
        else if (gap >= 30 * M) floor = 55;

        if (floor == null) {
            return { engagement: current, changed: false, gapMs: gap };
        }

        const next = clampEngagement(Math.min(current, floor)) ?? current;
        const changed = next !== current;
        if (changed) sess.engagement = next;
        if (next <= 25) sess.ghostedCold = true;
        return { engagement: next, changed, gapMs: gap, from: current };
    }

    global.MirageLoyaltyUX = {
        BANDS,
        COMPLIANCE_TO_ENGAGEMENT,
        clampEngagement,
        bandOf,
        labelOf,
        seedEngagement,
        seedSessionDynamics,
        migrateComplianceToEngagement,
        resolveEngagement,
        recordUserMessage,
        afterTurn,
        decayEngagementForSilence,
        resetSession,
        snapshotDynamics,
        restoreDynamics,
        engagementHueColor,
        engagementRiseCap,
        engagementSpikeCap,
        userMessageLooksTrivial,
        limitEngagementRise,
        difficultyTier,
        scoreGhostAxes,
        ghostProfile,
        ghostDeliveryClientNote,
        teaseBias,
        limitTeaseChange,
        clampLibido,
        ensureLibido,
        arousalRiseCap,
        limitArousalRise,
        drivePromptLine,
        planSkipCooling,
        applySkipCooling,
        enforceSkipWeatherCeiling,
        clearSkipWeather,
        stepMoodTowardRest,
        clampMoodNotSharperThan,
        classifyMood
    };
})(typeof window !== 'undefined' ? window : globalThis);
