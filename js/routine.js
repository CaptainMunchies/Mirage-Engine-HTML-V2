/**
 * MIRAGE ENGINE — Daily routine (her day)
 *
 * Client-resolved hour/lifestyle skeleton. Model still invents the env label.
 * Settings routineMode: jumps | stories | living
 */
(function (global) {
    'use strict';

    const S = () => global.EngineState;
    const MODES = ['jumps', 'stories', 'living'];
    const DEFAULT_MODE = 'stories';
    const SKIP_MOVE_MS = 45 * 60 * 1000;

    function normalizeMode(value) {
        const k = String(value || '').trim().toLowerCase();
        if (MODES.includes(k)) return k;
        if (k === 'jumps_only' || k === 'clock' || k === 'jump') return 'jumps';
        if (k === 'jumps_stories' || k === 'jumps+stories' || k === 'story') return 'stories';
        if (k === 'living_world' || k === 'always' || k === 'live') return 'living';
        return DEFAULT_MODE;
    }

    function currentMode() {
        return normalizeMode(S()?.routineMode);
    }

    function dossierBlob(profile) {
        const p = profile || S()?.profile || {};
        return [
            p.archetype, p.notes, p.personality, p.location,
            p.autoFill?.notes, p.autoFill?.archetype
        ].filter(Boolean).join(' ').toLowerCase();
    }

    function inferLifestyle(profile) {
        const blob = dossierBlob(profile);
        if (/nurse|hospital|paramedic|emt|\bshift\b|night.?shift/.test(blob)) return 'shift';
        if (/student|college|university|campus|dorm|high.?school/.test(blob)) return 'student';
        if (/office|lawyer|accountant|manager|corporate|9\s*[-–to]+\s*5|desk job/.test(blob)) return 'office';
        if (/waitress|waiter|barista|retail|server|hostess|\bshop\b|cashier/.test(blob)) return 'service';
        if (/influencer|content.?creat|onlyfans|model|homebody|stay.?home/.test(blob)) return 'creator';
        return 'unspecified';
    }

    function inferObservantJewish(profile) {
        return /jew(?:ish)?|judaism|shabbat|shabbos|יהוד|שומרת[\s-]?שבת|דתי/.test(dossierBlob(profile));
    }

    /**
     * These fallbacks compute *her* clock from the operator's browser timezone, which
     * is wrong in a way nothing on screen reveals — the same silent-corruption shape as
     * B00. They should be unreachable; if one ever fires, make sure it leaves a trace.
     */
    let wrongClockWarned = false;
    function warnWrongClockOnce(where) {
        if (wrongClockWarned) return;
        wrongClockWarned = true;
        console.warn(
            `[Mirage] ${where} fell back to the browser timezone — her clock, weekday and `
            + 'routine may be hours off. A script probably failed to load; reload the page.'
        );
        try {
            MirageSimulation?.appendDebugDecision?.({
                kind: 'notice',
                summary: `Clock fallback: ${where} is using the browser timezone, not hers`
            });
        } catch { /* debug panel is optional */ }
    }

    function clockParts(profile) {
        if (typeof MirageCalendar?.getSimDateParts === 'function') {
            return MirageCalendar.getSimDateParts(profile || S()?.profile);
        }
        // Reachable only if calendar.js failed to load. getHours/getDay here are the
        // *operator's* clock, so her whole daily rhythm would silently run on the wrong
        // timezone — the same failure mode as B00. Make it visible.
        warnWrongClockOnce('routine clock');
        const now = typeof MiragePhoneUX?.herNow === 'function'
            ? MiragePhoneUX.herNow()
            : new Date();
        return {
            hour: now.getHours(),
            minute: now.getMinutes(),
            weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
            weekdayIndex: now.getDay(),
            dateLabel: now.toDateString()
        };
    }

    function isOffDay(parts, profile) {
        const ix = Number(parts?.weekdayIndex);
        if (ix === 0 || ix === 6) return true;
        if (inferObservantJewish(profile) && (ix === 6 || (ix === 5 && (parts.hour || 0) >= 16))) {
            return true;
        }
        return false;
    }

    /**
     * Hour → life band. Lifestyle + weekend/holiday bias the daytime slot.
     */
    function resolveBand(hour, { lifestyle, offDay } = {}) {
        const h = Number(hour);
        const hr = Number.isFinite(h) ? ((h % 24) + 24) % 24 : 14;
        const workish = lifestyle === 'office' || lifestyle === 'student'
            || lifestyle === 'shift' || lifestyle === 'service';

        if (hr >= 0 && hr < 5) return 'night_private';
        if (hr >= 5 && hr < 8) return 'home_morning';
        if (hr >= 8 && hr < 10) {
            if (offDay) return 'weekend_errand';
            return workish ? 'commute' : 'home_morning';
        }
        if (hr >= 10 && hr < 16) {
            if (offDay) return 'weekend_errand';
            if (workish) return 'work_or_school';
            return 'midday_out';
        }
        if (hr >= 16 && hr < 18) {
            if (offDay) return 'weekend_errand';
            return workish ? 'commute' : 'home_evening';
        }
        if (hr >= 18 && hr < 21) {
            if (offDay && hr >= 19) return 'out_night';
            return 'home_evening';
        }
        return 'night_private';
    }

    function placeFamilyOf(label) {
        if (typeof MiragePrompt?.placeFamily === 'function') {
            return MiragePrompt.placeFamily(label);
        }
        return 'other';
    }

    /** Preferred place type + extras that are also legal this band. */
    function placesForBand(band) {
        const map = {
            home_morning: { prefer: 'kitchen', also: ['bathroom', 'living'] },
            commute: { prefer: 'car', also: ['cafe', 'outdoors'] },
            work_or_school: { prefer: 'work', also: ['cafe', 'car'] },
            midday_out: { prefer: 'cafe', also: ['shop', 'outdoors', 'living'] },
            home_evening: { prefer: 'living', also: ['kitchen', 'bathroom'] },
            out_night: { prefer: 'cafe', also: ['car', 'outdoors'] },
            night_private: { prefer: 'bedroom', also: ['living', 'bathroom'] },
            weekend_errand: { prefer: 'cafe', also: ['shop', 'outdoors', 'living'] }
        };
        return map[band] || map.home_evening;
    }

    function outfitHintForBand(band) {
        if (band === 'commute' || band === 'work_or_school' || band === 'midday_out'
            || band === 'weekend_errand') {
            return 'day';
        }
        if (band === 'out_night') return 'out';
        if (band === 'home_morning') return 'day';
        return 'same';
    }

    function atlasHint(edf, preferFamily) {
        const bank = edf?.ENV_ATLAS_TOP_5 || edf?.VISUAL_ANCHORS?.ENV_ATLAS;
        if (!bank) return '';
        const labels = Array.isArray(bank)
            ? bank.map(it => (it && typeof it === 'object' ? (it.Label || it.label || it.Name || '') : String(it || '')))
            : Object.keys(bank);
        const hit = labels.map(String).map(s => s.trim()).filter(Boolean)
            .find(lab => placeFamilyOf(lab) === preferFamily);
        return hit || '';
    }

    function clockLabel(parts) {
        const h = Number(parts.hour);
        const m = Number(parts.minute) || 0;
        if (!Number.isFinite(h)) return '';
        const hr12 = ((h + 11) % 12) + 1;
        const ampm = h >= 12 ? 'PM' : 'AM';
        const mm = String(m).padStart(2, '0');
        const day = parts.weekday || '';
        return `${hr12}:${mm} ${ampm}${day ? ` ${day}` : ''}`;
    }

    function buildLine(beat, { envSet, mustMove } = {}) {
        const also = (beat.also || []).filter(f => f !== beat.placeFamily).slice(0, 3);
        const alsoBit = also.length ? ` (${also.join('/')} ok)` : '';
        const forbid = (beat.forbidFamilies || []).join(', ') || 'a renamed last room';
        const clock = beat.clockLabel || '';
        const atlas = beat.atlasHint ? ` Atlas hint: "${beat.atlasHint}" is optional.` : '';
        if (!envSet) {
            return `ROUTINE: ${clock} · ${beat.band} · establish place type ${beat.placeFamily}${alsoBit}. `
                + `FORBIDDEN: ${forbid}. Invent a short new env label for this hour.${atlas}`;
        }
        if (mustMove) {
            return `ROUTINE: ${clock} · ${beat.band} · place type ${beat.placeFamily}${alsoBit} · `
                + `FORBIDDEN: ${forbid}. She is living this hour — not posing in the last room. `
                + `tracking.env MUST be a NEW short label in that place type (not a rename).${atlas}`;
        }
        return '';
    }

    function shouldMoveThisTurn({
        mode,
        storyLaunch,
        skipMs,
        band,
        prevBand,
        envSet,
        hardCut
    } = {}) {
        if (hardCut) return !!envSet;
        if (!envSet) return false;
        const skip = Math.max(0, Number(skipMs) || 0);
        if (skip >= SKIP_MOVE_MS) return true;
        const m = normalizeMode(mode);
        if (prevBand && band && prevBand !== band) {
            if (m === 'living') return true;
            if (skip > 0) return true;
        }
        if ((m === 'stories' || m === 'living') && storyLaunch) return true;
        if (m === 'living' && prevBand && band && prevBand !== band) return true;
        return false;
    }

    /**
     * Resolve the beat for this clock. Does not stamp session.
     */
    function resolveBeat({
        profile = null,
        edf = null,
        session = null,
        storyLaunch = false,
        skipMs = 0,
        hardCut = false
    } = {}) {
        const prof = profile || S()?.profile;
        const sess = session || S()?.session;
        const parts = clockParts(prof);
        const lifestyle = inferLifestyle(prof);
        const offDay = isOffDay(parts, prof);
        const band = resolveBand(parts.hour, { lifestyle, offDay });
        const places = placesForBand(band);
        const prevEnv = sess?.env;
        const envSet = typeof S()?.isSceneFieldSet === 'function'
            ? S().isSceneFieldSet(prevEnv)
            : !!(prevEnv && String(prevEnv).trim());
        const prevFamily = envSet ? placeFamilyOf(prevEnv) : '';
        const prevBand = String(sess?._routineBand || '').trim();
        const mode = currentMode();
        const mustMove = shouldMoveThisTurn({
            mode,
            storyLaunch: !!storyLaunch,
            skipMs,
            band,
            prevBand,
            envSet,
            hardCut: !!hardCut
        });

        let prefer = places.prefer;
        let also = places.also.slice();
        if (mustMove && prevFamily && prefer === prevFamily) {
            prefer = also.find(f => f !== prevFamily) || prefer;
            also = also.filter(f => f !== prevFamily);
        }

        const forbid = [];
        if (mustMove && prevFamily) forbid.push(prevFamily);
        if (band !== 'night_private' && prefer !== 'bedroom' && !also.includes('bedroom')) {
            if (!forbid.includes('bedroom')) forbid.push('bedroom');
        }

        const outfitHint = mustMove ? outfitHintForBand(band) : 'same';
        const beat = {
            mode,
            band,
            lifestyle,
            hour: parts.hour,
            weekday: parts.weekday || '',
            clockLabel: clockLabel(parts),
            placeFamily: prefer,
            also,
            forbidFamilies: forbid,
            outfitHint,
            mustMove,
            mayMove: mustMove || !envSet,
            envSet,
            atlasHint: atlasHint(edf || S()?.edf, prefer),
            prevFamily: prevFamily || '',
            prevBand: prevBand || ''
        };
        beat.line = buildLine(beat, { envSet, mustMove });
        return beat;
    }

    function resolveForTurn(opts = {}) {
        const sess = opts.session || S()?.session;
        const skipMs = Math.max(
            Number(opts.skipMs) || 0,
            Number(sess?.lastTimeSkipMs) || 0,
            Number(sess?.pendingWorldBeat?.skipMs) || 0,
            Number(sess?.pendingWorldBeat?.clockAdvanceMs) || 0
        );
        return resolveBeat({
            profile: opts.profile,
            edf: opts.edf,
            session: sess,
            storyLaunch: !!opts.storyLaunch,
            skipMs,
            hardCut: !!opts.hardCut
        });
    }

    function stamp(session, beat) {
        const sess = session || S()?.session;
        if (!sess || !beat?.band) return;
        sess._routineBand = beat.band;
        sess._routineAt = typeof MirageImmersion?.simNowMs === 'function'
            ? MirageImmersion.simNowMs()
            : Date.now();
    }

    /** Clock jumped but no turn (ditch) — still remember where her day is. */
    function stampFromClock(session) {
        const beat = resolveBeat({ session: session || S()?.session, skipMs: 0 });
        stamp(session, beat);
        return beat;
    }

    function forbidsBedroom(beat) {
        const list = beat?.forbidFamilies;
        return Array.isArray(list) && list.includes('bedroom');
    }

    function hourToMin(h) {
        const n = Number(h);
        if (!Number.isFinite(n)) return 0;
        return Math.round((((n % 24) + 24) % 24) * 60);
    }

    /**
     * Lifestyle beat ladder — place-types + hour windows, not a scripted day.
     * The model still invents the actual room/activity from her life.
     */
    function beatLadder(lifestyle, offDay) {
        const ls = String(lifestyle || 'unspecified');
        if (offDay) {
            return [
                { id: 'sleep', start: 0, end: 8, place: 'bedroom', also: ['living'], activity: 'asleep / slow morning in bed', outfit: 'same', band: 'night_private' },
                { id: 'wake_ready', start: 8, end: 11, place: 'kitchen', also: ['bathroom', 'living'], activity: 'getting ready / breakfast', outfit: 'day', band: 'home_morning' },
                { id: 'day_out', start: 11, end: 17, place: 'cafe', also: ['shop', 'outdoors', 'living'], activity: 'out in her day (errand, hang, content)', outfit: 'day', band: 'weekend_errand' },
                { id: 'evening', start: 17, end: 21, place: 'living', also: ['kitchen', 'cafe'], activity: 'evening at home or a low-key out', outfit: 'same', band: 'home_evening' },
                { id: 'night_out', start: 19, end: 23, place: 'cafe', also: ['outdoors', 'car'], activity: 'out after dark', outfit: 'out', band: 'out_night' },
                { id: 'bed', start: 22, end: 24, place: 'bedroom', also: ['living', 'bathroom'], activity: 'winding down / in bed', outfit: 'same', band: 'night_private' }
            ];
        }
        if (ls === 'creator') {
            return [
                { id: 'sleep', start: 0, end: 8, place: 'bedroom', also: ['living'], activity: 'asleep', outfit: 'same', band: 'night_private' },
                { id: 'wake_ready', start: 7, end: 10, place: 'bathroom', also: ['kitchen', 'living'], activity: 'getting ready at home', outfit: 'day', band: 'home_morning' },
                { id: 'home_day', start: 10, end: 14, place: 'living', also: ['kitchen', 'bathroom'], activity: 'home-day / content / chores', outfit: 'day', band: 'home_morning' },
                { id: 'mid_out', start: 12, end: 17, place: 'cafe', also: ['shop', 'outdoors'], activity: 'out for a bit', outfit: 'day', band: 'midday_out' },
                { id: 'evening', start: 17, end: 21, place: 'living', also: ['kitchen'], activity: 'evening unwind', outfit: 'same', band: 'home_evening' },
                { id: 'bed', start: 21, end: 24, place: 'bedroom', also: ['living', 'bathroom'], activity: 'in bed / winding down', outfit: 'same', band: 'night_private' }
            ];
        }
        if (ls === 'shift' || ls === 'service') {
            return [
                { id: 'sleep', start: 0, end: 9, place: 'bedroom', also: ['living'], activity: 'asleep / off-shift rest', outfit: 'same', band: 'night_private' },
                { id: 'wake_ready', start: 8, end: 11, place: 'bathroom', also: ['kitchen'], activity: 'getting ready for the shift', outfit: 'day', band: 'home_morning' },
                { id: 'transit_out', start: 10, end: 13, place: 'car', also: ['outdoors', 'cafe'], activity: 'heading in', outfit: 'day', band: 'commute' },
                { id: 'on_site', start: 11, end: 16, place: 'work', also: ['cafe'], activity: 'on shift', outfit: 'day', band: 'work_or_school' },
                { id: 'break', start: 14, end: 18, place: 'cafe', also: ['work', 'outdoors'], activity: 'a break / food', outfit: 'day', band: 'midday_out' },
                { id: 'on_site_pm', start: 16, end: 21, place: 'work', also: ['cafe'], activity: 'back on shift', outfit: 'day', band: 'work_or_school' },
                { id: 'transit_home', start: 20, end: 23, place: 'car', also: ['outdoors'], activity: 'heading home', outfit: 'day', band: 'commute' },
                { id: 'bed', start: 22, end: 24, place: 'bedroom', also: ['living', 'bathroom'], activity: 'home / in bed after the shift', outfit: 'same', band: 'night_private' }
            ];
        }
        if (ls === 'office' || ls === 'student') {
            const site = ls === 'student' ? 'work' : 'work';
            return [
                { id: 'sleep', start: 0, end: 6, place: 'bedroom', also: ['living'], activity: 'asleep', outfit: 'same', band: 'night_private' },
                { id: 'wake_ready', start: 6, end: 9, place: 'bathroom', also: ['kitchen', 'living'], activity: 'getting ready to leave', outfit: 'day', band: 'home_morning' },
                { id: 'transit_out', start: 7.5, end: 10, place: 'car', also: ['outdoors', 'cafe'], activity: 'in transit', outfit: 'day', band: 'commute' },
                { id: 'on_site', start: 9, end: 13, place: site, also: ['cafe'], activity: ls === 'student' ? 'at school / campus' : 'at work', outfit: 'day', band: 'work_or_school' },
                { id: 'break', start: 12, end: 15, place: 'cafe', also: [site, 'outdoors'], activity: 'a break / something to eat', outfit: 'day', band: 'midday_out' },
                { id: 'on_site_pm', start: 13.5, end: 18, place: site, also: ['cafe'], activity: ls === 'student' ? 'back on campus' : 'back at work', outfit: 'day', band: 'work_or_school' },
                { id: 'transit_home', start: 16.5, end: 19.5, place: 'car', also: ['outdoors', 'cafe'], activity: 'heading home', outfit: 'day', band: 'commute' },
                { id: 'evening', start: 18, end: 22, place: 'living', also: ['kitchen', 'cafe'], activity: 'evening unwind', outfit: 'same', band: 'home_evening' },
                { id: 'bed', start: 21.5, end: 24, place: 'bedroom', also: ['living', 'bathroom'], activity: 'in bed / winding down', outfit: 'same', band: 'night_private' }
            ];
        }
        return [
            { id: 'sleep', start: 0, end: 7, place: 'bedroom', also: ['living'], activity: 'asleep', outfit: 'same', band: 'night_private' },
            { id: 'wake_ready', start: 7, end: 10, place: 'kitchen', also: ['bathroom', 'living'], activity: 'getting the day started', outfit: 'day', band: 'home_morning' },
            { id: 'mid_out', start: 10, end: 16, place: 'cafe', also: ['shop', 'outdoors', 'living'], activity: 'out in her day', outfit: 'day', band: 'midday_out' },
            { id: 'evening', start: 16, end: 21, place: 'living', also: ['kitchen', 'cafe'], activity: 'evening', outfit: 'same', band: 'home_evening' },
            { id: 'bed', start: 21, end: 24, place: 'bedroom', also: ['living', 'bathroom'], activity: 'in bed / winding down', outfit: 'same', band: 'night_private' }
        ];
    }

    function isInternalUserLine(text) {
        const t = String(text || '').trim();
        return !t
            || t.startsWith('/')
            || /^\[(continued|story launch|proactive|world_skip|next_scene|jump|time_pass)\]$/i.test(t)
            || /^view story\b/i.test(t);
    }

    function operatorContextBlob(sess, extraText) {
        const hist = Array.isArray(sess?.history) ? sess.history : [];
        const recent = [];
        for (let i = hist.length - 1; i >= 0 && recent.length < 2; i--) {
            const line = String(hist[i]?.user || '').trim();
            if (!line || isInternalUserLine(line)) continue;
            recent.push(line);
        }
        recent.reverse();
        const hint = String(extraText || '').replace(/^\/next\s+scene\b/i, '').trim();
        if (hint && !isInternalUserLine(hint)) recent.push(hint);
        return recent.join('\n').toLowerCase();
    }

    function preferBeatIdFromContext(blob, sess) {
        const s = String(blob || '');
        if (!s.trim()) return '';
        if (/good\s*night|לילה טוב|go(?:ing)? to sleep|נרדמ|talk tomorrow|speak tomorrow/.test(s)) {
            return 'bed';
        }
        if (/date|drinks|bar|club|party|going out|night out|דייט|יאללה נצא|tonight/.test(s)) {
            return 'night_out';
        }
        if (/gym|workout|run|ספורט|כושר/.test(s)) return 'mid_out';
        if (/\bhome\b|בבית|come over|come here/.test(s)) return 'evening';
        if (/lunch|break|אוכל|צהריים/.test(s)) return 'break';
        if (/work|office|משרד|עבודה|class|campus|school/.test(s)) return 'on_site';
        const eng = Number(sess?.engagement);
        const rel = String(S()?.profile?.relationship || '').toLowerCase();
        const close = /girlfriend|boyfriend|partner|wife|husband|dating|exclusive|זוגי/.test(
            rel + ' ' + dossierBlob(S()?.profile)
        );
        if (close && Number.isFinite(eng) && eng >= 70 && /bed|come over|stay/.test(s)) {
            return 'bed';
        }
        return '';
    }

    function scoreLadderBeat(beat, hourMin, family) {
        const a = hourToMin(beat.start);
        let b = hourToMin(beat.end);
        if (b <= a) b += 24 * 60;
        let s = 0;
        if (hourMin >= a && hourMin < b) s += 4;
        else if (hourMin >= a - 45 && hourMin < b + 25) s += 1;
        if (family && (family === beat.place || (beat.also || []).includes(family))) s += 3;
        return s;
    }

    function pickCurrentBeat(ladder, hourMin, family) {
        let best = 0;
        let bestScore = -1;
        ladder.forEach((beat, i) => {
            const sc = scoreLadderBeat(beat, hourMin, family);
            if (sc > bestScore) {
                bestScore = sc;
                best = i;
            }
        });
        if (bestScore <= 0) {
            let nextIdx = 0;
            let bestDelta = Infinity;
            ladder.forEach((beat, i) => {
                let d = hourToMin(beat.start) - hourMin;
                if (d < 0) d += 24 * 60;
                if (d < bestDelta) {
                    bestDelta = d;
                    nextIdx = i;
                }
            });
            return Math.max(0, nextIdx - 1);
        }
        return best;
    }

    function successorBeat(ladder, idx, family) {
        const len = ladder.length;
        for (let step = 1; step <= len; step++) {
            const wrap = idx + step >= len;
            const n = ladder[(idx + step) % len];
            const sameRoom = family && n.place === family
                && n.band === 'night_private'
                && (ladder[idx].band === 'night_private');
            if (sameRoom) continue;
            return { beat: n, wrap: wrap || step > 1 && (idx + step) >= len, steps: step };
        }
        return { beat: ladder[(idx + 1) % len], wrap: idx + 1 >= len, steps: 1 };
    }

    function msUntilBeatWindow(beat, { minForwardMs = 25 * 60 * 1000 } = {}) {
        const minFwd = Math.max(18 * 60 * 1000, Number(minForwardMs) || 0);
        const jitterMin = 8 + Math.floor(Math.random() * 22);
        const startMin = hourToMin(beat.start);
        const targetHour = Math.floor(startMin / 60);
        const targetMinute = Math.min(59, (startMin % 60) + jitterMin);
        if (typeof MiragePhoneUX?.msUntilLocalHour === 'function') {
            return MiragePhoneUX.msUntilLocalHour(targetHour, {
                minute: targetMinute,
                minForwardMs: minFwd,
                organic: false
            });
        }
        return minFwd + jitterMin * 60 * 1000;
    }

    /**
     * Next /next scene landing: following beat of her day, biased by his last
     * lines + optional hint. Not a 4-hour lottery and not leftover AI captions.
     */
    function resolveNextSceneJump(session, extraText) {
        const sess = session || S()?.session;
        const prof = S()?.profile;
        const parts = clockParts(prof);
        const lifestyle = inferLifestyle(prof);
        const offDay = isOffDay(parts, prof);
        const ladder = beatLadder(lifestyle, offDay);
        const hourMin = (Number(parts.hour) || 0) * 60 + (Number(parts.minute) || 0);
        const family = placeFamilyOf(sess?.env);
        const envSet = typeof S()?.isSceneFieldSet === 'function'
            ? S().isSceneFieldSet(sess?.env)
            : !!(sess?.env && String(sess.env).trim());
        const curIdx = pickCurrentBeat(ladder, hourMin, envSet ? family : '');
        const blob = operatorContextBlob(sess, extraText);
        let preferId = preferBeatIdFromContext(blob, sess);
        const ids = new Set(ladder.map(b => b.id));
        if (preferId && !ids.has(preferId)) {
            if (preferId === 'night_out') {
                preferId = ids.has('evening') ? 'evening' : (ids.has('day_out') ? 'day_out' : 'mid_out');
            } else if (preferId === 'break') {
                preferId = ids.has('mid_out') ? 'mid_out' : (ids.has('day_out') ? 'day_out' : '');
            } else if (preferId === 'on_site') {
                preferId = ids.has('home_day') ? 'home_day' : (ids.has('day_out') ? 'day_out' : '');
            }
            if (preferId && !ids.has(preferId)) preferId = '';
        }
        let next;
        let wrap = false;
        if (preferId) {
            const hit = ladder.findIndex((b, i) => b.id === preferId && i !== curIdx);
            if (hit >= 0) {
                next = ladder[hit];
                wrap = hit < curIdx;
            }
        }
        if (!next) {
            const step = successorBeat(ladder, curIdx, envSet ? family : '');
            next = step.beat;
            wrap = step.wrap;
        }
        const minForward = wrap ? 45 * 60 * 1000 : 22 * 60 * 1000;
        let ms = msUntilBeatWindow(next, { minForwardMs: minForward });
        if (!(ms > 0)) ms = minForward;
        if (ms < 18 * 60 * 1000) {
            const at = Math.max(0, ladder.findIndex(b => b.id === next.id));
            const skip = successorBeat(ladder, at, next.place);
            next = skip.beat;
            wrap = wrap || skip.wrap;
            ms = msUntilBeatWindow(next, { minForwardMs: 22 * 60 * 1000 });
        }

        const also = (next.also || []).filter(f => f !== next.place).slice(0, 3);
        const clock = clockLabel({
            hour: Math.floor(hourToMin(next.start) / 60),
            minute: hourToMin(next.start) % 60,
            weekday: wrap ? '' : (parts.weekday || '')
        });
        const summary = `${next.activity}${clock ? ` · ${clock}` : ''}`;
        const line = `NEXT BEAT: ${next.activity} · place type ${next.place}`
            + (also.length ? ` (${also.join('/')} ok)` : '')
            + `. New PLACE TYPE — not a rename of the last room. Fresh outfit that fits this hour`
            + (next.outfit === 'day' || next.outfit === 'out' ? ` (${next.outfit} clothes).` : '.')
            + ' Invent the specific location from her life / dossier / what he just said — do not recap a stock schedule.';

        return {
            ms,
            band: next.band,
            placeFamily: next.place,
            also,
            activity: next.activity,
            outfitHint: next.outfit || 'day',
            lifestyle,
            fromId: ladder[curIdx]?.id || '',
            toId: next.id,
            wrap: !!wrap,
            clockLabel: clock,
            summary,
            line,
            forbidFamilies: envSet && family ? [family] : []
        };
    }

    global.MirageRoutine = {
        MODES,
        DEFAULT_MODE,
        normalizeMode,
        currentMode,
        inferLifestyle,
        resolveBand,
        resolveBeat,
        resolveForTurn,
        shouldMoveThisTurn,
        stamp,
        stampFromClock,
        forbidsBedroom,
        placeFamilyOf,
        resolveNextSceneJump
    };
})(typeof window !== 'undefined' ? window : globalThis);
