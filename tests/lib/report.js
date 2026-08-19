/**
 * Assertions and reporting.
 *
 * Layer 3 needs a category the usual runners don't have: a test that asserts the
 * *intended* behaviour of something the engine gets wrong today. Those are marked
 * `expectedRed`. A failing expected-red test is reported as a known gap, not a
 * broken suite — and an expected-red test that *passes* is reported loudly, because
 * it means the gap closed and the marker should come off.
 */

const C = process.stdout.isTTY
    ? { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
    : { green: '', red: '', yellow: '', dim: '', bold: '', off: '' };

class Suite {
    constructor(name) {
        this.name = name;
        this.results = [];
        this.current = null;
    }

    /**
     * @param {string} name
     * @param {() => Promise<void>} fn
     * @param {{expectedRed?: string}} [opts] expectedRed holds *why* it is red.
     */
    async test(name, fn, opts = {}) {
        this.current = { name, expectedRed: opts.expectedRed || null, failures: [] };
        try {
            await fn(this.assertions());
        } catch (err) {
            this.current.failures.push(`threw: ${err.message}`);
        }
        this.results.push(this.current);
        const r = this.current;
        this.current = null;

        const passed = r.failures.length === 0;
        if (passed && !r.expectedRed) {
            console.log(`  ${C.green}pass${C.off}  ${name}`);
        } else if (passed && r.expectedRed) {
            console.log(`  ${C.yellow}FIXED${C.off} ${name}`);
            console.log(`        ${C.dim}was expected to fail: ${r.expectedRed}${C.off}`);
            console.log(`        ${C.dim}remove the expectedRed marker${C.off}`);
        } else if (!passed && r.expectedRed) {
            console.log(`  ${C.yellow}red${C.off}   ${name}  ${C.dim}(known: ${r.expectedRed})${C.off}`);
            r.failures.forEach(f => console.log(`        ${C.dim}${f}${C.off}`));
        } else {
            console.log(`  ${C.red}FAIL${C.off}  ${name}`);
            r.failures.forEach(f => console.log(`        ${f}`));
        }
        return passed;
    }

    assertions() {
        const fail = (msg) => this.current.failures.push(msg);
        return {
            ok: (cond, msg) => { if (!cond) fail(msg || 'expected truthy'); },
            notOk: (cond, msg) => { if (cond) fail(msg || 'expected falsy'); },
            equal: (actual, expected, msg) => {
                if (actual !== expected) {
                    fail(`${msg || 'not equal'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
                }
            },
            deepEqual: (actual, expected, msg) => {
                const a = JSON.stringify(actual);
                const b = JSON.stringify(expected);
                if (a !== b) fail(`${msg || 'not deep-equal'}\n          expected ${b}\n          got      ${a}`);
            },
            match: (actual, re, msg) => {
                if (!re.test(String(actual ?? ''))) {
                    fail(`${msg || 'no match'} — ${re} did not match ${JSON.stringify(String(actual ?? '').slice(0, 160))}`);
                }
            },
            noMatch: (actual, re, msg) => {
                if (re.test(String(actual ?? ''))) {
                    fail(`${msg || 'unexpected match'} — ${re} matched ${JSON.stringify(String(actual ?? '').slice(0, 160))}`);
                }
            },
            between: (actual, min, max, msg) => {
                const n = Number(actual);
                if (!(n >= min && n <= max)) fail(`${msg || 'out of range'} — ${n} not in [${min}, ${max}]`);
            },
            fail
        };
    }

    summary() {
        const pass = this.results.filter(r => !r.failures.length && !r.expectedRed).length;
        const red = this.results.filter(r => r.failures.length && r.expectedRed).length;
        const fixed = this.results.filter(r => !r.failures.length && r.expectedRed).length;
        const fail = this.results.filter(r => r.failures.length && !r.expectedRed).length;
        return { total: this.results.length, pass, fail, red, fixed };
    }
}

function printSummary(name, s) {
    const bits = [`${s.pass} passed`];
    if (s.fail) bits.push(`${C.red}${s.fail} failed${C.off}`);
    if (s.red) bits.push(`${C.yellow}${s.red} known-red${C.off}`);
    if (s.fixed) bits.push(`${C.yellow}${s.fixed} newly fixed${C.off}`);
    console.log(`\n${C.bold}${name}${C.off}: ${bits.join(', ')}  ${C.dim}(${s.total} total)${C.off}`);
}

module.exports = { Suite, printSummary, C };
