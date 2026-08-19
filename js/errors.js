/**
 * MIRAGE ENGINE v2 — User-facing error classification
 */
(function (global) {
    'use strict';

    /**
     * The recommended stack is provider-specific: Grok and Seedream exist only in the
     * kie registry, so telling a Google-provider user to pick them sends them looking
     * for models their dropdown does not contain.
     */
    function goonStackTip() {
        const provider = (typeof EngineState !== 'undefined' && EngineState.apiProvider) || 'google';
        if (provider === 'kie') {
            return 'Best Goon stack: Settings → Thinking = Grok, Thinking — scene commands = Grok '
                + '(used by /next scene, /jump, /time pass), Image = Seedream 5.0 Lite or Pro. '
                + 'Click Save, then retry.';
        }
        return 'Google AI refuses explicit beats on every model it offers, so no combination of '
            + 'Google models will get past this. Switch Settings → Provider to kie.ai (needs a '
            + 'kie key and the local proxy), then pick Thinking = Grok and Image = Seedream 5.0.';
    }

    function safetyChatBody(err) {
        const preview = err.rawPreview || err.message
            ? `\n${String(err.rawPreview || err.message).slice(0, 220)}`
            : '';
        const modelHint = err.modelId ? ` (model: ${err.modelId})` : '';
        const sceneHint = /gemini|nano-banana|google\//i.test(String(err.modelId || ''))
            ? ' This looks like a Gemini-family model — explicit Goon beats often fail there even via kie.'
            : '';
        return 'Thinking was blocked by a provider safety filter'
            + modelHint
            + '. Many models refuse explicit sexual RP (not only Google).'
            + sceneHint
            + ' '
            + goonStackTip()
            + preview;
    }

    function describeTurnError(err) {
        if (!err) {
            return {
                toast: 'Turn failed.',
                chat: 'Turn failed — unknown error.',
                action: null
            };
        }

        if (err.code === 'CANCELLED' || err.message === 'Turn cancelled') {
            return {
                toast: 'Turn cancelled.',
                chat: null,
                action: null,
                silent: true
            };
        }

        if (err.code === 'SAFETY') {
            return {
                toast: 'Blocked by a safety filter — text was not sent.',
                chat: safetyChatBody(err),
                action: null
            };
        }

        if (err.code === 'JSON_PARSE') {
            const preview = err.rawPreview
                ? `\nPreview: ${String(err.rawPreview).slice(0, 160)}…`
                : '';
            // Mis-tagged safety refusals still show policy language in the preview
            if (/prohibited use policy|sensitive words|could not be submitted|content.?filter|safety|i cannot fulfill|sexually (explicit|suggestive)/i.test(String(err.rawPreview || ''))) {
                return {
                    toast: 'Blocked by a safety filter — text was not sent.',
                    chat: 'Provider safety filter blocked the turn.'
                        + ' '
                        + goonStackTip()
                        + preview,
                    action: null
                };
            }
            return {
                toast: 'Model returned invalid JSON — retry the turn.',
                chat: 'Thinking model returned malformed JSON. Retry your message.'
                    + ' Mid-session provider switches only apply after you click Save in Settings.'
                    + preview,
                action: 'retry',
                code: 'JSON_PARSE'
            };
        }

        const msg = String(err.message || err).toLowerCase();

        if (/api key|invalid.*key|401|403|permission denied|unauthorized|authentication/i.test(msg)) {
            return {
                toast: 'API key rejected — check Settings.',
                chat: 'API key rejected. Open Settings, verify your key for the active provider, and run Test Connection.',
                action: 'settings'
            };
        }

        if (/empty response from kie thinking|empty response|EMPTY_THINKING/i.test(msg) || err.code === 'EMPTY_THINKING') {
            return {
                toast: 'Thinking model returned nothing — retry the turn.',
                chat: 'The thinking model returned an empty reply (common with cheap/fast kie models on heavy turns like /next scene). Retry once, or switch scene/main thinking to Grok or a stronger Flash model in Settings.',
                action: 'retry'
            };
        }

        if (/quota|rate limit|429|resource exhausted|too many requests/i.test(msg)) {
            return {
                toast: 'Rate limit hit — wait and retry.',
                chat: 'Rate limit or quota exceeded. Wait a minute and try again.',
                action: 'retry'
            };
        }

        if (/prohibited use policy|sensitive words|could not be submitted|content.?filter|safety/i.test(msg)) {
            return {
                toast: 'Blocked by a safety filter — text was not sent.',
                chat: 'Provider safety filter blocked the prompt. '
                    + goonStackTip(),
                action: null
            };
        }

        if (/timeout|timed out|abort/i.test(msg) && err.code !== 'CANCELLED') {
            return {
                toast: 'Request timed out — try again or use Retry face / Retry Last Image.',
                chat: 'The request timed out (image models can take several minutes). Retry, cancel, or use Retry face / Retry Last Image if text already appeared.',
                action: 'retry'
            };
        }

        if (/network|cors|fetch|failed to fetch/i.test(msg)) {
            return {
                toast: 'Network error — is the server running?',
                chat: 'Network or CORS error. Launch via START MIRAGE.bat (localhost) — do not open index.html as a file.',
                action: 'server'
            };
        }

        // Only "no image returned" can reach here — the empty-thinking branch above
        // already claims every "empty response", so testing for it again was dead.
        if (/no image returned/i.test(msg)) {
            return {
                toast: err.message || 'Image model returned nothing.',
                chat: err.message || 'The image model returned no image. Retry the turn.',
                action: 'retry'
            };
        }

        return {
            toast: err.message || 'Turn failed.',
            chat: err.message || 'Turn failed.',
            action: null
        };
    }

    global.MirageErrors = { describeTurnError };
})(typeof window !== 'undefined' ? window : globalThis);
