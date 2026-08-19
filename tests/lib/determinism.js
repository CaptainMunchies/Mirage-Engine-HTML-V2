/**
 * Make a run reproducible.
 *
 * The engine leans on randomness deliberately — delivery-style weights, every
 * randBetween in the pacing ladder, shot variance, the mock's reaction emoji. That is
 * the right design for the product and the wrong one for a baseline: without a seed,
 * Layer 2 would re-record noise on every run and never catch a real regression.
 *
 * This is installed from the test side only. The app is not modified and has no idea
 * it is being observed — which matters, because a test hook inside the engine would
 * be one more thing that can drift from what actually ships.
 */

/**
 * Returns an init script (runs before any app code in a fresh page) that:
 *   - replaces Math.random with a seeded xorshift PRNG
 *   - freezes the wall clock and advances it by a fixed step per read, so anything
 *     derived from Date.now() is stable but still monotonic
 *   - leaves timers alone: the suites use Instant pacing, so nothing wall-waits
 *
 * @param {{seed?: number, startTime?: number, stepMs?: number}} opts
 */
function determinismScript({ seed = 0x5eed1e, startTime = Date.UTC(2026, 4, 14, 15, 30, 0), stepMs = 1 } = {}) {
    return `(() => {
        // xorshift32 — small, fast, and identical across engines, which a
        // Math.random polyfill built on a float accumulator would not be.
        let __state = ${seed} >>> 0;
        Math.random = function seededRandom() {
            __state ^= __state << 13; __state >>>= 0;
            __state ^= __state >>> 17;
            __state ^= __state << 5;  __state >>>= 0;
            return __state / 4294967296;
        };

        // Monotonic fake clock. Real Date.now() would put a fresh timestamp in every
        // recording; a fully frozen one breaks code that measures elapsed time.
        let __clock = ${startTime};
        const __RealDate = Date;
        const __step = ${stepMs};
        const nowFn = () => { __clock += __step; return __clock; };

        function FakeDate(...args) {
            if (!(this instanceof FakeDate)) return new __RealDate(nowFn()).toString();
            return args.length === 0 ? new __RealDate(nowFn()) : new __RealDate(...args);
        }
        FakeDate.prototype = __RealDate.prototype;
        FakeDate.now = nowFn;
        FakeDate.parse = __RealDate.parse;
        FakeDate.UTC = __RealDate.UTC;
        Object.setPrototypeOf(FakeDate, __RealDate);
        window.Date = FakeDate;

        // Let a suite read or reset the clock without reaching into internals.
        window.__mirageTestClock = {
            get: () => __clock,
            set: (ms) => { __clock = ms; },
            advance: (ms) => { __clock += ms; }
        };
        window.__mirageSeeded = true;
    })();`;
}

/**
 * Recording-safe normalization. Even seeded, a few values are inherently
 * per-run — generated ids, object URLs, absolute timestamps in ISO form. Replace
 * them with stable placeholders so a diff shows behaviour changes, not noise.
 */
function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]);
        return out;
    }
    if (typeof value !== 'string') return value;
    return value
        .replace(/\bcharacter-[a-z0-9]+/gi, 'character-<id>')
        .replace(/\bchat-[a-z0-9]+(-[a-z0-9]+)?/gi, 'chat-<id>')
        .replace(/\bprobe-[a-z0-9]+/gi, 'probe-<id>')
        .replace(/blob:[^\s"']+/gi, 'blob:<url>')
        .replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/gi, 'data:image/<mime>;base64,<data>')
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<iso>')
        .replace(/\b\d{13}\b/g, '<epoch>');
}

module.exports = { determinismScript, normalize };
