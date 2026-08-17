/**
 * MIRAGE ENGINE v2 — Dev mock API (no Google credits)
 * mockImages: placeholder PNG from imageDirective
 * mockThinking: local EDF JSON for offline plumbing tests
 */
(function (global) {
    'use strict';

    const S = () => global.EngineState;

    const DELIVERY_CYCLE = [
        'normal',
        'slow',
        'reaction',
        'double_text',
        'ghost_type',
        'left_on_read',
        'went_quiet',
        'normal',
        'double_text'
    ];

    let deliveryCursor = 0;
    let memoryStubEvery = 0;

    function isActiveImages() {
        const st = S();
        return !!(st?.developerMode && st?.mockImages);
    }

    function isActiveThinking() {
        const st = S();
        return !!(st?.developerMode && st?.mockThinking);
    }

    function apiModeLabel() {
        if (isActiveThinking()) return 'full mock';
        if (isActiveImages()) return 'mock images';
        return 'live';
    }

    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                const err = new Error('Cancelled');
                err.name = 'AbortError';
                reject(err);
                return;
            }
            const timer = setTimeout(resolve, ms);
            if (!signal) return;
            const onAbort = () => {
                clearTimeout(timer);
                const err = new Error('Cancelled');
                err.name = 'AbortError';
                reject(err);
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function joinUserText(userParts) {
        return (userParts || []).map(p => p.text || '').join('\n');
    }

    function extractUserInput(userParts) {
        const text = joinUserText(userParts);
        const m = text.match(/USER INPUT:\n([\s\S]*)$/i);
        const raw = (m ? m[1] : text).trim();
        return raw.slice(0, 240) || 'hey';
    }

    function wantsImage(userParts) {
        const text = joinUserText(userParts);
        return !/Image generation is OFF this turn/i.test(text);
    }

    function isStoryLaunch(userParts) {
        return /PUBLIC INSTAGRAM STORY/i.test(joinUserText(userParts));
    }

    function hasCommandInject(userParts) {
        return /COMMAND CONTEXT:/i.test(joinUserText(userParts));
    }

    function truncate(str, n) {
        const s = String(str || '').replace(/\s+/g, ' ').trim();
        if (s.length <= n) return s;
        return `${s.slice(0, n - 1)}…`;
    }

    function wrapLines(ctx, text, maxWidth, lineHeight, startY) {
        const words = String(text || '').split(/\s+/).filter(Boolean);
        let line = '';
        let y = startY;
        for (const word of words) {
            const test = line ? `${line} ${word}` : word;
            if (ctx.measureText(test).width > maxWidth && line) {
                ctx.fillText(line, 36, y);
                y += lineHeight;
                line = word;
            } else {
                line = test;
            }
        }
        if (line) {
            ctx.fillText(line, 36, y);
            y += lineHeight;
        }
        return y;
    }

    /**
     * Build a 9:16 placeholder that prints directive fields for visual QA.
     */
    function buildPlaceholderDataUrl(directive, imagePrompt) {
        const d = directive && typeof directive === 'object' ? directive : {};
        const w = 576;
        const h = 1024;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');

        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#1a2332');
        grad.addColorStop(0.55, '#243044');
        grad.addColorStop(1, '#3a2a38');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        for (let i = 0; i < 14; i++) {
            ctx.fillRect(0, i * 72, w, 36);
        }

        ctx.fillStyle = 'rgba(94, 234, 212, 0.9)';
        ctx.font = 'bold 42px system-ui, sans-serif';
        ctx.fillText('MOCK IMAGE', 36, 72);

        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '18px system-ui, sans-serif';
        ctx.fillText('Dev Mode · no image credits', 36, 104);

        const shot = d.shotType || 'Front Selfie';
        const rows = [
            ['Shot', shot],
            ['Crop', d.crop || '—'],
            ['Pose', d.pose || '—'],
            ['Outfit', d.outfitDetail || '—'],
            ['Env', d.envDetail || '—'],
            ['Light', d.lighting || '—'],
            ['Grain', d.imperfections || '—']
        ];

        let y = 160;
        ctx.font = 'bold 20px system-ui, sans-serif';
        for (const [label, value] of rows) {
            ctx.fillStyle = 'rgba(94, 234, 212, 0.75)';
            ctx.fillText(label, 36, y);
            ctx.fillStyle = 'rgba(255,255,255,0.88)';
            ctx.font = '18px system-ui, sans-serif';
            y = wrapLines(ctx, truncate(value, 180), w - 72, 24, y + 28);
            y += 18;
            ctx.font = 'bold 20px system-ui, sans-serif';
            if (y > h - 120) break;
        }

        if (imagePrompt && y < h - 80) {
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.font = '14px ui-monospace, monospace';
            wrapLines(ctx, truncate(imagePrompt, 220), w - 72, 18, y + 8);
        }

        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, h - 48, w, 48);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '16px system-ui, sans-serif';
        ctx.fillText('9:16 · Mirage mock renderer', 36, h - 20);

        return canvas.toDataURL('image/png');
    }

    function parseDirectiveFromPrompt(imagePrompt) {
        const t = String(imagePrompt || '');
        const grab = (re) => {
            const m = t.match(re);
            return m ? m[1].trim().replace(/\.\s*$/, '') : '';
        };
        return {
            shotType: grab(/Shot:\s*([^\n—]+)/i) || 'Front Selfie',
            crop: grab(/Crop:\s*([^\n—]+)/i) || '',
            pose: grab(/Pose:\s*([^\n]+)/i),
            outfitDetail: grab(/Outfit:\s*([^\n]+)/i),
            envDetail: grab(/Environment:\s*([^\n]+)/i),
            lighting: grab(/Lighting:\s*([^\n]+)/i),
            imperfections: grab(/Realism:\s*([^\n]+)/i)
        };
    }

    async function mockImageGenerate({ imagePrompt, imageDirective, signal } = {}) {
        await sleep(120 + Math.floor(Math.random() * 220), signal);
        const d = imageDirective && typeof imageDirective === 'object'
            ? imageDirective
            : parseDirectiveFromPrompt(imagePrompt);
        return buildPlaceholderDataUrl(d, imagePrompt);
    }

    function nextDeliveryStyle() {
        const realTime = !!S()?.realTimeChat;
        if (!realTime) return 'normal';
        const style = DELIVERY_CYCLE[deliveryCursor % DELIVERY_CYCLE.length];
        deliveryCursor += 1;
        return style;
    }

    async function mockThinkingGenerate({ userParts, signal } = {}) {
        await sleep(220 + Math.floor(Math.random() * 420), signal);

        const sess = S()?.session || {};
        const profile = S()?.profile || {};
        const userLine = extractUserInput(userParts);
        const story = isStoryLaunch(userParts);
        const cmd = hasCommandInject(userParts);
        const needImage = wantsImage(userParts) || story;
        const style = story ? 'normal' : nextDeliveryStyle();

        const outfit = sess.outfit || 'casual day look';
        const env = sess.env || 'her place';
        const name = profile.name || 'she';

        let characterResponse;
        if (story) {
            characterResponse = `golden hour at ${env} ✨ (${outfit}) — mock story caption`;
        } else if (style === 'reaction') {
            characterResponse = `mock reaction text to "${truncate(userLine, 60)}"`;
        } else if (style === 'ghost_type' || style === 'left_on_read' || style === 'went_quiet') {
            characterResponse = `…was gonna say something about "${truncate(userLine, 40)}" but mock held it`;
        } else if (cmd) {
            characterResponse = `got the command — mock ack on "${truncate(userLine, 60)}"`;
        } else {
            characterResponse = `mock: "${truncate(userLine, 80)}" — still in ${sess.persona || 'persona'} @ ${env}`;
        }

        const secondMessage = style === 'double_text'
            ? `ok wait the real bit — reacting to: ${truncate(userLine, 70)}`
            : undefined;

        memoryStubEvery += 1;
        const memoryUpdates = (memoryStubEvery % 4 === 0)
            ? [{ op: 'add', kind: 'fact', text: `mock ledger note after: ${truncate(userLine, 50)}` }]
            : [];

        const payload = {
            tracking: {
                persona: sess.persona || 'Loyal Girlfriend',
                mode: story ? 'STORY' : (sess.mode || 'DM'),
                outfit,
                env,
                arousal: Number.isFinite(sess.arousal) ? sess.arousal : 20,
                tease: Number.isFinite(sess.tease) ? sess.tease : 0,
                awareness: Number.isFinite(sess.awareness) ? sess.awareness : 40,
                thermal: sess.thermal || 'Normal',
                mood: sess.mood || 'Neutral',
                moodIntensity: Number.isFinite(Number(sess.moodIntensity)) ? Number(sess.moodIntensity) : 1,
                engagement: Number.isFinite(Number(sess.engagement)) ? Number(sess.engagement) : 55,
                compliance: sess.compliance || 'engaged'
            },
            characterResponse,
            memoryUpdates,
            delivery: {
                style,
                delaySec: style === 'slow' ? 8 : null,
                reaction: style === 'reaction'
                    ? ['😂', '🔥', '👀', '🥰', '❤️', '💀'][Math.floor(Math.random() * 6)]
                    : undefined,
                secondMessage
            }
        };

        if (needImage) {
            payload.imageDirective = {
                shotType: story ? 'Mirror Selfie' : 'Front Selfie',
                crop: story ? 'Full' : 'Bust',
                goonFace: sess.persona === 'Goon' ? (story ? 'CrossTease' : 'TongueOut') : undefined,
                goonFrame: sess.persona === 'Goon' ? (story ? 'MirrorFullPose' : 'Cleavage') : undefined,
                pose: story
                    ? 'phone propped / mirror, she frames herself'
                    : 'front camera, face toward the lens',
                lighting: 'available indoor light, soft shadows',
                imperfections: 'slight iPhone grain, authentic social capture',
                outfitDetail: `${outfit} — mock visual detail for ${name}`,
                envDetail: `${env} — mock environment detail`
            };
        }

        return JSON.stringify(payload);
    }

    global.MirageMockAPI = {
        isActiveImages,
        isActiveThinking,
        apiModeLabel,
        mockThinkingGenerate,
        mockImageGenerate,
        buildPlaceholderDataUrl
    };
})(typeof window !== 'undefined' ? window : globalThis);
