/**
 * MIRAGE ENGINE v2 — Phone realism
 *
 * Bezel clock (her local time), presence / last-seen, typing indicator in the phone
 * feed, and Delivered → Seen receipts on the operator chat user bubble.
 */
(function (global) {
    'use strict';

    const S = () => global.EngineState;

    /**
     * Common free-text location → IANA, used only when the character record carries
     * no explicit `profile.timezone`. Matching is whole-word and longest-key-first
     * (see CITY_TZ_MATCHERS) — a substring scan in object order used to send every
     * location containing the letters "la" to Los Angeles, Dallas and Atlanta included.
     */
    const CITY_TZ = {
        'los angeles': 'America/Los_Angeles', 'la': 'America/Los_Angeles', 'nyc': 'America/New_York',
        'new york': 'America/New_York', 'brooklyn': 'America/New_York', 'queens': 'America/New_York',
        'boston': 'America/New_York', 'philadelphia': 'America/New_York', 'philly': 'America/New_York',
        'washington': 'America/New_York', 'dc': 'America/New_York', 'atlanta': 'America/New_York',
        'orlando': 'America/New_York', 'tampa': 'America/New_York', 'charlotte': 'America/New_York',
        'detroit': 'America/Detroit', 'cleveland': 'America/New_York', 'pittsburgh': 'America/New_York',
        'miami': 'America/New_York',
        'chicago': 'America/Chicago', 'houston': 'America/Chicago', 'dallas': 'America/Chicago',
        'austin': 'America/Chicago', 'san antonio': 'America/Chicago', 'nashville': 'America/Chicago',
        'new orleans': 'America/Chicago', 'minneapolis': 'America/Chicago', 'kansas city': 'America/Chicago',
        'st louis': 'America/Chicago', 'milwaukee': 'America/Chicago', 'memphis': 'America/Chicago',
        'denver': 'America/Denver', 'salt lake city': 'America/Denver', 'albuquerque': 'America/Denver',
        'new mexico': 'America/Denver', 'boise': 'America/Boise',
        'phoenix': 'America/Phoenix', 'arizona': 'America/Phoenix', 'tucson': 'America/Phoenix',
        'seattle': 'America/Los_Angeles', 'portland': 'America/Los_Angeles', 'oakland': 'America/Los_Angeles',
        'sacramento': 'America/Los_Angeles', 'san diego': 'America/Los_Angeles',
        'san jose': 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles',
        'sf': 'America/Los_Angeles', 'vegas': 'America/Los_Angeles', 'las vegas': 'America/Los_Angeles',
        'honolulu': 'Pacific/Honolulu', 'hawaii': 'Pacific/Honolulu', 'anchorage': 'America/Anchorage',
        'alaska': 'America/Anchorage',
        'london': 'Europe/London', 'manchester': 'Europe/London', 'liverpool': 'Europe/London',
        'edinburgh': 'Europe/London', 'glasgow': 'Europe/London', 'dublin': 'Europe/Dublin',
        'ireland': 'Europe/Dublin', 'iceland': 'Atlantic/Reykjavik', 'reykjavik': 'Atlantic/Reykjavik',
        'lisbon': 'Europe/Lisbon', 'portugal': 'Europe/Lisbon',
        'paris': 'Europe/Paris', 'lyon': 'Europe/Paris', 'marseille': 'Europe/Paris',
        'berlin': 'Europe/Berlin', 'munich': 'Europe/Berlin', 'hamburg': 'Europe/Berlin',
        'frankfurt': 'Europe/Berlin', 'cologne': 'Europe/Berlin',
        'amsterdam': 'Europe/Amsterdam', 'rotterdam': 'Europe/Amsterdam',
        'brussels': 'Europe/Brussels', 'zurich': 'Europe/Zurich', 'geneva': 'Europe/Zurich',
        'vienna': 'Europe/Vienna', 'prague': 'Europe/Prague', 'budapest': 'Europe/Budapest',
        'warsaw': 'Europe/Warsaw', 'poland': 'Europe/Warsaw', 'krakow': 'Europe/Warsaw',
        'madrid': 'Europe/Madrid', 'barcelona': 'Europe/Madrid', 'valencia': 'Europe/Madrid',
        'rome': 'Europe/Rome', 'milan': 'Europe/Rome', 'naples': 'Europe/Rome', 'venice': 'Europe/Rome',
        'florence': 'Europe/Rome', 'athens': 'Europe/Athens', 'greece': 'Europe/Athens',
        'stockholm': 'Europe/Stockholm', 'oslo': 'Europe/Oslo', 'copenhagen': 'Europe/Copenhagen',
        'helsinki': 'Europe/Helsinki', 'finland': 'Europe/Helsinki',
        'istanbul': 'Europe/Istanbul', 'kyiv': 'Europe/Kyiv', 'kiev': 'Europe/Kyiv',
        'moscow': 'Europe/Moscow', 'st petersburg': 'Europe/Moscow',
        'tokyo': 'Asia/Tokyo', 'osaka': 'Asia/Tokyo', 'kyoto': 'Asia/Tokyo', 'japan': 'Asia/Tokyo',
        'seoul': 'Asia/Seoul', 'korea': 'Asia/Seoul',
        'shanghai': 'Asia/Shanghai', 'beijing': 'Asia/Shanghai', 'shenzhen': 'Asia/Shanghai',
        'hong kong': 'Asia/Hong_Kong', 'taipei': 'Asia/Taipei', 'taiwan': 'Asia/Taipei',
        'singapore': 'Asia/Singapore', 'bangkok': 'Asia/Bangkok', 'thailand': 'Asia/Bangkok',
        'jakarta': 'Asia/Jakarta', 'manila': 'Asia/Manila', 'philippines': 'Asia/Manila',
        'kuala lumpur': 'Asia/Kuala_Lumpur', 'ho chi minh': 'Asia/Ho_Chi_Minh', 'hanoi': 'Asia/Ho_Chi_Minh',
        'sydney': 'Australia/Sydney', 'melbourne': 'Australia/Melbourne', 'brisbane': 'Australia/Brisbane',
        'perth': 'Australia/Perth', 'adelaide': 'Australia/Adelaide',
        'auckland': 'Pacific/Auckland', 'wellington': 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland',
        'toronto': 'America/Toronto', 'ottawa': 'America/Toronto', 'montreal': 'America/Toronto',
        'vancouver': 'America/Vancouver', 'calgary': 'America/Edmonton', 'edmonton': 'America/Edmonton',
        'winnipeg': 'America/Winnipeg',
        'mexico city': 'America/Mexico_City', 'mexico': 'America/Mexico_City',
        'guadalajara': 'America/Mexico_City', 'cancun': 'America/Cancun', 'tijuana': 'America/Tijuana',
        'sao paulo': 'America/Sao_Paulo', 'rio': 'America/Sao_Paulo', 'brazil': 'America/Sao_Paulo',
        'buenos aires': 'America/Argentina/Buenos_Aires', 'argentina': 'America/Argentina/Buenos_Aires',
        'santiago': 'America/Santiago', 'chile': 'America/Santiago', 'lima': 'America/Lima',
        'bogota': 'America/Bogota', 'colombia': 'America/Bogota',
        'dubai': 'Asia/Dubai', 'uae': 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai',
        'doha': 'Asia/Qatar', 'riyadh': 'Asia/Riyadh',
        'mumbai': 'Asia/Kolkata', 'delhi': 'Asia/Kolkata', 'bangalore': 'Asia/Kolkata',
        'india': 'Asia/Kolkata', 'karachi': 'Asia/Karachi', 'lahore': 'Asia/Karachi',
        'tel aviv': 'Asia/Jerusalem', 'jerusalem': 'Asia/Jerusalem', 'haifa': 'Asia/Jerusalem',
        'israel': 'Asia/Jerusalem',
        'cairo': 'Africa/Cairo', 'egypt': 'Africa/Cairo', 'lagos': 'Africa/Lagos',
        'nigeria': 'Africa/Lagos', 'nairobi': 'Africa/Nairobi', 'kenya': 'Africa/Nairobi',
        'johannesburg': 'Africa/Johannesburg', 'cape town': 'Africa/Johannesburg',
        'south africa': 'Africa/Johannesburg', 'casablanca': 'Africa/Casablanca',
        'morocco': 'Africa/Casablanca'
    };

    /**
     * Longest key first, so "los angeles" beats "la" and "mexico city" beats "mexico";
     * whole-word, so "atlanta" / "iceland" / "poland" / "milan" no longer contain "la".
     */
    const CITY_TZ_MATCHERS = Object.entries(CITY_TZ)
        .sort((a, b) => b[0].length - a[0].length)
        .map(([key, tz]) => ({
            re: new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
            tz
        }));

    let clockTimer = null;
    let lastUserReceiptEl = null;
    let turnGen = 0;

    /** True when the runtime accepts this string as an IANA zone. */
    function isValidTimeZone(name) {
        const tz = String(name || '').trim();
        if (!tz) return false;
        try {
            Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
            return true;
        } catch {
            return false;
        }
    }

    /** Best-effort IANA zone from a free-text location. '' when nothing matches. */
    function inferTimeZoneFromLocation(location) {
        const raw = String(location || '').trim();
        if (!raw) return '';
        for (const { re, tz } of CITY_TZ_MATCHERS) {
            if (re.test(raw)) return tz;
        }
        // Accept a pasted IANA zone ("America/Los_Angeles")
        if (isValidTimeZone(raw)) return raw;
        return '';
    }

    function browserTimeZone() {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch {
            return 'UTC';
        }
    }

    /**
     * Her zone, in priority order:
     *   1. `profile.timezone` — an explicit IANA zone chosen at character setup. Authoritative.
     *   2. Inference from the free-text location, whole-word and longest-match-first.
     *   3. The operator's browser zone, which is a guess and is only ever a last resort.
     *
     * Callers pass her location and may pass the profile record it came from; when they
     * don't, the active character is used, which is what every existing call site wants.
     */
    function resolveTimeZone(location, profile) {
        const record = profile || S()?.profile;
        const explicit = String(record?.timezone || '').trim();
        if (explicit && isValidTimeZone(explicit)) return explicit;
        return inferTimeZoneFromLocation(location) || browserTimeZone();
    }

    function herNow() {
        const sess = S()?.session || {};
        const offset = Number(sess.clockOffsetMs) || 0;
        return new Date(Date.now() + offset);
    }

    function formatClock(date, timeZone) {
        try {
            return new Intl.DateTimeFormat('en-US', {
                timeZone,
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            }).format(date);
        } catch {
            const h = date.getHours();
            const m = String(date.getMinutes()).padStart(2, '0');
            const ap = h >= 12 ? 'PM' : 'AM';
            const h12 = h % 12 || 12;
            return `${h12}:${m} ${ap}`;
        }
    }

    /**
     * e.g. "3:15 PM → 5:41 PM" (adds landing day when it differs).
     * `fromMs` must be the sim instant BEFORE the jump — callers that already
     * advanced the clock have to pass the pre-advance time or the arrow double-counts.
     */
    function formatClockArrow(advanceMs, fromMs) {
        const ms = Math.max(0, Number(advanceMs) || 0);
        const tz = resolveTimeZone(S()?.profile?.location);
        const start = Number.isFinite(Number(fromMs))
            ? Number(fromMs)
            : herNow().getTime();
        const now = new Date(start);
        const next = new Date(start + ms);
        const from = formatClock(now, tz);
        const to = formatClock(next, tz);
        try {
            const dayOpts = { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' };
            const fromDay = new Intl.DateTimeFormat('en-US', dayOpts).format(now);
            const toDay = new Intl.DateTimeFormat('en-US', dayOpts).format(next);
            if (fromDay !== toDay) return `${from} → ${to} (${toDay})`;
        } catch { /* clock only */ }
        return `${from} → ${to}`;
    }

    function bumpStamp(latest, n) {
        const v = Number(n);
        return Number.isFinite(v) && v > latest ? v : latest;
    }

    /**
     * Transcript instants only — history, uiLog, bubble DOM, monotonic stamp.
     * Do not include lastAi/lastUser here; those can sit ahead of a cancelled turn.
     */
    function latestTranscriptStampMs(sess, { includeDom = false } = {}) {
        const s = sess || S()?.session;
        if (!s) return 0;
        let latest = 0;
        latest = bumpStamp(latest, s._lastChatStampMs);
        latest = bumpStamp(latest, s.lastChatStampMs);
        latest = bumpStamp(latest, s.lastStoryAt);
        if (Array.isArray(s.history)) {
            s.history.forEach((h) => { latest = bumpStamp(latest, h?.at); });
        }
        if (Array.isArray(s.uiLog)) {
            s.uiLog.forEach((e) => { latest = bumpStamp(latest, e?.at); });
        }
        if (includeDom) {
            try {
                document.querySelectorAll('#chatLog [data-at], #phoneFeed [data-at]').forEach((el) => {
                    latest = bumpStamp(latest, el.getAttribute('data-at'));
                });
            } catch { /* ignore */ }
        }
        return latest;
    }

    /**
     * Latest sim-clock instant from the transcript plus activity pointers.
     * Pass includeDom only after this chat's bubbles are in the page — never while
     * loading a different chat, or the previous thread's stamps leak in.
     */
    function latestSimStampMs(sess, { includeDom = false } = {}) {
        const s = sess || S()?.session;
        if (!s) return 0;
        let latest = latestTranscriptStampMs(s, { includeDom });
        latest = bumpStamp(latest, s.lastAiMessageAt);
        latest = bumpStamp(latest, s.lastUserMessageAt);
        return latest;
    }

    /**
     * Engine clock must never sit behind the last bubble. Old chats + clock-resume
     * "keep same time" used a stale lastAiMessageAt and rewound the phone while
     * history.at stayed put.
     */
    function ensureClockNotBehindStamps({ includeDom = false } = {}) {
        const sess = S()?.session;
        if (!sess) return 0;
        const now = herNow().getTime();
        // Operator rewound onto real/user time — leftover /next scene stamps may sit
        // in the sim-future. Do not snap the bezel back to those bubbles.
        if (sess.clockMayLagStamps) return now;
        const latest = latestTranscriptStampMs(sess, { includeDom });
        if (!(latest > 0)) return now;
        if (latest > now + 2000) {
            setClockToInstant(latest);
            return latest;
        }
        return now;
    }

    /**
     * Estimate clock advance for deck previews (mirrors /time pass, /jump, /next scene).
     * Skips organicize jitter so the preview stays stable while typing.
     */
    function estimateDirectiveAdvanceMs(kind, text) {
        const sess = S()?.session;
        const t = String(text || '').trim();
        if (kind === 'next_scene') {
            return resolveSceneJumpAdvanceMs(sess, t) || (4 * 60 * 60 * 1000);
        }
        if (kind === 'jump') {
            if (!t) return null;
            const organic = resolveOrganicArrival(t, {
                minForwardMs: 45 * 60 * 1000,
                allowDayWrap: true
            });
            if (organic?.ms) return organic.ms;
            return resolveSceneJumpAdvanceMs(sess, t) || (3 * 60 * 60 * 1000);
        }
        if (kind === 'time_pass') {
            if (!t) return null;
            const parsed = parseDuration(t);
            if (parsed?.explicit) return parsed.ms;
            const organic = resolveOrganicArrival(t, {
                minForwardMs: 30 * 60 * 1000,
                allowDayWrap: looksLikeOvernightIntent(t)
            });
            if (organic?.ms) return organic.ms;
            return parsed?.ms || (2 * 60 * 60 * 1000);
        }
        return null;
    }

    /**
     * Whole midnights between two instants in her TZ (WhatsApp-style).
     * 0 = same calendar day, 1 = yesterday (stamp is before today's 12:00 AM).
     */
    function calendarDaysAgo(stampMs, nowMs, timeZone) {
        const tz = timeZone || resolveTimeZone(S()?.profile?.location);
        const stamp = Number(stampMs);
        const now = Number(nowMs);
        if (!Number.isFinite(stamp) || !Number.isFinite(now)) return 0;
        const a = getZonedParts(new Date(stamp), tz);
        const b = getZonedParts(new Date(now), tz);
        const aDay = Date.UTC(a.year, a.month - 1, a.day);
        const bDay = Date.UTC(b.year, b.month - 1, b.day);
        return Math.round((bDay - aDay) / 86400000);
    }

    function formatLastSeen(date, timeZone) {
        if (!date) return 'Last seen recently';
        const at = new Date(date).getTime();
        const nowMs = herNow().getTime();
        const ageMs = Math.max(0, nowMs - at);
        const days = calendarDaysAgo(at, nowMs, timeZone);
        if (days <= 0 && ageMs < 60 * 1000) return 'Active now';
        if (days <= 0 && ageMs < 60 * 60 * 1000) {
            const mins = Math.max(1, Math.round(ageMs / 60000));
            return `Last seen ${mins}m ago`;
        }
        if (days <= 0) {
            const clock = formatClock(new Date(date), timeZone);
            return `Last seen ${clock}`;
        }
        if (days === 1) return 'Last seen yesterday';
        return `Last seen ${days} days ago`;
    }

    function updateChrome() {
        const statusTime = document.getElementById('phoneStatusTime')
            || document.getElementById('phoneStatus');
        const presence = document.getElementById('phonePresence');
        const headerName = document.getElementById('phoneHeaderName');
        const tz = resolveTimeZone(S()?.profile?.location);
        const now = herNow();
        const name = S()?.profile?.name || 'Character';

        if (statusTime) {
            if (statusTime.id === 'phoneStatusTime') {
                statusTime.textContent = formatClock(now, tz);
            } else {
                statusTime.textContent = `${formatClock(now, tz)} · 5G`;
            }
        }

        const weekdayEl = document.getElementById('phoneStatusWeekday');
        const specialEl = document.getElementById('phoneStatusSpecial');
        const bezel = typeof global.MirageCalendar?.statusBezel === 'function'
            ? global.MirageCalendar.statusBezel(S()?.profile)
            : null;
        let weekday = bezel?.weekday || '';
        if (!weekday) {
            try {
                weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
            } catch {
                weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()] || '';
            }
        }
        if (weekdayEl) weekdayEl.textContent = weekday;
        if (specialEl) {
            const label = String(bezel?.special || '').trim();
            specialEl.textContent = label;
            specialEl.hidden = !label;
            if (label) specialEl.title = bezel.specialFull || label;
            else specialEl.removeAttribute('title');
        }

        if (headerName) headerName.textContent = name;

        if (presence) {
            const state = S()?.session?.presence || 'idle';
            if (state === 'typing') {
                presence.textContent = 'typing…';
                presence.dataset.state = 'typing';
            } else if (state === 'reading') {
                presence.textContent = 'online';
                presence.dataset.state = 'reading';
            } else if (state === 'active') {
                presence.textContent = 'online';
                presence.dataset.state = 'active';
            } else {
                presence.textContent = formatLastSeen(S()?.session?.lastSeenAt, tz);
                presence.dataset.state = 'idle';
            }
        }
    }

    function setPresence(state, { touchSeen = true } = {}) {
        const sess = S()?.session;
        if (!sess) return;
        sess.presence = state;
        if (touchSeen && (state === 'active' || state === 'idle')) {
            sess.lastSeenAt = herNow().getTime();
        }
        updateChrome();
    }

    function showTyping(on) {
        const feed = document.getElementById('phoneFeed');
        const empty = document.getElementById('phoneEmpty');
        if (!feed) return;

        let el = document.getElementById('phoneTyping');
        if (on) {
            if (empty) empty.hidden = true;
            if (!el) {
                el = document.createElement('div');
                el.id = 'phoneTyping';
                el.className = 'phone-typing';
                el.innerHTML = '<span></span><span></span><span></span>';
                feed.appendChild(el);
            }
            feed.scrollTop = feed.scrollHeight;
            setPresence('typing');
        } else {
            if (el) el.remove();
            // Dots gone — don't leave the WhatsApp header stuck on "typing…"
            if (S()?.session?.presence === 'typing') {
                setPresence('active');
            }
        }
    }

    function ensureReceipt(el) {
        if (!el || el.classList.contains('chat-command') || !el.classList.contains('chat-bubble-user')) {
            return null;
        }
        let receipt = el.querySelector('.chat-receipt');
        if (!receipt) {
            receipt = document.createElement('span');
            receipt.className = 'chat-receipt';
            el.appendChild(receipt);
        }
        return receipt;
    }

    function markUserDelivered() {
        const log = document.getElementById('chatLog');
        if (!log) return;
        const users = log.querySelectorAll('.chat-entry.chat-bubble-user');
        const last = users[users.length - 1];
        if (!last) return;
        lastUserReceiptEl = last;
        const receipt = ensureReceipt(last);
        if (!receipt) return;
        receipt.textContent = 'Delivered';
        receipt.dataset.state = 'delivered';
        last.dataset.receipt = 'delivered';
    }

    function markUserSeen() {
        const el = lastUserReceiptEl;
        if (!el) return;
        stampSeen(el);
        setPresence('reading');
    }

    function stampSeen(el) {
        if (!el) return;
        const receipt = ensureReceipt(el);
        if (!receipt) return;
        if (receipt.dataset.state === 'reaction') return;
        receipt.textContent = 'Seen';
        receipt.dataset.state = 'seen';
        el.dataset.receipt = 'seen';
    }

    /**
     * After a chat reload: answered operator bubbles are Seen.
     * A trailing unanswered line is Delivered, or Seen if she already opened (left-on-read).
     */
    function restoreUserReceipts() {
        const log = document.getElementById('chatLog');
        if (!log) return;
        const entries = [...log.children];
        let lastAiIdx = -1;
        entries.forEach((el, i) => {
            if (el.classList.contains('chat-bubble-ai') || el.classList.contains('chat-story')) {
                lastAiIdx = i;
            }
        });

        const hold = S()?.session?.socialHold || null;
        const kind = String(hold?.kind || hold?.style || '').toLowerCase();
        const opened = !!(
            hold?.openedThread
            || kind === 'left_on_read'
            || kind === 'ditch'
        );

        entries.forEach((el, i) => {
            if (!el.classList.contains('chat-bubble-user')) return;
            if (lastAiIdx >= 0 && i < lastAiIdx) {
                stampSeen(el);
                return;
            }
            if (opened) {
                stampSeen(el);
                return;
            }
            const receipt = ensureReceipt(el);
            if (!receipt || receipt.dataset.state === 'reaction') return;
            receipt.textContent = 'Delivered';
            receipt.dataset.state = 'delivered';
            el.dataset.receipt = 'delivered';
            lastUserReceiptEl = el;
        });
    }

    /** She opened the DM — every still-Delivered operator bubble becomes Seen. */
    function markAllUserSeen() {
        const log = document.getElementById('chatLog');
        if (!log) return;
        const users = log.querySelectorAll('.chat-entry.chat-bubble-user');
        let last = null;
        users.forEach((el) => {
            const state = el.querySelector('.chat-receipt')?.dataset?.state
                || el.dataset.receipt
                || '';
            if (state === 'reaction' || state === 'seen') return;
            stampSeen(el);
            last = el;
        });
        if (last) lastUserReceiptEl = last;
        if (users.length) setPresence('reading');
    }

    /** @deprecated use markUserSeen */
    function markUserOpened() {
        return markUserSeen();
    }

    function markUserReaction(emoji) {
        const el = lastUserReceiptEl;
        if (!el) return;
        const receipt = ensureReceipt(el);
        if (!receipt) return;
        const face = String(emoji || '❤️').trim() || '❤️';
        receipt.textContent = `Reacted ${face}`;
        receipt.dataset.state = 'reaction';
        el.dataset.receipt = 'reaction';

        let chip = el.querySelector('.chat-reaction');
        if (!chip) {
            chip = document.createElement('span');
            chip.className = 'chat-reaction';
            el.appendChild(chip);
        }
        chip.textContent = face;
        setPresence('active');
    }

    /** Mark her messages since the last user bubble as unread until the operator engages. */
    function markAiUnread() {
        const log = document.getElementById('chatLog');
        if (!log) return;
        const entries = Array.from(log.querySelectorAll('.chat-entry'));
        let lastUser = -1;
        entries.forEach((el, i) => {
            if (el.classList.contains('chat-user')) lastUser = i;
        });
        entries.forEach((el, i) => {
            if (i <= lastUser || !el.classList.contains('chat-ai')) return;
            el.classList.add('is-unread');
            let tag = el.querySelector('.chat-unread-tag');
            if (!tag) {
                tag = document.createElement('span');
                tag.className = 'chat-unread-tag';
                tag.textContent = 'Unread';
                el.appendChild(tag);
            }
        });
    }

    function markAllAiRead() {
        const log = document.getElementById('chatLog');
        if (!log) return;
        log.querySelectorAll('.chat-entry.chat-ai.is-unread').forEach(el => {
            el.classList.remove('is-unread');
            el.querySelector('.chat-unread-tag')?.remove();
        });
    }

    const MODAL_IDS = ['configModal', 'charactersModal', 'chatsModal', 'sessionChoiceModal'];

    /** True when the operator is looking at the live simulation chat. */
    function operatorAttendingChat() {
        try {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
                return false;
            }
        } catch { /* ignore */ }
        const sess = S()?.session;
        if (!sess || sess.phase !== 'active') return false;
        if (Number(sess.setupStep) !== 6) return false;
        for (const id of MODAL_IDS) {
            const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
            if (el && !el.hidden) return false;
        }
        return true;
    }

    /** Operator is present on the sim — clear unread chrome + cancel unread aftermath. */
    function onOperatorAttending() {
        markAllAiRead();
        try {
            global.MirageImmersion?.onOperatorAttending?.();
        } catch { /* ignore */ }
    }

    const DURATION_NUM_WORDS = {
        a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
        six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
        couple: 2, few: 3
    };

    function daysInMonth(year, month1to12) {
        return new Date(Date.UTC(Number(year), Number(month1to12), 0)).getUTCDate();
    }

    /** Calendar add in her TZ (same clock-of-day). */
    function addZonedCalendar({ months = 0, years = 0 } = {}) {
        const tz = resolveTimeZone(S()?.profile?.location);
        const now = herNow();
        const p = getZonedParts(now, tz);
        let y = Number(p.year) + Math.trunc(Number(years) || 0);
        let m0 = Number(p.month) - 1 + Math.trunc(Number(months) || 0);
        y += Math.floor(m0 / 12);
        m0 = ((m0 % 12) + 12) % 12;
        const dim = daysInMonth(y, m0 + 1);
        const day = Math.min(Number(p.day) || 1, dim);
        const target = instantForZonedParts({
            year: y,
            month: m0 + 1,
            day,
            hour: p.hour,
            minute: p.minute,
            second: p.second || 0
        }, tz);
        const ms = target - now.getTime();
        return ms > 60 * 1000 ? ms : (30 * 24 * 60 * 60 * 1000);
    }

    /**
     * Parse "/time pass 2 hours" / "1 month" / "3 years" (EN + Hebrew).
     * Months/years are calendar jumps in her timezone, not 30-day approximations
     * and not the 2-hour fallback.
     */
    function parseDuration(raw) {
        const s = String(raw || '').trim().toLowerCase();
        const empty = { ms: 2 * 60 * 60 * 1000, unit: 'hour', calendar: false, explicit: false, count: 2 };
        if (!s || /^(some time|a while|a bit)$/i.test(s)) return empty;

        if (/\bnext\s+year\b|בשנה הבאה/.test(s)) {
            return { ms: addZonedCalendar({ years: 1 }), unit: 'year', calendar: true, explicit: true, count: 1 };
        }
        if (/\bnext\s+month\b|בחודש הבא/.test(s)) {
            return { ms: addZonedCalendar({ months: 1 }), unit: 'month', calendar: true, explicit: true, count: 1 };
        }
        if (/שנתיים/.test(s)) {
            return { ms: addZonedCalendar({ years: 2 }), unit: 'year', calendar: true, explicit: true, count: 2 };
        }
        if (/חודשיים/.test(s)) {
            return { ms: addZonedCalendar({ months: 2 }), unit: 'month', calendar: true, explicit: true, count: 2 };
        }

        const he = s.match(/(\d+(?:\.\d+)?)\s*(שנים|שנה|חודשים|חודש|שבועות|שבוע|ימים|יום|שעות|שעה|דקות|דקה|שניות|שניה)/);
        const en = s.match(
            /(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\s*(years?|yrs?|months?|mos?|weeks?|days?|hours?|hrs?|minutes?|mins?|min|seconds?|secs?|sec)\b/i
        );
        const m = he || en;
        if (!m) {
            if (/\bmonths?\b|\bmos?\b|חודש/.test(s)) {
                return { ms: addZonedCalendar({ months: 1 }), unit: 'month', calendar: true, explicit: true, count: 1 };
            }
            if (/\byears?\b|\byrs?\b|שנה/.test(s)) {
                return { ms: addZonedCalendar({ years: 1 }), unit: 'year', calendar: true, explicit: true, count: 1 };
            }
            if (/\bweeks?\b|שבוע/.test(s)) return { ms: 7 * 24 * 60 * 60 * 1000, unit: 'week', calendar: false, explicit: true, count: 1 };
            if (/\bdays?\b|יום/.test(s)) return { ms: 24 * 60 * 60 * 1000, unit: 'day', calendar: false, explicit: true, count: 1 };
            if (/\bhours?\b|\bhrs?\b|שעה/.test(s)) return { ms: 60 * 60 * 1000, unit: 'hour', calendar: false, explicit: true, count: 1 };
            return empty;
        }

        const rawCount = String(m[1]).toLowerCase();
        let n = Number(DURATION_NUM_WORDS[rawCount]);
        if (!Number.isFinite(n)) n = parseFloat(rawCount);
        if (!Number.isFinite(n) || n <= 0) n = 1;
        const unitRaw = String(m[2]).toLowerCase();

        const isYear = /^(years?|yrs?|שנים|שנה)$/.test(unitRaw);
        const isMonth = /^(months?|mos?|חודשים|חודש)$/.test(unitRaw);
        const isWeek = /^(weeks?|שבועות|שבוע)$/.test(unitRaw);
        const isDay = /^(days?|ימים|יום)$/.test(unitRaw);
        const isHour = /^(hours?|hrs?|שעות|שעה)$/.test(unitRaw);
        const isMin = /^(minutes?|mins?|min|דקות|דקה)$/.test(unitRaw);
        const isSec = /^(seconds?|secs?|sec|שניות|שניה)$/.test(unitRaw);

        if (isYear) {
            const whole = Math.trunc(n);
            const frac = n - whole;
            let ms = addZonedCalendar({ years: whole || (frac ? 0 : 1) });
            if (frac > 0) ms += Math.round(frac * 365 * 24 * 60 * 60 * 1000);
            if (whole === 0 && frac > 0) ms = Math.round(frac * 365 * 24 * 60 * 60 * 1000);
            return { ms, unit: 'year', calendar: true, explicit: true, count: n };
        }
        if (isMonth) {
            const whole = Math.trunc(n);
            const frac = n - whole;
            let ms = addZonedCalendar({ months: whole || (frac ? 0 : 1) });
            if (frac > 0) ms += Math.round(frac * 30 * 24 * 60 * 60 * 1000);
            if (whole === 0 && frac > 0) ms = Math.round(frac * 30 * 24 * 60 * 60 * 1000);
            return { ms, unit: 'month', calendar: true, explicit: true, count: n };
        }
        if (isWeek) return { ms: n * 7 * 24 * 60 * 60 * 1000, unit: 'week', calendar: false, explicit: true, count: n };
        if (isDay) return { ms: n * 24 * 60 * 60 * 1000, unit: 'day', calendar: false, explicit: true, count: n };
        if (isHour) return { ms: n * 60 * 60 * 1000, unit: 'hour', calendar: false, explicit: true, count: n };
        if (isMin) return { ms: n * 60 * 1000, unit: 'minute', calendar: false, explicit: true, count: n };
        if (isSec) return { ms: n * 1000, unit: 'second', calendar: false, explicit: true, count: n };
        return empty;
    }

    /** Parse "/time pass 2 hours" style durations into ms. */
    function parseDurationMs(raw) {
        return parseDuration(raw).ms;
    }

    function advanceClock(ms) {
        const sess = S()?.session;
        if (!sess) return;
        sess.clockMayLagStamps = false;
        sess.clockOffsetMs = (Number(sess.clockOffsetMs) || 0) + Math.max(0, ms);
        sess.lastSeenAt = herNow().getTime();
        syncClockChrome();
    }

    function advanceClockByDuration(raw) {
        advanceClock(parseDurationMs(raw));
    }

    /** Local wall-clock parts for a Date in the given IANA zone. */
    function getZonedParts(date, timeZone) {
        const tz = timeZone || resolveTimeZone(S()?.profile?.location);
        try {
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hourCycle: 'h23'
            });
            const parts = {};
            fmt.formatToParts(date).forEach(p => {
                if (p.type !== 'literal') parts[p.type] = p.value;
            });
            return {
                year: Number(parts.year),
                month: Number(parts.month),
                day: Number(parts.day),
                hour: Number(parts.hour),
                minute: Number(parts.minute),
                second: Number(parts.second)
            };
        } catch {
            const d = date instanceof Date ? date : new Date(date);
            return {
                year: d.getFullYear(),
                month: d.getMonth() + 1,
                day: d.getDate(),
                hour: d.getHours(),
                minute: d.getMinutes(),
                second: d.getSeconds()
            };
        }
    }

    function userTimeZone() {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch {
            return 'UTC';
        }
    }

    /** UTC ms for a wall-clock date/time in an IANA zone. */
    function instantForZonedParts(parts, timeZone) {
        const tz = timeZone || resolveTimeZone(S()?.profile?.location);
        const wantUtc = Date.UTC(
            Number(parts.year),
            Number(parts.month) - 1,
            Number(parts.day),
            Number(parts.hour),
            Number(parts.minute),
            Number(parts.second) || 0
        );
        let guess = wantUtc;
        for (let i = 0; i < 4; i++) {
            const got = getZonedParts(new Date(guess), tz);
            const gotUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
            const delta = wantUtc - gotUtc;
            if (delta === 0) break;
            guess += delta;
        }
        return guess;
    }

    /** Pin herNow() to an absolute instant (may move the clock backward). */
    function setClockToInstant(targetMs) {
        const sess = S()?.session;
        if (!sess) return;
        const t = Number(targetMs);
        if (!Number.isFinite(t)) return;
        sess.clockOffsetMs = t - Date.now();
        sess.lastSeenAt = t;
        syncClockChrome();
    }

    function formatClockLong(date, timeZone) {
        const tz = timeZone || resolveTimeZone(S()?.profile?.location);
        const d = date instanceof Date ? date : new Date(date);
        try {
            return new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            }).format(d);
        } catch {
            return formatClock(d, tz);
        }
    }

    function localHourAtOffset(offsetMs) {
        const tz = resolveTimeZone(S()?.profile?.location);
        const at = new Date(herNow().getTime() + Math.max(0, Number(offsetMs) || 0));
        return getZonedParts(at, tz).hour;
    }

    function randInt(lo, hi) {
        const a = Math.ceil(Number(lo) || 0);
        const b = Math.floor(Number(hi) || 0);
        if (b <= a) return a;
        return a + Math.floor(Math.random() * (b - a + 1));
    }

    /**
     * Lived-in minutes — almost never :00, rarely quarter-hours.
     * Real texts land at 8:47 / 9:13, not 9:00.
     */
    function organicMinute() {
        const lived = [
            2, 4, 6, 7, 9, 11, 13, 14, 16, 17, 19, 21, 23, 24, 26, 27, 29,
            31, 33, 34, 36, 38, 39, 41, 42, 44, 46, 48, 49, 51, 53, 54, 56, 57, 58
        ];
        if (Math.random() < 0.06) {
            // rare near-round, still not exact :00
            return [1, 2, 3, 14, 16, 28, 29, 31, 32, 44, 46][randInt(0, 10)];
        }
        return lived[randInt(0, lived.length - 1)];
    }

    /** Soft local windows (minutes from midnight). Inclusive start, exclusive end. */
    const ARRIVAL_BANDS = {
        morning: { startMin: 7 * 60 + 18, endMin: 9 * 60 + 55, label: 'morning' },
        work_morning: { startMin: 8 * 60 + 12, endMin: 10 * 60 + 42, label: 'into the day' },
        midday: { startMin: 11 * 60 + 28, endMin: 13 * 60 + 25, label: 'midday' },
        afternoon: { startMin: 13 * 60 + 38, endMin: 16 * 60 + 52, label: 'afternoon' },
        evening: { startMin: 18 * 60 + 18, endMin: 21 * 60 + 55, label: 'evening' },
        late: { startMin: 22 * 60 + 8, endMin: 23 * 60 + 48, label: 'late' }
    };

    function pickOrganicInBand(band) {
        const b = typeof band === 'string' ? ARRIVAL_BANDS[band] : band;
        if (!b) return { hour: 8, minute: organicMinute() };
        const span = Math.max(8, b.endMin - b.startMin);
        let total = b.startMin + randInt(0, span - 1);
        let minute = total % 60;
        // Force lived-in minutes; re-roll round clocks hard
        if (minute === 0 || minute % 15 === 0 || Math.random() < 0.72) {
            minute = organicMinute();
            const hourPart = Math.floor(total / 60) * 60;
            total = hourPart + minute;
            if (total < b.startMin) total = b.startMin + minute % Math.min(40, span);
            if (total >= b.endMin) total = b.endMin - 1 - (minute % Math.min(25, span));
            // final minute still organic if we slid onto a round
            if (total % 60 === 0 || (total % 60) % 15 === 0) {
                total = Math.floor(total / 60) * 60 + organicMinute();
                if (total >= b.endMin) total = b.endMin - organicMinute();
                if (total < b.startMin) total = b.startMin + (organicMinute() % 20);
            }
        }
        const hour = Math.floor(((total % (24 * 60)) + 24 * 60) % (24 * 60) / 60);
        minute = ((total % 60) + 60) % 60;
        if (minute === 0) minute = organicMinute();
        return { hour, minute, label: b.label || 'later' };
    }

    /** Soft cloud around an hour hint (model arriveLocalHour) — never exact :00. */
    function pickOrganicNearHour(hour) {
        const h = ((Math.floor(Number(hour)) % 24) + 24) % 24;
        // Avoid treating midnight as a destination unless it was intentional late-night —
        // hour 0 soft-window becomes late evening / early night feel, not 12:00 AM sharp.
        if (h === 0) {
            return pickOrganicInBand(ARRIVAL_BANDS.late);
        }
        const center = h * 60;
        const band = {
            startMin: Math.max(0, center - 38),
            endMin: Math.min(24 * 60 - 1, center + 54),
            label: `around ${((h + 11) % 12) + 1}${h >= 12 ? 'pm' : 'am'}`
        };
        if (band.endMin - band.startMin < 20) {
            band.startMin = center;
            band.endMin = Math.min(24 * 60 - 1, center + 45);
        }
        return pickOrganicInBand(band);
    }

    /**
     * Sim ms until her local clock hits hour:minute (next occurrence).
     * Uncapped for simulation — callers map to real wait separately.
     */
    function msUntilLocalHour(hour, { minute = 0, minForwardMs = 30 * 60 * 1000, organic = true } = {}) {
        const h = ((Math.floor(Number(hour)) % 24) + 24) % 24;
        let m = Math.max(0, Math.min(59, Math.floor(Number(minute) || 0)));
        // Callers that pass minute:0 still get a lived-in minute unless organic:false
        if (m === 0 && organic) m = organicMinute();
        const tz = resolveTimeZone(S()?.profile?.location);
        const nowMs = herNow().getTime();
        const earliest = nowMs + Math.max(0, Number(minForwardMs) || 0);
        const limit = earliest + 48 * 60 * 60 * 1000;
        for (let t = earliest; t < limit; t += 60 * 1000) {
            const p = getZonedParts(new Date(t), tz);
            if (p.hour === h && p.minute === m) {
                return t - nowMs;
            }
        }
        return 8 * 60 * 60 * 1000 + organicMinute() * 60 * 1000;
    }

    /**
     * Context → arrival band key (soft window), or null if no cue.
     */
    function inferArriveBand(text) {
        const s = String(text || '').toLowerCase();
        if (!s.trim()) return null;
        if (/good\s*night|לילה טוב|nighty|נרדמ|going to sleep|go to sleep|talk tomorrow|speak tomorrow|מחר|tomorrow morning|next morning|next day|tomorrow/.test(s)) {
            return 'morning';
        }
        if (/office|work|משרד|עבודה|commute|job|shift/.test(s)) return 'work_morning';
        if (/morning|בבוקר|wake up|waking|בוקר טוב|just woke/.test(s)) return 'morning';
        if (/noon|midday|lunch/.test(s)) return 'midday';
        if (/afternoon|צהריים|צהרים/.test(s)) return 'afternoon';
        if (/tonight|evening|הערב|night out|dinner/.test(s)) return 'evening';
        if (/\blate\b|can't sleep|cant sleep/.test(s)) return 'late';
        return null;
    }

    /**
     * Infer a typical hour (compat). Prefer inferArriveBand + organic pick.
     * @returns {number|null}
     */
    function inferArriveLocalHour(text) {
        const band = inferArriveBand(text);
        if (!band || !ARRIVAL_BANDS[band]) return null;
        const b = ARRIVAL_BANDS[band];
        return Math.floor((b.startMin + b.endMin) / 2 / 60) % 24;
    }

    /**
     * Resolve an organic local arrival from text, band key, or soft hour hint.
     * @returns {{ ms: number, hour: number, minute: number, label: string }|null}
     */
    function resolveOrganicArrival(spec, {
        minForwardMs = 45 * 60 * 1000,
        maxMs = null,
        allowDayWrap = true
    } = {}) {
        let picked = null;
        if (spec == null || spec === '') return null;
        if (typeof spec === 'number' && Number.isFinite(spec)) {
            picked = pickOrganicNearHour(spec);
        } else if (typeof spec === 'string' && ARRIVAL_BANDS[spec]) {
            picked = pickOrganicInBand(spec);
        } else if (typeof spec === 'string') {
            const band = inferArriveBand(spec);
            if (band) picked = pickOrganicInBand(band);
        } else if (spec && typeof spec === 'object') {
            if (spec.band && ARRIVAL_BANDS[spec.band]) picked = pickOrganicInBand(spec.band);
            else if (Number.isFinite(spec.hour)) picked = pickOrganicNearHour(spec.hour);
        }
        if (!picked) return null;
        const ms = msUntilLocalHour(picked.hour, {
            minute: picked.minute,
            minForwardMs,
            organic: false
        });
        if (!(ms > 0)) return null;

        // Target already passed tonight (e.g. now 11:53 → pick 11:41) wraps to tomorrow.
        // Without an intentional overnight jump that reads as time going BACKWARDS in the UI.
        if (!allowDayWrap && isApparentClockRewind(ms)) return null;
        if (maxMs != null && ms > maxMs) return null;

        return {
            ms,
            hour: picked.hour,
            minute: picked.minute,
            label: picked.label || 'later'
        };
    }

    /** True when a forward jump lands on an earlier clock-face (next-day wrap). */
    function isApparentClockRewind(advanceMs) {
        const ms = Number(advanceMs) || 0;
        if (ms < 6 * 60 * 60 * 1000) return false;
        const tz = resolveTimeZone(S()?.profile?.location);
        const now = getZonedParts(herNow(), tz);
        const land = getZonedParts(new Date(herNow().getTime() + ms), tz);
        const nowMins = now.hour * 60 + now.minute;
        const landMins = land.hour * 60 + land.minute;
        // Long jump that lands earlier on the 12h face than we are now
        if (ms >= 12 * 60 * 60 * 1000 && landMins + 5 < nowMins) return true;
        return ms >= 20 * 60 * 60 * 1000;
    }

    function looksLikeOvernightIntent(text) {
        const s = String(text || '').toLowerCase();
        return /tomorrow|next day|next morning|מחר|good\s*night|לילה טוב|going to sleep|go to sleep|נרדמ|woke up|wake up|overnight|slept|sleep it off/.test(s);
    }

    /** Nudge a raw duration so landing clock rarely hits :00 / :30. */
    function organicizeAdvanceMs(rawMs, { allowDayJump = false } = {}) {
        const raw = Math.max(0, Number(rawMs) || 0);
        let ms = Math.max(60 * 1000, raw);
        // Jitter scales with skip size — never turn a 3-min beat into a multi-hour jump
        const rawMin = ms / 60000;
        const jitterHi = Math.min(28, Math.max(1, Math.round(rawMin * 0.2)));
        const jitterLo = Math.min(16, jitterHi);
        ms += randInt(-jitterLo, jitterHi) * 60 * 1000;
        ms = Math.max(60 * 1000, ms);

        const tz = resolveTimeZone(S()?.profile?.location);
        const land = getZonedParts(new Date(herNow().getTime() + ms), tz);

        // Only scene-scale skips may snap out of the dead of night / midnight
        if (allowDayJump && land.hour >= 1 && land.hour < 7) {
            const morning = resolveOrganicArrival('morning', {
                minForwardMs: 40 * 60 * 1000,
                allowDayWrap: true
            });
            if (morning) return morning.ms;
        }
        if (allowDayJump && land.hour === 0 && land.minute <= 20) {
            const late = resolveOrganicArrival('late', {
                minForwardMs: 20 * 60 * 1000,
                allowDayWrap: false,
                maxMs: 3 * 60 * 60 * 1000
            });
            if (late) return late.ms;
            const morning = resolveOrganicArrival('morning', {
                minForwardMs: 40 * 60 * 1000,
                allowDayWrap: true
            });
            if (morning) return morning.ms;
        }
        if (land.minute === 0 || land.minute === 30 || (land.minute % 15 === 0 && Math.random() < 0.9)) {
            ms += Math.max(1, organicMinute() % 17) * 60 * 1000;
        }
        // Never invent a day-wrap from a short raw skip
        if (!allowDayJump && isApparentClockRewind(ms)) {
            return Math.max(60 * 1000, raw);
        }
        return ms;
    }

    /** Recent chat blob for scene-jump context (user + AI lines). */
    function recentChatContext(sess, extraText) {
        const bits = [];
        const hist = Array.isArray(sess?.history) ? sess.history : [];
        hist.slice(-6).forEach(h => {
            if (h?.user) bits.push(String(h.user));
            if (h?.ai) bits.push(String(h.ai));
        });
        if (sess?._lastUserInput) bits.push(String(sess._lastUserInput));
        if (extraText) bits.push(String(extraText));
        return bits.join('\n');
    }

    /**
     * How far to advance for /next scene (and similar beats).
     * Operator hint → organic arrival. Bare /next scene → next routine beat.
     * Do not scan AI captions for "work"/"morning" — that felt like random jumps.
     */
    function resolveSceneJumpAdvanceMs(sess, extraText) {
        const hint = String(extraText || '').replace(/^\/next\s+scene\b/i, '').trim();
        if (hint && !/^\/next\b/i.test(hint)) {
            const organic = resolveOrganicArrival(hint, {
                minForwardMs: 25 * 60 * 1000,
                allowDayWrap: true
            });
            if (organic) return organic.ms;
        }
        const jump = global.MirageRoutine?.resolveNextSceneJump?.(sess, hint);
        if (jump?.ms > 0) return jump.ms;

        const hour = getZonedParts(herNow(), resolveTimeZone(S()?.profile?.location)).hour;
        if (hour >= 22 || hour < 7) {
            const morning = resolveOrganicArrival('morning', {
                minForwardMs: 45 * 60 * 1000,
                allowDayWrap: true
            });
            if (morning) return morning.ms;
        }
        return organicizeAdvanceMs(75 * 60 * 1000, { allowDayJump: false });
    }

    function localHourNow() {
        const tz = resolveTimeZone(S()?.profile?.location);
        return getZonedParts(herNow(), tz).hour;
    }

    function timeOfDayBand(hour) {
        const h = ((Number(hour) % 24) + 24) % 24;
        if (h >= 5 && h < 8) return 'dawn';
        if (h >= 8 && h < 11) return 'morning';
        if (h >= 11 && h < 16) return 'midday';
        if (h >= 16 && h < 18) return 'afternoon';
        if (h >= 18 && h < 20) return 'dusk';
        if (h >= 20 && h < 22) return 'evening';
        return 'night';
    }

    function lightingForBand(band) {
        switch (band) {
            case 'dawn':
                return 'pre-dawn / early morning, cool blue window light, dim interior, no harsh midday sun';
            case 'morning':
                return 'morning daylight through windows, sun climbing, indoor ambient, not nighttime';
            case 'midday':
                return 'bright midday daylight, sun high, strong window light, no sunset, no night sky';
            case 'afternoon':
                return 'late afternoon daylight, warmer sun lower in the sky, not night';
            case 'dusk':
                return 'dusk, fading daylight, indoor lamps coming on, no bright noon sunbeams';
            case 'evening':
                return 'evening interior lighting, windows dark or weak city glow, NO daylight, NO sunbeams through shutters';
            default:
                return 'nighttime interior lamps / phone screen glow, windows fully dark, NO sunlight, NO daytime sky';
        }
    }

    function timeOfDayLock() {
        const tz = resolveTimeZone(S()?.profile?.location);
        const now = herNow();
        const hour = getZonedParts(now, tz).hour;
        const band = timeOfDayBand(hour);
        const clock = formatClock(now, tz);
        const night = band === 'evening' || band === 'night';
        return {
            hour,
            band,
            clock,
            tz,
            lighting: lightingForBand(band),
            night,
            line: `TIME OF DAY LOCK: her local clock is ${clock} (${band}). `
                + (night
                    ? 'Windows must be DARK. Forbidden: sunlight, sunbeams through shutters, blue daylight sky, golden-hour sun, daytime exterior.'
                    : `Window and outdoor light must match ${band}. Forbidden: night-black windows or the wrong sun position.`)
        };
    }

    function applyTimeOfDayToDirective(directive) {
        const d = directive && typeof directive === 'object' ? { ...directive } : {};
        const lock = timeOfDayLock();
        d.lighting = lock.lighting;
        d.timeOfDay = `${lock.clock} ${lock.band}`;
        return d;
    }

    /** Force bezel + presence chrome to match herNow() after any clock jump. */
    function syncClockChrome() {
        try {
            updateChrome();
        } catch { /* ignore */ }
        try {
            global.MirageSimulation?.refreshChatTimestamps?.();
        } catch { /* ignore */ }
    }

    /** Clear phone-realism fields when starting / switching chats. */
    function resetSessionFields(session) {
        if (!session) return;
        session.clockOffsetMs = 0;
        session.lastSeenAt = null;
        session.lastUserMessageAt = null;
        session.lastAiMessageAt = null;
        session.lastReplyLagMs = null;
        session.lastAttendedWallMs = Date.now();
        session.catchUpForMessageAt = null;
        session.clockResumeHold = null;
        session.clockMayLagStamps = false;
        session.presence = 'idle';
        session._lastChatStampMs = 0;
    }

    /**
     * @param {{ deferOpen?: boolean }} [opts]
     * deferOpen — real-time mode: stay on Delivered; immersion marks Seen later.
     * skipReceipts — god-mode commands: no Delivered/Seen chrome (commands are instant).
     */
    function onTurnStart({ deferOpen = false, skipReceipts = false } = {}) {
        const gen = ++turnGen;
        markAllAiRead(); // operator sent → they've seen her prior messages
        try {
            global.MirageImmersion?.clearSocialHold?.();
            global.MirageImmersion?.clearNoReplyWatch?.();
        } catch { /* ignore */ }
        if (skipReceipts) {
            updateChrome();
            return;
        }
        markUserDelivered();
        if (!deferOpen) {
            setTimeout(() => {
                if (gen !== turnGen) return;
                markAllUserSeen();
            }, 80);
        }
        updateChrome();
    }

    function onTurnEnd() {
        const gen = ++turnGen;
        showTyping(false);
        setPresence('active');
        // Seen if he's on the sim; either way start the 3-minute no-reply clock.
        // Aftermath (ditch / follow-up / Story) if he doesn't respond — Unread tag only if still away.
        if (operatorAttendingChat()) {
            markAllAiRead();
        }
        try {
            global.MirageImmersion?.armNoReplyWatch?.();
        } catch { /* ignore */ }
        updateChrome();
        // Fade back to last-seen after a short "Active now" window
        setTimeout(() => {
            if (gen !== turnGen) return;
            if (S()?.session?.presence === 'active') setPresence('idle');
        }, 45 * 1000);
    }

    function onTurnCancel() {
        turnGen += 1;
        showTyping(false);
        setPresence('idle');
        lastUserReceiptEl = null;
        updateChrome();
    }

    function bind() {
        updateChrome();
        if (clockTimer) clearInterval(clockTimer);
        clockTimer = setInterval(updateChrome, 30 * 1000);
        // Focusing the composer marks her messages read
        document.getElementById('simInput')?.addEventListener('focus', () => {
            onOperatorAttending();
        });
        document.getElementById('chatLog')?.addEventListener('click', () => {
            if (operatorAttendingChat()) onOperatorAttending();
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && operatorAttendingChat()) {
                onOperatorAttending();
            }
        });
    }

    /**
     * Story Shuffle: jump her sim clock to a random lived-in local time-of-day
     * (still in her timezone) so the opener is not locked to wall-clock "now".
     * Story Sync (B1) leaves the clock alone.
     */
    function jumpToRandomLocalTime({ minForwardMs = 45 * 60 * 1000 } = {}) {
        const tz = resolveTimeZone(S()?.profile?.location);
        const nowParts = getZonedParts(herNow(), tz);
        const nowMin = nowParts.hour * 60 + nowParts.minute;
        const entries = Object.entries(ARRIVAL_BANDS);
        const other = entries.filter(([, b]) => !(nowMin >= b.startMin && nowMin < b.endMin));
        const pool = other.length ? other : entries;
        const [bandKey] = pool[randInt(0, pool.length - 1)];
        const organic = resolveOrganicArrival(bandKey, {
            minForwardMs: Math.max(15 * 60 * 1000, Number(minForwardMs) || 0),
            allowDayWrap: true
        });
        if (!organic?.ms) return null;
        advanceClock(organic.ms);
        return {
            band: bandKey,
            hour: organic.hour,
            minute: organic.minute,
            label: organic.label || bandKey,
            ms: organic.ms,
            clock: formatClock(herNow(), tz)
        };
    }

    global.MiragePhoneUX = {
        bind,
        updateChrome,
        resolveTimeZone,
        inferTimeZoneFromLocation,
        isValidTimeZone,
        browserTimeZone,
        herNow,
        formatClock,
        formatClockLong,
        formatClockArrow,
        latestSimStampMs,
        latestTranscriptStampMs,
        ensureClockNotBehindStamps,
        userTimeZone,
        instantForZonedParts,
        setClockToInstant,
        estimateDirectiveAdvanceMs,
        formatLastSeen,
        setPresence,
        showTyping,
        onTurnStart,
        onTurnEnd,
        onTurnCancel,
        advanceClock,
        advanceClockByDuration,
        jumpToRandomLocalTime,
        parseDuration,
        parseDurationMs,
        getZonedParts,
        calendarDaysAgo,
        localHourAtOffset,
        msUntilLocalHour,
        inferArriveBand,
        inferArriveLocalHour,
        resolveOrganicArrival,
        organicizeAdvanceMs,
        isApparentClockRewind,
        looksLikeOvernightIntent,
        recentChatContext,
        resolveSceneJumpAdvanceMs,
        syncClockChrome,
        localHourNow,
        timeOfDayBand,
        lightingForBand,
        timeOfDayLock,
        applyTimeOfDayToDirective,
        resetSessionFields,
        markUserDelivered,
        markUserSeen,
        markAllUserSeen,
        restoreUserReceipts,
        markUserOpened,
        markUserReaction,
        markAiUnread,
        markAllAiRead,
        operatorAttendingChat,
        onOperatorAttending
    };
})(typeof window !== 'undefined' ? window : globalThis);
