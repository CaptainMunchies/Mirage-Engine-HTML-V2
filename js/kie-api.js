/**
 * MIRAGE ENGINE — kie.ai provider (cheaper Market API)
 * Thinking: OpenAI chat completions OR Grok /v1/responses via local proxy
 * Images: upload refs → createTask → poll recordInfo → fetch result
 */
(function (global) {
    'use strict';

    const PROXY_PORT = 8080;
    const DEFAULT_TIMEOUT_MS = 300000;

    /**
     * Poll backoff. A flat 2.5s meant up to ~120 proxied round-trips per image, all of
     * them pointless for the first minute of a generation that typically takes longer
     * than that. Stay responsive early — a fast model can finish in seconds — then ease
     * off, capping at 10s so a finished job is still noticed promptly.
     */
    const POLL_START_MS = 1500;
    const POLL_MAX_MS = 10000;
    const POLL_GROWTH = 1.35;

    function nextPollDelay(current) {
        return Math.min(POLL_MAX_MS, Math.round((current || POLL_START_MS) * POLL_GROWTH));
    }

    /** Poll chatter is useful when a generation misbehaves and noise otherwise. */
    function pollLog(...args) {
        if (global.EngineState?.developerMode) console.log(...args);
    }

    const ASPECT_FALLBACKS = {
        '1:1': '1:1',
        '2:3': '2:3',
        '3:2': '3:2',
        '3:4': '3:4',
        '4:3': '4:3',
        '9:16': '9:16',
        '16:9': '16:9',
        '21:9': '21:9'
    };

    function usingLocalProxy() {
        const host = location.hostname;
        return host === 'localhost' || host === '127.0.0.1';
    }

    function requireProxy(context) {
        if (usingLocalProxy()) return;
        throw new Error(
            `${context}: kie.ai requires the local Mirage proxy. `
            + `Run START MIRAGE.bat and open http://localhost:${PROXY_PORT}.`
        );
    }

    function proxyMissingError(res, context) {
        const portHint = location.port && location.port !== String(PROXY_PORT)
            ? ` This page is on port ${location.port}; proxy listens on ${PROXY_PORT}.`
            : '';
        return new Error(
            `${context}: no Mirage kie proxy at ${location.origin} (HTTP ${res.status}).${portHint}`
            + ` Close this tab, run START MIRAGE.bat, reopen http://localhost:${PROXY_PORT}.`
        );
    }

    function proxyDidNotAnswer(res) {
        return usingLocalProxy() && !/json/i.test(res.headers.get('Content-Type') || '');
    }

    async function parseJsonSafe(res) {
        const text = await res.text();
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            const low = String(text || '').toLowerCase();
            if (res.status === 403 && (low.includes('1010') || low.includes('browser'))) {
                throw new Error(
                    'kie Cloudflare blocked the proxy (error 1010). Restart START MIRAGE.bat — '
                    + 'Python urllib was being banned for its User-Agent.'
                );
            }
            throw new Error(`Invalid kie response (${res.status}): ${text.slice(0, 200)}`);
        }
    }

    function formatKieError(data, context, status) {
        const msg = data?.msg
            || data?.error?.message
            || data?.message
            || (typeof data?.error === 'string' ? data.error : null)
            || `HTTP ${status}`;
        return `${context}: ${msg}`;
    }

    async function proxyFetch(path, { apiKey, method = 'GET', body, signal, formData } = {}) {
        requireProxy('kie.ai');
        const baseHeaders = { 'X-Mirage-Api-Key': apiKey };
        if (!formData) baseHeaders['Content-Type'] = 'application/json';

        const send = async () => {
            // The proxy rejects anything without this run's token, which is what keeps
            // other sites in the browser from using it.
            const headers = await MirageProxySession.withSession(baseHeaders);
            return fetch(path, {
                method,
                headers,
                body: formData || (body != null ? JSON.stringify(body) : undefined),
                signal: signal || undefined
            });
        };

        let res = await send();
        if (res.status === 403) {
            // A server restart mints a new token; refetch once before giving up.
            MirageProxySession.invalidate();
            res = await send();
        }

        if (proxyDidNotAnswer(res)) {
            throw proxyMissingError(res, 'kie.ai');
        }

        return res;
    }

    async function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                const err = new Error('Cancelled');
                err.name = 'AbortError';
                reject(err);
                return;
            }
            const t = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
                clearTimeout(t);
                const err = new Error('Cancelled');
                err.name = 'AbortError';
                reject(err);
            }, { once: true });
        });
    }

    function normalizeAspect(ratio, allowList) {
        const raw = String(ratio || '9:16').trim();
        const mapped = ASPECT_FALLBACKS[raw] || raw;
        if (Array.isArray(allowList) && allowList.length) {
            if (allowList.includes(mapped)) return mapped;
            // Prefer portrait phone frame when unsupported
            if (allowList.includes('9:16')) return '9:16';
            if (allowList.includes('2:3')) return '2:3';
            return allowList[0];
        }
        return mapped;
    }

    function partsToOpenAIContent(userParts) {
        const content = [];
        for (const part of userParts || []) {
            if (part.text) {
                content.push({ type: 'text', text: part.text });
            } else if (part.inlineData?.data) {
                const mime = part.inlineData.mimeType || 'image/jpeg';
                content.push({
                    type: 'image_url',
                    image_url: {
                        url: `data:${mime};base64,${part.inlineData.data}`
                    }
                });
            }
        }
        return content.length ? content : [{ type: 'text', text: '' }];
    }

    function partsToGrokContent(userParts) {
        const content = [];
        for (const part of userParts || []) {
            if (part.text) {
                content.push({ type: 'input_text', text: part.text });
            } else if (part.inlineData?.data) {
                const mime = part.inlineData.mimeType || 'image/jpeg';
                content.push({
                    type: 'input_image',
                    image_url: `data:${mime};base64,${part.inlineData.data}`
                });
            }
        }
        return content.length ? content : [{ type: 'input_text', text: '' }];
    }

    function coerceMessageText(raw) {
        let text = raw;
        if (Array.isArray(text)) {
            text = text.map(part => {
                if (typeof part === 'string') return part;
                if (part?.type === 'text' && part.text) return part.text;
                if (part?.type === 'output_text' && part.text) return part.text;
                if (part?.text) return part.text;
                return '';
            }).filter(Boolean).join('\n');
        }
        return String(text || '').trim();
    }

    /** Pull assistant text from kie OpenAI-compat / Gemini-shaped chat payloads. */
    function extractOpenAIChatText(data) {
        const finish = String(
            data?.choices?.[0]?.finish_reason
            || data?.candidates?.[0]?.finishReason
            || ''
        ).toLowerCase();
        if (/content_?filter|safety|blocked/.test(finish)) {
            const err = new Error(
                coerceMessageText(data?.choices?.[0]?.message?.refusal)
                || coerceMessageText(data?.choices?.[0]?.message?.content)
                || `Thinking blocked by safety filter (finish: ${finish})`
            );
            err.code = 'SAFETY';
            throw err;
        }

        const msg = data?.choices?.[0]?.message;
        if (msg) {
            const fromContent = coerceMessageText(msg.content);
            if (fromContent) {
                if (typeof MirageAPI?.looksLikeSafetyRejection === 'function'
                    && MirageAPI.looksLikeSafetyRejection(fromContent)) {
                    const err = new Error(fromContent.slice(0, 320));
                    err.code = 'SAFETY';
                    throw err;
                }
                return fromContent;
            }
            // Do NOT treat refusal as successful model output — that becomes fake "JSON"
            const refusal = coerceMessageText(msg.refusal);
            if (refusal) {
                const err = new Error(refusal.slice(0, 320));
                err.code = 'SAFETY';
                throw err;
            }
            for (const key of ['reasoning_content', 'reasoning', 'output_text']) {
                const alt = coerceMessageText(msg[key]);
                if (alt) return alt;
            }
        }
        const fromCandidates = (data?.candidates?.[0]?.content?.parts || [])
            .map(p => (typeof p?.text === 'string' ? p.text : ''))
            .filter(Boolean)
            .join('\n')
            .trim();
        if (fromCandidates) {
            if (typeof MirageAPI?.looksLikeSafetyRejection === 'function'
                && MirageAPI.looksLikeSafetyRejection(fromCandidates)) {
                const err = new Error(fromCandidates.slice(0, 320));
                err.code = 'SAFETY';
                throw err;
            }
            return fromCandidates;
        }
        if (typeof data?.output_text === 'string' && data.output_text.trim()) {
            return data.output_text.trim();
        }
        return '';
    }

    function extractGrokResponseText(data) {
        if (typeof data?.output_text === 'string' && data.output_text.trim()) {
            return data.output_text.trim();
        }
        const chunks = [];
        for (const item of data?.output || []) {
            if (!item || item.type === 'reasoning') continue;
            if (typeof item.text === 'string') chunks.push(item.text);
            for (const block of item.content || []) {
                if (block?.type === 'output_text' && block.text) chunks.push(block.text);
                else if (block?.text) chunks.push(block.text);
            }
        }
        if (chunks.length) return chunks.join('\n').trim();
        return extractOpenAIChatText(data);
    }

    async function thinkingViaOpenAIChat({ apiKey, meta, systemInstruction, userParts, jsonMode, signal }) {
        const messages = [];
        if (systemInstruction) {
            messages.push({
                role: 'system',
                content: [{ type: 'text', text: systemInstruction }]
            });
        }
        messages.push({
            role: 'user',
            content: partsToOpenAIContent(userParts)
        });

        const path = meta.chatPath || '/gemini-3-5-flash-openai/v1/chat/completions';

        async function postOnce(useJsonFormat) {
            const body = {
                model: meta.kieModel || meta.id,
                messages,
                stream: false,
                include_thoughts: false
            };
            if (useJsonFormat) {
                body.response_format = { type: 'json_object' };
            }

            const res = await proxyFetch('/api/proxy/kie/chat', {
                apiKey,
                method: 'POST',
                body: { path, payload: body },
                signal
            });
            const data = await parseJsonSafe(res);
            return { res, data };
        }

        let { res, data } = await postOnce(!!jsonMode);
        if (!res.ok) {
            // json_object sometimes rejected — retry plain
            if (jsonMode) {
                console.warn('[Mirage kie] OpenAI-chat json format rejected, retrying without response_format', data);
                ({ res, data } = await postOnce(false));
            }
            if (!res.ok) {
                throw new Error(formatKieError(data, `kie thinking (${meta.label})`, res.status));
            }
        }

        let text = extractOpenAIChatText(data);
        if (!text && jsonMode) {
            console.warn('[Mirage kie] Empty OpenAI-chat content with json_object — retrying without response_format', {
                model: meta.id,
                finish: data?.choices?.[0]?.finish_reason,
                keys: data ? Object.keys(data) : []
            });
            ({ res, data } = await postOnce(false));
            if (!res.ok) {
                throw new Error(formatKieError(data, `kie thinking (${meta.label})`, res.status));
            }
            text = extractOpenAIChatText(data);
        }

        if (!text) {
            const finish = data?.choices?.[0]?.finish_reason || data?.candidates?.[0]?.finishReason || '';
            console.error('[Mirage kie] Empty thinking response', meta.id, { finish, data });
            const err = new Error(
                `Empty response from kie thinking model: ${meta.id}`
                + (finish ? ` (finish: ${finish})` : '')
                + '. Retry the turn, or switch thinking model in Settings.'
            );
            err.code = 'EMPTY_THINKING';
            throw err;
        }
        return text;
    }

    async function thinkingViaResponsesApi({ apiKey, meta, systemInstruction, userParts, jsonMode, signal }) {
        const input = [];
        if (systemInstruction) {
            input.push({
                role: 'system',
                content: [{ type: 'input_text', text: systemInstruction }]
            });
        }
        input.push({
            role: 'user',
            content: partsToGrokContent(userParts)
        });

        const body = {
            model: meta.kieModel || meta.id,
            stream: false,
            input
        };
        if (meta.reasoningEffort) {
            body.reasoning = { effort: meta.reasoningEffort };
        }
        // Prefer plain JSON object mode when available; Mirage already asks for JSON in the prompt.
        if (jsonMode) {
            body.text = {
                format: { type: 'json_object' }
            };
        }

        const path = meta.chatPath || '/grok/v1/responses';
        const res = await proxyFetch('/api/proxy/kie/chat', {
            apiKey,
            method: 'POST',
            body: { path, payload: body },
            signal
        });

        const data = await parseJsonSafe(res);
        if (!res.ok) {
            // Some Responses deployments reject json_object — retry once without format
            if (jsonMode && body.text) {
                console.warn('[Mirage kie] Responses json format rejected, retrying without text.format', data);
                delete body.text;
                const retry = await proxyFetch('/api/proxy/kie/chat', {
                    apiKey,
                    method: 'POST',
                    body: { path, payload: body },
                    signal
                });
                const retryData = await parseJsonSafe(retry);
                if (!retry.ok) {
                    throw new Error(formatKieError(retryData, `kie thinking (${meta.label})`, retry.status));
                }
                const retryText = extractGrokResponseText(retryData);
                if (!retryText) throw new Error(`Empty response from kie thinking model: ${meta.id}`);
                return retryText;
            }
            throw new Error(formatKieError(data, `kie thinking (${meta.label})`, res.status));
        }

        const text = extractGrokResponseText(data);
        if (!text) {
            throw new Error(`Empty response from kie thinking model: ${meta.id}`);
        }
        return text;
    }

    async function thinkingGenerate({
        apiKey,
        model,
        systemInstruction,
        userParts,
        jsonMode = false,
        signal
    }) {
        const meta = MirageModels.getThinkingModel(model, 'kie');
        if (meta.apiStyle === 'responses' || meta.apiStyle === 'grok-responses') {
            return thinkingViaResponsesApi({
                apiKey, meta, systemInstruction, userParts, jsonMode, signal
            });
        }
        return thinkingViaOpenAIChat({
            apiKey, meta, systemInstruction, userParts, jsonMode, signal
        });
    }

    async function uploadFileBase64(apiKey, file, signal) {
        const base64 = await MirageAPI.readFileBase64(file);
        const mime = file.type || 'image/jpeg';
        const name = (file.name || 'ref.jpg').replace(/[^\w.\-]+/g, '_');
        console.log('[Mirage kie] uploading reference', name, mime);
        const res = await proxyFetch('/api/proxy/kie/upload', {
            apiKey,
            method: 'POST',
            body: {
                base64Data: `data:${mime};base64,${base64}`,
                uploadPath: 'mirage-refs',
                fileName: `${Date.now()}-${name}`
            },
            signal
        });
        const data = await parseJsonSafe(res);
        if (!res.ok || data?.success === false || (data.code != null && data.code !== 200)) {
            throw new Error(formatKieError(data, 'kie file upload', res.status));
        }
        const url = data?.data?.fileUrl || data?.data?.downloadUrl || data?.fileUrl;
        if (!url) {
            console.error('[Mirage kie] upload response missing fileUrl', data);
            throw new Error('kie file upload returned no fileUrl');
        }
        console.log('[Mirage kie] upload ok', String(url).slice(0, 96));
        return url;
    }

    /**
     * Compact photographic prompt for Market image models (many cap ~5–10k chars).
     */
    function buildKieImagePrompt(systemInstruction, imagePrompt, {
        hasRefs = false,
        maxLen = 9500,
        mentionRefs = false,
        referenceRoles = null,
        liteLock = false
    } = {}) {
        const main = String(imagePrompt || '').trim();
        const bits = [];
        const roles = Array.isArray(referenceRoles) ? referenceRoles : null;
        if (liteLock) {
            bits.push(
                'LENS LOCK: You ARE her front camera. Do not draw a phone, case, or screen in her hands. '
                + 'Mirror Selfie exception: one small phone in the reflection only. No second device. She looks into THIS lens.'
            );
        }
        if (hasRefs) {
            bits.push(
                'IDENTITY LOCK: reproduce the FACE reference feature-for-feature — eyes, nose, mouth, jaw, bone structure, skin tone. '
                + 'Do not generate a celebrity lookalike or a beautified influencer version — trace THIS photo. '
                + 'Facial accuracy outranks pose, outfit, and atmosphere. Front-camera selfie only — do not draw a phone in her hands.'
            );
            if (mentionRefs) {
                if (roles?.length) {
                    roles.forEach((role, i) => {
                        const tag = `@image${i + 1}`;
                        if (role === 'FACE') bits.push(`${tag} is the identity / face reference — copy these features exactly. Do not beautify or substitute a lookalike.`);
                        else if (role === 'BODY') bits.push(`${tag} is body proportions only — ignore its face and outfit.`);
                        else if (role === 'SCENE') {
                            bits.push(
                                `${tag} is SCENE continuity (wardrobe + environment only) — `
                                + 'ignore its face, body, pose, and any phone/device in her hands; FACE/BODY refs win identity.'
                            );
                        } else if (role === 'OUTFIT') bits.push(`${tag} is wardrobe only — ignore its face and body.`);
                    });
                } else {
                    bits.push('@image1 is the identity / face reference.');
                }
            } else if (roles?.includes('SCENE')) {
                bits.push(
                    'SCENE reference is wardrobe + environment continuity only — '
                    + 'never inherit face, body, pose, or any phone/device in her hands; FACE/BODY refs win identity.'
                );
            }
        }
        bits.push('No text, captions, watermarks, or UI overlays in the image.');
        if (typeof MiragePhoneUX?.timeOfDayLock === 'function') {
            const tod = MiragePhoneUX.timeOfDayLock();
            if (tod?.line) bits.push(tod.line);
        }
        if (main) bits.push(main);

        let joined = bits.join('\n\n');
        if (joined.length < maxLen * 0.55 && systemInstruction) {
            const sys = String(systemInstruction).replace(/\s+/g, ' ').trim().slice(0, 1200);
            if (sys) joined = `${joined}\n\nRENDER NOTES: ${sys}`;
        }
        return joined.length > maxLen ? `${joined.slice(0, maxLen - 1)}…` : joined;
    }

    function resolveJobModel(meta, hasRefs) {
        if (hasRefs && meta.i2iModel) return meta.i2iModel;
        if (!hasRefs && meta.t2iModel) return meta.t2iModel;
        return meta.id;
    }

    function buildImageInput(meta, {
        prompt,
        imageUrls,
        aspectRatio,
        resolution
    }) {
        const family = meta.family || 'nano';
        const refs = (imageUrls || []).filter(Boolean)
            .slice(0, Math.max(0, Number.isFinite(meta.maxCharacterRefs) ? meta.maxCharacterRefs : 8));
        const hasRefs = refs.length > 0;
        const ratio = normalizeAspect(aspectRatio, meta.aspectAllow);
        const res = resolution === '2K' || resolution === '4K' ? '2K' : '1K';
        const input = { prompt };

        if (family === 'nano') {
            input.aspect_ratio = ratio;
            input.resolution = res;
            input.output_format = 'png';
            if (hasRefs) input[meta.refField || 'image_input'] = refs;
        } else if (family === 'nano-lite') {
            input.aspect_ratio = ratio;
            if (hasRefs) input[meta.refField || 'image_urls'] = refs;
        } else if (family === 'qwen') {
            input.image_size = ratio;
            input.resolution = res;
            input.output_format = 'png';
            if (hasRefs) input.image_urls = refs;
        } else if (family === 'gpt-image') {
            input.aspect_ratio = ratio;
            input.resolution = '1K';
            if (hasRefs) input.input_urls = refs;
        } else if (family === 'seedream') {
            input.aspect_ratio = ratio;
            input.quality = res === '2K' ? 'high' : 'basic';
            input.output_format = 'png';
            if (hasRefs) input.image_urls = refs;
        } else if (family === 'wan') {
            input.aspect_ratio = ratio;
            input.resolution = res === '2K' ? '2K' : '1K';
            input.n = 1;
            input.enable_sequential = false;
            if (hasRefs) input.input_urls = refs;
        } else if (family === 'grok-imagine') {
            if (hasRefs) {
                input.image_urls = refs;
            } else {
                input.aspect_ratio = ratio;
            }
            if (meta.forceEnablePro || res === '2K') input.enable_pro = true;
        } else if (family === 'flux-kontext') {
            // Flux Kontext uses a different API shape; buildImageInput is unused for jobs.
            input.aspect_ratio = ratio;
            if (hasRefs) input.inputImage = refs[0];
        } else {
            input.aspect_ratio = ratio;
            if (hasRefs) input[meta.refField || 'image_input'] = refs;
        }

        return { jobModel: resolveJobModel(meta, hasRefs), input, refs };
    }

    async function createFluxKontextTask(apiKey, {
        prompt,
        imageUrl,
        aspectRatio,
        resolution,
        signal
    }) {
        const meta = MirageModels.getImageModel('flux-kontext', 'kie');
        const ratio = normalizeAspect(aspectRatio, meta.aspectAllow);
        const useMax = resolution === '2K' || resolution === '4K';
        const body = {
            prompt,
            enableTranslation: true,
            outputFormat: 'png',
            aspectRatio: ratio,
            model: useMax
                ? (meta.kontextModelMax || 'flux-kontext-max')
                : (meta.kontextModel || 'flux-kontext-pro')
        };
        if (imageUrl) body.inputImage = imageUrl;

        console.log('[Mirage kie] flux-kontext generate', {
            model: body.model,
            hasInputImage: !!imageUrl,
            aspectRatio: ratio
        });

        const res = await proxyFetch('/api/proxy/kie/flux-kontext', {
            apiKey,
            method: 'POST',
            body,
            signal
        });
        const data = await parseJsonSafe(res);
        if (!res.ok || (data.code != null && data.code !== 200)) {
            console.error('[Mirage kie] flux-kontext create failed', res.status, data);
            throw new Error(formatKieError(data, 'kie Flux Kontext', res.status));
        }
        const taskId = data?.data?.taskId;
        if (!taskId) throw new Error('kie Flux Kontext: no taskId returned');
        return taskId;
    }

    async function pollFluxKontextTask(apiKey, taskId, { timeoutMs, signal } = {}) {
        const deadline = Date.now() + (timeoutMs || DEFAULT_TIMEOUT_MS);
        let delay = POLL_START_MS;
        let lastFlag;
        while (Date.now() < deadline) {
            if (signal?.aborted) {
                const err = new Error('Cancelled');
                err.name = 'AbortError';
                throw err;
            }
            const res = await proxyFetch(
                `/api/proxy/kie/flux-kontext/status?taskId=${encodeURIComponent(taskId)}`,
                { apiKey, method: 'GET', signal }
            );
            const data = await parseJsonSafe(res);
            if (!res.ok && res.status !== 422) {
                throw new Error(formatKieError(data, 'kie Flux Kontext status', res.status));
            }
            const flag = data?.data?.successFlag;
            if (flag !== lastFlag) {
                pollLog('[Mirage kie] flux-kontext state', taskId, flag);
                lastFlag = flag;
            }
            if (flag === 1) return data.data;
            if (flag === 2 || flag === 3) {
                const failMsg = data?.data?.errorMessage || data?.data?.errorCode || data?.msg || 'unknown';
                throw new Error(`kie Flux Kontext failed: ${failMsg}`);
            }
            await sleep(delay, signal);
            delay = nextPollDelay(delay);
        }
        throw new Error('kie Flux Kontext timed out waiting for task completion');
    }

    async function createImageTask(apiKey, { model, prompt, imageUrls, aspectRatio, resolution, signal }) {
        const meta = MirageModels.getImageModel(model, 'kie');
        const { jobModel, input, refs } = buildImageInput(meta, {
            prompt,
            imageUrls,
            aspectRatio,
            resolution
        });

        console.log('[Mirage kie] createTask', {
            uiModel: meta.id,
            jobModel,
            family: meta.family,
            promptLen: prompt.length,
            refs: refs.length,
            inputKeys: Object.keys(input)
        });

        const res = await proxyFetch('/api/proxy/kie/jobs', {
            apiKey,
            method: 'POST',
            body: {
                model: jobModel,
                input
            },
            signal
        });
        const data = await parseJsonSafe(res);
        if (!res.ok || (data.code != null && data.code !== 200)) {
            console.error('[Mirage kie] createTask failed', res.status, data);
            throw new Error(formatKieError(data, `kie image (${meta.label})`, res.status));
        }
        const taskId = data?.data?.taskId;
        if (!taskId) {
            console.error('[Mirage kie] createTask missing taskId', data);
            throw new Error(`kie image (${meta.label}): no taskId returned`);
        }
        console.log('[Mirage kie] task created', taskId);
        return taskId;
    }

    async function pollTask(apiKey, taskId, { timeoutMs, signal } = {}) {
        const deadline = Date.now() + (timeoutMs || DEFAULT_TIMEOUT_MS);
        let delay = POLL_START_MS;
        let lastState;
        while (Date.now() < deadline) {
            if (signal?.aborted) {
                const err = new Error('Cancelled');
                err.name = 'AbortError';
                throw err;
            }
            const res = await proxyFetch(
                `/api/proxy/kie/jobs/status?taskId=${encodeURIComponent(taskId)}`,
                { apiKey, method: 'GET', signal }
            );
            const data = await parseJsonSafe(res);
            if (!res.ok && res.status !== 422) {
                throw new Error(formatKieError(data, 'kie task status', res.status));
            }
            const state = data?.data?.state;
            // Only on change — this used to print on every one of ~120 polls.
            if (state && state !== lastState) {
                pollLog('[Mirage kie] task state', taskId, state);
                lastState = state;
            }
            if (state === 'success') return data.data;
            if (state === 'fail') {
                const failMsg = data?.data?.failMsg || data?.data?.failCode || data?.msg || 'unknown';
                console.error('[Mirage kie] task failed', data?.data);
                throw new Error(`kie image failed: ${failMsg}`);
            }
            await sleep(delay, signal);
            delay = nextPollDelay(delay);
        }
        throw new Error('kie image timed out waiting for task completion');
    }

    function extractResultUrl(taskData) {
        let parsed = taskData?.resultJson;
        if (typeof parsed === 'string') {
            try {
                parsed = JSON.parse(parsed);
            } catch {
                parsed = null;
            }
        }
        const urls = parsed?.resultUrls || parsed?.result_urls || parsed?.urls;
        if (Array.isArray(urls) && urls[0]) return urls[0];
        if (typeof urls === 'string') return urls;
        if (parsed?.resultUrl) return parsed.resultUrl;
        return null;
    }

    async function fetchResultAsDataUrl(apiKey, imageUrl, signal) {
        console.log('[Mirage kie] fetching result image');
        const res = await proxyFetch('/api/proxy/kie/fetch-image', {
            apiKey,
            method: 'POST',
            body: { url: imageUrl },
            signal
        });
        const data = await parseJsonSafe(res);
        if (!res.ok) {
            throw new Error(formatKieError(data, 'kie image download', res.status));
        }
        if (!data?.dataUrl) throw new Error('kie image download returned no dataUrl');
        return data.dataUrl;
    }

    async function imageGenerate({
        apiKey,
        model,
        systemInstruction,
        imagePrompt,
        referenceImages = [],
        referenceRoles = null,
        aspectRatio = '9:16',
        imageSize = '1K',
        timeoutMs = DEFAULT_TIMEOUT_MS,
        signal
    }) {
        const meta = MirageModels.getImageModel(model, 'kie');
        const maxPrompt = Number.isFinite(meta.maxPrompt) ? meta.maxPrompt : 9500;

        const imageUrls = [];
        for (const file of referenceImages || []) {
            if (file) imageUrls.push(await uploadFileBase64(apiKey, file, signal));
        }

        const prompt = buildKieImagePrompt(systemInstruction, imagePrompt, {
            hasRefs: imageUrls.length > 0,
            maxLen: maxPrompt,
            mentionRefs: !!meta.mentionRefsInPrompt,
            referenceRoles,
            liteLock: meta.family === 'nano-lite'
        });
        if (!prompt.trim()) {
            throw new Error('kie image: empty prompt');
        }

        const resolution = imageSize === '2K' || imageSize === '4K' ? '2K' : '1K';

        if (meta.family === 'flux-kontext') {
            const taskId = await createFluxKontextTask(apiKey, {
                prompt,
                imageUrl: imageUrls[0] || null,
                aspectRatio,
                resolution,
                signal
            });
            const task = await pollFluxKontextTask(apiKey, taskId, { timeoutMs, signal });
            const resultUrl = task?.response?.resultImageUrl
                || task?.response?.originImageUrl
                || null;
            if (!resultUrl) {
                console.error('[Mirage kie] flux-kontext success but no result URL', task);
                throw new Error(`No image URL from kie (${meta.label})`);
            }
            return fetchResultAsDataUrl(apiKey, resultUrl, signal);
        }

        const taskId = await createImageTask(apiKey, {
            model: meta.id,
            prompt,
            imageUrls,
            aspectRatio,
            resolution,
            signal
        });

        const task = await pollTask(apiKey, taskId, { timeoutMs, signal });
        const resultUrl = extractResultUrl(task);
        if (!resultUrl) {
            console.error('[Mirage kie] success but no result URL', task);
            throw new Error(`No image URL from kie (${meta.label})`);
        }

        return fetchResultAsDataUrl(apiKey, resultUrl, signal);
    }

    async function testApiKey(apiKey) {
        const res = await proxyFetch('/api/proxy/kie/credits', {
            apiKey,
            method: 'GET'
        });
        const data = await parseJsonSafe(res);
        if (!res.ok) throw new Error(formatKieError(data, 'kie API key', res.status));
        return true;
    }

    function parseCreditsPayload(data) {
        if (data == null) return null;
        if (typeof data === 'number' && Number.isFinite(data)) return data;
        if (typeof data === 'string' && data.trim() && Number.isFinite(Number(data))) return Number(data);
        const inner = data.data != null ? data.data : data;
        if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
        if (inner && typeof inner === 'object') {
            const n = inner.credits ?? inner.credit ?? inner.balance ?? inner.remaining;
            if (Number.isFinite(Number(n))) return Number(n);
        }
        return null;
    }

    let lastKnownCredits = null;

    function noteBalance(n) {
        const v = Number(n);
        if (Number.isFinite(v)) lastKnownCredits = v;
        return lastKnownCredits;
    }

    function peekCredits() {
        return lastKnownCredits;
    }

    async function getCredits(apiKey) {
        const res = await proxyFetch('/api/proxy/kie/credits', {
            apiKey,
            method: 'GET'
        });
        const data = await parseJsonSafe(res);
        if (!res.ok) throw new Error(formatKieError(data, 'kie credits', res.status));
        const n = parseCreditsPayload(data);
        if (n == null) throw new Error('kie credits response missing balance');
        noteBalance(n);
        return n;
    }

    global.MirageKieAPI = {
        thinkingGenerate,
        imageGenerate,
        testApiKey,
        getCredits,
        peekCredits,
        noteBalance,
        usingLocalProxy,
        buildKieImagePrompt
    };
})(typeof window !== 'undefined' ? window : globalThis);
