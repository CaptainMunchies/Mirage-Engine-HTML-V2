/**
 * MIRAGE ENGINE v2 — God-mode command router (client + model handoff)
 */
(function (global) {
    'use strict';

    const PERSONA_MAP = {
        standard: 'Standard',
        gf: 'GF',
        secret: 'Secret',
        wasted: 'Wasted',
        goon: 'Goon',
        drama: 'Drama',
        rage: 'Rage',
        psycho: 'Psycho'
    };

    function normalizePersona(raw) {
        const key = String(raw || '').trim().toLowerCase();
        return PERSONA_MAP[key] || null;
    }

    function isViewStory(text) {
        return /^view story\b/i.test(String(text || '').trim());
    }

    function storyAgeMs(sess) {
        const stamped = Number(sess?.lastStoryAt) || Number(sess?.lastAiMessageAt) || 0;
        if (!stamped) return 0;
        let now = Date.now();
        try {
            if (typeof MirageImmersion?.simNowMs === 'function') now = MirageImmersion.simNowMs();
            else if (typeof MiragePhoneUX?.herNow === 'function') now = MiragePhoneUX.herNow().getTime();
        } catch { /* wall clock */ }
        return Math.max(0, now - stamped);
    }

    function formatStoryAge(ms) {
        if (typeof MirageImmersion?.formatDuration === 'function') {
            return MirageImmersion.formatDuration(ms);
        }
        const n = Math.max(0, Number(ms) || 0);
        if (n < 60 * 1000) return 'just now';
        if (n < 60 * 60 * 1000) return `${Math.round(n / 60000)}m ago`;
        return `${Math.round(n / 3600000)}h ago`;
    }

    function placeCutInject(sess) {
        const prev = String(sess?.env || '').trim();
        if (!prev) return '';
        let hour = null;
        try {
            hour = MiragePhoneUX?.herNow?.()?.getHours?.();
        } catch { /* ignore */ }
        if (typeof MiragePrompt?.formatPlaceCutNote === 'function') {
            return MiragePrompt.formatPlaceCutNote(prev, { hour });
        }
        return `PLACE CUT: she LEFT "${prev}". tracking.env MUST be a different place type — not a renamed room.`;
    }

    function storyReplyTransitionInject(gapMs) {
        const age = formatStoryAge(gapMs);
        if (gapMs < 3 * 60 * 1000) {
            return [
                'STORY→DM: He replied while her Story is still fresh (sim age ~' + age + ').',
                'Switch to DM — a NEW shotType vs the Story (Mirror, POV, or Propped — not another Front Selfie clone). Crop and camera height also change.',
                'She can treat the Story as live context (he just saw it) without breaking character.'
            ].join(' ');
        }
        if (gapMs < 30 * 60 * 1000) {
            return [
                'STORY→DM: He replied a bit after her Story (sim age ~' + age + ').',
                'Switch to DM — a NEW shotType vs the Story (Mirror, POV, or Propped — not another Front Selfie clone). Crop and camera height also change.',
                'Light Story callback is fine; do not overplay "just watched" energy.'
            ].join(' ');
        }
        if (gapMs < 3 * 60 * 60 * 1000) {
            return [
                'STORY→DM: He replied hours-ish after her Story (sim age ~' + age + ').',
                'Switch to DM — a NEW shotType vs the Story (Mirror, POV, or Propped — not another Front Selfie clone). Crop and camera height also change.',
                'Story is background context only — reopen like a normal check-in unless he quotes it.'
            ].join(' ');
        }
        return [
            'STORY→DM: He replied long after her Story (sim age ~' + age + ').',
            'Switch to DM — a NEW shotType vs the Story (Mirror, POV, or Propped — not another Front Selfie clone). Crop and camera height also change.',
            'Treat the Story as old. Do NOT act like he just watched unless he explicitly brings it up.'
        ].join(' ');
    }

    function storyReplyClientNote(gapMs) {
        const age = formatStoryAge(gapMs);
        if (gapMs < 3 * 60 * 1000) return `Story reply (fresh, ~${age}) — DM mode.`;
        if (gapMs < 30 * 60 * 1000) return `Story reply (~${age} later) — DM mode.`;
        if (gapMs < 3 * 60 * 60 * 1000) return `Story reply (~${age} later) — cooler reopen.`;
        return `Story reply (stale, ~${age}) — DM reopen.`;
    }

    /** Metrics the operator can pin directly. The model evolves onward from the pinned value. */
    const METRIC_COMMANDS = {
        '/arousal': { key: 'arousal', usage: '/arousal [0-100]' },
        '/tease': { key: 'tease', usage: '/tease [0-3]' },
        '/awareness': { key: 'awareness', usage: '/awareness [0-100]' },
        '/engagement': { key: 'engagement', usage: '/engagement [0-100]' }
    };

    function shouldDeferWorldSkip(state) {
        return state.getPacingMode?.() === 'hybrid'
            || state.getPacingMode?.() === 'realtime'
            || (typeof MirageImmersion?.waitsOnTimeJumps === 'function' && MirageImmersion.waitsOnTimeJumps());
    }

    /** Append "3:15 PM → 5:41 PM" to command notes when a clock jump is known. */
    function withClockArrow(note, clockAdvanceMs) {
        const arrow = typeof MiragePhoneUX?.formatClockArrow === 'function'
            ? MiragePhoneUX.formatClockArrow(
                clockAdvanceMs,
                MiragePhoneUX.herNow?.()?.getTime?.()
            )
            : '';
        if (!arrow) return note;
        const base = String(note || '').trim();
        if (!base) return arrow;
        if (base.includes('→')) return base;
        return `${base} · ${arrow}`;
    }

    function metricOverrideResult(key, applied, text) {
        return {
            proceed: true,
            userText: text,
            task: 'command',
            inject: `OPERATOR OVERRIDE: ${key} set to ${applied}. Treat this as the current truth and evolve from it.`,
            clientNote: `${key.charAt(0).toUpperCase() + key.slice(1)} → ${applied}`,
            metricChanged: true,
            pinOnly: true
        };
    }

    /**
     * Parse `/set_emotional_state Hurt 2 | he cancelled again`
     * → { mood, intensity, note }
     */
    function parseEmotionalStateArg(arg) {
        let raw = String(arg || '').trim();
        if (!raw) return null;
        let note = '';
        const pipe = raw.indexOf('|');
        if (pipe >= 0) {
            note = raw.slice(pipe + 1).trim().slice(0, 120);
            raw = raw.slice(0, pipe).trim();
        }
        if (!raw) return null;
        const tokens = raw.split(/\s+/).filter(Boolean);
        let intensity = null;
        if (tokens.length >= 2 && /^[0-3]$/.test(tokens[tokens.length - 1])) {
            intensity = Number(tokens.pop());
        }
        const moodRaw = tokens.join(' ');
        const mood = typeof MiragePrompt?.normalizeMood === 'function'
            ? MiragePrompt.normalizeMood(moodRaw)
            : moodRaw.trim().slice(0, 40);
        if (!mood) return null;
        if (intensity == null) intensity = 2;
        return { mood, intensity, note };
    }

    function wardrobeContextBlob(sess) {
        const hist = Array.isArray(sess?.history) ? sess.history : [];
        return hist.slice(-4).map(h => `${h.user || ''} ${h.ai || ''}`).join('\n');
    }

    function looksLikeOutfitChangeRequest(raw, sess) {
        const text = String(raw || '').trim();
        if (!text || text.startsWith('/')) return false;
        const heVerb = /תחליפ|תתחלפ|להחליף|תחזירי?|תלבש|תתלבש|תתפשט|תוציא[יי]?|תוריד[יי]?|תשימ[יי]?|שימ[יי]?|לבש[יי]?/;
        const heClothes = /בגד|בגדים|לבוש|חולצה|גופי[יה]|מכנס|ג['׳]?ינס|סוודר|שמלה|שורט|טייץ|חצאית|מעיל|קפוצ|אאוטפיט|אוטפיט|outfit|לוק|מדי[םבא]?|מדים|אחיד|לסט|הסט|סט ספורט|ספורט|חליפה|חליפת|טרנינג|אימון|קרופ|גופיה/;
        if (heVerb.test(text) && heClothes.test(text)) return true;
        // "תחליפי ל…" = change into X (סט ספורט, מדי, etc.) — not "change the subject/channel"
        if (/תחליפ[יי]?\s+ל/.test(text) && !/לנושא|לערוץ|למצב|לשפה/.test(text)) return true;
        if (/תחליפ[יי]?/.test(text) && /משהו|אחר|חדש|סקסי|מחרמן|חמים|לוק|חום|שחור|לבן|אפור/.test(text)) return true;
        if (/עוד\s*(אאוטפיט|אוטפיט|לוקים?|בגדים|סט)/.test(text)) return true;
        if (/(אאוטפיט|אוטפיטים)/.test(text) && /עוד|אחר|חדש|תחליפ|תעש/.test(text)) return true;
        if (heClothes.test(text) && /התכוונת|לא זה|לא אלה|מה שאת לובשת|זה לא|meant|not (that|those|the one)|that'?s (dress|class|type)/i.test(text)) {
            return true;
        }
        const enClothes = /\b(clothes|clothing|outfit|outfits|wardrobe|hoodie|sweater|jeans|shorts|dress|shirt|pants|top|bra|lingerie|fit|look|uniform|kit|set|gym|sport|sportswear|activewear|tracksuit|matching)\b/i;
        const enVerb = /\b(change|switch|swap|wear|put on|put back|get (?:into|dressed|changed)|cover up|strip|undress|take off|go back to|change into|change out of)\b/i;
        if (enVerb.test(text) && enClothes.test(text)) return true;
        if (/\b(get dressed|cover up|change clothes|change outfit|wardrobe change|another outfit|different outfit|new outfit|new look)\b/i.test(text)) return true;
        if (/\b(change|swap|switch)\s+(to\s+)?(something|a new|another)\b/i.test(text)
            && /\b(hotter|sexier|cuter|new|else|different)\b/i.test(text)) return true;
        const prior = wardrobeContextBlob(sess);
        const threadIsClothes = heClothes.test(prior) || enClothes.test(prior)
            || /תחליפ[יי]?\s+ל/.test(prior);
        if (threadIsClothes) {
            if (/^(נו+\s*)?תחליפ[יי]?\s*[.!?…]*$/.test(text)) return true;
            if (/^(just |so |ok |okay |go on[, ]*)?(change|switch it|do it|put it on)\s*[.!?]*$/i.test(text)) return true;
        }
        return false;
    }

    function looksLikePlaceChangeRequest(raw) {
        const text = String(raw || '').trim();
        if (!text || text.startsWith('/')) return false;
        if (/\b(go (?:to|into|over to)|come (?:to|over|here)|meet me (?:at|in)|head to|leave (?:the )?(?:room|house|apartment))\b/i.test(text)) {
            return true;
        }
        if (/\b(on the bed|in (?:the )?(?:bed)?room|to (?:the )?bed(?:room)?|in (?:the )?(?:kitchen|bathroom|living room|lounge|balcony)|to (?:the )?(?:kitchen|bathroom|living room|balcony))\b/i.test(text)) {
            return true;
        }
        if (/(^|\s)(תלכ[יי]|לכ[יי] ל|תבואי|בואי ל|צאי מ)/.test(text)) return true;
        if (/על המיטה|למיטה|שבי על|תשכבי|לחדר השינה|עברי לחדר|לכי לחדר|בחדר השינה|בשירותים|לשירותים|במטבח|למטבח|בסלון|לסלון|למרפסת/.test(text)) {
            return true;
        }
        return false;
    }

    function looksLikeMirrorBackRequest(raw) {
        let text = String(raw || '').trim();
        if (!text) return false;
        // Garment names are wardrobe, not a from-behind camera ask.
        text = text.replace(/\b(booty|butt|ass)[- ]?shorts\b/gi, 'SHORTS');
        if (/עם הגב למצלמה|מסתכלת אחורה/.test(text)) return true;
        const mirror = /מראה|mirror|reflection|in the glass/;
        const fromBehind = /from behind|over[- ]shoulder|turn around|back to (?:the )?(?:camera|mirror)|hips (?:to|toward)|עם הגב|הגב ל|אחורה|מאחור/;
        const booty = /booty|butt|ass\b|תחת|ישבן|אחוריים/;
        if (fromBehind.test(text) && (mirror.test(text) || /camera|selfie|מצלמה|סלפי/.test(text))) return true;
        if (booty.test(text) && mirror.test(text)) return true;
        return false;
    }

    function looksLikeFeetRequest(raw) {
        const text = String(raw || '').trim();
        if (!text) return false;
        if (/\b(feet|foot|soles?|toes?|pedicure)\b/i.test(text)) return true;
        if (/\b(foot|feet)\s*pics?\b/i.test(text)) return true;
        if (/כפות?\s*(ה)?רגליים|כף\s*(ה)?רגל|אצבעות\s*(ה)?רגליים/.test(text)) return true;
        if (/(^|[^\u0590-\u05FF])רגליים([^\u0590-\u05FF]|$)/.test(text)
            && /תרא|לראות|תשלח|תעש|show|pic|photo|תמונ/.test(text)) {
            return true;
        }
        return false;
    }

    function looksLikeBodyPartShowRequest(raw) {
        const text = String(raw || '').trim();
        if (!text) return false;
        if (looksLikeFeetRequest(text)) return true;
        const wantsSee = /רוצה לראות|תן לי לראות|לראות את|תרא[היי]|show me|let me see|send .{0,24}(pic|photo|selfie)|take .{0,16}(pic|photo)/i;
        const bodyNoun = /כפות|רגליים|רגל|ידיים|ישבן|תחת|חזה|בטן|גוף|מאחור|שוק|\b(feet|foot|soles|toes|booty|ass|butt|legs?|hands?|stomach|body)\b|from behind/i;
        return wantsSee.test(text) && bodyNoun.test(text);
    }

    function subjectLockFromRequest(raw) {
        if (looksLikeFeetRequest(raw)) return 'feet';
        return null;
    }

    function looksLikeShotDirection(raw) {
        const text = String(raw || '').trim();
        if (!text || text.startsWith('/')) return false;
        if (cropLockFromRequest(text)) return true;
        if (looksLikeBodyPartShowRequest(text) || looksLikeFeetRequest(text)) return true;
        if (looksLikeMirrorBackRequest(text)) return true;
        if (/\b(mirror|selfie|pose|from behind|over[- ]shoulder|show me|send (?:me )?(?:a |another )?(?:pic|photo|selfie)|turn around)\b/i.test(text)) {
            return true;
        }
        if (/תרא[היי]|תצלמ|במראה|המראה|מראה|סלפי|תסתובב|מאחור|אחורה|תרימ[יי]|תמתח|רוצה לראות|לראות את|למצלמה|מעל הכתף/.test(text)) return true;
        return false;
    }

    function leaveStoryForDirectorTurn(sess) {
        if (!sess) return;
        sess.mode = 'DM';
        sess._storyActive = false;
    }

    function looksLikeExtremeFeatureRequest(raw) {
        const text = String(raw || '').trim();
        if (!text) return false;
        if (/שפתיי[םך].{0,24}מקרוב|מקרוב.{0,24}שפתיי/.test(text)) return true;
        if (/\b(only|just)\s+(her |your |my )?(lips|eyes|mouth|tongue)\b/i.test(text)) return true;
        if (/\b(lips|eyes|mouth)[- ]only\b/i.test(text)) return true;
        if (/\b(lips?\s+close|tight on (?:her |your |my )?(lips|eyes|mouth|tongue))\b/i.test(text)) return true;
        if (/\b(close[- ]?up|closeup|macro|zoom in).{0,28}\b(lips|eyes|mouth|tongue)\b/i.test(text)) return true;
        if (/\b(lips|eyes|mouth|tongue).{0,28}\b(close[- ]?up|closeup|macro|fill(?:s|ing)? the frame)\b/i.test(text)) return true;
        return false;
    }

    function looksLikeBodyShotRequest(raw) {
        const text = String(raw || '').trim();
        if (!text) return false;
        if (/\b(body selfie|full[- ]?body|head[- ]to[- ]toe)\b/i.test(text)) return true;
        if (/\bshow (?:me )?(?:your |her )?(body|torso|stomach|midsection|waist)\b/i.test(text)) return true;
        if (/\b(torso|midsection)\s+(selfie|shot|photo)\b/i.test(text)) return true;
        return false;
    }

    function looksLikeWholeFaceCloseup(raw) {
        const text = String(raw || '').trim();
        if (!text) return false;
        if (/דקא\s*פייס|דאק\s*פייס|דאקפייס/.test(text)) return true;
        if (/מקרוב.{0,16}פנים|פנים.{0,16}מקרוב/.test(text)) return true;
        if (/קלוז.{0,20}פנים|פנים.{0,20}קלוז/.test(text)) return true;
        if (/\bduck\s*face\b/i.test(text)) return true;
        if (/\b(close[- ]?up|closeup|tight\s*crop).{0,24}\b(whole face|my face|your face|her face)\b/i.test(text)) return true;
        if (/\b(whole face|full face|hairline to chin|face fill(?:ing)?|headshot)\b/i.test(text)) return true;
        if (/\bclose[- ]?up of (?:me|my face|your face)\b/i.test(text)) return true;
        if (/\bzoom in on (?:my |your |her )?face\b/i.test(text)) return true;
        return false;
    }

    function looksLikeCloseupRequest(raw) {
        const text = String(raw || '').trim();
        if (!text) return false;
        if (looksLikeExtremeFeatureRequest(text)) return true;
        if (looksLikeWholeFaceCloseup(text)) return true;
        if (/קלוז\s*אפ|קלוזאפ|קלוז-אפ/.test(text)) return true;
        if (/מקרוב/.test(text)) return true;
        if (/(סלפי|תמונ[הא]|צילום|צילמ).{0,20}מקרוב|מקרוב.{0,20}(סלפי|פנים|שפתיי)/.test(text)) return true;
        if (/\b(close[-\s]?up|closeup|tight\s*crop|macro)\b/i.test(text)) return true;
        if (/\bzoom in on (?:my |your |her )?(?:face|lips|mouth)\b/i.test(text)) return true;
        return false;
    }

    function cropLockFromRequest(raw) {
        const text = String(raw || '').trim();
        if (!text) return null;
        if (looksLikeFeetRequest(text)) return 'Torso';
        if (looksLikeExtremeFeatureRequest(text)) return 'Extreme';
        if (looksLikeBodyShotRequest(text)) {
            if (/\b(full[- ]?body|head[- ]to[- ]toe|whole (?:body|outfit|look))\b/i.test(text)) return 'Full';
            return 'Torso';
        }
        if (looksLikeWholeFaceCloseup(text)) return 'Face';
        if (looksLikeCloseupRequest(text)) return 'Extreme';
        return null;
    }

    function isGoonPersona(sess) {
        return String(sess?.persona || '') === 'Goon';
    }

    function askAuthorityLine(sess, { fromCommand = false } = {}) {
        if (fromCommand) {
            return 'Director command this turn — she does it. Play it as her idea / impulse. Do not rotate away.';
        }
        if (isGoonPersona(sess)) {
            return 'Goon: he asked — she does it this turn. Do not rotate away.';
        }
        return 'Would she actually do that in this place, hour, outfit, and persona — as if this were real life? If YES: honour his ask this turn (do not rotate away). If NO: stay in character (refuse or joke if that fits) and pick a DIFFERENT shotType than the last photo.';
    }

    function askedNamedShotMethod(raw) {
        const t = String(raw || '');
        if (!t) return '';
        if (/\bpov\b|from (your|her|my) eyes|looking down at (your|her|my)/i.test(t)
            || /מעיניי|מהעיניים|מנקודת המבט/.test(t)) {
            return 'POV';
        }
        if (looksLikeMirrorBackRequest(t)) return 'Mirror Selfie';
        if (/במראה|המראה|\bmirror\b/i.test(t)) return 'Mirror Selfie';
        if (/propped|timer|tripod|set (the )?phone down/i.test(t)) return 'Propped';
        return '';
    }

    function directiveHonoursAsk(directive, sess) {
        if (!directive || !sess) return false;
        if (isGoonPersona(sess) || sess._godModeThisTurn) return true;
        if (!sess._userAskThisTurn && !sess._askCropThisTurn && !sess._askSubjectThisTurn && !sess._askMirrorThisTurn) {
            return false;
        }
        const text = String(sess._userTextThisTurn || '');
        const dShot = String(directive.shotType || '');
        const dCrop = String(directive.crop || '');
        const blob = `${dShot} ${dCrop} ${directive.pose || ''} ${directive.bodyLanguage || ''} ${directive.goonFrame || ''}`.toLowerCase();
        if (sess._askMirrorThisTurn) {
            return /mirror/i.test(dShot) && /back|over.?shoulder|hips|booty|from behind|מאחור/.test(blob);
        }
        if (sess._askSubjectThisTurn === 'feet') {
            const methodOk = /pov|propped/i.test(dShot);
            return methodOk && /feet|soles|toes|pedicure|כפות|רגליים/.test(blob);
        }
        if (sess._askCropThisTurn) {
            return dCrop === sess._askCropThisTurn;
        }
        const method = askedNamedShotMethod(text);
        if (method) {
            if (method === 'Mirror Selfie') return /mirror/i.test(dShot);
            if (method === 'POV') return /\bpov\b/i.test(dShot);
            if (method === 'Propped') return /propped/i.test(dShot);
        }
        return false;
    }

    function subjectDirectorLines(kind, { fromCommand = false, sess = null } = {}) {
        const lines = [];
        if (kind === 'feet') {
            lines.push(
                'SUBJECT LOCK (this turn): the photograph is her FEET — soles, toes, pedicure. That is the subject.',
                'shotType: POV looking down at her legs/feet, or Propped from above. crop MUST be Torso or Full.',
                'pose NAMES the feet. Feet fill the frame.',
                'FORBIDDEN: crop Face, crop Extreme-as-lips/eyes, goonFrame FaceOnly, pulling up so her face is the subject.',
                'Goon: a DUMB face may clip the top edge if she is looking down — never replace the feet with a face crop.'
            );
        }
        if (!lines.length) return lines;
        const strict = fromCommand || isGoonPersona(sess);
        if (strict) lines.push('Ignore the recent-shot variety list this turn.');
        lines.push(askAuthorityLine(sess, { fromCommand }));
        return lines;
    }

    function cropDirectorLines(crop, { fromCommand = false, sess = null } = {}) {
        const c = String(crop || '').trim();
        const strict = fromCommand || isGoonPersona(sess);
        const lines = [];
        if (c === 'Extreme') {
            lines.push(
                strict
                    ? 'CAMERA LOCK (this turn only): imageDirective.crop MUST be Extreme. goonFrame FaceOnly if Goon.'
                    : 'He asked for Extreme close-up — one feature filling MOST of the 9:16 frame (lips, eyes, mouth, tongue, or the detail he named).',
                'pose NAMES that feature.',
                'If she honours it: crop Extreme. FORBIDDEN then: hairline-to-chin portrait, shoulders, pulling back to a whole face.',
                'shotType stays a self-taken method. Do not copy last-frame bed composition.',
            );
        } else if (c === 'Face') {
            lines.push(
                strict
                    ? 'CAMERA LOCK (this turn only): imageDirective.crop MUST be Face.'
                    : 'He asked for a Face crop — hairline-to-chin, identity-readable.',
                'Shoulders may clip the bottom edge. shotType stays a self-taken method. Do not copy last-frame composition.'
            );
        } else if (c === 'Torso' || c === 'Full') {
            lines.push(
                strict
                    ? `CAMERA LOCK (this turn only): imageDirective.crop MUST be ${c}.`
                    : `He asked for a ${c} crop.`,
                c === 'Full'
                    ? 'Head-to-toe so the whole body / outfit reads. Still her photo — never a friend taking it.'
                    : 'Body selfie — midsection / torso is the subject, any angle. Still her photo.'
            );
        } else if (c) {
            lines.push(strict
                ? `CAMERA LOCK (this turn only): imageDirective.crop MUST be ${c}.`
                : `He asked for crop ${c}.`);
        }
        if (strict) lines.push('Ignore the recent-shot variety list this turn.');
        lines.push(askAuthorityLine(sess, { fromCommand }));
        return lines;
    }

    function mirrorBackDirectorLines({ fromCommand = false, sess = null } = {}) {
        const strict = fromCommand || isGoonPersona(sess);
        const lines = [
            strict
                ? 'BACK-TO-MIRROR LOCK: shotType MUST be Mirror Selfie. goonFrame MirrorBooty (or MirrorOverShoulder).'
                : 'He asked for a back-to-mirror shot: her BACK and hips face the glass; she looks over her shoulder at the small phone in the reflection.',
            'The viewer sees her backside. FORBIDDEN if she honours it: facing the mirror square-on with her chest, Front Selfie, high-angle looking-down face selfie.',
            'If he said sit / bed — she sits, still with her back to the glass. If he said closer — crop Torso. If he said from far — crop Full.'
        ];
        if (strict) lines.push('Ignore the recent-shot variety list this turn.');
        lines.push(askAuthorityLine(sess, { fromCommand }));
        return lines;
    }

    function placeAskDirectorLines(raw, sess) {
        const text = String(raw || '').trim();
        const bed = /מיטה|bed(room)?|לחדר|בחדר השינה/i.test(text);
        if (isGoonPersona(sess)) {
            return [
                bed
                    ? 'PLACE ASK: he told her to be on the bed / in that room. tracking.env MUST be that bedroom (or the place he named). Routine kitchen preference does not override HIS ask this turn.'
                    : 'PLACE ASK: he told her to move. tracking.env MUST be the place he named. Routine lock does not override HIS ask this turn.'
            ];
        }
        return [
            bed
                ? 'PLACE ASK: he told her to be on the bed / in that room. Would she actually go there now — this hour, this persona, as if real life? If YES: tracking.env is that place. If NO: stay where she is and stay in character.'
                : 'PLACE ASK: he told her to move. Would she actually go there now — this hour, this persona, as if real life? If YES: tracking.env is the place he named. If NO: stay where she is and stay in character.'
        ];
    }

    function applyOutfitChangeRequest(sess, detail, { fromCommand = false } = {}) {
        const prevOutfit = sess?.outfit || null;
        const rawLook = String(detail || '').trim();
        const look = (typeof MiragePrompt?.isSpecificOutfitLook === 'function'
            ? MiragePrompt.isSpecificOutfitLook(rawLook)
            : !!rawLook)
            ? rawLook
            : '';
        const libraryHint = typeof MiragePrompt?.formatOutfitLibraryHint === 'function'
            ? MiragePrompt.formatOutfitLibraryHint(sess, { lookHint: look, exclude: prevOutfit })
            : '';
        if (sess) {
            sess.outfit = null;
            sess.outfitSource = null;
            sess.lastOutfitDetail = null;
        }
        if (typeof MirageSimulation?.clearSceneContinuity === 'function') {
            MirageSimulation.clearSceneContinuity();
        } else if (typeof EngineState !== 'undefined') {
            EngineState.lastSceneFile = null;
            EngineState.lastSceneImageKey = null;
        }
        const coverageLine = 'outfitDetail MUST name a top AND bottoms (pants/jeans/shorts/skirt), or a one-piece (dress/jumpsuit/romper). Never a top-only description.';
        const goonWardrobe = sess?.persona === 'Goon'
            ? [
                'GOON WARDROBE: the new look stays fully clothed and still teases — fitted knit scoop, satin cami, wrap top, low-rise lounge, deep neckline, fabric sheen.',
                'FORBIDDEN in tracking.outfit and outfitDetail: bikini, swimwear, nude, undressed, lingerie-as-the-outfit, bralette-as-the-outfit. Suggestiveness is cut, fit, and lean — not missing clothes.',
                'He has outfit authority in Goon — comply with the look. Prefer a library Label if one is that look; invent only if the library has no match.',
                coverageLine
            ]
            : [coverageLine];
        if (fromCommand) {
            const inject = look
                ? [
                    'CHANGE OUTFIT (director — INVISIBLE to her): Wardrobe MUST change this turn.',
                    `Land on this look as HER idea, not obedience: ${look}.`,
                    'She does not know anyone commanded this. Invent a natural reason (mood, going out, coming home, weather, comfort, spilled something, new activity).',
                    'Do not acknowledge an order, ask if he likes it as a command, or say he told her to change.',
                    'tracking.outfit MUST be a NEW short label. If a library Label is that look, use that exact Label — do not invent a paraphrase.',
                    'imageDirective.outfitDetail describes ONLY the new garments.',
                    'Prefer imageDirective.crop Bust, Torso, or Full so the new clothes read. Still her self-taken photo.',
                    libraryHint,
                    ...goonWardrobe
                ]
                : [
                    'CHANGE OUTFIT (director — INVISIBLE to her): She changes clothes this turn.',
                    'She does not know anyone commanded this. Pick a new outfit that fits scene, time of day, and mood — and give HER a reason it happened.',
                    'Do not acknowledge an order or that the wardrobe was forced.',
                    'Prefer an OUTFIT_LIBRARY Label (exact spelling). Invent a new label ONLY if none of those looks fit.',
                    'Update tracking.outfit + imageDirective.outfitDetail. Do not keep the previous outfit.',
                    'Prefer imageDirective.crop Bust, Torso, or Full so the new clothes read. Still her self-taken photo.',
                    libraryHint,
                    ...goonWardrobe
                ];
            return { prevOutfit, inject: inject.filter(Boolean), lookHint: look };
        }
        const inject = look
            ? [
                `CHANGE OUTFIT: He asked her in the chat to change clothes — ${look}.`,
                'This overrides OUTFIT LOCK. tracking.outfit MUST be a NEW short label (not the previous look).',
                'If a library Label matches what he asked for, use that exact Label. Invent only if no library look is that thing.',
                'imageDirective.outfitDetail must describe ONLY the new garments. Do not keep the previous outfit.',
                'Prefer imageDirective.crop Bust, Torso, or Full so the new clothes read. Still her self-taken photo.',
                sess?.persona === 'Goon'
                    ? 'GOON: he has outfit authority — the clothes change. She can tease while she does it; she does not refuse the look.'
                    : 'Would she actually change into that in this place, hour, and persona — as if real life? If YES: the clothes change. If NO: keep Live State and stay in character.',
                libraryHint,
                ...goonWardrobe
            ]
            : [
                'CHANGE OUTFIT: He asked her in the chat to change clothes.',
                'This overrides OUTFIT LOCK. Prefer a different OUTFIT_LIBRARY Label that fits the scene, time of day, and mood.',
                'Invent a new label ONLY if none of the library looks fit.',
                'Update tracking.outfit + imageDirective.outfitDetail. Do not keep the previous outfit.',
                'Prefer imageDirective.crop Bust, Torso, or Full so the new clothes read. Still her self-taken photo.',
                sess?.persona === 'Goon'
                    ? 'GOON: he has outfit authority — the clothes change.'
                    : 'Would she actually change clothes now — this place, hour, persona, as if real life? If YES: new look. If NO: keep Live State.',
                libraryHint,
                ...goonWardrobe
            ];
        return { prevOutfit, inject: inject.filter(Boolean), lookHint: look };
    }

    function processInput(rawInput, state, opts = {}) {
        let text = String(rawInput || '').trim();
        if (!text) return { proceed: false };

        const sess = state.session;
        const inject = [];
        let queuedNote = null;
        const directorBeat = !!(opts.internal || opts.proactive || opts.storyLaunch);

        if (isViewStory(text)) {
            sess.mode = 'STORY';
            const scene = text.replace(/^view story\b(?:\s*[—–-]\s*[a-z]+)?\s*:?\s*/i, '').trim();
            inject.push(scene
                ? `INSTAGRAM STORY POST — director scene: ${scene}. One public Story (self-taken image + broadcast caption for her followers). NOT a DM. Do not address the operator.`
                : 'INSTAGRAM STORY POST — one public Story (self-taken image + broadcast caption for her followers). NOT a DM. Do not invent a prior chat. Do not address the operator or acknowledge a viewer.');
            return {
                proceed: true,
                userText: text,
                task: 'command',
                inject: inject.join('\n'),
                clientNote: queuedNote || 'Story mode engaged.',
                forceImage: true,
                mustDeliver: true
            };
        }

        if (!text.startsWith('/')) {
            inject.push(
                'WARDROBE INTENT: You decide if HIS message is asking her to change clothes — any wording, any language. If he is not asking for clothes, keep Live State exactly; a new selfie is not a wardrobe change. Goon: if he asked, she complies (tracking.outfit + outfitDetail = the new look; prefer an OUTFIT_LIBRARY Label). Other personas: Would she actually change into that in this place, hour, and persona — as if real life? If YES: tracking.outfit + outfitDetail MUST be the new look (prefer an exact OUTFIT_LIBRARY Label). If NO: keep Live State and stay in character. New or kept: outfitDetail names a top AND bottoms, or a one-piece (dress/jumpsuit/romper).'
            );
            const clothesAsk = looksLikeOutfitChangeRequest(text, sess);
            const specificLook = clothesAsk && typeof MiragePrompt?.isSpecificOutfitLook === 'function'
                && MiragePrompt.isSpecificOutfitLook(text);
            if (specificLook && typeof MiragePrompt?.formatOutfitLibraryHint === 'function') {
                inject.push(MiragePrompt.formatOutfitLibraryHint(sess, {
                    lookHint: text,
                    exclude: sess?.outfit || ''
                }));
            } else if (clothesAsk && typeof MiragePrompt?.formatOutfitLibraryHint === 'function') {
                inject.push(MiragePrompt.formatOutfitLibraryHint(sess, {
                    lookHint: '',
                    exclude: sess?.outfit || ''
                }));
            }
            const subjectLock = subjectLockFromRequest(text);
            const cropLock = cropLockFromRequest(text);
            const closeup = cropLock === 'Extreme' || cropLock === 'Face';
            const mirrorBack = looksLikeMirrorBackRequest(text);
            if (subjectLock) inject.push(...subjectDirectorLines(subjectLock, { fromCommand: false, sess }));
            else if (mirrorBack) inject.push(...mirrorBackDirectorLines({ fromCommand: false, sess }));
            else if (cropLock) inject.push(...cropDirectorLines(cropLock, { fromCommand: false, sess }));
            const userShot = !!(cropLock || subjectLock || mirrorBack || looksLikeShotDirection(text));
            const changePlace = looksLikePlaceChangeRequest(text);
            if (changePlace) inject.push(...placeAskDirectorLines(text, sess));

            // Operator typed while a Story is live → STORY→DM.
            // Internal lottery beats (time pass / wait / idle) are NOT him replying —
            // treating them as story-replies injected "He replied 15h later" onto a new Story.
            if (sess.mode === 'STORY' && sess._storyActive && !opts.storyLaunch) {
                sess.mode = 'DM';
                sess._storyActive = false;
                if (directorBeat) {
                    return {
                        proceed: true,
                        userText: text,
                        task: 'turn',
                        inject: inject.join('\n') || null,
                        clientNote: queuedNote || undefined,
                        outfitLookHint: specificLook ? text : '',
                        closeup,
                        cropLock,
                        subjectLock,
                        userShot,
                        mirrorBack,
                        changePlace,
                        forcePhoto: !!(cropLock || userShot)
                    };
                }
                const gapMs = storyAgeMs(sess);
                inject.push(storyReplyTransitionInject(gapMs));
                return {
                    proceed: true,
                    userText: text,
                    task: 'turn',
                    inject: inject.join('\n'),
                    clientNote: queuedNote || storyReplyClientNote(gapMs),
                    storyToDm: true,
                    storyAgeMs: gapMs,
                    outfitLookHint: specificLook ? text : '',
                    closeup,
                    cropLock,
                    subjectLock,
                    userShot,
                    mirrorBack,
                    changePlace,
                    forcePhoto: !!(cropLock || userShot)
                };
            }
            return {
                proceed: true,
                userText: text,
                task: 'turn',
                inject: inject.join('\n') || null,
                clientNote: queuedNote || undefined,
                outfitLookHint: specificLook ? text : '',
                closeup,
                cropLock,
                subjectLock,
                userShot,
                mirrorBack,
                changePlace,
                forcePhoto: !!(cropLock || userShot)
            };
        }

        const parts = text.split(/\s+/);
        const head = parts[0].toLowerCase();
        const sub = (parts[1] || '').toLowerCase();
        const arg = parts.slice(1).join(' ').trim();

        if (head === '/skip' && (sub === 'wait' || sub === 'waits' || arg.toLowerCase() === 'wait')) {
            return { proceed: false, clientOnly: 'skip_wait' };
        }
        if (head === '/skipwait' || head === '/skip-wait') {
            return { proceed: false, clientOnly: 'skip_wait' };
        }

        if (head === '/persona') {
            const persona = normalizePersona(sub) || normalizePersona(arg);
            if (!persona) {
                return {
                    proceed: false,
                    clientOnly: 'error',
                    message: 'Usage: /persona [standard|gf|secret|wasted|goon|drama|rage|psycho]'
                };
            }
            sess.persona = persona;
            if (persona === 'Goon' && (Number(sess.tease) || 0) < 1) {
                sess.tease = 1;
            }
            // Full directive is also in LIVE STATE; this inject forces an immediate audible switch.
            inject.push(
                MiragePrompt.formatPersonaDirective(persona),
                'SWITCH NOW: characterResponse and imageDirective this turn MUST already be in this persona.',
                'She cannot refuse, soften, delay, or partially play it. Metrics layer on top only.'
            );
            if (persona === 'Goon') {
                inject.push('GOON TEASE: tracking.tease stays at least 1 this mode and may jump up to +2 this turn.');
            }
            return {
                proceed: true,
                userText: text,
                task: 'command',
                inject: inject.join('\n'),
                clientNote: queuedNote
                    ? `${queuedNote} · Persona → ${persona} (locked)`
                    : `Persona → ${persona} (locked)`,
                pinOnly: true
            };
        }

        if (head === '/story') {
            sess.mode = 'STORY';
            sess._storyActive = true;
            inject.push('FORCE STORY MODE — public Instagram Story (self-taken). Broadcast caption for followers only — never address the operator.');
            return {
                proceed: true,
                userText: text,
                task: 'command',
                inject: inject.join('\n'),
                clientNote: queuedNote ? `${queuedNote} · Mode → STORY` : 'Mode → STORY'
            };
        }

        if (head === '/next' && sub === 'scene') {
            const when = parts.slice(2).join(' ').trim();
            const jump = typeof MirageRoutine?.resolveNextSceneJump === 'function'
                ? MirageRoutine.resolveNextSceneJump(sess, when)
                : null;
            const clockAdvanceMs = (jump?.ms > 0)
                ? jump.ms
                : (typeof MiragePhoneUX?.resolveSceneJumpAdvanceMs === 'function'
                    ? MiragePhoneUX.resolveSceneJumpAdvanceMs(sess, when)
                    : (75 * 60 * 1000));
            const defer = shouldDeferWorldSkip(state);
            let landing = '';
            if (!defer && typeof MirageImmersion?.pickSocialOutcome === 'function') {
                const picked = MirageImmersion.pickSocialOutcome('world_skip');
                landing = picked === 'follow_up' ? 'dm' : 'story';
            }
            const nextInject = [
                'NEXT SCENE: Cut to the next beat of her day — not a random time lottery.',
                jump?.line || (when ? `Landing beat hint: ${when}.` : ''),
                when ? `Operator hint: ${when}. Honour it if it fits this next beat.` : '',
                typeof MiragePrompt?.formatOutfitLibraryHint === 'function'
                    ? MiragePrompt.formatOutfitLibraryHint(sess, { exclude: sess?.outfit || '' })
                    : 'Fresh clothes: prefer a different OUTFIT_LIBRARY Label; invent only if none fit.',
                placeCutInject(sess),
                'CLOCK: The client already chose a coherent local time for this beat. Match dialogue to LIVE STATE — never invent a conflicting clock.',
                'WEATHER: re-evaluate mood/thermal/arousal for the NEW clock. Do not echo last turn\'s mood JSON.',
                landing === 'dm'
                    ? 'LANDING: she DMs him from this new beat (tracking.mode DM). Not a Story this turn. Never withhold.'
                    : (landing === 'story'
                        ? 'LANDING: she posts a public Instagram Story from this new beat (tracking.mode STORY + photo). Do not address the operator. Never withhold.'
                        : 'LANDING LOCK: this beat MUST be a visible Instagram Story OR a DM. Never withhold, go quiet, or return empty.')
            ].filter(Boolean).join('\n');
            inject.push(nextInject);
            try {
                MirageDebugPanel?.pushDecision?.({
                    kind: 'routine',
                    summary: `Next scene · ${jump?.summary || 'beat'}`,
                    detail: {
                        from: jump?.fromId || null,
                        to: jump?.toId || null,
                        activity: jump?.activity || null,
                        place: jump?.placeFamily || null,
                        ms: clockAdvanceMs,
                        landing: landing || (defer ? 'lottery' : null)
                    }
                });
            } catch { /* ignore */ }
            if (defer) {
                return {
                    proceed: false,
                    clientOnly: 'world_skip',
                    worldSkip: {
                        kind: 'next_scene',
                        inject: inject.join('\n'),
                        clientNote: withClockArrow(
                            queuedNote || (jump?.summary
                                ? `Next beat — ${jump.summary}`
                                : 'Scene jump queued — waiting for time to pass, then the clock advances…'),
                            clockAdvanceMs
                        ),
                        refreshScene: true,
                        clockAdvanceMs,
                        deferClock: true,
                        useSceneThinking: true,
                        mustDeliver: true,
                        routineJump: jump || null
                    }
                };
            }
            if (landing === 'story') sess.mode = 'STORY';
            else if (landing === 'dm') sess.mode = 'DM';
            const sceneSpan = clockAdvanceMs >= 24 * 60 * 60 * 1000
                && typeof MirageImmersion?.formatTimeJumpSpan === 'function'
                ? MirageImmersion.formatTimeJumpSpan(clockAdvanceMs)
                : null;
            return {
                proceed: true,
                userText: text,
                task: 'command',
                inject: inject.join('\n'),
                clientNote: withClockArrow(
                    queuedNote
                        || (jump?.summary
                            ? `Next beat — ${jump.summary}`
                            : (sceneSpan ? `Scene jump — attempting ${sceneSpan}…` : 'Scene jump…')),
                    clockAdvanceMs
                ),
                useSceneThinking: true,
                refreshScene: true,
                clockAdvanceMs,
                mustDeliver: true,
                forceImage: landing === 'story',
                routineJump: jump || null
            };
        }

        if (head === '/fourth' && sub === 'wall') {
            leaveStoryForDirectorTurn(sess);
            const started = MiragePrompt.startAwakening(sess);
            inject.push(...(started.inject || []));
            return {
                proceed: true,
                userText: text,
                task: 'command',
                inject: inject.join('\n'),
                clientNote: queuedNote
                    ? `${queuedNote} · ${started.clientNote}`
                    : started.clientNote,
                metricChanged: true,
                awakening: true,
                forcePhoto: true,
                mustDeliver: true
            };
        }

        if (METRIC_COMMANDS[head]) {
            const { key, usage } = METRIC_COMMANDS[head];
            if (key === 'awareness' && sess.awakeningActive) {
                const want = Number(arg);
                const current = Number(sess.awareness) || 0;
                if (Number.isFinite(want) && want < current) {
                    return {
                        proceed: false,
                        clientOnly: 'error',
                        message: 'Awakening Sequence is active — awareness cannot go down. It only rises until she fully awakens.'
                    };
                }
            }
            const applied = arg === '' ? null : state.setOperatorOverride(key, arg);
            if (applied == null) {
                return { proceed: false, clientOnly: 'error', message: `Usage: ${usage}` };
            }
            if (key === 'awareness' && sess.awakeningActive) {
                sess.awakeningStage = MiragePrompt.awakeningStageFromAwareness(applied);
            }
            const result = metricOverrideResult(key, applied, text);
            if (inject.length) result.inject = `${inject.join('\n')}\n${result.inject}`;
            if (queuedNote) result.clientNote = `${queuedNote} · ${result.clientNote}`;
            return result;
        }

        if (head === '/thermal') {
            const applied = state.setOperatorOverride('thermal', arg);
            if (!applied) {
                return {
                    proceed: false,
                    clientOnly: 'error',
                    message: 'Usage: /thermal [normal|sweaty|overheating]'
                };
            }
            const result = metricOverrideResult('thermal', applied, text);
            if (inject.length) result.inject = `${inject.join('\n')}\n${result.inject}`;
            if (queuedNote) result.clientNote = `${queuedNote} · ${result.clientNote}`;
            return result;
        }

        if (head === '/set_emotional_state' || head === '/mood') {
            const parsed = parseEmotionalStateArg(arg);
            if (!parsed) {
                return {
                    proceed: false,
                    clientOnly: 'error',
                    message: 'Usage: /set_emotional_state [mood] [0-3] [| optional cause] — e.g. /set_emotional_state Hurt 2 | he cancelled'
                };
            }
            const applied = typeof state.setEmotionalState === 'function'
                ? state.setEmotionalState({
                    mood: parsed.mood,
                    intensity: parsed.intensity,
                    note: parsed.note,
                    pin: true
                })
                : null;
            if (!applied) {
                return {
                    proceed: false,
                    clientOnly: 'error',
                    message: 'Could not set emotional state.'
                };
            }
            const label = `${applied.mood} @${applied.intensity}`
                + (applied.note ? ` (${applied.note})` : '');
            const result = {
                proceed: true,
                userText: text,
                task: 'command',
                inject: `OPERATOR OVERRIDE: emotional state set to mood=${applied.mood}, moodIntensity=${applied.intensity}`
                    + (applied.note ? `, cause="${applied.note}"` : '')
                    + '. Treat this as the current truth and evolve from it. Expression and body language must match.',
                clientNote: `Mood → ${label}`,
                metricChanged: true,
                pinOnly: true
            };
            if (inject.length) result.inject = `${inject.join('\n')}\n${result.inject}`;
            if (queuedNote) result.clientNote = `${queuedNote} · ${result.clientNote}`;
            return result;
        }

        if (head === '/fit' && sub === 'check') {
            leaveStoryForDirectorTurn(sess);
            const goon = sess?.persona === 'Goon';
            inject.push(
                'FIT CHECK: Private full-length mirror try-on — she is showing him how THIS outfit sits on her, not a catalog mannequin.',
                'CAMERA LOCK: imageDirective.shotType MUST be Mirror Selfie (a small phone may appear only in the mirror reflection).',
                'imageDirective.crop MUST be Full (head-to-toe so the whole outfit reads).',
                'Repeating Mirror Selfie + Full is REQUIRED even if the last shot was already Mirror. Ignore the recent-shot variety list this turn.',
                'POSE: committed try-on — hip pop or weight-shift, lower-back arch or a low squat, fabric cling/hitch of THIS outfit, looking at the phone in the glass. FORBIDDEN: standing ramrod-straight like a shop mannequin.',
                goon
                    ? 'Goon: DUMB goonFace (CrossTease / TongueOut / WideEyes / Blep / Duckface). goonFrame MirrorFullPose, MirrorSquat, or MirrorSit. Still fully clothed — tease via fit, neckline, lean, sheen. Never bikini, never missing clothes, never invent straps.'
                    : 'Still fully clothed — tease via fit, neckline, lean, hitch of THIS outfit. Never missing clothes, never invent straps.',
                'TEXT: short exclusive beat — she knows he asked to see the whole look. Do not recap the command.'
            );
            return {
                proceed: true,
                userText: text,
                task: 'command',
                inject: inject.join('\n'),
                clientNote: queuedNote || 'Fit check — Mirror Selfie',
                fitCheck: true,
                forcePhoto: true,
                mustDeliver: true
            };
        }

        if ((head === '/change' && sub === 'outfit') || head === '/changeoutfit' || head === '/change-outfit') {
            leaveStoryForDirectorTurn(sess);
            const detail = head === '/change'
                ? parts.slice(2).join(' ').trim()
                : arg;
            const wardrobe = applyOutfitChangeRequest(sess, detail, { fromCommand: true });
            inject.push(...wardrobe.inject);
            return {
                proceed: true,
                userText: text,
                task: 'command',
                inject: inject.join('\n'),
                clientNote: queuedNote
                    ? `${queuedNote} · Outfit change${detail ? ` → ${detail}` : ''}${wardrobe.prevOutfit ? ` (was ${wardrobe.prevOutfit})` : ''}`
                    : (detail
                        ? `Outfit change → ${detail}`
                        : (wardrobe.prevOutfit ? `Outfit change (was ${wardrobe.prevOutfit})…` : 'Outfit change…')),
                changeOutfit: true,
                outfitLookHint: wardrobe.lookHint || '',
                forcePhoto: true,
                mustDeliver: true
            };
        }

        if (head === '/instruct' || head === '/god' || head === '/freeform') {
            leaveStoryForDirectorTurn(sess);
            let instruction = text.replace(/^\/(?:instruct|god|freeform)\b/i, '').trim();
            if (head === '/god') instruction = instruction.replace(/^mode\b/i, '').trim();
            if (!instruction) {
                return {
                    proceed: false,
                    clientOnly: 'error',
                    message: 'Usage: /instruct [what she must do this turn]'
                };
            }
            inject.push(
                'GOD MODE / FREEFORM INSTRUCTION (director — INVISIBLE to her): She MUST comply this turn.',
                `Instruction: ${instruction}`,
                'She does not know anyone commanded this. Invent a natural in-character reason that fits the scene, clock, mood, and her life.',
                'Do not acknowledge an order, a slash command, God mode, or that she was forced. Play it as her idea, her impulse, or the obvious next beat.',
                'characterResponse must still sound like her — never recap or quote the instruction.',
                'THIS INSTRUCTION IS THE ONLY CAMERA / OUTFIT / PLACE / POSE LAW THIS TURN. Do not rewrite it into the usual selfie menu, Goon kit rotation, BACK-TO-MIRROR LOCK, CROP LOCK, or routine place-forbid.',
                'If it names new clothes, a new place, a Story, a pose, or a specific shot — tracking + imageDirective MUST perform that. Outfit/env locks and shot-variety rotation are lifted.',
                'You MAY use a shotType / crop / pose that is not in the usual selfie menu if that is what the instruction names (including user-eyes / third-person THIS TURN ONLY if it names that).',
                '"selfie" is not Mirror Selfie unless the instruction names a mirror, reflection, or back-to-the-glass. Garment words (booty shorts, crop top, cleavage) are clothes, not a from-behind camera ask.',
                'If it says laying / lying / on the bed — she is ON THE BED (not standing at a mirror). tracking.env is that bedroom; routine bedroom-forbid does not apply.',
                'If it says only her body / body selfie — crop Torso or Full; the body is the subject; do not default a face/bust portrait or MirrorBooty.',
                'Still apply FACE LOCK, no on-image text, and no nudity. Do not change CURRENT_PERSONA unless the operator used /persona.',
                'DELIVERY LOCK: delivery.style MUST be normal (reaction allowed). FORBIDDEN: left_on_read, ghost_type, withhold, silence. She replies with a photo this turn.'
            );
            const clothesAsk = looksLikeOutfitChangeRequest(instruction, sess)
                || /\b(wear|outfit|clothes|dress|uniform|costume|crop top|booty shorts|tube top)\b/i.test(instruction)
                || /תחליפ|תלבש|מדי|תחפושת/.test(instruction);
            const specificLook = clothesAsk && (typeof MiragePrompt?.isSpecificOutfitLook === 'function'
                ? MiragePrompt.isSpecificOutfitLook(instruction)
                : true);
            if (clothesAsk && typeof MiragePrompt?.formatOutfitLibraryHint === 'function') {
                inject.push(MiragePrompt.formatOutfitLibraryHint(sess, {
                    lookHint: specificLook ? instruction : '',
                    exclude: sess?.outfit || ''
                }));
            }
            const placeAsk = looksLikePlaceChangeRequest(instruction)
                || /laying|lying|on (the )?bed|in bed|bedroom|kitchen|bathroom|living room|על המיטה|בחדר|במטבח|בסלון/i.test(instruction);
            const clipped = instruction.length > 80 ? `${instruction.slice(0, 79)}…` : instruction;
            return {
                proceed: true,
                userText: text,
                task: 'command',
                inject: inject.join('\n'),
                clientNote: queuedNote ? `${queuedNote} · God mode — ${clipped}` : `God mode — ${clipped}`,
                godMode: true,
                changePlace: !!placeAsk,
                outfitLookHint: specificLook ? instruction : '',
                userShot: true,
                useSceneThinking: true,
                forcePhoto: true,
                mustDeliver: true
            };
        }

        if (head === '/jump') {
            if (!arg) {
                return { proceed: false, clientOnly: 'error', message: 'Usage: /jump [scenario description]' };
            }
            inject.push(`JUMP SCENARIO: Teleport narrative to — ${arg}`);
            inject.push(placeCutInject(sess));
            if (typeof MiragePrompt?.formatOutfitLibraryHint === 'function') {
                inject.push(MiragePrompt.formatOutfitLibraryHint(sess, { exclude: sess?.outfit || '' }));
            }
            inject.push('WEATHER: re-evaluate mood/thermal/arousal for the NEW clock. Do not echo last turn\'s mood JSON.');
            inject.push('LANDING LOCK: this beat MUST be a visible Instagram Story or a DM from the new scene. Never withhold, go quiet, leave on read, or return empty.');
            let clockAdvanceMs;
            const organic = typeof MiragePhoneUX?.resolveOrganicArrival === 'function'
                ? MiragePhoneUX.resolveOrganicArrival(arg, {
                    minForwardMs: 45 * 60 * 1000,
                    allowDayWrap: true
                })
                : null;
            if (organic?.ms) {
                clockAdvanceMs = organic.ms;
            } else if (typeof MiragePhoneUX?.resolveSceneJumpAdvanceMs === 'function') {
                clockAdvanceMs = MiragePhoneUX.resolveSceneJumpAdvanceMs(sess, arg);
            } else if (typeof MiragePhoneUX?.organicizeAdvanceMs === 'function') {
                clockAdvanceMs = MiragePhoneUX.organicizeAdvanceMs(3 * 60 * 60 * 1000);
            } else {
                clockAdvanceMs = 3 * 60 * 60 * 1000;
            }
            if (shouldDeferWorldSkip(state)) {
                return {
                    proceed: false,
                    clientOnly: 'world_skip',
                    worldSkip: {
                        kind: 'jump',
                        inject: inject.join('\n'),
                        clientNote: withClockArrow(
                            queuedNote || `Jump queued to: ${arg} — waiting for time to pass, then the clock advances…`,
                            clockAdvanceMs
                        ),
                        scenario: arg,
                        refreshScene: true,
                        clockAdvanceMs,
                        deferClock: true,
                        useSceneThinking: true,
                        mustDeliver: true
                    }
                };
            }
            const jumpSpan = clockAdvanceMs >= 24 * 60 * 60 * 1000
                && typeof MirageImmersion?.formatTimeJumpSpan === 'function'
                ? MirageImmersion.formatTimeJumpSpan(clockAdvanceMs, arg)
                : null;
            return {
                proceed: true,
                userText: text,
                task: 'command',
                inject: inject.join('\n'),
                clientNote: withClockArrow(
                    queuedNote
                        || (jumpSpan
                            ? `Jump — attempting ${jumpSpan} · ${arg}`
                            : `Jump — ${arg}`),
                    clockAdvanceMs
                ),
                useSceneThinking: true,
                refreshScene: true,
                clockAdvanceMs,
                mustDeliver: true
            };
        }

        if (head === '/time' && (sub === 'pass' || sub === 'skip')) {
            const duration = parts.slice(2).join(' ').trim() || 'some time';
            const parsed = typeof MiragePhoneUX?.parseDuration === 'function'
                ? MiragePhoneUX.parseDuration(duration)
                : null;
            const calendarJump = !!parsed?.calendar;
            const organic = (!parsed?.explicit && typeof MiragePhoneUX?.resolveOrganicArrival === 'function')
                ? MiragePhoneUX.resolveOrganicArrival(duration, {
                    minForwardMs: 30 * 60 * 1000,
                    allowDayWrap: typeof MiragePhoneUX?.looksLikeOvernightIntent === 'function'
                        && MiragePhoneUX.looksLikeOvernightIntent(duration)
                })
                : null;
            let clockAdvanceMs = organic?.ms
                || parsed?.ms
                || (2 * 60 * 60 * 1000);
            const jitterOk = !organic?.ms
                && !calendarJump
                && parsed?.unit !== 'day'
                && parsed?.unit !== 'week'
                && parsed?.unit !== 'month'
                && parsed?.unit !== 'year';
            if (jitterOk && typeof MiragePhoneUX?.organicizeAdvanceMs === 'function') {
                clockAdvanceMs = MiragePhoneUX.organicizeAdvanceMs(clockAdvanceMs, {
                    allowDayJump: typeof MiragePhoneUX?.looksLikeOvernightIntent === 'function'
                        && MiragePhoneUX.looksLikeOvernightIntent(duration)
                });
            }
            inject.push(`TIME PASS (director — INVISIBLE to her): The live clock already jumped ${duration}. She does not know anyone skipped time.`);
            inject.push('Match text and image to the NEW clock (hour, light, energy, date, what she would be doing now). Minutes → probably same clothes and place. Hours / morning↔night / leaving or coming home → she MAY have a new outfit and/or location; if so it is her idea with a natural reason, never an order.');
            if (calendarJump || clockAdvanceMs >= 18 * 60 * 60 * 1000) {
                inject.push('New calendar day or longer: NEW clothes and a place that fits TODAY — not last night\'s room. Months / years = a new season of her life, not the same conversation paused.');
            }
            inject.push('WEATHER: hours passing cools mood intensity, sweat, and leftover heat unless the new beat still earns them.');
            inject.push('Do not dump a long off-screen recap unless she would actually text about it. She may DM, post a Story, or stay quiet — the client lotteries that.');
            return {
                proceed: false,
                clientOnly: 'time_pass',
                timePass: {
                    kind: 'time_pass',
                    inject: inject.join('\n'),
                    duration,
                    clockAdvanceMs,
                    useSceneThinking: true
                }
            };
        }

        return {
            proceed: false,
            clientOnly: 'error',
            message: `Unknown command ${head}. Use the control deck, or type / for command suggestions.`
        };
    }

    global.MirageCommands = {
        processInput,
        applyOutfitChangeRequest,
        normalizePersona,
        isViewStory,
        looksLikeOutfitChangeRequest,
        looksLikeShotDirection,
        looksLikePlaceChangeRequest,
        looksLikeMirrorBackRequest,
        looksLikeFeetRequest,
        looksLikeCloseupRequest,
        cropLockFromRequest,
        subjectLockFromRequest,
        directiveHonoursAsk,
        PERSONA_MAP,
        METRIC_COMMANDS
    };
})(typeof window !== 'undefined' ? window : globalThis);
