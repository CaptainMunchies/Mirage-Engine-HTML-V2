/**
 * MIRAGE ENGINE v2 — Developer debug panel (visible when Developer Mode is on)
 */
(function (global) {
    'use strict';

    const S = () => EngineState;
    /** Persist / keep only the last N turns of DEV log. Plenty for a paste-into-Cursor report. */
    const DEV_TURN_CAP = 10;
    const NOTICE_CAP = DEV_TURN_CAP * 18;
    const NOTICE_STORE = 'mirage_v2_dev_notice_log';
    const TRACE_CAP = DEV_TURN_CAP;
    const DUMP_TURN_MAX = 40;

    let lastTurnDebug = null;
    let lastPromptDebug = null;
    let immersionPoll = null;
    let scopeKey = '';
    let noticeLog = [];
    let unreadNotices = 0;
    let turnTrace = [];
    let turnTraceByScope = {};
    let currentTurnSeq = 0;
    let runtimeFaults = [];

    function engineNowMs() {
        if (typeof MirageImmersion?.simNowMs === 'function') {
            try { return MirageImmersion.simNowMs(); } catch { /* fall through */ }
        }
        try {
            const t = MiragePhoneUX?.herNow?.()?.getTime?.();
            if (Number.isFinite(t)) return t;
        } catch { /* fall through */ }
        return Date.now() + (Number(S()?.session?.clockOffsetMs) || 0);
    }

    function hydrateTurnSeq() {
        currentTurnSeq = noticeLog.reduce((m, n) => Math.max(m, Number(n?.turnSeq) || 0), 0);
    }

    /** Start a new DEV-log turn cluster (operator beat / executeTurn). */
    function beginDevTurn() {
        syncChatScope();
        currentTurnSeq += 1;
        return currentTurnSeq;
    }

    function currentScopeKey() {
        const charId = (typeof MirageChatStore?.characterKey === 'function'
            ? MirageChatStore.characterKey(S())
            : null) || S()?.activeCharacterId || '_';
        const chatId = S()?.session?.activeChatId;
        if (!chatId) return `${charId}::__idle`;
        return `${charId}::${chatId}`;
    }

    function currentChatId() {
        return S()?.session?.activeChatId || null;
    }

    function readStorage(store, key) {
        try {
            const raw = store.getItem(key);
            const data = raw ? JSON.parse(raw) : {};
            if (data && typeof data === 'object' && !Array.isArray(data)) return data;
            return {};
        } catch {
            return {};
        }
    }

    function loadAllNoticeBuckets() {
        const local = readStorage(localStorage, NOTICE_STORE);
        const session = readStorage(sessionStorage, NOTICE_STORE);
        const keys = new Set([...Object.keys(local), ...Object.keys(session)]);
        if (!keys.size) return {};
        const merged = {};
        keys.forEach((k) => {
            merged[k] = normalizeDump(session[k] || local[k]);
            if (local[k] && session[k]) {
                const a = normalizeDump(local[k]);
                const b = normalizeDump(session[k]);
                const notices = [...(b.notices || []), ...(a.notices || [])];
                const seen = new Set();
                merged[k] = {
                    notices: notices.filter((n) => {
                        const id = `${n?.at}|${n?.kind}|${n?.summary}`;
                        if (seen.has(id)) return false;
                        seen.add(id);
                        return true;
                    }).slice(0, NOTICE_CAP),
                    lastTurn: compactLastTurn(b.lastTurn || a.lastTurn),
                    lastPrompt: compactLastPrompt(b.lastPrompt || a.lastPrompt),
                    turnTrace: ((b.turnTrace?.length ? b.turnTrace : a.turnTrace) || []).slice(0, TRACE_CAP)
                };
            }
        });
        return merged;
    }

    function normalizeDump(raw) {
        if (Array.isArray(raw)) {
            return { notices: raw, lastTurn: null, lastPrompt: null, turnTrace: [] };
        }
        if (raw && typeof raw === 'object') {
            return {
                notices: Array.isArray(raw.notices) ? raw.notices.slice(0, NOTICE_CAP) : [],
                lastTurn: raw.lastTurn || null,
                lastPrompt: raw.lastPrompt || null,
                turnTrace: Array.isArray(raw.turnTrace) ? raw.turnTrace.slice(0, TRACE_CAP) : []
            };
        }
        return { notices: [], lastTurn: null, lastPrompt: null, turnTrace: [] };
    }

    function persistBuckets(buckets) {
        const slim = {};
        Object.keys(buckets || {}).forEach((k) => {
            const d = normalizeDump(buckets[k]);
            slim[k] = {
                notices: (d.notices || []).slice(0, NOTICE_CAP),
                lastTurn: compactLastTurn(d.lastTurn),
                lastPrompt: compactLastPrompt(d.lastPrompt),
                turnTrace: (d.turnTrace || []).slice(0, TRACE_CAP).map(compactLastTurn).filter(Boolean)
            };
        });
        try {
            localStorage.setItem(NOTICE_STORE, JSON.stringify(slim));
            try { sessionStorage.removeItem(NOTICE_STORE); } catch { /* ignore */ }
        } catch { /* ignore quota */ }
    }

    function oldestKeptTurnAt(traces) {
        const kept = (traces || []).slice(0, TRACE_CAP);
        if (!kept.length) return null;
        const last = kept[kept.length - 1];
        const t = Number(last?.traceAt || last?.historyAt);
        if (Number.isFinite(t)) return t;
        const at = Date.parse(last?.at);
        return Number.isFinite(at) ? at : null;
    }

    function trimDevLog() {
        if (turnTrace.length > TRACE_CAP) turnTrace.length = TRACE_CAP;
        const oldest = oldestKeptTurnAt(turnTrace);
        if (oldest != null) {
            noticeLog = noticeLog.filter((n) => {
                const at = Number(n?.at);
                if (!Number.isFinite(at)) return true;
                return at >= oldest - 15000;
            });
        }
        if (noticeLog.length > NOTICE_CAP) noticeLog.length = NOTICE_CAP;
    }

    function scopeDump() {
        trimDevLog();
        return {
            notices: noticeLog.slice(0, NOTICE_CAP),
            lastTurn: compactLastTurn(lastTurnDebug),
            lastPrompt: compactLastPrompt(lastPromptDebug),
            turnTrace: turnTrace.slice(0, TRACE_CAP).map(compactLastTurn).filter(Boolean)
        };
    }

    function compactLastTurn(t) {
        if (!t || typeof t !== 'object') return null;
        const parsed = t.parsed && typeof t.parsed === 'object'
            ? {
                tracking: t.parsed.tracking || null,
                imageDirective: t.parsed.imageDirective || null,
                characterResponse: t.parsed.characterResponse || t.parsed.message || null
            }
            : null;
        return {
            at: t.at || null,
            historyAt: t.historyAt || null,
            traceAt: t.traceAt || null,
            userInput: t.userInput || null,
            parsed,
            failed: !!t.failed,
            error: t.error || null,
            errorCode: t.errorCode || null,
            rawPreview: t.rawPreview || null,
            chatError: t.chatError || null,
            toast: t.toast || null,
            imageFailed: !!t.imageFailed,
            imageSkipped: !!t.imageSkipped,
            imageFailReason: t.imageFailReason || null,
            commandInject: t.commandInject || null,
            chatId: t.chatId || null,
            thinkingModel: t.thinkingModel || null,
            imageModel: t.imageModel || null,
            godMode: !!t.godMode
        };
    }

    function compactLastPrompt(p) {
        if (!p || typeof p !== 'object') return null;
        return {
            at: p.at || null,
            faceRecovery: !!p.faceRecovery,
            soft: !!p.soft,
            references: Array.isArray(p.references) ? p.references.slice(0, 8) : [],
            imageSystem: clip(p.imageSystem, 2400),
            imagePrompt: clip(p.imagePrompt, 2400),
            chatId: p.chatId || null
        };
    }

    function scopedNotices(list) {
        const chatId = currentChatId();
        const rows = Array.isArray(list) ? list : [];
        if (!chatId) return rows.filter(d => !d.chatId);
        return rows.filter(d => !d.chatId || d.chatId === chatId);
    }

    function belongsToOpenChat(stamp) {
        if (!stamp) return false;
        const chatId = currentChatId();
        if (!chatId) return !stamp.chatId;
        return stamp.chatId === chatId;
    }

    /** Swap DEV log + last-turn dumps to the open chat. Call after chat/character switches. */
    function syncChatScope() {
        const next = currentScopeKey();
        if (next === scopeKey && noticeLog) {
            noticeLog = scopedNotices(noticeLog);
            if (!lastTurnDebug) hydrateLastTurnFromHistory();
            return;
        }
        const buckets = loadAllNoticeBuckets();
        if (scopeKey) {
            buckets[scopeKey] = scopeDump();
            turnTraceByScope[scopeKey] = turnTrace.slice(0, TRACE_CAP);
        }
        scopeKey = next;
        const dump = normalizeDump(buckets[next]);
        noticeLog = scopedNotices(dump.notices || []);
        lastTurnDebug = dump.lastTurn || null;
        lastPromptDebug = dump.lastPrompt || null;
        turnTrace = Array.isArray(dump.turnTrace) && dump.turnTrace.length
            ? dump.turnTrace.slice(0, TRACE_CAP)
            : (Array.isArray(turnTraceByScope[next]) ? turnTraceByScope[next].slice(0, TRACE_CAP) : []);
        hydrateTurnSeq();
        if (!lastTurnDebug) hydrateLastTurnFromHistory();
        trimDevLog();
        buckets[next] = scopeDump();
        persistBuckets(buckets);
        unreadNotices = 0;
        if (lastTurnDebug && !belongsToOpenChat(lastTurnDebug)) lastTurnDebug = null;
        if (lastPromptDebug && !belongsToOpenChat(lastPromptDebug)) lastPromptDebug = null;
        if (S()?.developerMode) {
            renderDecisions();
            syncUnreadBadge();
        }
    }

    function hydrateLastTurnFromHistory() {
        if (lastTurnDebug) return;
        const hist = S()?.session?.history;
        if (!Array.isArray(hist) || !hist.length) return;
        let last = null;
        for (let i = hist.length - 1; i >= 0; i--) {
            const h = hist[i];
            if (!h || String(h.user || '').trim() === '[continued]') continue;
            last = h;
            break;
        }
        if (!last) return;
        lastTurnDebug = {
            at: last.debug?.at || (last.at ? new Date(last.at).toISOString() : new Date().toISOString()),
            historyAt: last.at || null,
            userInput: last.user || null,
            parsed: {
                tracking: last.tracking || null,
                imageDirective: last.imageDirective || last.debug?.imageDirective || null,
                characterResponse: last.ai || null
            },
            imageFailed: !!last.debug?.imageFailed,
            imageSkipped: !!last.debug?.imageSkipped,
            imageFailReason: last.debug?.imageFailReason || null,
            commandInject: last.debug?.commandInject || null,
            chatId: currentChatId(),
            restored: true,
            ...(last.debug || {})
        };
        if (!lastPromptDebug && last.debug?.imagePromptClip) {
            lastPromptDebug = {
                at: lastTurnDebug.at,
                references: last.debug.imageRefs || [],
                imageSystem: '',
                imagePrompt: last.debug.imagePromptClip,
                chatId: currentChatId(),
                restored: true
            };
        }
    }

    function saveNotices() {
        const buckets = loadAllNoticeBuckets();
        const key = scopeKey || currentScopeKey();
        scopeKey = key;
        buckets[key] = scopeDump();
        persistBuckets(buckets);
    }

    function panelEl() {
        return document.getElementById('debugPanel');
    }

    function setVisible(show) {
        const panel = panelEl();
        if (panel) panel.hidden = !show;
        const btn = document.getElementById('btnToggleDebug');
        if (btn) btn.hidden = !show;
        if (show) {
            unreadNotices = 0;
            syncUnreadBadge();
        }
        syncImmersionPoll();
    }

    function panelIsOpen() {
        const panel = panelEl();
        return !!(panel && !panel.hidden);
    }

    function syncUnreadBadge() {
        const badge = document.getElementById('debugUnreadBadge');
        if (!badge) return;
        if (!S()?.developerMode || unreadNotices <= 0) {
            badge.hidden = true;
            badge.textContent = '';
            return;
        }
        badge.hidden = false;
        badge.textContent = unreadNotices > 99 ? '99+' : String(unreadNotices);
    }

    function setLastTurn(data) {
        lastTurnDebug = data
            ? { ...data, chatId: currentChatId(), traceAt: Date.now() }
            : null;
        if (lastTurnDebug) {
            turnTrace.unshift(lastTurnDebug);
            trimDevLog();
        }
        saveNotices();
        if (S().developerMode) refresh();
    }

    /** Exact system instruction + prompt handed to the image model on the last render. */
    function setLastPrompt(data) {
        lastPromptDebug = data
            ? { ...data, chatId: currentChatId() }
            : null;
        saveNotices();
        if (S().developerMode) refresh();
    }

    function pushNotice(evt) {
        if (!evt) return;
        syncChatScope();
        const summary = String(evt.summary || evt.body || evt.kind || '').trim();
        if (!summary) return;
        const entry = {
            at: Number(evt.at) || Date.now(),
            engineAt: Number(evt.engineAt) || engineNowMs(),
            turnSeq: Number.isFinite(Number(evt.turnSeq))
                ? Number(evt.turnSeq)
                : (currentTurnSeq || 0),
            kind: evt.kind || 'notice',
            tone: evt.tone || 'info',
            summary,
            detail: evt.detail || null,
            creditsLabel: evt.creditsLabel || null,
            creditsEst: !!evt.creditsEst,
            chatId: currentChatId()
        };
        const prev = noticeLog[0];
        if (entry.kind !== 'spend' && prev && prev.summary === entry.summary && prev.kind === entry.kind
            && (entry.at - prev.at) < 800) {
            return;
        }
        noticeLog.unshift(entry);
        trimDevLog();
        saveNotices();
        if (S()?.developerMode) {
            if (!panelIsOpen()) unreadNotices += 1;
            renderDecisions();
            syncUnreadBadge();
        }
    }

    function pushDecision(evt) {
        if (!evt) return;
        pushNotice({
            kind: evt.kind || 'decision',
            summary: evt.summary || evt.kind || 'decision',
            detail: evt.detail || null,
            tone: 'info'
        });
    }

    function clearNotices() {
        noticeLog = [];
        unreadNotices = 0;
        currentTurnSeq = 0;
        saveNotices();
        renderDecisions();
        syncUnreadBadge();
    }

    function forgetChatScope(charKey, chatId) {
        if (!charKey || !chatId) return;
        const key = `${charKey}::${chatId}`;
        const buckets = loadAllNoticeBuckets();
        delete buckets[key];
        persistBuckets(buckets);
        if (scopeKey === key) {
            noticeLog = [];
            unreadNotices = 0;
            currentTurnSeq = 0;
            lastTurnDebug = null;
            lastPromptDebug = null;
            turnTrace = [];
            scopeKey = '';
            renderDecisions();
            syncUnreadBadge();
        }
        delete turnTraceByScope[key];
    }

    function safeJson(obj) {
        try {
            return JSON.stringify(obj, null, 2);
        } catch {
            return String(obj);
        }
    }

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function fmtDuration(ms) {
        if (ms == null || !Number.isFinite(Number(ms))) return '—';
        const n = Number(ms);
        if (n <= 0) return '0s';
        if (typeof MirageImmersion?.formatDuration === 'function') {
            return MirageImmersion.formatDuration(n);
        }
        const sec = Math.round(n / 1000);
        if (sec < 60) return `${sec}s`;
        return `${Math.round(sec / 60)} min`;
    }

    function fmtWallTime(at) {
        if (at == null || !Number.isFinite(Number(at))) return '—';
        return new Date(Number(at)).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function fmtEngineTime(at) {
        if (at == null || !Number.isFinite(Number(at))) return '';
        const date = new Date(Number(at));
        const tz = MiragePhoneUX?.resolveTimeZone?.(S()?.profile?.location);
        const clock = typeof MiragePhoneUX?.formatClock === 'function'
            ? MiragePhoneUX.formatClock(date, tz)
            : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        let day = '';
        try {
            day = new Intl.DateTimeFormat('en-US', {
                ...(tz ? { timeZone: tz } : {}),
                weekday: 'short'
            }).format(date);
        } catch {
            day = date.toLocaleDateString([], { weekday: 'short' });
        }
        return day ? `${clock} ${day}` : clock;
    }

    function isTurnStartNotice(d) {
        const kind = String(d?.kind || '');
        if (kind === 'world_skip') return true;
        const s = String(d?.summary || '');
        return /^(Scene jump|Jump —|Time pass|World skip|Scene jump queued|Jump queued)/i.test(s);
    }

    /** Newest-first rows → clusters that belong to one engine beat. */
    function groupNotices(rows) {
        const groups = [];
        (Array.isArray(rows) ? rows : []).forEach((d) => {
            const seq = Number.isFinite(Number(d?.turnSeq)) && Number(d.turnSeq) > 0
                ? Number(d.turnSeq)
                : null;
            const last = groups[groups.length - 1];
            const sameSeq = last && !last.closed && last.seq != null && seq != null && last.seq === seq;
            const unseqContinue = last && !last.closed && last.seq == null && seq == null
                && !isTurnStartNotice(d);
            if (sameSeq || unseqContinue) {
                last.items.push(d);
                return;
            }
            if (last && !last.closed && last.seq == null && seq == null && isTurnStartNotice(d)) {
                last.items.push(d);
                last.closed = true;
                return;
            }
            groups.push({ seq, items: [d], closed: false });
        });
        return groups;
    }

    function noticeTimeHtml(d) {
        const wall = fmtWallTime(d.at);
        const engine = d.engineAt ? fmtEngineTime(d.engineAt) : '';
        return `<span class="dbg-decision-time" title="Wall clock">${escapeHtml(wall)}</span>`
            + (engine
                ? `<span class="dbg-decision-engine" title="Her sim clock">${escapeHtml(engine)}</span>`
                : '');
    }

    function noticeTimeText(d) {
        const wall = fmtWallTime(d.at);
        const engine = d.engineAt ? fmtEngineTime(d.engineAt) : '';
        return engine ? `${wall} / ${engine}` : wall;
    }

    function fmtClock(at) {
        if (at == null || !Number.isFinite(Number(at))) return '—';
        const date = new Date(Number(at));
        const tz = MiragePhoneUX?.resolveTimeZone?.(S().profile?.location);
        if (typeof MiragePhoneUX?.formatClock === 'function') {
            return MiragePhoneUX.formatClock(date, tz);
        }
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    function fmtAgo(at) {
        if (at == null || !Number.isFinite(Number(at))) return '—';
        const now = typeof MirageImmersion?.simNowMs === 'function'
            ? MirageImmersion.simNowMs()
            : Date.now();
        const delta = Math.max(0, now - Number(at));
        return `${fmtDuration(delta)} ago`;
    }

    function clip(text, max = 400) {
        const s = String(text ?? '').replace(/\s+/g, ' ').trim();
        if (!s) return '—';
        if (s.length <= max) return s;
        return `${s.slice(0, max - 1)}…`;
    }

    function clipKeep(text, max = 4000) {
        const s = String(text ?? '').trim();
        if (!s) return '—';
        if (s.length <= max) return s;
        return `${s.slice(0, max - 1)}…`;
    }

    function fenceBlock(body, max = 4000) {
        const s = clipKeep(body, max);
        if (s === '—') return '—';
        return `\`\`\`\n${s}\n\`\`\``;
    }

    function line(label, value) {
        const v = value == null || value === '' ? '—' : String(value);
        return `- **${label}:** ${v}`;
    }

    function formatOutfitWithSource(outfit, source) {
        const o = String(outfit || '').trim() || '—';
        if (o === '—') return o;
        if (source === 'library-still') return `${o} (library still)`;
        if (source === 'library') return `${o} (library ref)`;
        if (source === 'invented') return `${o} (invented)`;
        return o;
    }

    function detectCacheBump() {
        try {
            const scripts = Array.from(document.querySelectorAll('script[src*="js/"]'));
            const hit = scripts.map(s => (s.getAttribute('src') || '').match(/[?&]v=([^&]+)/)).find(Boolean);
            return hit ? hit[1] : 'unknown';
        } catch {
            return 'unknown';
        }
    }

    function pill(text, tone = '') {
        return `<span class="dbg-pill${tone ? ` dbg-pill-${tone}` : ''}">${escapeHtml(text)}</span>`;
    }

    function row(label, valueHtml) {
        return `<div class="dbg-row"><span class="dbg-label">${escapeHtml(label)}</span><span class="dbg-value">${valueHtml}</span></div>`;
    }

    function heatBars(heat) {
        const h = Math.max(0, Math.min(5, Math.round(Number(heat) || 0)));
        let html = '<span class="dbg-heat" title="chat heat 0–5">';
        for (let i = 1; i <= 5; i += 1) {
            html += `<i class="${i <= h ? 'on' : ''}"></i>`;
        }
        html += `<span class="dbg-heat-n">${h}/5</span></span>`;
        return html;
    }

    function presenceTone(band) {
        const b = String(band || '').toLowerCase();
        if (b === 'hot') return 'hot';
        if (b === 'warm') return 'warm';
        if (b === 'cool') return 'cool';
        if (b === 'cold') return 'cold';
        return '';
    }

    function renderDecisionRow(d) {
        if (d?.kind === 'turn') return '';
        const tone = d.tone === 'error' ? 'cold' : (d.tone === 'ok' ? 'on' : 'muted');
        const spendTone = d.creditsEst ? 'muted' : 'spend';
        const cr = d.creditsLabel ? pill(d.creditsLabel, spendTone) : '';
        const extra = d.kind === 'image' && d.detail?.refs
            ? ` <span class="dbg-decision-extra">${escapeHtml((d.detail.refs || []).join(', '))}</span>`
            : '';
        return `<div class="dbg-decision">
                ${noticeTimeHtml(d)}
                ${pill(d.kind, tone)}
                ${cr}
                <span class="dbg-decision-summary">${escapeHtml(d.summary)}${extra}</span>
            </div>`;
    }

    function metaChip(text) {
        const t = String(text || '').trim();
        if (!t) return '';
        return `<span class="dbg-turn-chip">${escapeHtml(t)}</span>`;
    }

    function renderTurnSummary(items) {
        const turns = (items || []).filter((d) => d?.kind === 'turn');
        const open = turns.find((d) => d.detail?.phase === 'open') || null;
        const close = turns.find((d) => d.detail?.phase === 'close') || null;
        if (!open && !close) return '';
        const o = open?.detail || {};
        const c = close?.detail || {};
        const input = String(o.input || '').trim();
        const reply = String(c.reply || '').trim()
            || (c.withheld ? '(withheld — no bubble)' : '')
            || (c.failed ? `(failed${c.error ? ` — ${c.error}` : ''})` : '');
        const shot = [c.shot, c.crop].filter(Boolean).join(' / ');
        const refs = Array.isArray(c.refs) && c.refs.length ? c.refs.join(', ') : '';
        const scene = [c.outfit, c.env].filter(Boolean).join(' → ');
        const lookSrc = (c.outfitSource === 'library' || c.outfitSource === 'library-still')
            ? 'look:library'
            : (c.outfitSource === 'invented' ? 'look:invented' : '');
        const image = c.image === 'failed' ? 'photo failed'
            : c.image === 'skipped' ? 'no photo'
            : c.image === 'photo' ? 'photo ok'
            : '';
        const flags = [];
        if (o.refreshScene) flags.push('next-scene');
        if (o.godMode) flags.push('god');
        if (o.changeOutfit) flags.push('outfit-cmd');
        if (o.mustDeliver) flags.push('must-deliver');
        if (o.proactive) flags.push(o.proactiveReason || 'proactive');
        if (o.storyLaunch) flags.push('story-launch');
        if (c.withheld) flags.push(c.withheldStyle || 'withheld');
        if (c.failed) flags.push('failed');
        const chips = [
            c.mode || (o.storyLaunch ? 'STORY' : null),
            o.pacing,
            o.thinkingModel,
            shot,
            refs,
            image,
            c.style,
            lookSrc,
            scene,
            c.engagement != null ? `eng ${c.engagement}` : '',
            flags.join(' · ')
        ].map(metaChip).filter(Boolean).join('');
        return `<div class="dbg-turn-summary">
            ${input ? `<div class="dbg-turn-in">${escapeHtml(input)}</div>` : ''}
            ${reply ? `<div class="dbg-turn-out">${escapeHtml(reply)}</div>` : ''}
            ${chips ? `<div class="dbg-turn-meta">${chips}</div>` : ''}
        </div>`;
    }

    function renderDecisions() {
        const el = document.getElementById('debugDecisions');
        const countEl = document.getElementById('debugLogCount');
        const rows = scopedNotices(noticeLog);
        const groups = groupNotices(rows);
        if (countEl) {
            countEl.textContent = rows.length
                ? `(${rows.length} · ${groups.length} turn${groups.length === 1 ? '' : 's'})`
                : '';
        }
        if (!el) return;
        if (!rows.length) {
            el.innerHTML = '<p class="dbg-empty">No DEV notices yet this chat. Pins, engine notes, and spends for this simulation land here.</p>';
            return;
        }
        el.innerHTML = groups.map((g, gi) => {
            const start = g.items[g.items.length - 1];
            const engine = start?.engineAt ? fmtEngineTime(start.engineAt) : '';
            const n = g.items.filter((d) => d?.kind !== 'turn').length;
            const label = g.seq
                ? `Turn ${g.seq}`
                : `Turn ${groups.length - gi}`;
            const head = `<div class="dbg-turn-head">${escapeHtml(label)}`
                + (engine ? ` · ${escapeHtml(engine)}` : '')
                + ` · ${n} event${n === 1 ? '' : 's'}</div>`;
            const summary = renderTurnSummary(g.items);
            const body = g.items.map(renderDecisionRow).join('');
            return `<div class="dbg-turn-group">${head}${summary}${body}</div>`;
        }).join('');
    }

    function renderLiveState(snap) {
        const el = document.getElementById('debugLiveState');
        const badge = document.getElementById('debugRtBadge');
        if (!el) return;
        const mode = snap?.pacingMode
            || S().getPacingMode?.()
            || S().pacingMode
            || (S().realTimeChat ? 'realtime' : 'instant');
        if (badge) {
            badge.hidden = false;
            badge.textContent = String(mode).toUpperCase();
            badge.dataset.on = mode === 'realtime' ? '1' : '0';
        }
        const sess = S().session || {};
        const eng = Number.isFinite(Number(sess.engagement)) ? Number(sess.engagement) : 55;
        const band = MirageLoyaltyUX?.bandOf?.(eng)?.id || 'warm';
        el.innerHTML = `
            <div class="dbg-grid">
                <section class="dbg-card dbg-card-wide">
                    <h4>Session strip</h4>
                    ${row('Pacing', pill(mode, mode === 'realtime' ? 'on' : 'muted'))}
                    ${row('Max wait', escapeHtml(fmtDuration(S().realTimeMaxWaitMs || snap?.realWaitCapMs)))}
                    ${row('Quiet chase', escapeHtml(fmtDuration(S().noReplyWaitMs || snap?.noReplyWaitMs)))}
                    ${row('Engagement', `${pill(String(eng), presenceTone(band))} ${pill(band, presenceTone(band))}`)}
                    ${row('Libido (hidden)', escapeHtml(String(
                        MirageLoyaltyUX?.clampLibido?.(S().profile?.libido)
                        ?? S().profile?.libido
                        ?? '—'
                    )))}
                    ${row('Arousal', escapeHtml(String(sess.arousal ?? '—')))}
                    ${row('Thermal', escapeHtml(sess.thermal || '—'))}
                    ${row('Mood', escapeHtml(`${sess.mood || 'Neutral'} · ${sess.moodIntensity ?? 1}${sess.moodNote ? ` — ${sess.moodNote}` : ''}`))}
                    ${row('Persona / mode', escapeHtml(`${sess.persona || '—'} · ${sess.mode || '—'}`))}
                    ${row('Social hold', sess.socialHold?.kind
                        ? pill(sess.socialHold.kind, 'warn')
                        : pill('none', 'muted'))}
                </section>
            </div>
        `;
    }

    function renderImmersionBoard(snap) {
        const el = document.getElementById('debugImmersion');
        const rawEl = document.getElementById('debugImmersionRaw');
        if (!el) return;

        if (rawEl) rawEl.textContent = snap ? safeJson(snap) : 'No snapshot.';
        renderLiveState(snap);

        if (!snap) {
            el.innerHTML = '<p class="dbg-empty">Immersion snapshot unavailable.</p>';
            return;
        }

        const mode = snap.pacingMode || 'instant';
        const presence = snap.presence || {};
        const sess = snap.session || {};
        const pending = snap.pendingDelivery;
        const band = presence.band || '—';
        const herNow = typeof MirageImmersion?.simNowMs === 'function'
            ? MirageImmersion.simNowMs()
            : Date.now();

        const modeNote = mode === 'realtime'
            ? 'Full phone theater + proactive idle.'
            : mode === 'hybrid'
                ? 'Fast texts; wall waits only on time jumps.'
                : 'Instant replies — sim clock still advances on time skips.';

        let pipelineHtml;
        if (pending) {
            const bits = [
                pending.style ? `style ${pending.style}` : null,
                pending.narrativeWaitMs ? `narrative wait ${fmtDuration(pending.narrativeWaitMs)}` : null,
                pending.preReadMs != null ? `pre-read ${fmtDuration(pending.preReadMs)}` : null,
                pending.gapMs != null ? `gap ${fmtDuration(pending.gapMs)}` : null,
                pending.typingMs != null ? `typing ${fmtDuration(pending.typingMs)}` : null,
                pending.leftOnReadHoldMs ? `hold ${fmtDuration(pending.leftOnReadHoldMs)}` : null,
                pending.timeSkipReason || null
            ].filter(Boolean);
            pipelineHtml = `${pill('pending', 'warn')} ${escapeHtml(bits.join(' · ') || 'held delivery')}`;
        } else if (snap.hasProactiveTimer) {
            pipelineHtml = `${pill('proactive armed', 'warm')} waiting to text / story first`;
        } else {
            pipelineHtml = `${pill('idle', 'muted')} no delivery or proactive timer`;
        }

        const skipHtml = sess.lastTimeSkipMs
            ? `<strong>${escapeHtml(fmtDuration(sess.lastTimeSkipMs))}</strong>`
                + (sess.lastTimeSkipReason ? ` — ${escapeHtml(sess.lastTimeSkipReason)}` : '')
            : '—';

        const flags = [
            sess._storyActive ? pill('story active', 'story') : null,
            sess.awakeningActive ? pill(`awakening · ${sess.awakeningStage || 'crack'}`, 'warn') : null,
            sess.pendingWorldBeat?.kind ? pill(`world · ${sess.pendingWorldBeat.kind}`, 'cool') : null
        ].filter(Boolean);

        el.innerHTML = `
            <div class="dbg-immersion-head">
                ${pill(mode, mode === 'realtime' ? 'on' : 'muted')}
                ${pill(`cap ${fmtDuration(snap.realWaitCapMs || 600000)}`, 'muted')}
                ${pill(`quiet ${fmtDuration(snap.noReplyWaitMs || 180000)}`, 'muted')}
                <span class="dbg-note">${escapeHtml(modeNote)}</span>
            </div>

            <div class="dbg-grid">
                <section class="dbg-card">
                    <h4>Presence</h4>
                    ${row('Band', `${pill(String(band).toUpperCase(), presenceTone(band))} ${presence.onPhone ? pill('on phone', 'on') : pill('away', 'muted')}`)}
                    ${row('Heat', heatBars(presence.heat ?? sess.chatHeat))}
                    ${row('Reply lag', escapeHtml(fmtDuration(presence.lagMs ?? sess.lastReplyLagMs)))}
                    ${row('Since her msg', escapeHtml(presence.sinceAiMs != null ? fmtDuration(presence.sinceAiMs) : '—'))}
                    ${row('Phone UX', escapeHtml(sess.presencePhoneUx || '—'))}
                </section>

                <section class="dbg-card">
                    <h4>Clocks (her sim time)</h4>
                    ${row('Now', escapeHtml(fmtClock(herNow)))}
                    ${row('Last user', `${escapeHtml(fmtClock(sess.lastUserMessageAt))} <span class="dbg-sub">${escapeHtml(fmtAgo(sess.lastUserMessageAt))}</span>`)}
                    ${row('Last AI', `${escapeHtml(fmtClock(sess.lastAiMessageAt))} <span class="dbg-sub">${escapeHtml(fmtAgo(sess.lastAiMessageAt))}</span>`)}
                    ${row('Last story', `${escapeHtml(fmtClock(sess.lastStoryAt))} <span class="dbg-sub">${escapeHtml(fmtAgo(sess.lastStoryAt))}</span>`)}
                    ${row('Last time skip', skipHtml)}
                    ${typeof MirageCalendar?.debugLine === 'function'
                        ? row('Calendar', escapeHtml(MirageCalendar.debugLine()))
                        : ''}
                    ${typeof MirageCalendar?.formatDateContext === 'function'
                        ? row('Date context', escapeHtml(String(MirageCalendar.formatDateContext(S()?.profile) || '').replace(/\n/g, ' · ')))
                        : ''}
                </section>

                <section class="dbg-card dbg-card-wide">
                    <h4>Delivery pipeline</h4>
                    ${row('State', pipelineHtml)}
                    ${row('Timers', [
                        snap.hasProactiveTimer ? pill('proactive', 'warm') : pill('no proactive', 'muted'),
                        snap.hasWaitStatusTimer ? pill('wait label', 'cool') : null,
                        pill(`gen ${snap.deliveryGen ?? 0}`, 'muted')
                    ].filter(Boolean).join(' '))}
                    ${row('Flags', flags.length ? flags.join(' ') : pill('none', 'muted'))}
                    ${sess.directorScene ? row('Director', escapeHtml(sess.directorScene)) : ''}
                    ${sess.startInstruction ? row('Start', escapeHtml(String(sess.startInstruction).slice(0, 120))) : ''}
                    ${row('Epoch', escapeHtml(String(sess.sessionEpoch ?? '—')))}
                </section>
            </div>
        `;
    }

    function refreshImmersionOnly() {
        if (!S().developerMode) return;
        const snap = typeof MirageImmersion?.debugSnapshot === 'function'
            ? MirageImmersion.debugSnapshot()
            : null;
        renderImmersionBoard(snap);
    }

    function syncImmersionPoll() {
        const panel = panelEl();
        const should = !!(S().developerMode && panel && !panel.hidden);
        if (should && !immersionPoll) {
            immersionPoll = setInterval(refreshImmersionOnly, 2000);
            refreshImmersionOnly();
        } else if (!should && immersionPoll) {
            clearInterval(immersionPoll);
            immersionPoll = null;
        }
    }

    function refresh() {
        if (!S().developerMode) return;
        syncChatScope();

        const badge = document.getElementById('debugApiModeBadge');
        if (badge) {
            const label = (() => {
                const mock = MirageMockAPI?.apiModeLabel?.() || 'live';
                if (mock !== 'live') return mock;
                return S().apiProvider === 'kie' ? 'kie.ai' : 'google';
            })();
            badge.hidden = false;
            badge.textContent = `API: ${label}`;
            badge.dataset.mode = label;
        }

        renderDecisions();
        syncUnreadBadge();

        const sessEl = document.getElementById('debugSession');
        const edfEl = document.getElementById('debugEdf');
        const turnEl = document.getElementById('debugLastTurn');

        if (sessEl) {
            sessEl.textContent = safeJson({
                phase: S().session.phase,
                protocol: S().session.protocol,
                persona: S().session.persona,
                mode: S().session.mode,
                pacingMode: S().getPacingMode?.() || S().pacingMode,
                realTimeMaxWaitMs: S().realTimeMaxWaitMs,
                noReplyWaitMs: S().noReplyWaitMs,
                activeChatId: S().session.activeChatId,
                characterKey: MirageChatStore.characterKey(S()),
                apiProvider: S().apiProvider || 'google',
                metrics: {
                    arousal: S().session.arousal,
                    tease: S().session.tease,
                    awareness: S().session.awareness,
                    thermal: S().session.thermal,
                    mood: S().session.mood,
                    moodIntensity: S().session.moodIntensity,
                    moodNote: S().session.moodNote,
                    engagement: S().session.engagement,
                    outfit: S().session.outfit,
                    outfitSource: S().session.outfitSource || null,
                    env: S().session.env,
                    lastShotType: S().session.lastShotType,
                    shotHistory: S().session.shotHistory,
                    operatorOverrides: S().session.operatorOverrides,
                    awakeningActive: !!S().session.awakeningActive,
                    awakeningStage: S().session.awakeningStage
                },
                phone: {
                    clockOffsetMs: S().session.clockOffsetMs,
                    lastSeenAt: S().session.lastSeenAt,
                    presence: S().session.presence,
                    timeZone: MiragePhoneUX?.resolveTimeZone?.(S().profile?.location)
                },
                memoryLedger: S().session.memoryLedger,
                turnsSinceCallback: S().session.turnsSinceCallback,
                referenceMode: S().effectiveReferenceMode?.(),
                historyLength: S().session.history?.length || 0,
                activeCharacterId: S().activeCharacterId,
                imageSaveMode: S().imageSaveMode,
                saveGeneratedImages: S().saveGeneratedImages,
                apiMode: MirageMockAPI?.apiModeLabel?.() || 'live',
                mockImages: !!(S().developerMode && S().mockImages),
                mockThinking: !!(S().developerMode && S().mockThinking)
            });
        }

        refreshImmersionOnly();

        if (edfEl) {
            edfEl.textContent = S().edf ? safeJson(S().edf) : 'No EDF loaded.';
        }

        if (turnEl) {
            turnEl.textContent = belongsToOpenChat(lastTurnDebug)
                ? safeJson(lastTurnDebug)
                : 'No turn recorded yet this chat.';
        }

        const promptEl = document.getElementById('debugImagePrompt');
        if (promptEl) {
            promptEl.textContent = belongsToOpenChat(lastPromptDebug)
                ? `[refs: ${(lastPromptDebug.references || []).join(', ') || 'none'}]\n\n--- SYSTEM ---\n${lastPromptDebug.imageSystem}\n\n--- PROMPT ---\n${lastPromptDebug.imagePrompt}`
                : 'No image prompt sent yet this chat.';
        }

        syncImmersionPoll();
    }

    function recentHistoryLines(limit = 4) {
        return turnDumpSection(limit, { compact: true });
    }

    function askTurnCount(historyLen) {
        const max = Math.min(DUMP_TURN_MAX, Math.max(1, historyLen || 0));
        if (!historyLen) return 0;
        const def = Math.min(8, max);
        const raw = window.prompt(
            `How many recent turns to include in the troubleshoot report? (1–${max})`,
            String(def)
        );
        if (raw == null) return null;
        const n = parseInt(String(raw).trim(), 10);
        if (!Number.isFinite(n) || n < 1) return def;
        return Math.min(max, n);
    }

    function settingsDiffLines(prev, next) {
        if (!prev || !next) return [];
        const keys = [
            'thinkingModel', 'imageModel', 'apiProvider', 'referenceMode',
            'pacing', 'mockImages', 'mockThinking', 'sceneContinuityRef',
            'persona', 'protocol'
        ];
        return keys.filter((k) => {
            const a = prev[k];
            const b = next[k];
            if (a == null && b == null) return false;
            return String(a) !== String(b);
        }).map((k) => `${k}: ${prev[k] ?? '—'} → ${next[k] ?? '—'}`);
    }

    function matchTurnImage(turnImages, histAt) {
        const imgs = Array.isArray(turnImages) ? turnImages : [];
        if (!imgs.length) return null;
        const at = Number(histAt);
        if (!Number.isFinite(at)) return imgs[0] || null;
        return imgs.find((t) => Math.abs(Number(t.at) - at) < 12000) || null;
    }

    function overlayTraceForHistory(h, isLast) {
        if (isLast && belongsToOpenChat(lastTurnDebug) && !lastTurnDebug.failed) {
            return lastTurnDebug;
        }
        const at = Number(h?.at);
        if (!Number.isFinite(at)) return null;
        return turnTrace.find((t) => {
            if (t.failed) return false;
            const tAt = Number(t.historyAt || t.simAt);
            if (Number.isFinite(tAt) && Math.abs(tAt - at) < 12000) return true;
            return false;
        }) || null;
    }

    function formatOneHistoryTurn(h, absIndex, total, prevDebug, turnImage, overlay) {
        const d = { ...(h.debug || {}), ...(overlay || {}) };
        const parsed = overlay?.parsed || null;
        const tracking = h.tracking || parsed?.tracking || null;
        const directive = parsed?.imageDirective || turnImage?.imageDirective || null;
        const diffs = settingsDiffLines(prevDebug, d);
        const failBits = [];
        if (d.imageFailed || turnImage?.imageFailed) {
            failBits.push(`image ${d.imageFailReason || turnImage?.imageFailReason || 'failed'}`);
            if (d.imageFailDetail) failBits.push(d.imageFailDetail);
        }
        if (d.failed || d.error) failBits.push(d.error || 'turn error');
        const flags = [
            d.godMode ? 'god-mode' : null,
            d.changeOutfit ? 'outfit-cmd' : null,
            d.refreshScene ? 'next-scene' : null,
            d.fitCheck ? 'fit-check' : null,
            d.closeup ? 'closeup' : null,
            d.cropLock ? `crop-lock:${d.cropLock}` : null,
            d.userShot ? 'user-shot' : null,
            d.mirrorBack ? 'mirror-back' : null,
            d.subjectLock ? `subject:${d.subjectLock}` : null,
            d.internal ? 'proactive' : null,
            d.storyLaunch ? 'story-launch' : null,
            d.proactive ? 'proactive-timer' : null,
            d.retried ? `retry:${d.retryMode || 'image'}` : null,
            d.generateImage === false ? 'text-only' : null,
            d.imageSkipped ? 'image-skipped' : null,
            d.mockImages ? 'mock-images' : null,
            d.mockThinking ? 'mock-thinking' : null
        ].filter(Boolean);

        return [
            `### Turn ${absIndex} / ${total} · ${h.mode || d.mode || 'DM'} · ${fmtClock(h.at)}`,
            line('Sim stamp', h.at || '—'),
            line('Her clock (this turn)', d.herClock || '—'),
            line('Flags', flags.length ? flags.join(', ') : '—'),
            line('Thinking model', d.thinkingModel || '—'),
            line('Image model', d.imageModel || '—'),
            line('API / refs', `${d.apiProvider || '—'} / ${d.referenceMode || '—'}`),
            line('Pacing', d.pacing || '—'),
            line('Persona / protocol', `${d.persona || '—'} / ${d.protocol || '—'}`),
            line('Outfit → env', `${formatOutfitWithSource(d.outfit || h.tracking?.outfit, d.outfitSource)} → ${d.env || h.tracking?.env || '—'}`),
            line('Delivery style', d.deliveryStyle || '—'),
            line('Shot type', d.shotType || directive?.shotType || '—'),
            line('Crop', d.crop || directive?.crop || '—'),
            line('Camera height', d.cameraAngle || directive?.cameraAngle || '—'),
            line('Goon face / frame', (d.goonFace || directive?.goonFace || '—') + ' / ' + (d.goonFrame || directive?.goonFrame || '—')),
            line('Generate image', d.generateImage == null ? '—' : (d.generateImage ? 'yes' : 'no')),
            line('Image failed', failBits.length ? failBits.join(' — ') : 'no'),
            line('Image skipped', d.imageSkipped || turnImage?.imageSkipped ? 'yes' : 'no'),
            line('Turn image store', turnImage
                ? `failed=${!!turnImage.imageFailed} skipped=${!!turnImage.imageSkipped} mock=${!!turnImage.imageMock} hasKey=${!!turnImage.imageKey} reason=${turnImage.imageFailReason || '—'}`
                : '—'),
            line('Image refs', Array.isArray(d.imageRefs) && d.imageRefs.length ? d.imageRefs.join(', ') : '—'),
            line('Settings changed since prior turn', diffs.length ? diffs.join('; ') : 'none'),
            '',
            '**User / command**',
            fenceBlock(h.user, 4000),
            '',
            '**Her reply**',
            fenceBlock(h.ai, 4000),
            '',
            '**Command inject**',
            d.commandInject ? fenceBlock(d.commandInject, 1200) : '—',
            '',
            '**Tracking**',
            tracking ? fenceBlock(safeJson(tracking), 2500) : '—',
            '',
            '**Image directive**',
            directive ? fenceBlock(safeJson(directive), 2500) : '—',
            d.imagePromptClip ? `\n**Image prompt (clip)**\n${fenceBlock(d.imagePromptClip, 900)}` : ''
        ].filter((row) => row != null).join('\n');
    }

    function turnDumpSection(limit, { compact = false } = {}) {
        const hist = Array.isArray(S()?.session?.history) ? S().session.history : [];
        if (!hist.length) return '_No history yet._';
        const n = Math.min(Math.max(1, limit || 4), hist.length);
        const slice = hist.slice(-n);
        const stored = MirageChatStore.getActiveChat?.(S());
        const startAbs = hist.length - slice.length + 1;
        if (compact) {
            return slice.map((h, i) => {
                const abs = startAbs + i;
                return [
                    `### Turn ${abs}`,
                    `User: ${clip(h?.user, 280)}`,
                    `AI: ${clip(h?.ai, 280)}`,
                    h?.tracking ? `Tracking: ${clip(safeJson(h.tracking), 220)}` : null,
                    h?.debug?.imageFailed ? `Image failed: ${h.debug.imageFailReason || 'yes'}` : null
                ].filter(Boolean).join('\n');
            }).join('\n\n');
        }
        return slice.map((h, i) => {
            const abs = startAbs + i;
            const prev = i > 0 ? (slice[i - 1].debug || null) : null;
            const overlay = overlayTraceForHistory(h, i === slice.length - 1);
            const img = matchTurnImage(stored?.turnImages, h.at);
            return formatOneHistoryTurn(h, abs, hist.length, prev, img, overlay);
        }).join('\n\n---\n\n');
    }

    function windowedUiLog(fromMs, toMs) {
        const rows = Array.isArray(S()?.session?.uiLog) ? S().session.uiLog : [];
        const hit = rows.filter((e) => {
            const at = Number(e?.at);
            if (!Number.isFinite(at)) return false;
            return at >= fromMs && at <= toMs;
        });
        if (!hit.length) return '_None in this window._';
        return hit.map((e) => {
            const t = fmtClock(e.at);
            const kind = e.kind || 'caption';
            if (kind === 'alert') {
                return `- \`${t}\` **ALERT ${e.alertType || ''}** — ${e.title || ''} ${e.body || e.text || ''}`.trim();
            }
            if (kind === 'command') {
                return `- \`${t}\` **CMD** — ${clipKeep(e.text, 400)}${e.clockArrow ? ` · ${e.clockArrow}` : ''}`;
            }
            return `- \`${t}\` **${kind}** — ${clipKeep(e.text || e.body || '', 400)}`;
        }).join('\n');
    }

    function windowedNotices(fromMs, toMs, extraLimit = 80) {
        const rows = scopedNotices(noticeLog);
        const wallFrom = Date.now() - 4 * 60 * 60 * 1000;
        const simFrom = Number(fromMs);
        const simTo = Number(toMs);
        const hit = rows.filter((d) => {
            if (['error', 'settings', 'spend', 'scene'].includes(d.kind)) return true;
            const at = Number(d.at);
            if (!Number.isFinite(at)) return false;
            if (at >= wallFrom) return true;
            if (Number.isFinite(simFrom) && Number.isFinite(simTo) && at >= simFrom && at <= simTo) return true;
            return false;
        });
        if (!hit.length) return '_No DEV notices in this window._';
        return hit.slice(0, extraLimit).map((d) => {
            const cap = d.kind === 'error' ? 1800 : 400;
            const detail = d.detail ? ` · ${clip(safeJson(d.detail), cap)}` : '';
            return `- \`${noticeTimeText(d)}\` **${d.kind}** — ${d.summary}${detail}`;
        }).join('\n');
    }

    function formatFailedTurn(t) {
        return [
            line('Failed', 'yes'),
            line('At', t.at),
            line('Input', clipKeep(t.userInput, 800)),
            line('Toast / popup title', t.toast || t.error || '—'),
            line('Code', t.errorCode || '—'),
            line('Thinking model', t.thinkingModel || '—'),
            line('God mode', t.godMode ? 'yes' : 'no'),
            line('Chat alert body', clipKeep(t.chatError, 2000)),
            line('Command inject', t.commandInject ? clipKeep(t.commandInject, 1200) : '—'),
            t.rawPreview ? `Malformed model output:\n${fenceBlock(t.rawPreview, 2500)}` : line('Malformed model output', '—')
        ].join('\n');
    }

    function failedTurnsAll() {
        const rows = [];
        const seen = new Set();
        const push = (t) => {
            if (!t || !(t.failed || t.error)) return;
            const id = `${t.traceAt || t.at}|${t.userInput || ''}|${t.error || ''}`;
            if (seen.has(id)) return;
            seen.add(id);
            rows.push(t);
        };
        (turnTrace || []).forEach(push);
        push(lastTurnDebug);
        if (!rows.length) return '_None captured this chat._';
        return rows.map((t) => formatFailedTurn(t)).join('\n\n');
    }

    function visibleAlertsSection() {
        const bits = [];
        document.querySelectorAll('#chatLog .chat-alert').forEach((el) => {
            const title = el.querySelector('.chat-alert-text strong')?.textContent
                || el.querySelector('strong')?.textContent
                || '';
            const body = el.querySelector('.chat-alert-text p')?.textContent || '';
            bits.push([
                line('Source', 'chat popup (on screen)'),
                line('Title', clipKeep(title, 400)),
                line('Body', clipKeep(body, 2500))
            ].join('\n'));
        });
        document.querySelectorAll('.toast-player, .toast').forEach((el) => {
            const cls = String(el.className || '');
            if (!/error|warn/i.test(cls)) return;
            const text = String(el.textContent || '').trim();
            if (!text) return;
            bits.push([
                line('Source', 'toast (on screen)'),
                line('Class', clip(cls, 120)),
                line('Text', clipKeep(text, 800))
            ].join('\n'));
        });
        const uiAlerts = (Array.isArray(S()?.session?.uiLog) ? S().session.uiLog : [])
            .filter((e) => e && e.kind === 'alert')
            .slice(-20)
            .reverse();
        uiAlerts.forEach((e) => {
            bits.push([
                line('Source', 'uiLog alert (persisted)'),
                line('At', fmtClock(e.at)),
                line('Type', e.alertType || 'warn'),
                line('Title', clipKeep(e.title, 400)),
                line('Body', clipKeep(e.body || e.text, 2500))
            ].join('\n'));
        });
        if (!bits.length) return '_No chat alerts, error toasts, or persisted alert log entries._';
        return bits.join('\n\n');
    }

    function runtimeFaultsSection() {
        if (!runtimeFaults.length) return '_No uncaught JS / promise errors captured this page load._';
        return runtimeFaults.slice(0, 20).map((f) => [
            line('Kind', f.kind || 'js'),
            line('Wall', f.at ? new Date(f.at).toISOString() : '—'),
            line('Message', clipKeep(f.message, 800)),
            line('File', f.file ? `${f.file}:${f.line || '?'}:${f.col || '?'}` : '—'),
            f.stack ? `Stack:\n${fenceBlock(f.stack, 1800)}` : line('Stack', '—')
        ].join('\n')).join('\n\n');
    }

    function pushRuntimeFault(entry) {
        if (!entry) return;
        const message = String(entry.message || '').trim();
        if (!message) return;
        const last = runtimeFaults[0];
        if (last && last.message === message && (Date.now() - Number(last.at || 0)) < 1500) return;
        runtimeFaults.unshift({
            at: Date.now(),
            engineAt: engineNowMs(),
            kind: entry.kind || 'js',
            message: message.slice(0, 800),
            file: entry.file || null,
            line: entry.line || null,
            col: entry.col || null,
            stack: entry.stack ? String(entry.stack).slice(0, 2000) : null
        });
        if (runtimeFaults.length > 30) runtimeFaults.length = 30;
        pushNotice({
            kind: 'error',
            tone: 'error',
            summary: `JS ${entry.kind || 'error'}: ${message.slice(0, 180)}`,
            detail: {
                kind: entry.kind || 'js',
                file: entry.file || null,
                line: entry.line || null,
                message: message.slice(0, 400)
            }
        });
    }

    function failedTraceSection() {
        return failedTurnsAll();
    }

    function decisionLines(limit = 20) {
        const rows = scopedNotices(noticeLog);
        if (!rows.length) return '_No DEV notices logged yet this chat._';
        return rows.slice(0, limit).map(d => {
            const detail = d.detail ? ` · ${clip(safeJson(d.detail), 160)}` : '';
            return `- \`${noticeTimeText(d)}\` **${d.kind}** — ${d.summary}${detail}`;
        }).join('\n');
    }

    function lastTurnSection() {
        if (!belongsToOpenChat(lastTurnDebug)) return '_No turn recorded yet this chat._';
        const t = lastTurnDebug;
        const parsed = t.parsed || {};
        const tracking = parsed.tracking || null;
        const directive = parsed.imageDirective || null;
        const failBlock = (t.failed || t.error)
            ? [
                line('FAILED', 'yes — this turn did not land in chat history'),
                line('Toast / popup title', t.toast || t.error || '—'),
                line('Code', t.errorCode || '—'),
                line('Chat alert body', clipKeep(t.chatError, 2000)),
                t.rawPreview ? `Malformed model output:\n${fenceBlock(t.rawPreview, 2500)}` : line('Malformed model output', '—'),
                ''
            ]
            : [];
        return [
            ...failBlock,
            line('At', t.at),
            line('User / cmd input', clipKeep(t.userInput, 800)),
            line('Image failed', t.imageFailed
                ? `yes (${t.imageFailReason || 'unknown'}${t.imageFailDetail ? ` — ${clip(t.imageFailDetail, 240)}` : ''})`
                : 'no'),
            line('Image skipped', t.imageSkipped ? 'yes' : 'no'),
            line('Command inject', t.commandInject ? clipKeep(t.commandInject, 1200) : '—'),
            line('Character response', clipKeep(parsed.characterResponse || parsed.message || '', 800)),
            line('Tracking', tracking ? clipKeep(safeJson(tracking), 800) : '—'),
            line('Image directive', directive ? clipKeep(safeJson(directive), 800) : '—')
        ].join('\n');
    }

    function lastPromptSection() {
        if (!belongsToOpenChat(lastPromptDebug)) return '_No image prompt sent yet this chat._';
        const refs = (lastPromptDebug.references || []).join(', ') || 'none';
        return [
            line('Refs', refs),
            line('Face recovery', lastPromptDebug.faceRecovery ? 'yes' : 'no'),
            line('Soft prompt', lastPromptDebug.soft ? 'yes' : 'no'),
            '',
            '### Image system (trimmed)',
            '```',
            clip(lastPromptDebug.imageSystem, 1800),
            '```',
            '',
            '### Image prompt (trimmed)',
            '```',
            clip(lastPromptDebug.imagePrompt, 1800),
            '```'
        ].join('\n');
    }

    function immersionSection(snap) {
        if (!snap) return '_Immersion snapshot unavailable._';
        const presence = snap.presence || {};
        const sess = snap.session || {};
        const pending = snap.pendingDelivery;
        return [
            line('Pacing', snap.pacingMode || '—'),
            line('Max wait', fmtDuration(snap.realWaitCapMs)),
            line('Quiet chase', fmtDuration(snap.noReplyWaitMs)),
            line('Presence band', presence.band || '—'),
            line('On phone', presence.onPhone ? 'yes' : 'no'),
            line('Heat', `${presence.heat ?? sess.chatHeat ?? '—'}/5`),
            line('Reply lag', fmtDuration(presence.lagMs ?? sess.lastReplyLagMs)),
            line('Proactive timer', snap.hasProactiveTimer ? 'armed' : 'none'),
            line('Pending delivery', pending
                ? clip(safeJson({
                    style: pending.style,
                    narrativeWaitMs: pending.narrativeWaitMs,
                    preReadMs: pending.preReadMs,
                    gapMs: pending.gapMs,
                    typingMs: pending.typingMs,
                    leftOnReadHoldMs: pending.leftOnReadHoldMs,
                    timeSkipReason: pending.timeSkipReason
                }), 400)
                : 'none'),
            line('World beat', sess.pendingWorldBeat?.kind || 'none'),
            line('Last time skip', sess.lastTimeSkipMs
                ? `${fmtDuration(sess.lastTimeSkipMs)}${sess.lastTimeSkipReason ? ` — ${sess.lastTimeSkipReason}` : ''}`
                : '—'),
            line('Her day', snap.routineMode || S()?.routineMode || '—'),
            line('Routine band', sess.routineBand || '—'),
            line('Delivery gen', snap.deliveryGen ?? '—')
        ].join('\n');
    }

    /**
     * Human-readable dump meant to paste into Cursor for troubleshooting.
     * Never includes API keys or raw media blobs.
     */
    function formatDebugDump(turnCount) {
        syncChatScope();
        const sess = S()?.session || {};
        const profile = S()?.profile || {};
        const snap = typeof MirageImmersion?.debugSnapshot === 'function'
            ? MirageImmersion.debugSnapshot()
            : null;
        const herNow = typeof MiragePhoneUX?.herNow === 'function'
            ? MiragePhoneUX.herNow()
            : new Date();
        const tz = MiragePhoneUX?.resolveTimeZone?.(profile.location, profile);
        const stored = MirageChatStore.getActiveChat?.(S());
        const mockLabel = MirageMockAPI?.apiModeLabel?.() || 'live';
        const hist = Array.isArray(sess.history) ? sess.history : [];
        const nTurns = Math.min(
            Math.max(1, Number(turnCount) || 8),
            DUMP_TURN_MAX,
            Math.max(1, hist.length || 1)
        );
        const nowEngine = engineNowMs();
        const slice = hist.slice(-Math.min(nTurns, hist.length));
        const windowFrom = slice.length
            ? (Number(slice[0].at) || nowEngine) - (2 * 60 * 1000)
            : nowEngine - (30 * 60 * 1000);
        const windowTo = nowEngine + 60 * 1000;
        const genCheck = document.getElementById('checkGenerateImage');

        return [
            '# Mirage Engine — Troubleshoot Report',
            '',
            '_Paste this whole report into Cursor. Add 1–2 lines above it describing what went wrong / what you expected._',
            '',
            '## Snapshot',
            line('Copied at', new Date().toISOString()),
            line('Cache bump', `v=${detectCacheBump()}`),
            line('URL', typeof location !== 'undefined' ? location.href.split('?')[0] : '—'),
            line('Browser', typeof navigator !== 'undefined' ? clip(navigator.userAgent, 180) : '—'),
            line('Turns included', `${Math.min(nTurns, hist.length)} of ${hist.length}`),
            '',
            '## ON-SCREEN ERRORS / POPUPS',
            visibleAlertsSection(),
            '',
            '## Failed / incomplete turns',
            failedTurnsAll(),
            '',
            '## Runtime JS faults',
            runtimeFaultsSection(),
            '',
            '## App / API',
            line('API provider', S()?.apiProvider || 'google'),
            line('API mode', mockLabel),
            line('Thinking model', S()?.thinkingModel || '—'),
            line('Scene thinking model', S()?.sceneThinkingModel || '—'),
            line('Image model', S()?.imageModel || '—'),
            line('Reference mode', S()?.effectiveReferenceMode?.() || S()?.referenceMode || '—'),
            line('Master face', S()?.masterFaceFile ? `yes (${S().masterFaceFile.name || 'file'})` : 'no'),
            line('Master body', S()?.masterBodyFile ? `yes (${S().masterBodyFile.name || 'file'})` : 'no'),
            line('Scene continuity ref', S()?.lastSceneFile ? 'yes (last frame kept)' : 'no'),
            line('Scene continuity setting', S()?.sceneContinuityRef ? 'on' : 'off'),
            line('Mock images', S()?.mockImages ? 'on' : 'off'),
            line('Mock thinking', S()?.mockThinking ? 'on' : 'off'),
            line('Generate images checkbox', genCheck ? (genCheck.checked ? 'on' : 'off') : '—'),
            line('Image save mode', `${S()?.saveGeneratedImages ? 'on' : 'off'} / ${S()?.imageSaveMode || '—'}`),
            line('Pacing', S()?.getPacingMode?.() || S()?.pacingMode || '—'),
            line('Her day', S()?.routineMode || 'stories'),
            '',
            '## Character / chat',
            line('Name', profile.name || S()?.activeCharacterLabel || '—'),
            line('Age', profile.age ?? '—'),
            line('Location', profile.location || '—'),
            line('Timezone', `${tz || '—'}${profile.timezone ? ' (set)' : ' (inferred)'}`),
            line('Character id', S()?.activeCharacterId || MirageChatStore.characterKey?.(S()) || '—'),
            line('Chat id', sess.activeChatId || '—'),
            line('Chat label', stored?.label || '—'),
            line('Chat updated', stored?.updatedAt || '—'),
            line('History turns', sess.history?.length || 0),
            '',
            '## Session',
            line('Phase', sess.phase || '—'),
            line('Protocol', sess.protocol || '—'),
            line('Persona', sess.persona || '—'),
            line('Mode', sess.mode || '—'),
            line('Outfit', formatOutfitWithSource(sess.outfit, sess.outfitSource)),
            line('Env', sess.env || '—'),
            line('Routine band', sess._routineBand || '—'),
            line('Arousal / tease / awareness', `${sess.arousal ?? '—'} / ${sess.tease ?? '—'} / ${sess.awareness ?? '—'}`),
            line('Libido (hidden)', profile.libido ?? '—'),
            line('Engagement', sess.engagement ?? '—'),
            line('Thermal', sess.thermal || '—'),
            line('Mood', `${sess.mood || 'Neutral'} @${sess.moodIntensity ?? 1}${sess.moodNote ? ` — ${sess.moodNote}` : ''}`),
            line('Shot history', Array.isArray(sess.shotHistory) ? sess.shotHistory.join(', ') : '—'),
            line('Operator overrides', Object.keys(sess.operatorOverrides || {}).length
                ? clip(safeJson(sess.operatorOverrides), 240)
                : 'none'),
            line('Awakening', sess.awakeningActive ? sess.awakeningStage || 'active' : 'off'),
            line('Story active', sess._storyActive ? 'yes' : 'no'),
            line('Social hold', sess.socialHold?.kind || 'none'),
            line('Session epoch', sess.sessionEpoch ?? '—'),
            '',
            '## Clocks (her sim time)',
            line('Time zone', tz || '—'),
            line('Clock offset', fmtDuration(sess.clockOffsetMs)),
            line('Her now', typeof MiragePhoneUX?.formatClock === 'function'
                ? MiragePhoneUX.formatClock(herNow, tz)
                : herNow.toISOString()),
            line('Last user msg', `${fmtClock(sess.lastUserMessageAt)} (${fmtAgo(sess.lastUserMessageAt)})`),
            line('Last AI msg', `${fmtClock(sess.lastAiMessageAt)} (${fmtAgo(sess.lastAiMessageAt)})`),
            line('Last story', `${fmtClock(sess.lastStoryAt)} (${fmtAgo(sess.lastStoryAt)})`),
            line('Holiday catalog', typeof MirageCalendar?.debugLine === 'function'
                ? MirageCalendar.debugLine()
                : '—'),
            line('Date context', typeof MirageCalendar?.formatDateContext === 'function'
                ? String(MirageCalendar.formatDateContext(profile) || '').replace(/\n/g, ' / ')
                : '—'),
            line('Phone presence', sess.presence || '—'),
            '',
            '## Engine busy',
            line('Hard busy', MirageSimulation?.isHardBusy?.() ? 'yes' : 'no'),
            line('Engine busy', MirageSimulation?.isEngineBusy?.() ? 'yes' : 'no'),
            line('Turn in progress', MirageSimulation?.isTurnInProgress?.() ? 'yes' : 'no'),
            '',
            '## Immersion / timers',
            immersionSection(snap),
            '',
            `## Last ${Math.min(nTurns, hist.length)} turns (full)`,
            turnDumpSection(nTurns),
            '',
            '## Scene actions / alerts / commands in that window',
            windowedUiLog(windowFrom, windowTo),
            '',
            '## DEV log in that window (errors, spends, settings, scene)',
            windowedNotices(windowFrom, windowTo),
            '',
            '## Failed turns this session (not in history)',
            failedTraceSection(),
            '',
            '## Last turn snapshot',
            lastTurnSection(),
            '',
            '## Last image prompt',
            lastPromptSection(),
            '',
            '## Immersion raw (trimmed)',
            '```json',
            clip(safeJson(snap), 2500),
            '```',
            '',
            '---',
            '_Secrets omitted: API keys, raw image blobs, full EDF._'
        ].join('\n');
    }

    async function copyText(text) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('copy failed');
    }

    function bind() {
        syncChatScope();
        if (!window.__mirageFaultHook) {
            window.__mirageFaultHook = true;
            window.addEventListener('error', (e) => {
                pushRuntimeFault({
                    kind: 'js',
                    message: e?.message || String(e),
                    file: e?.filename || null,
                    line: e?.lineno || null,
                    col: e?.colno || null,
                    stack: e?.error && e.error.stack
                });
            });
            window.addEventListener('unhandledrejection', (e) => {
                const reason = e?.reason;
                pushRuntimeFault({
                    kind: 'promise',
                    message: reason && (reason.message || String(reason)),
                    stack: reason && reason.stack
                });
            });
        }
        document.getElementById('btnToggleDebug')?.addEventListener('click', () => {
            const panel = panelEl();
            if (panel) panel.hidden = !panel.hidden;
            if (panel && !panel.hidden) {
                unreadNotices = 0;
                syncUnreadBadge();
                refresh();
            }
            syncImmersionPoll();
        });

        document.getElementById('btnClearDevLog')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            clearNotices();
        });

        document.getElementById('btnRefreshDebug')?.addEventListener('click', refresh);

        document.getElementById('btnCopyDebug')?.addEventListener('click', async () => {
            try {
                refresh();
                const histLen = Array.isArray(S()?.session?.history) ? S().session.history.length : 0;
                const n = askTurnCount(histLen);
                if (n == null) return;
                const report = formatDebugDump(n);
                await copyText(report);
                MirageUI.toast(
                    histLen
                        ? `Troubleshoot report copied (${Math.min(n, histLen)} turn${Math.min(n, histLen) === 1 ? '' : 's'}). Paste it into Cursor.`
                        : 'Troubleshoot report copied — paste it into Cursor.',
                    'success',
                    { essential: true }
                );
            } catch (err) {
                console.warn('[Mirage] copy troubleshoot report failed', err);
                MirageUI.toast('Copy failed — check clipboard permissions.', 'error');
            }
        });
    }

    global.MirageDebugPanel = {
        bind,
        refresh,
        setVisible,
        setLastTurn,
        setLastPrompt,
        pushDecision,
        pushNotice,
        beginDevTurn,
        clearNotices,
        syncChatScope,
        forgetChatScope,
        formatDebugDump
    };
})(typeof window !== 'undefined' ? window : globalThis);
