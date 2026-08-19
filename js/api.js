/**
 * MIRAGE ENGINE — Google AI API layer
 * Thinking: generateContent (browser-safe for Gemini 3.6/3.5)
 * Image (Nano Banana): Interactions API via local proxy (CORS fix)
 */
(function (global) {
    'use strict';

    const BASE = 'https://generativelanguage.googleapis.com/v1beta';
    const IMAGE_TEST_TIMEOUT_MS = 300000; // 5 min — Nano Banana Pro can be slow on first run
    const IMAGE_ASPECT_RATIO = '9:16';
    const IMAGE_OUTPUT_SIZE = '1K';
    const PROXY_PORT = 8080; // must match PORT in mirage_server.py

    function usingLocalProxy() {
        const host = location.hostname;
        return host === 'localhost' || host === '127.0.0.1';
    }

    /** Use local proxy when served from localhost (avoids Google CORS on /interactions) */
    function interactionsUrl() {
        return usingLocalProxy() ? '/api/proxy/interactions' : `${BASE}/interactions`;
    }

    function interactionsHeaders(apiKey) {
        const headers = { 'Content-Type': 'application/json' };
        if (usingLocalProxy()) {
            headers['X-Mirage-Api-Key'] = apiKey;
        } else {
            headers['x-goog-api-key'] = apiKey;
        }
        return headers;
    }

    /**
     * mirage_server.py tags every proxy reply — success or error — as application/json, so any other
     * content type on this route means a plain static server answered and cannot forward to Google.
     */
    function proxyDidNotAnswer(res) {
        return usingLocalProxy() && !/json/i.test(res.headers.get('Content-Type') || '');
    }

    function proxyMissingError(res, context) {
        const portHint = location.port && location.port !== String(PROXY_PORT)
            ? ` This page is served from port ${location.port}, but the proxy only listens on ${PROXY_PORT}.`
            : '';
        return new Error(
            `${context}: no local image proxy at ${location.origin} (HTTP ${res.status}).${portHint}`
            + ` Close this tab, run "START MIRAGE.bat", and reopen http://localhost:${PROXY_PORT}.`
        );
    }

    async function readFileBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async function fileToInlinePart(file) {
        const base64 = await readFileBase64(file);
        return {
            inlineData: {
                mimeType: file.type || 'image/jpeg',
                data: base64
            }
        };
    }

    async function fileToInteractionImage(file) {
        const base64 = await readFileBase64(file);
        return {
            type: 'image',
            mime_type: file.type || 'image/jpeg',
            data: base64
        };
    }

    function partsToInteractionInput(userParts) {
        const items = [];
        for (const part of userParts) {
            if (part.text) {
                items.push({ type: 'text', text: part.text });
            } else if (part.inlineData) {
                items.push({
                    type: 'image',
                    mime_type: part.inlineData.mimeType || 'image/jpeg',
                    data: part.inlineData.data
                });
            }
        }
        if (items.length === 1 && items[0].type === 'text') {
            return items[0].text;
        }
        return items;
    }

    function stripJsonFences(text) {
        let t = String(text || '').trim();
        // Full-fence wrap
        t = t.replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/\s*```$/i, '').trim();
        // Leading/trailing fence leftovers
        t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        return t;
    }

    /**
     * Pull the first top-level JSON object/array from mixed model output
     * (prose preface, trailing commentary, partial fences).
     */
    function extractJsonPayload(text) {
        const raw = stripJsonFences(text);
        if (!raw) return raw;

        try {
            JSON.parse(raw);
            return raw;
        } catch {
            /* fall through */
        }

        const startObj = raw.indexOf('{');
        const startArr = raw.indexOf('[');
        let start = -1;
        if (startObj >= 0 && (startArr < 0 || startObj < startArr)) start = startObj;
        else if (startArr >= 0) start = startArr;
        if (start < 0) return raw;

        const open = raw[start];
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = start; i < raw.length; i++) {
            const ch = raw[i];
            if (inString) {
                if (escape) escape = false;
                else if (ch === '\\') escape = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === open) depth += 1;
            else if (ch === close) {
                depth -= 1;
                if (depth === 0) return raw.slice(start, i + 1);
            }
        }
        return raw;
    }

    function looksLikeSafetyRejection(text) {
        const s = String(text || '');
        if (!s.trim()) return false;
        return /prohibited use policy|sensitive words|could not be submitted|content.?filter|blocked by safety|violat\w* (google'?s |the )?policy|generative ai prohibited|responsible ai|harm category|safety.?block|i cannot fulfill|i can'?t fulfill|i am unable to|i'?m unable to|unable to generate|cannot generate (sexually|explicit)|sexually (explicit|suggestive) (content|roleplay|imagery)|won'?t generate|will not generate|as an ai (language )?model|against (my|the) (guidelines|policies)/i.test(s);
    }

    function safetyError(text) {
        const err = new Error(String(text || '').trim().slice(0, 320));
        err.code = 'SAFETY';
        err.rawPreview = String(text || '').slice(0, 400);
        return err;
    }

    /** Does this parsed object look like one of our turns, rather than provider prose? */
    function looksLikeTurnPayload(parsed) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        return typeof parsed.characterResponse === 'string'
            || typeof parsed.response === 'string'
            || (parsed.tracking && typeof parsed.tracking === 'object')
            || (parsed.delivery && typeof parsed.delivery === 'object');
    }

    /**
     * Parse first, classify second.
     *
     * The refusal heuristic used to run on the raw text *before* JSON.parse, and it
     * matches phrases like "i'm unable to" and "won't generate" — which a character
     * says in character all the time ("i'm unable to even rn 😭"). A perfectly valid
     * turn was being reported as a provider refusal, burning the softened-retry pass
     * and sometimes failing the turn outright.
     */
    function parseJsonResponse(text) {
        const candidate = extractJsonPayload(text);
        let parsed;
        try {
            parsed = JSON.parse(candidate);
        } catch {
            // Not JSON at all. Refusal prose is the usual cause, so say so when it
            // reads like one rather than blaming the model's JSON.
            if (looksLikeSafetyRejection(candidate) || looksLikeSafetyRejection(text)) {
                throw safetyError(text || candidate);
            }
            const err = new Error('Thinking model returned invalid JSON.');
            err.code = 'JSON_PARSE';
            err.rawPreview = String(text || '').slice(0, 400);
            throw err;
        }

        // It parsed. The heuristic is only safe now, and only when the payload isn't
        // actually a turn — a provider can still refuse in well-formed JSON.
        if (!looksLikeTurnPayload(parsed) && looksLikeSafetyRejection(text)) {
            throw safetyError(text);
        }
        return parsed;
    }

    function extractInteractionText(data) {
        if (data?.output_text) return data.output_text;

        const steps = data?.steps || [];
        for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];
            if (step.type !== 'model_output') continue;
            const texts = (step.content || [])
                .filter(c => c.type === 'text' && c.text)
                .map(c => c.text);
            if (texts.length) return texts.join('\n');
        }
        return null;
    }

    function extractInteractionImage(data) {
        if (data?.output_image?.data) {
            const mime = data.output_image.mime_type || 'image/png';
            return `data:${mime};base64,${data.output_image.data}`;
        }

        let last = null;
        for (const step of data?.steps || []) {
            if (step.type !== 'model_output') continue;
            for (const block of step.content || []) {
                if (block.type === 'image' && block.data) last = block;
            }
        }

        if (last) {
            const mime = last.mime_type || 'image/png';
            return `data:${mime};base64,${last.data}`;
        }
        return null;
    }

    function formatApiError(data, context) {
        const msg = data?.error?.message || data?.message;
        if (msg) return `${context}: ${msg}`;
        return `${context}: request failed`;
    }

    function wrapFetchError(err, context, { cancelled = false } = {}) {
        if (err.name === 'AbortError' || cancelled) {
            const e = new Error('Turn cancelled');
            e.code = 'CANCELLED';
            return e;
        }
        if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
            if (location.protocol === 'file:') {
                return new Error(`${context}: browser blocked API — use START MIRAGE.bat (not index.html directly)`);
            }
            return new Error(`${context}: network/CORS error — restart via START MIRAGE.bat`);
        }
        return err;
    }

    function classifyImageError(err) {
        const msg = String(err?.message || err || '').toLowerCase();
        if (/safety|blocked|block|filter|policy|harm|refus|not allowed|prohibited|moderation|responsible|violat/i.test(msg)) {
            return 'filtered';
        }
        if (/timeout|timed out|abort/i.test(msg)) {
            return 'timeout';
        }
        if (/no image returned|empty|missing image|no image url|no dataurl/i.test(msg)) {
            return 'empty';
        }
        if (/402|insufficient credit|not enough credit/i.test(msg)) {
            return 'failed';
        }
        return 'failed';
    }

    function imageFailureMessage(reason, detail) {
        const titles = {
            filtered: 'Image blocked by safety filter',
            timeout: 'Image generation timed out',
            empty: 'Image model returned no image',
            failed: 'Image failed to generate'
        };
        const hints = {
            filtered: 'Text still sent. Use Retry Last Image, or switch models in Settings if this keeps happening.',
            timeout: 'Image generation can take several minutes on kie/Google. Retry or switch to a faster model.',
            empty: 'The API completed but no image data came back. Retry the turn.',
            failed: 'Something went wrong during image generation. Retry the last image, or Test Connection in Settings if it keeps failing.'
        };
        const raw = String(detail || '').trim();
        // Prefer the real provider/proxy error when we have one
        let body = raw && !/^image generation failed/i.test(raw)
            ? raw
            : (hints[reason] || hints.failed);
        if (reason === 'filtered' && raw && raw !== hints.filtered) {
            body = `${raw}\n\n${hints.filtered}`;
        }
        return {
            title: titles[reason] || titles.failed,
            body
        };
    }

    async function parseJsonResponseSafe(res) {
        const text = await res.text();
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            throw new Error(`Invalid API response (${res.status}): ${text.slice(0, 200)}`);
        }
    }

    async function interactionsCreate(apiKey, body, { timeoutMs = 0, context = 'Interactions API', signal } = {}) {
        const timeoutController = timeoutMs > 0 ? new AbortController() : null;
        const timer = timeoutController
            ? setTimeout(() => timeoutController.abort(), timeoutMs)
            : null;

        let fetchSignal = signal || null;
        if (signal && timeoutController) {
            const linked = new AbortController();
            const abortLinked = () => linked.abort();
            signal.addEventListener('abort', abortLinked, { once: true });
            timeoutController.signal.addEventListener('abort', abortLinked, { once: true });
            fetchSignal = linked.signal;
        } else if (timeoutController) {
            fetchSignal = timeoutController.signal;
        }

        try {
            const res = await fetch(interactionsUrl(), {
                method: 'POST',
                headers: interactionsHeaders(apiKey),
                body: JSON.stringify(body),
                signal: fetchSignal || undefined
            });

            if (proxyDidNotAnswer(res)) {
                throw proxyMissingError(res, context);
            }

            const data = await parseJsonResponseSafe(res);

            if (!res.ok) {
                throw new Error(formatApiError(data, context));
            }

            return data;
        } catch (err) {
            const userCancelled = signal?.aborted && !(timeoutController?.signal?.aborted);
            if (userCancelled) {
                throw wrapFetchError(err, context, { cancelled: true });
            }
            if (err.name === 'AbortError' && timeoutController?.signal?.aborted) {
                // `return` here resolved the call *with* an Error object, so the caller
                // found no image and reported "the API completed but no image data came
                // back" — discarding the one message that says what actually happened.
                throw wrapFetchError(err, `${context}: timed out after 5 minutes — Nano Banana can be slow; try Nano Banana 2 Lite for faster tests`);
            }
            throw wrapFetchError(err, context);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function thinkingViaGenerateContent({ apiKey, model, systemInstruction, userParts, jsonMode, signal }) {
        const body = {
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: 'user', parts: userParts }]
        };
        if (jsonMode) {
            body.generationConfig = { responseMimeType: 'application/json' };
        }

        const url = `${BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: signal || undefined
            });

            const data = await parseJsonResponseSafe(res);
            if (!res.ok) throw new Error(formatApiError(data, `Thinking model (${model})`));

            const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
            if (!text) throw new Error(`Empty response from thinking model: ${model}`);
            return text;
        } catch (err) {
            if (signal?.aborted) throw wrapFetchError(err, `Thinking model (${model})`, { cancelled: true });
            throw err;
        }
    }

    async function thinkingViaInteractions({ apiKey, model, systemInstruction, userParts, jsonMode, signal }) {
        const body = {
            model,
            system_instruction: systemInstruction,
            input: partsToInteractionInput(userParts)
        };

        if (jsonMode) {
            body.response_format = {
                type: 'text',
                mime_type: 'application/json'
            };
        }

        const data = await interactionsCreate(apiKey, body, {
            context: `Thinking model (${model})`,
            signal
        });

        const text = extractInteractionText(data);
        if (!text) throw new Error(`Empty response from thinking model: ${model}`);
        return text;
    }

    function spendMeta(kind, model, provider) {
        if (kind === 'image') return MirageModels.getImageModel(model, provider);
        return MirageModels.getThinkingModel(model, provider);
    }

    function spendEstimate(kind, meta) {
        if (kind === 'image') return MirageModels.imageTurnEstimate?.(meta) || null;
        return MirageModels.thinkingTurnEstimate?.(meta) || null;
    }

    function formatSpendCredits(n) {
        const fmt = MirageModels.formatCreditAmount?.(n);
        if (fmt) return fmt;
        const v = Number(n);
        if (!Number.isFinite(v)) return '';
        return String(Math.round(v * 100) / 100);
    }

    async function snapshotKieCredits(apiKey, { force = false } = {}) {
        if (!apiKey || typeof MirageKieAPI?.getCredits !== 'function') return null;
        if (!force && Number.isFinite(Number(MirageKieAPI.peekCredits?.()))) {
            return Number(MirageKieAPI.peekCredits());
        }
        try {
            return await MirageKieAPI.getCredits(apiKey);
        } catch {
            return Number.isFinite(Number(MirageKieAPI.peekCredits?.()))
                ? Number(MirageKieAPI.peekCredits())
                : null;
        }
    }

    function logSpendNotice({
        kind,
        action,
        meta,
        spent,
        estimated,
        ok,
        before,
        after
    }) {
        const label = meta?.label || meta?.id || kind;
        const amount = formatSpendCredits(spent);
        const crBit = !amount
            ? 'credits unknown'
            : (estimated ? `~${amount} cr (est)` : `${amount} cr`);
        const failBit = ok ? '' : ' · failed';
        if (typeof global.MirageDebugPanel?.pushNotice !== 'function') return;
        global.MirageDebugPanel.pushNotice({
            kind: 'spend',
            tone: ok ? 'info' : 'error',
            summary: `${action} · ${label} · ${crBit}${failBit}`,
            creditsLabel: amount ? `${estimated ? '~' : ''}${amount} cr` : null,
            creditsEst: !!estimated,
            detail: {
                kind,
                model: meta?.id || null,
                spent: spent ?? null,
                estimated: !!estimated,
                before: before ?? null,
                after: after ?? null,
                ok: !!ok
            }
        });
    }

    async function withSpendLog({ kind, action, model, provider, apiKey, run }) {
        const resolvedProvider = MirageModels.normalizeProvider(
            provider
            || (typeof EngineState !== 'undefined' && EngineState.apiProvider)
            || 'google'
        );
        const meta = spendMeta(kind, model, resolvedProvider);
        const est = spendEstimate(kind, meta);
        const kie = resolvedProvider === 'kie' && !!apiKey;
        let before = null;
        if (kie) before = await snapshotKieCredits(apiKey, { force: false });

        let ok = false;
        try {
            const result = await run();
            ok = true;
            return result;
        } finally {
            // Don't hold the turn on the credits snapshot — kie balance can lag
            // several seconds after a long thinking call.
            const capturedOk = ok;
            void (async () => {
                let after = null;
                let spent = null;
                let estimated = true;
                if (kie) {
                    after = await snapshotKieCredits(apiKey, { force: true });
                    if (before != null && after != null) {
                        spent = Math.round((Number(before) - Number(after)) * 100) / 100;
                        if (spent > 0.001) estimated = false;
                    }
                }
                const billed = !estimated && spent > 0.001;
                if (!billed && capturedOk && Number.isFinite(Number(est?.credits))) {
                    spent = Number(est.credits);
                    estimated = true;
                }
                if (capturedOk || billed) {
                    logSpendNotice({
                        kind,
                        action,
                        meta,
                        spent,
                        estimated,
                        ok: capturedOk,
                        before,
                        after
                    });
                }
            })().catch(() => { /* spend log is best-effort */ });
        }
    }

    async function thinkingGenerate({
        apiKey,
        model,
        systemInstruction,
        userParts,
        jsonMode = false,
        signal,
        forceReal = false,
        provider = null
    }) {
        if (!forceReal && global.MirageMockAPI?.isActiveThinking?.()) {
            return global.MirageMockAPI.mockThinkingGenerate({ userParts, signal });
        }

        const resolvedProvider = MirageModels.normalizeProvider(
            provider
            || (typeof EngineState !== 'undefined' && EngineState.apiProvider)
            || 'google'
        );

        return withSpendLog({
            kind: 'thinking',
            action: 'Thinking',
            model,
            provider: resolvedProvider,
            apiKey,
            run: () => {
                if (resolvedProvider === 'kie') {
                    return MirageKieAPI.thinkingGenerate({
                        apiKey,
                        model,
                        systemInstruction,
                        userParts,
                        jsonMode,
                        signal
                    });
                }

                const resolved = MirageModels.resolveThinkingModel(model, 'google');

                if (MirageModels.usesGenerateContent(resolved, 'google')) {
                    return thinkingViaGenerateContent({
                        apiKey,
                        model: resolved,
                        systemInstruction,
                        userParts,
                        jsonMode,
                        signal
                    });
                }

                return thinkingViaInteractions({
                    apiKey,
                    model: resolved,
                    systemInstruction,
                    userParts,
                    jsonMode,
                    signal
                });
            }
        });
    }

    async function imageGenerate({
        apiKey,
        model,
        systemInstruction,
        imagePrompt,
        imageDirective = null,
        referenceImages = [],
        referenceRoles = null,
        aspectRatio = IMAGE_ASPECT_RATIO,
        imageSize = IMAGE_OUTPUT_SIZE,
        timeoutMs = IMAGE_TEST_TIMEOUT_MS,
        signal,
        forceReal = false,
        provider = null
    }) {
        if (!forceReal && global.MirageMockAPI?.isActiveImages?.()) {
            return global.MirageMockAPI.mockImageGenerate({
                imagePrompt,
                imageDirective,
                signal
            });
        }

        const resolvedProvider = MirageModels.normalizeProvider(
            provider
            || (typeof EngineState !== 'undefined' && EngineState.apiProvider)
            || 'google'
        );

        return withSpendLog({
            kind: 'image',
            action: 'Image',
            model,
            provider: resolvedProvider,
            apiKey,
            run: async () => {
                if (resolvedProvider === 'kie') {
                    return MirageKieAPI.imageGenerate({
                        apiKey,
                        model,
                        systemInstruction,
                        imagePrompt,
                        referenceImages,
                        referenceRoles,
                        aspectRatio,
                        imageSize,
                        timeoutMs,
                        signal
                    });
                }

                const meta = MirageModels.getImageModel(model, 'google');
                const resolvedModel = meta.id;
                const size = IMAGE_OUTPUT_SIZE;
                const ratio = IMAGE_ASPECT_RATIO;

                const input = [{ type: 'text', text: imagePrompt }];
                for (const file of referenceImages) {
                    if (file) input.push(await fileToInteractionImage(file));
                }

                const body = {
                    model: resolvedModel,
                    system_instruction: systemInstruction,
                    input,
                    response_format: {
                        type: 'image',
                        mime_type: 'image/jpeg',
                        aspect_ratio: ratio,
                        image_size: size
                    }
                };

                const data = await interactionsCreate(apiKey, body, {
                    timeoutMs,
                    context: `Image model (${meta.label})`,
                    signal
                });

                if (data.status && data.status !== 'completed') {
                    throw new Error(`Image generation status: ${data.status}`);
                }

                const imageUrl = extractInteractionImage(data);
                if (!imageUrl) {
                    throw new Error(`No image returned from ${meta.label} (${resolvedModel})`);
                }
                return imageUrl;
            }
        });
    }

    async function testApiKey(apiKey, provider = null) {
        const resolvedProvider = MirageModels.normalizeProvider(
            provider
            || (typeof EngineState !== 'undefined' && EngineState.apiProvider)
            || 'google'
        );
        if (resolvedProvider === 'kie') {
            return MirageKieAPI.testApiKey(apiKey);
        }
        const res = await fetch(`${BASE}/models?key=${encodeURIComponent(apiKey)}`);
        if (!res.ok) {
            const err = await parseJsonResponseSafe(res);
            throw new Error(err?.error?.message || 'Invalid API key');
        }
        return true;
    }

    async function listModels(apiKey) {
        const res = await fetch(`${BASE}/models?key=${encodeURIComponent(apiKey)}`);
        if (!res.ok) throw new Error('Failed to list models');
        const data = await parseJsonResponseSafe(res);
        return (data.models || []).map(m => ({
            id: m.name.replace('models/', ''),
            methods: m.supportedGenerationMethods || []
        }));
    }

    async function testThinkingModel(apiKey, model, provider = null) {
        const resolvedProvider = MirageModels.normalizeProvider(
            provider
            || (typeof EngineState !== 'undefined' && EngineState.apiProvider)
            || 'google'
        );
        const resolved = MirageModels.resolveThinkingModel(model, resolvedProvider);
        const sys = MiragePrompt.buildThinkingSystemInstruction('setup', { phase: 'test' });
        const text = await thinkingGenerate({
            apiKey,
            model: resolved,
            systemInstruction: sys,
            userParts: [{ text: 'Reply with exactly: MIRAGE_OK' }],
            forceReal: true,
            provider: resolvedProvider
        });
        if (!text.trim()) {
            throw new Error(`Thinking model (${resolved}) returned empty response`);
        }
        return { model: resolved, text: text.trim().slice(0, 80), provider: resolvedProvider };
    }

    async function testImageModel(apiKey, model, provider = null) {
        const resolvedProvider = MirageModels.normalizeProvider(
            provider
            || (typeof EngineState !== 'undefined' && EngineState.apiProvider)
            || 'google'
        );
        const meta = MirageModels.getImageModel(model, resolvedProvider);
        const sys = 'Generate a simple test photo.';
        const prompt = 'Simple portrait, neutral background, 9:16 vertical.';

        await imageGenerate({
            apiKey,
            model: meta.id,
            systemInstruction: sys,
            imagePrompt: prompt,
            referenceImages: [],
            aspectRatio: '9:16',
            imageSize: '1K',
            timeoutMs: IMAGE_TEST_TIMEOUT_MS,
            forceReal: true,
            provider: resolvedProvider
        });

        return { model: meta.id, label: meta.label, provider: resolvedProvider };
    }

    global.MirageAPI = {
        BASE,
        IMAGE_TEST_TIMEOUT_MS,
        IMAGE_ASPECT_RATIO,
        IMAGE_OUTPUT_SIZE,
        thinkingGenerate,
        imageGenerate,
        interactionsCreate,
        testApiKey,
        testThinkingModel,
        testImageModel,
        listModels,
        parseJsonResponse,
        looksLikeSafetyRejection,
        extractJsonPayload,
        stripJsonFences,
        fileToInlinePart,
        fileToInteractionImage,
        readFileBase64,
        extractInteractionImage,
        extractInteractionText,
        partsToInteractionInput,
        classifyImageError,
        imageFailureMessage
    };
})(typeof window !== 'undefined' ? window : globalThis);
