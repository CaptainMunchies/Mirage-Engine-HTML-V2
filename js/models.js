/**
 * MIRAGE ENGINE — Official model registry
 * Providers: Google AI Studio (official) | kie.ai (cheaper Market API)
 */
(function (global) {
    'use strict';

    const PROVIDERS = [
        { id: 'google', label: 'Google AI (official)' },
        { id: 'kie', label: 'kie.ai (cheaper)' }
    ];

    const VENDOR_ORDER = ['google', 'openai', 'xai', 'qwen', 'bytedance', 'wan', 'flux', 'other'];
    const VENDOR_LABELS = {
        google: 'Google',
        openai: 'OpenAI',
        xai: 'xAI · Grok',
        qwen: 'Qwen',
        bytedance: 'ByteDance',
        wan: 'Wan',
        flux: 'Flux',
        other: 'Other'
    };

    /** Verified thinking models — Google generateContent */
    const GOOGLE_THINKING_MODELS = [
        {
            id: 'gemini-3.7-flash',
            label: 'Gemini 3.7 Flash',
            vendor: 'google',
            tag: 'ga',
            costRank: 2,
            costLabel: '$$',
            dropdownHint: 'stronger',
            bestFor: 'Scene commands + heavier JSON',
            capability: 'Strongest Gemini Flash for JSON, persona, and /jump /next scene.',
            caution: 'Gemini safety can mute explicit / Goon beats.',
            costNote: '$0.75 in / $3.75 out per 1M tokens (intro through Dec 31, 2026). Then $1.50 / $7.50.',
            pricing: {
                headline: '$0.75 in / $3.75 out per 1M tokens',
                input: '$0.75',
                output: '$3.75',
                inputPer1MUsd: 0.75,
                outputPer1MUsd: 3.75,
                note: 'Google intro through Dec 31, 2026. Standard from Jan 1, 2027: $1.50 / $7.50. Default for /jump and /next scene.'
            }
        },
        {
            id: 'gemini-3.6-flash',
            label: 'Gemini 3.6 Flash',
            vendor: 'google',
            tag: 'ga',
            costRank: 3,
            costLabel: '$$',
            dropdownHint: 'solid',
            bestFor: 'Stable chat if 3.7 misbehaves',
            capability: 'Reliable Flash workhorse. Slightly behind 3.7 on agents/coding.',
            caution: 'Same Gemini safety stack as 3.7.',
            costNote: '$0.75 in / $3.75 out per 1M tokens (intro through Dec 31, 2026). Then $1.50 / $7.50.',
            pricing: {
                headline: '$0.75 in / $3.75 out per 1M tokens',
                input: '$0.75',
                output: '$3.75',
                inputPer1MUsd: 0.75,
                outputPer1MUsd: 3.75,
                note: 'Google intro through Dec 31, 2026. Standard from Jan 1, 2027: $1.50 / $7.50.'
            }
        },
        {
            id: 'gemini-3.5-flash',
            label: 'Gemini 3.5 Flash',
            vendor: 'google',
            tag: 'ga',
            costRank: 2,
            costLabel: '$$',
            dropdownHint: 'older',
            bestFor: 'Fallback if newer Flash ids fail',
            capability: 'Fine for short DMs. Weaker on heavy scene jumps.',
            caution: 'Gemini safety. Weaker JSON than 3.6/3.7.',
            costNote: '$1.50 in / $9.00 out per 1M tokens.',
            pricing: {
                headline: '$1.50 in / $9.00 out per 1M tokens',
                input: '$1.50',
                output: '$9.00',
                inputPer1MUsd: 1.50,
                outputPer1MUsd: 9.00,
                note: 'Google standard list (global, ≤200K context).'
            }
        },
        {
            id: 'gemini-3.5-flash-lite',
            label: 'Gemini 3.5 Flash Lite',
            vendor: 'google',
            tag: 'recommended',
            costRank: 1,
            costLabel: '$',
            dropdownHint: 'default',
            bestFor: 'Everyday chat (cheap)',
            capability: 'Fast and light. Fine for DMs. Empty/weak JSON on scene commands is common.',
            caution: 'Keep Scene model on 3.7 Flash for /next scene, /jump, /time pass.',
            costNote: '$0.30 in / $2.50 out per 1M tokens.',
            pricing: {
                headline: '$0.30 in / $2.50 out per 1M tokens',
                input: '$0.30',
                output: '$2.50',
                inputPer1MUsd: 0.30,
                outputPer1MUsd: 2.50,
                note: 'Cheapest official Gemini Flash. Google standard list.'
            }
        }
    ];

    /**
     * kie.ai thinking / chat models
     * apiStyle: 'openai-chat' | 'responses' (Grok / GPT Codex Responses API)
     * costRank 1 = cheapest in this list
     * Credits: kie bills in credits (~$0.005 each). Chat-turn estimates assume
     * ~6k input + ~500 output tokens (typical Mirage thinking call).
     */
    const KIE_THINKING_MODELS = [
        {
            id: 'gemini-3.7-flash',
            label: 'Gemini 3.7 Flash',
            vendor: 'google',
            tag: 'ga',
            apiStyle: 'openai-chat',
            chatPath: '/gemini-3-7-flash-openai/v1/chat/completions',
            kieModel: 'gemini-3.7-flash',
            costRank: 2,
            costLabel: '$$',
            dropdownHint: 'stronger',
            bestFor: 'Scene commands + heavier JSON',
            capability: 'Newest Gemini Flash on kie. Strong JSON, persona, /jump and /next scene.',
            caution: 'Gemini safety can mute explicit / Goon beats — switch Thinking + Scene to Grok.',
            costNote: '45 / 225 credits per 1M in/out ($0.225 / $1.125). Official Google intro $0.75 / $3.75.',
            pricing: {
                headline: '45 cr in / 225 cr out per 1M tokens ($0.225 / $1.125)',
                input: '45 credits ($0.225)',
                output: '225 credits ($1.125)',
                inputPer1MCredits: 45,
                outputPer1MCredits: 225,
                official: '$0.75 / $3.75 per 1M (Google intro through Dec 31, 2026)',
                note: 'kie.ai Market. 1 credit ≈ $0.005. Default for /jump and /next scene.'
            }
        },
        {
            id: 'gemini-3.6-flash',
            label: 'Gemini 3.6 Flash',
            vendor: 'google',
            tag: 'ga',
            apiStyle: 'openai-chat',
            chatPath: '/gemini-3-6-flash-openai/v1/chat/completions',
            kieModel: 'gemini-3.6-flash',
            costRank: 3,
            costLabel: '$$',
            dropdownHint: 'solid',
            bestFor: 'Stable chat if 3.7 hiccups',
            capability: 'Previous default. Reliable Flash JSON.',
            caution: 'Same Gemini safety. Usually costs more than 3.7.',
            costNote: 'kie Market credits. Official Google intro $0.75 / $3.75 per 1M.',
            pricing: {
                headline: 'kie Market credits (cheaper than Google)',
                official: '$0.75 / $3.75 per 1M (Google intro through Dec 31, 2026)',
                inputPer1MUsd: 0.75,
                outputPer1MUsd: 3.75,
                note: 'Live kie credit rate: kie.ai/pricing. 1 credit ≈ $0.005. Turn estimate uses Google list (kie is usually less).'
            }
        },
        {
            id: 'gemini-3.5-flash',
            label: 'Gemini 3.5 Flash',
            vendor: 'google',
            tag: 'ga',
            apiStyle: 'openai-chat',
            chatPath: '/gemini-3-5-flash-openai/v1/chat/completions',
            kieModel: 'gemini-3-5-flash',
            costRank: 3,
            costLabel: '$$',
            dropdownHint: 'older',
            bestFor: 'Fallback Gemini',
            capability: 'Fine for short DMs. Weaker on heavy scene jumps.',
            caution: 'Gemini safety. Prefer 3.7.',
            costNote: 'kie Market credits. Official Google $1.50 / $9.00 per 1M.',
            pricing: {
                headline: 'kie Market credits (cheaper than Google)',
                official: '$1.50 / $9.00 per 1M tokens',
                inputPer1MUsd: 1.50,
                outputPer1MUsd: 9.00,
                note: 'Live kie credit rate: kie.ai/pricing. 1 credit ≈ $0.005. Turn estimate uses Google list (kie is usually less).'
            }
        },
        {
            id: 'gemini-3.5-flash-lite',
            label: 'Gemini 3.5 Flash Lite',
            vendor: 'google',
            tag: 'recommended',
            apiStyle: 'openai-chat',
            chatPath: '/gemini-3-5-flash-openai/v1/chat/completions',
            kieModel: 'gemini-3-5-flash',
            costRank: 1,
            costLabel: '$',
            dropdownHint: 'default',
            bestFor: 'Everyday chat (cheap)',
            capability: 'Fast. Fine for DMs. Empty JSON on /next scene is common.',
            caution: 'Keep Scene model on 3.7 Flash for /next scene, /jump, /time pass.',
            costNote: 'kie Market credits. Official Google $0.30 / $2.50 per 1M.',
            pricing: {
                headline: 'kie Market credits (cheapest Gemini route)',
                official: '$0.30 / $2.50 per 1M tokens',
                inputPer1MUsd: 0.30,
                outputPer1MUsd: 2.50,
                note: 'Shares the 3.5 Flash kie endpoint. Turn estimate uses Google list (kie is usually less).'
            }
        },
        {
            id: 'gpt-5.6-luna',
            label: 'GPT-5.6 Luna',
            vendor: 'openai',
            tag: 'fast',
            apiStyle: 'responses',
            chatPath: '/codex/v1/responses',
            kieModel: 'gpt-5-6-luna',
            reasoningEffort: 'low',
            costRank: 1,
            costLabel: '$',
            dropdownHint: 'cheap alt',
            bestFor: 'Cheap non-Gemini text',
            capability: 'Fast Codex-style replies. JSON is hit-or-miss vs Gemini Flash.',
            caution: 'Not the first pick for scene commands.',
            costNote: 'kie Market credits. OpenAI list $0.20 / $1.20 per 1M.',
            pricing: {
                headline: 'kie Market credits (cheapest thinking option here)',
                official: '$0.20 in / $1.20 out per 1M tokens (OpenAI list)',
                inputPer1MUsd: 0.20,
                outputPer1MUsd: 1.20,
                note: 'Live kie credit rate: kie.ai/pricing. Turn estimate uses OpenAI list (kie is usually less).'
            }
        },
        {
            id: 'gpt-5.6-terra',
            label: 'GPT-5.6 Terra',
            vendor: 'openai',
            tag: 'alt',
            apiStyle: 'responses',
            chatPath: '/codex/v1/responses',
            kieModel: 'gpt-5-6-terra',
            reasoningEffort: 'medium',
            costRank: 4,
            costLabel: '$$$',
            dropdownHint: 'heavier',
            bestFor: 'When you want OpenAI reasoning instead of Gemini',
            capability: 'Stronger than Luna. Slower, more credits.',
            caution: 'Overkill for ping-pong DMs.',
            costNote: 'kie Market credits. OpenAI list $2.00 / $12.00 per 1M.',
            pricing: {
                headline: 'kie Market credits (several× Luna per turn)',
                official: '$2.00 in / $12.00 out per 1M tokens (OpenAI list)',
                inputPer1MUsd: 2.00,
                outputPer1MUsd: 12.00,
                note: 'Live kie credit rate: kie.ai/pricing. Turn estimate uses OpenAI list (kie is usually less).'
            }
        },
        {
            id: 'grok-4-3',
            label: 'Grok 4.3',
            vendor: 'xai',
            tag: 'alt',
            apiStyle: 'responses',
            chatPath: '/grok/v1/responses',
            kieModel: 'grok-4-3',
            reasoningEffort: 'low',
            costRank: 4,
            costLabel: '$$$',
            dropdownHint: 'uncensored',
            bestFor: 'Explicit / Goon on a budget vs 4.5/4.6',
            capability: 'xAI reasoning. Follows persona/heat without Gemini safety softening.',
            caution: 'Pricier than Gemini Flash. Scene model auto-follows this Grok.',
            costNote: 'kie Market credits. xAI list $1.25 / $2.50 per 1M (<200K).',
            pricing: {
                headline: 'kie Market credits',
                official: '$1.25 in / $2.50 out per 1M tokens (<200K prompt). ≥200K: $2.50 / $5.00.',
                inputPer1MUsd: 1.25,
                outputPer1MUsd: 2.50,
                note: 'xAI list. Turn estimate uses xAI list (kie is usually less).'
            }
        },
        {
            id: 'grok-4-5',
            label: 'Grok 4.5',
            vendor: 'xai',
            tag: 'alt',
            apiStyle: 'responses',
            chatPath: '/grok/v1/responses',
            kieModel: 'grok-4-5',
            costRank: 5,
            costLabel: '$$$$',
            dropdownHint: 'uncensored',
            bestFor: 'Explicit RP + solid JSON',
            capability: 'Strong instruction following. Auto-pairs scene commands to this same Grok.',
            caution: 'One of the expensive chat options.',
            costNote: 'kie Market credits. xAI list $2.00 / $6.00 per 1M (<200K).',
            pricing: {
                headline: 'kie Market credits',
                official: '$2.00 in / $6.00 out per 1M tokens (<200K prompt). ≥200K: $4.00 / $12.00.',
                inputPer1MUsd: 2.00,
                outputPer1MUsd: 6.00,
                note: 'xAI list. Cached input $0.30 / 1M. Turn estimate uses xAI list (kie is usually less).'
            }
        },
        {
            id: 'grok-4-6',
            label: 'Grok 4.6',
            vendor: 'xai',
            tag: 'new',
            apiStyle: 'responses',
            chatPath: '/grok/v1/responses',
            kieModel: 'grok-4-6',
            reasoningEffort: 'low',
            costRank: 6,
            costLabel: '$$$$$',
            dropdownHint: 'uncensored',
            bestFor: 'Best Grok for long beats + explicit scene jumps',
            capability: 'Newest xAI. Best at staying in persona across /jump and multi-step heat.',
            caution: 'Most expensive thinking model here. Scene model auto-follows.',
            costNote: 'kie Market credits. xAI list $2.00 / $6.00 per 1M (<200K).',
            pricing: {
                headline: 'kie Market credits',
                official: '$2.00 in / $6.00 out per 1M tokens (<200K prompt). ≥200K: $4.00 / $12.00.',
                inputPer1MUsd: 2.00,
                outputPer1MUsd: 6.00,
                note: 'xAI list (same headline as 4.5). Cached input $0.50 / 1M. Turn estimate uses xAI list (kie is usually less).'
            }
        }
    ];

    /** Nano Banana — Google Interactions API */
    const GOOGLE_IMAGE_MODELS = [
        {
            id: 'gemini-3-pro-image',
            label: 'Nano Banana Pro',
            vendor: 'google',
            product: 'Gemini 3 Pro Image',
            tag: 'alt',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 5,
            costRank: 3,
            costLabel: '$$$',
            bestFor: 'Best identity lock + 2K stills',
            capability: '2K output, up to 5 character refs.',
            caution: 'Gemini image safety can refuse explicit beats.',
            pricing: {
                headline: '$0.134 per 1K/2K image · $0.24 per 4K',
                perImage: '1K/2K $0.134 · 4K $0.24',
                perImageUsd: 0.134,
                note: 'Google list. Image output billed as 1120 tokens ($0.134) or 2000 tokens ($0.24).'
            }
        },
        {
            id: 'gemini-3.1-flash-image',
            label: 'Nano Banana 2',
            vendor: 'google',
            product: 'Gemini 3.1 Flash Image',
            tag: 'workhorse',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 4,
            costRank: 2,
            costLabel: '$$',
            bestFor: 'Everyday stills, cheaper than Pro',
            capability: '2K output, up to 4 character refs.',
            caution: 'Gemini image safety can refuse explicit beats.',
            pricing: {
                headline: '$0.067 per 1K · $0.101 per 2K · $0.15 per 4K',
                perImage: '512 $0.045 · 1K $0.067 · 2K $0.101 · 4K $0.15',
                perImageUsd: 0.067,
                note: 'Google list (Gemini 3.1 Flash Image output tokens). 1K typical for Mirage stills.'
            }
        },
        {
            id: 'gemini-3.1-flash-lite-image',
            label: 'Nano Banana 2 Lite',
            vendor: 'google',
            product: 'Gemini 3.1 Flash Lite Image',
            tag: 'recommended',
            maxImageSize: '1K',
            supportsMultiReference: false,
            maxCharacterRefs: 0,
            costRank: 1,
            costLabel: '$',
            bestFor: 'Everyday stills (cheap 1K)',
            capability: '1K output. Fastest / cheapest Nano Banana. No multi-ref.',
            caution: 'Weaker identity lock than Pro. Gemini safety still applies.',
            pricing: {
                headline: '$0.034 per 1K image',
                perImage: '1K $0.034',
                perImageUsd: 0.034,
                note: 'Google list (1120 image-output tokens at $30 / 1M).'
            }
        }
    ];

    /**
     * kie.ai image models (Market jobs API)
     * family drives request shape. i2iModel/t2iModel switch when face refs exist.
     * Note: Grok Imagine 2.0 is not a separate kie model id yet — use grok-imagine/*.
     * costRank for 1K i2i-ish: 1 = cheapest
     */
    const KIE_IMAGE_MODELS = [
        {
            id: 'nano-banana-pro',
            label: 'Nano Banana Pro',
            vendor: 'google',
            product: 'Gemini 3 Pro Image via kie',
            tag: 'alt',
            family: 'nano',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 5,
            maxPrompt: 9500,
            refField: 'image_input',
            aspectField: 'aspect_ratio',
            costRank: 7,
            costLabel: '$$$$',
            pricing: {
                headline: '$0.09 per 1K–2K image · $0.12 per 4K',
                perImage: '1K/2K $0.09 · 4K $0.12',
                perImageUsd: 0.09,
                official: 'Google 1K/2K $0.134 · 4K $0.24',
                note: 'kie.ai Market USD (Aug 2026).'
            }
        },
        {
            id: 'nano-banana-2',
            label: 'Nano Banana 2',
            vendor: 'google',
            product: 'Gemini 3.1 Flash Image via kie',
            tag: 'workhorse',
            family: 'nano',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 4,
            maxPrompt: 18000,
            refField: 'image_input',
            aspectField: 'aspect_ratio',
            costRank: 5,
            costLabel: '$$$',
            pricing: {
                headline: '$0.04 per 1K · $0.06 per 2K · $0.09 per 4K',
                perImage: '1K $0.04 · 2K $0.06 · 4K $0.09',
                perImageUsd: 0.04,
                official: 'Google 1K $0.067 · 2K $0.101 · 4K $0.15',
                note: 'kie.ai Market USD (Aug 2026). 1K typical for Mirage stills.'
            }
        },
        {
            id: 'nano-banana-2-lite',
            label: 'Nano Banana 2 Lite',
            vendor: 'google',
            product: 'Flash Lite Image via kie',
            tag: 'recommended',
            family: 'nano-lite',
            maxImageSize: '1K',
            supportsMultiReference: true,
            maxCharacterRefs: 4,
            maxPrompt: 18000,
            refField: 'image_urls',
            aspectField: 'aspect_ratio',
            costRank: 1,
            costLabel: '$',
            pricing: {
                headline: '~$0.02 per 1K image on kie (Google list $0.034)',
                perImage: '1K ~$0.02 (est.) · Google $0.034',
                perImageUsd: 0.02,
                official: 'Google 1K $0.034',
                note: 'Cheapest Nano Banana on kie. Market USD not always listed; estimate is ~half of Google 1K.'
            }
        },
        {
            id: 'gpt-image-2',
            label: 'GPT Image 2',
            vendor: 'openai',
            product: 'OpenAI GPT Image 2 image-to-image',
            tag: 'alt',
            family: 'gpt-image',
            maxImageSize: '1K',
            supportsMultiReference: true,
            maxCharacterRefs: 16,
            maxPrompt: 18000,
            refField: 'input_urls',
            aspectField: 'aspect_ratio',
            i2iModel: 'gpt-image-2-image-to-image',
            t2iModel: 'gpt-image-2-text-to-image',
            aspectAllow: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
            costRank: 6,
            costLabel: '$$$',
            latencyNote: 'slowest',
            pricing: {
                headline: '≈ 12–24 cr / image on kie Market',
                perImageCreditsMin: 12,
                perImageCreditsMax: 24,
                note: 'OpenAI GPT Image 2 via kie. Live rate: kie.ai/pricing. Slowest image option here.'
            }
        },
        {
            id: 'qwen3-image',
            label: 'Qwen Image 3.0',
            vendor: 'qwen',
            product: 'Qwen3 text/image-to-image',
            tag: 'alt',
            family: 'qwen',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 3,
            maxPrompt: 5000,
            refField: 'image_urls',
            aspectField: 'image_size',
            i2iModel: 'qwen3/image-to-image',
            t2iModel: 'qwen3/text-to-image',
            aspectAllow: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
            costRank: 2,
            costLabel: '$',
            pricing: {
                headline: '≈ 4–8 cr / image on kie Market',
                perImageCreditsMin: 4,
                perImageCreditsMax: 8,
                note: 'Qwen 3 via kie. Live rate: kie.ai/pricing.'
            }
        },
        {
            id: 'qwen3-image-pro',
            label: 'Qwen Image 3.0 Pro',
            vendor: 'qwen',
            product: 'Qwen3 Pro text/image-to-image',
            tag: 'alt',
            family: 'qwen',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 3,
            maxPrompt: 5000,
            refField: 'image_urls',
            aspectField: 'image_size',
            i2iModel: 'qwen3/pro-image-to-image',
            t2iModel: 'qwen3/pro-text-to-image',
            aspectAllow: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
            costRank: 3,
            costLabel: '$$',
            pricing: {
                headline: '≈ 6–12 cr / image on kie Market',
                perImageCreditsMin: 6,
                perImageCreditsMax: 12,
                note: 'Qwen 3 Pro via kie. Live rate: kie.ai/pricing.'
            }
        },
        {
            id: 'seedream-5-pro',
            label: 'Seedream 5.0 Pro',
            vendor: 'bytedance',
            product: 'Seedream 5 Pro text/image-to-image',
            note: 'unfiltered',
            tag: 'alt',
            family: 'seedream',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 10,
            maxPrompt: 5000,
            refField: 'image_urls',
            aspectField: 'aspect_ratio',
            i2iModel: 'seedream/5-pro-image-to-image',
            t2iModel: 'seedream/5-pro-text-to-image',
            aspectAllow: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
            costRank: 4,
            costLabel: '$$',
            pricing: {
                headline: '≈ 8–16 cr / image on kie Market',
                perImageCreditsMin: 8,
                perImageCreditsMax: 16,
                note: 'ByteDance Seedream 5 Pro via kie. Unfiltered. Live rate: kie.ai/pricing.'
            }
        },
        {
            id: 'seedream-5-lite',
            label: 'Seedream 5.0 Lite',
            vendor: 'bytedance',
            product: 'Seedream 5 Lite text/image-to-image',
            note: 'unfiltered',
            tag: 'alt',
            family: 'seedream',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 14,
            maxPrompt: 3000,
            refField: 'image_urls',
            aspectField: 'aspect_ratio',
            i2iModel: 'seedream/5-lite-image-to-image',
            t2iModel: 'seedream/5-lite-text-to-image',
            aspectAllow: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
            costRank: 3,
            costLabel: '$$',
            pricing: {
                headline: '≈ 6–12 cr / image on kie Market',
                perImageCreditsMin: 6,
                perImageCreditsMax: 12,
                note: 'ByteDance Seedream 5 Lite via kie. Unfiltered. Live rate: kie.ai/pricing.'
            }
        },
        {
            id: 'wan-2-7-image',
            label: 'Wan 2.7 Image',
            vendor: 'wan',
            product: 'Wan 2.7 text/image-to-image',
            tag: 'alt',
            family: 'wan',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 9,
            maxPrompt: 5000,
            refField: 'input_urls',
            aspectField: 'aspect_ratio',
            i2iModel: 'wan/2-7-image',
            t2iModel: 'wan/2-7-image',
            aspectAllow: ['1:1', '16:9', '4:3', '21:9', '3:4', '9:16', '8:1', '1:8'],
            costRank: 3,
            costLabel: '$$',
            pricing: {
                headline: '≈ 6–12 cr / image on kie Market',
                perImageCreditsMin: 6,
                perImageCreditsMax: 12,
                note: 'Wan 2.7 via kie. Live rate: kie.ai/pricing.'
            }
        },
        {
            id: 'grok-imagine',
            label: 'Grok Imagine',
            vendor: 'xai',
            product: 'Grok Imagine speed mode (Market jobs API)',
            tag: 'alt',
            family: 'grok-imagine',
            maxImageSize: '1K',
            supportsMultiReference: true,
            maxCharacterRefs: 1,
            maxPrompt: 5000,
            refField: 'image_urls',
            aspectField: 'aspect_ratio',
            i2iModel: 'grok-imagine/image-to-image',
            t2iModel: 'grok-imagine/text-to-image',
            mentionRefsInPrompt: true,
            aspectAllow: ['1:1', '2:3', '3:2', '16:9', '9:16'],
            costRank: 1,
            costLabel: '$',
            pricing: {
                headline: '≈ 4–8 cr / image on kie Market (speed mode)',
                perImageCreditsMin: 4,
                perImageCreditsMax: 8,
                note: 'xAI Grok Imagine via kie. Live rate: kie.ai/pricing.'
            }
        },
        {
            id: 'grok-imagine-2',
            label: 'Grok Imagine Image 2.0',
            vendor: 'xai',
            product: 'Grok Imagine quality mode (enable_pro / Image 2.0)',
            tag: 'alt',
            family: 'grok-imagine',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 5,
            maxPrompt: 5000,
            refField: 'image_urls',
            aspectField: 'aspect_ratio',
            i2iModel: 'grok-imagine/image-to-image',
            t2iModel: 'grok-imagine/text-to-image',
            mentionRefsInPrompt: true,
            forceEnablePro: true,
            aspectAllow: ['1:1', '2:3', '3:2', '16:9', '9:16'],
            costRank: 2,
            costLabel: '$$',
            pricing: {
                headline: '≈ 6–12 cr / image on kie Market (quality / Image 2.0)',
                perImageCreditsMin: 6,
                perImageCreditsMax: 12,
                note: 'xAI Grok Imagine 2.0 via kie (enable_pro). Live rate: kie.ai/pricing.'
            }
        },
        {
            id: 'flux-kontext',
            label: 'Flux Kontext',
            vendor: 'flux',
            product: 'Flux Kontext Pro/Max via dedicated Kontext API',
            tag: 'alt',
            family: 'flux-kontext',
            maxImageSize: '2K',
            supportsMultiReference: true,
            maxCharacterRefs: 1,
            maxPrompt: 5000,
            refField: 'inputImage',
            aspectField: 'aspectRatio',
            kontextModel: 'flux-kontext-pro',
            kontextModelMax: 'flux-kontext-max',
            aspectAllow: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
            costRank: 4,
            costLabel: '$$',
            pricing: {
                headline: '≈ 8–16 cr / image on kie Market',
                perImageCreditsMin: 8,
                perImageCreditsMax: 16,
                note: 'Flux Kontext Pro/Max via kie. Live rate: kie.ai/pricing.'
            }
        }
    ];

    const DEFAULT_THINKING = 'gemini-3.5-flash-lite';
    const DEFAULT_IMAGE = 'gemini-3.1-flash-lite-image';
    const DEFAULT_KIE_THINKING = 'gemini-3.5-flash-lite';
    const DEFAULT_KIE_IMAGE = 'nano-banana-2-lite';
    /** Default for first scene, /next scene, /time pass|/time skip, /jump — keep the stronger Flash. */
    const DEFAULT_SCENE_THINKING = 'gemini-3.7-flash';
    const DEFAULT_KIE_SCENE_THINKING = 'gemini-3.7-flash';

    const LEGACY_THINKING_ALIASES = {
        'gemini-3-pro': 'gemini-3.7-flash',
        'gemini-3.1-pro': 'gemini-3.7-flash',
        'gemini-3.1-pro-preview': 'gemini-3.7-flash',
        'gemini-3-flash': 'gemini-3.7-flash',
        'gemini-3-flash-preview': 'gemini-3.7-flash',
        'gemini-3.1-flash': 'gemini-3.5-flash',
        'gemini-3.1-flash-lite': 'gemini-3.5-flash-lite',
        'gemini-2.5-flash': 'gemini-3.7-flash',
        'gemini-2.5-pro': 'gemini-3.7-flash'
    };

    const LEGACY_IMAGE_ALIASES = {
        'nano-banana-pro': 'gemini-3-pro-image',
        'nano-banana-2': 'gemini-3.1-flash-image',
        'nano-banana-2-lite': 'gemini-3.1-flash-lite-image',
        'nano-banana': 'gemini-3.1-flash-image',
        'imagen-3.0-generate-002': 'gemini-3-pro-image',
        'gemini-2.0-flash-preview-image-generation': 'gemini-3-pro-image',
        'gemini-2.5-flash-image': 'gemini-3.1-flash-image',
        'qwen3/image-to-image': 'qwen3-image',
        'qwen3/text-to-image': 'qwen3-image',
        'qwen3/pro-image-to-image': 'qwen3-image-pro',
        'qwen3/pro-text-to-image': 'qwen3-image-pro',
        'gpt-image-2-image-to-image': 'gpt-image-2',
        'gpt-image-2-text-to-image': 'gpt-image-2',
        'seedream/5-pro-image-to-image': 'seedream-5-pro',
        'seedream/5-pro-text-to-image': 'seedream-5-pro',
        'seedream/5-lite-image-to-image': 'seedream-5-lite',
        'seedream/5-lite-text-to-image': 'seedream-5-lite',
        'wan/2-7-image': 'wan-2-7-image',
        'grok-imagine/image-to-image': 'grok-imagine',
        'grok-imagine/text-to-image': 'grok-imagine',
        'flux-kontext-pro': 'flux-kontext',
        'flux-kontext-max': 'flux-kontext'
    };

    const GOOGLE_TO_KIE_IMAGE = {
        'gemini-3-pro-image': 'nano-banana-pro',
        'gemini-3.1-flash-image': 'nano-banana-2',
        'gemini-3.1-flash-lite-image': 'nano-banana-2-lite'
    };
    const KIE_TO_GOOGLE_IMAGE = {
        'nano-banana-pro': 'gemini-3-pro-image',
        'nano-banana-2': 'gemini-3.1-flash-image',
        'nano-banana-2-lite': 'gemini-3.1-flash-lite-image',
        'google/nano-banana': 'gemini-3.1-flash-image',
        'qwen3-image': 'gemini-3.1-flash-image',
        'qwen3-image-pro': 'gemini-3-pro-image',
        'gpt-image-2': 'gemini-3-pro-image',
        'seedream-5-pro': 'gemini-3-pro-image',
        'seedream-5-lite': 'gemini-3.1-flash-image',
        'wan-2-7-image': 'gemini-3.1-flash-image',
        'grok-imagine': 'gemini-3.1-flash-image',
        'grok-imagine-2': 'gemini-3-pro-image',
        'flux-kontext': 'gemini-3.1-flash-image'
    };
    const GOOGLE_TO_KIE_THINKING = {
        'gemini-3.7-flash': 'gemini-3.7-flash',
        'gemini-3.6-flash': 'gemini-3.6-flash',
        'gemini-3.5-flash': 'gemini-3.5-flash',
        'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite'
    };
    const KIE_TO_GOOGLE_THINKING = {
        'gemini-3.7-flash': 'gemini-3.7-flash',
        'gemini-3.6-flash': 'gemini-3.7-flash',
        'gemini-3.5-flash': 'gemini-3.5-flash',
        'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite',
        'gpt-5.6-terra': 'gemini-3.7-flash',
        'gpt-5.6-luna': 'gemini-3.5-flash',
        'grok-4-3': 'gemini-3.7-flash',
        'grok-4-5': 'gemini-3.7-flash',
        'grok-4-6': 'gemini-3.7-flash'
    };

    function normalizeProvider(provider) {
        return provider === 'kie' ? 'kie' : 'google';
    }

    function thinkingModels(provider) {
        return normalizeProvider(provider) === 'kie' ? KIE_THINKING_MODELS : GOOGLE_THINKING_MODELS;
    }

    function imageModels(provider) {
        return normalizeProvider(provider) === 'kie' ? KIE_IMAGE_MODELS : GOOGLE_IMAGE_MODELS;
    }

    function defaultThinking(provider) {
        return normalizeProvider(provider) === 'kie' ? DEFAULT_KIE_THINKING : DEFAULT_THINKING;
    }

    function defaultImage(provider) {
        return normalizeProvider(provider) === 'kie' ? DEFAULT_KIE_IMAGE : DEFAULT_IMAGE;
    }

    function defaultSceneThinking(provider) {
        return normalizeProvider(provider) === 'kie'
            ? DEFAULT_KIE_SCENE_THINKING
            : DEFAULT_SCENE_THINKING;
    }

    /**
     * Best thinking model for character creation / forensic EDF (setup only).
     * Always prefer 3.7 Flash — playtime "recommended" is the cheap Lite default.
     */
    function bestThinkingModel(provider = 'google') {
        const list = thinkingModels(provider);
        if (!list.length) return defaultThinking(provider);
        const setup = list.find(m => m.id === 'gemini-3.7-flash');
        if (setup) return setup.id;
        let best = list[0];
        for (const m of list) {
            if ((Number(m.costRank) || 0) > (Number(best.costRank) || 0)) best = m;
        }
        return best.id;
    }

    function resolveThinkingModel(id, provider = 'google') {
        const list = thinkingModels(provider);
        if (list.some(m => m.id === id)) return id;
        if (normalizeProvider(provider) === 'kie') {
            const mapped = GOOGLE_TO_KIE_THINKING[id] || GOOGLE_TO_KIE_THINKING[LEGACY_THINKING_ALIASES[id]];
            if (mapped && list.some(m => m.id === mapped)) return mapped;
            return DEFAULT_KIE_THINKING;
        }
        if (LEGACY_THINKING_ALIASES[id] && list.some(m => m.id === LEGACY_THINKING_ALIASES[id])) {
            return LEGACY_THINKING_ALIASES[id];
        }
        const fromKie = KIE_TO_GOOGLE_THINKING[id];
        if (fromKie && list.some(m => m.id === fromKie)) return fromKie;
        return DEFAULT_THINKING;
    }

    function resolveImageModel(id, provider = 'google') {
        const list = imageModels(provider);
        if (list.some(m => m.id === id)) return id;
        if (normalizeProvider(provider) === 'kie') {
            const mapped = GOOGLE_TO_KIE_IMAGE[id]
                || LEGACY_IMAGE_ALIASES[id]
                || GOOGLE_TO_KIE_IMAGE[LEGACY_IMAGE_ALIASES[id]]
                || id;
            if (list.some(m => m.id === mapped)) return mapped;
            return DEFAULT_KIE_IMAGE;
        }
        if (LEGACY_IMAGE_ALIASES[id] && list.some(m => m.id === LEGACY_IMAGE_ALIASES[id])) {
            return LEGACY_IMAGE_ALIASES[id];
        }
        const fromKie = KIE_TO_GOOGLE_IMAGE[id];
        if (fromKie) return fromKie;
        return DEFAULT_IMAGE;
    }

    function getThinkingModel(id, provider = 'google') {
        const resolved = resolveThinkingModel(id, provider);
        const list = thinkingModels(provider);
        return list.find(m => m.id === resolved) || list[0];
    }

    function getImageModel(id, provider = 'google') {
        const resolved = resolveImageModel(id, provider);
        const list = imageModels(provider);
        return list.find(m => m.id === resolved) || list[0];
    }

    function usesGenerateContent(modelId, provider = 'google') {
        return normalizeProvider(provider) === 'google';
    }

    function usesInteractions(modelId, provider = 'google') {
        return normalizeProvider(provider) === 'google';
    }

    /** Gemini / Nano Banana family — prone to pre-submit safety blocks on explicit beats. */
    function isGeminiFamily(modelId) {
        const id = String(modelId || '').toLowerCase();
        return id.includes('gemini')
            || id.includes('nano-banana')
            || id.startsWith('google/');
    }

    function thinkingNeedsSoftening(modelId, provider = 'google') {
        const resolved = resolveThinkingModel(modelId, provider);
        return isGeminiFamily(resolved);
    }

    function imageNeedsSoftening(modelId, provider = 'google') {
        const resolved = resolveImageModel(modelId, provider);
        const meta = getImageModel(resolved, provider);
        return isGeminiFamily(resolved)
            || meta?.family === 'nano'
            || meta?.family === 'nano-lite';
    }

    function isLiteImageFamily(modelId, provider = 'google') {
        const meta = getImageModel(modelId, provider);
        return meta?.family === 'nano-lite'
            || /lite/i.test(String(meta?.id || modelId || ''));
    }

    function isGrokThinking(modelId) {
        const id = String(modelId || '').toLowerCase();
        return /^grok-4-\d/.test(id);
    }

    function formatOptionLabel(m) {
        if (!m) return '';
        const bits = [m.label];
        if (m.tag === 'recommended') bits.push('★');
        else if (m.tag === 'new') bits.push('new');
        if (m.costLabel) bits.push(m.costLabel);
        if (m.dropdownHint) bits.push(m.dropdownHint);
        else if (m.note) bits.push(m.note);
        if (m.latencyNote) bits.push(m.latencyNote);
        return bits.join(' · ');
    }

    function groupedModels(list) {
        const groups = new Map();
        (list || []).forEach((m) => {
            const v = m.vendor || 'other';
            if (!groups.has(v)) groups.set(v, []);
            groups.get(v).push(m);
        });
        return VENDOR_ORDER.filter(v => groups.has(v)).map(v => ({
            vendor: v,
            label: VENDOR_LABELS[v] || v,
            models: groups.get(v)
        }));
    }

    function optionsHtml(list, selectedId) {
        const groups = groupedModels(list);
        const escape = (s) => String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        if (groups.length <= 1) {
            return (list || []).map(m => {
                const selected = m.id === selectedId ? ' selected' : '';
                return `<option value="${escape(m.id)}"${selected}>${escape(formatOptionLabel(m))}</option>`;
            }).join('');
        }
        return groups.map((g) => {
            const opts = g.models.map(m => {
                const selected = m.id === selectedId ? ' selected' : '';
                return `<option value="${escape(m.id)}"${selected}>${escape(formatOptionLabel(m))}</option>`;
            }).join('');
            return `<optgroup label="${escape(g.label)}">${opts}</optgroup>`;
        }).join('');
    }

    /**
     * Scene-command model that should ride along with the main thinking pick.
     * Grok chat → same Grok for /jump /next scene (Gemini safety would mute Goon).
     * Otherwise the provider default (Gemini 3.7).
     */
    function pairedSceneThinking(thinkingId, provider = 'google') {
        const resolved = resolveThinkingModel(thinkingId, provider);
        if (isGrokThinking(resolved)) return resolved;
        return defaultSceneThinking(provider);
    }

    function modelGuideEntries(provider = 'google') {
        const prov = normalizeProvider(provider);
        const thinking = thinkingModels(prov).map(m => ({
            ...m,
            kind: 'thinking',
            kindLabel: 'Thinking (chat / scene)'
        }));
        const images = imageModels(prov).map(m => ({
            ...m,
            kind: 'image',
            kindLabel: 'Image',
            bestFor: m.bestFor || m.product || m.label,
            capability: m.capability || [
                m.maxImageSize ? `${m.maxImageSize} output` : null,
                m.supportsMultiReference ? `up to ${m.maxCharacterRefs || 1} refs` : 'no multi-ref',
                m.note || null
            ].filter(Boolean).join(' · '),
            caution: m.caution || (m.family === 'nano' || m.family === 'nano-lite'
                ? 'Gemini image safety can refuse explicit beats.'
                : ''),
            costNote: m.costNote || (m.pricing?.headline
                || `${m.costLabel || ''} · rank ${m.costRank || '—'} in this list (1 = cheapest).`)
        }));
        return {
            provider: prov,
            thinking,
            images,
            thinkingLabs: groupedModels(thinking),
            imageLabs: groupedModels(images),
            groups: groupedModels([...thinking, ...images])
        };
    }

    const TYPICAL_TURN = {
        thinkingInTokens: 6000,
        thinkingOutTokens: 500,
        creditUsd: 0.005
    };

    function formatCreditAmount(n) {
        const v = Number(n);
        if (!Number.isFinite(v) || v <= 0) return '';
        if (v >= 10) return String(Math.round(v));
        if (v >= 1) return v.toFixed(1).replace(/\.0$/, '');
        return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    }

    function thinkingTurnEstimate(m) {
        const p = m?.pricing || {};
        const inn = TYPICAL_TURN.thinkingInTokens / 1e6;
        const out = TYPICAL_TURN.thinkingOutTokens / 1e6;
        if (Number.isFinite(Number(p.inputPer1MCredits)) && Number.isFinite(Number(p.outputPer1MCredits))) {
            const cr = inn * Number(p.inputPer1MCredits) + out * Number(p.outputPer1MCredits);
            return {
                credits: cr,
                line: `≈ ${formatCreditAmount(cr)} cr / thinking turn`
            };
        }
        if (Number.isFinite(Number(p.inputPer1MUsd)) && Number.isFinite(Number(p.outputPer1MUsd))) {
            const usd = inn * Number(p.inputPer1MUsd) + out * Number(p.outputPer1MUsd);
            const cr = usd / TYPICAL_TURN.creditUsd;
            return {
                usd,
                credits: cr,
                line: `≈ ${formatCreditAmount(cr)} cr / thinking turn ($${usd.toFixed(4)})`
            };
        }
        return null;
    }

    function imageTurnEstimate(m) {
        const p = m?.pricing || {};
        if (Number.isFinite(Number(p.perImageUsd))) {
            const usd = Number(p.perImageUsd);
            const cr = usd / TYPICAL_TURN.creditUsd;
            return {
                usd,
                credits: cr,
                line: `≈ ${formatCreditAmount(cr)} cr / image ($${usd.toFixed(3)})`
            };
        }
        const min = Number(p.perImageCreditsMin);
        const max = Number(p.perImageCreditsMax);
        if (Number.isFinite(min) && Number.isFinite(max) && max >= min) {
            return {
                credits: (min + max) / 2,
                line: `≈ ${formatCreditAmount(min)}–${formatCreditAmount(max)} cr / image`
            };
        }
        if (Number.isFinite(Number(p.perImageCredits))) {
            const cr = Number(p.perImageCredits);
            return { credits: cr, line: `≈ ${formatCreditAmount(cr)} cr / image` };
        }
        return null;
    }

    function formatPriceHtml(m, esc) {
        const escape = typeof esc === 'function'
            ? esc
            : (s) => String(s || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        const p = m?.pricing;
        const isImage = m?.kind === 'image' || Number.isFinite(Number(p?.perImageUsd))
            || Number.isFinite(Number(p?.perImageCreditsMin))
            || (p?.perImage && !p?.input);
        const turn = isImage ? imageTurnEstimate(m) : thinkingTurnEstimate(m);
        if (!p && !turn) {
            const fallback = m?.costNote || m?.costLabel;
            return fallback ? `<p class="model-guide-price">${escape(fallback)}</p>` : '';
        }
        const lines = [];
        if (turn?.line) {
            lines.push(`<strong>${escape(turn.line)}</strong>`);
        }
        if (p?.headline && p.headline !== turn?.line) {
            lines.push(escape(p.headline));
        } else if (!turn && p?.input && p?.output) {
            lines.push(`Input ${escape(p.input)} · Output ${escape(p.output)} per 1M tokens`);
        } else if (!turn && p?.perImage) {
            lines.push(escape(p.perImage));
        }
        if (p?.official) lines.push(`Official list: ${escape(p.official)}`);
        const note = p?.note
            ? `<span class="model-guide-price-note">${escape(p.note)}</span>`
            : '';
        return `<p class="model-guide-price">${lines.join('<br>')}${note}</p>`;
    }

    const THINKING_MODELS = GOOGLE_THINKING_MODELS;
    const IMAGE_MODELS = GOOGLE_IMAGE_MODELS;

    global.MirageModels = {
        PROVIDERS,
        THINKING_MODELS,
        IMAGE_MODELS,
        GOOGLE_THINKING_MODELS,
        GOOGLE_IMAGE_MODELS,
        KIE_THINKING_MODELS,
        KIE_IMAGE_MODELS,
        DEFAULT_THINKING,
        DEFAULT_IMAGE,
        DEFAULT_KIE_THINKING,
        DEFAULT_KIE_IMAGE,
        DEFAULT_SCENE_THINKING,
        DEFAULT_KIE_SCENE_THINKING,
        LEGACY_THINKING_ALIASES,
        normalizeProvider,
        thinkingModels,
        imageModels,
        defaultThinking,
        defaultImage,
        defaultSceneThinking,
        bestThinkingModel,
        resolveThinkingModel,
        resolveImageModel,
        getThinkingModel,
        getImageModel,
        usesGenerateContent,
        usesInteractions,
        isGeminiFamily,
        thinkingNeedsSoftening,
        imageNeedsSoftening,
        isGrokThinking,
        formatOptionLabel,
        groupedModels,
        optionsHtml,
        pairedSceneThinking,
        modelGuideEntries,
        formatPriceHtml,
        formatCreditAmount,
        thinkingTurnEstimate,
        imageTurnEstimate,
        isLiteImageFamily,
        VENDOR_LABELS
    };
})(typeof window !== 'undefined' ? window : globalThis);
