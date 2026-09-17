/**
 * The wall, made mechanical.
 *
 * Phase 4 puts all screen code behind one boundary with two crossings, and is blunt
 * about why a written convention is not enough: an agent will comply until it gets
 * stuck, then quietly reach through. A rule in a document does not survive that. A
 * failing check does.
 *
 * So this reads the files that are declared behind the wall and fails if any of them
 * reaches for the engine, the DOM, or storage. A view gets everything it needs as an
 * argument; the moment one of them calls `S()` or `document.getElementById`, the
 * gallery stops being able to render it and the UI regains the ability to change how
 * she behaves.
 *
 * BEHIND_THE_WALL is an allowlist that GROWS. It is not a list of files that happen
 * to be clean — it is the set that is *promised* clean, and adding a file to it is
 * the act of moving that file behind the wall. Same shape as tests/tsconfig.json's
 * `files`, for the same reason.
 *
 * What this does not yet check is the other direction: that engine files stop
 * building markup. simulation.js still owns plenty of DOM, and declaring that a
 * violation today would fail on the first run with hundreds of findings, which is
 * how a check gets switched off. It comes as that code moves across.
 */
const fs = require('fs');
const path = require('path');
const { Suite, printSummary } = require('./lib/report');

const REPO_ROOT = path.resolve(__dirname, '..');

/** Files promised pure. Add a file here as part of moving it behind the wall. */
const BEHIND_THE_WALL = [
    'js/chat-view.js',
    'js/setup-view.js',
    'js/errors.js'
];

/**
 * Each rule is a name, a matcher, and the reason — the reason is what gets printed,
 * because "forbidden pattern" tells whoever hits this nothing about what to do.
 */
const RULES = [
    {
        name: 'engine state',
        re: /\bEngineState\b|\bS\(\)/,
        why: 'a view must be handed its data, not read it — pass it in as an argument'
    },
    {
        name: 'the DOM',
        re: /\bdocument\b|getElementById|querySelector/,
        why: 'a view returns markup; the caller decides where it goes'
    },
    {
        name: 'storage',
        re: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/,
        why: 'persistence is the engine\'s job, and it is what stops a gallery rendering this'
    },
    {
        name: 'an engine module',
        re: /\bMirage[A-Z][A-Za-z]*\b/,
        why: 'reaching sideways into the engine is the crossing this wall exists to prevent'
    },
    {
        name: 'a timer',
        re: /\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b/,
        why: 'a view has no lifetime of its own — timing belongs to the caller'
    }
];

/**
 * The module footer every file in this codebase ends with names `window`, and the
 * header comments describe what the file deliberately does *not* touch. Scanning raw
 * text would flag both, and a check that cries wolf is a check that gets deleted.
 */
const FOOTER = /\(typeof window !== 'undefined' \? window : globalThis\)/;

function scan(relPath) {
    const abs = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(abs)) {
        return [{ line: 0, rule: 'the file', why: `${relPath} does not exist` }];
    }
    const src = fs.readFileSync(abs, 'utf8');
    const lines = src.split('\n');

    // Every module in this codebase ends by hanging itself off `global`, so its own
    // name is the one Mirage* identifier that is not a reach sideways. Deriving that
    // rather than hardcoding it is what lets the next file join the wall without
    // editing this rule — the first draft special-cased MirageChatView by name and
    // would have flagged the export line of every file added after it.
    const ownNames = [...src.matchAll(/(?:global|window)\.(Mirage[A-Za-z]*)\s*=/g)].map(m => m[1]);
    const ownRe = ownNames.length
        ? new RegExp(`\\b(?:${ownNames.join('|')})\\b`, 'g')
        : null;

    const findings = [];
    let inBlockComment = false;

    lines.forEach((raw, i) => {
        let code = raw;

        if (inBlockComment) {
            const end = code.indexOf('*/');
            if (end < 0) return;
            code = code.slice(end + 2);
            inBlockComment = false;
        }
        // Strip block comments that open and close on this line, then any that open
        // and run on.
        code = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
        const open = code.indexOf('/*');
        if (open >= 0) {
            code = code.slice(0, open);
            inBlockComment = true;
        }
        code = code.replace(/\/\/.*$/, '');
        code = code.replace(FOOTER, ' ');
        if (ownRe) code = code.replace(ownRe, 'OWN');
        if (!code.trim()) return;

        RULES.forEach((rule) => {
            if (rule.re.test(code)) {
                findings.push({ line: i + 1, rule: rule.name, why: rule.why, text: raw.trim() });
            }
        });
    });

    return findings;
}

async function run() {
    const suite = new Suite('Boundary — the wall, checked');

    await suite.test('nothing behind the wall reaches through it', async (t) => {
        t.ok(BEHIND_THE_WALL.length > 0, 'no files are declared behind the wall');

        const problems = [];
        BEHIND_THE_WALL.forEach((relPath) => {
            scan(relPath).forEach((f) => {
                problems.push(`${relPath}:${f.line} reaches for ${f.rule} — ${f.why}`
                    + (f.text ? `\n          ${f.text.slice(0, 110)}` : ''));
            });
        });

        if (problems.length) {
            t.fail(`${problems.length} boundary violation(s):\n        ${problems.join('\n        ')}`);
        }
    });

    const s = suite.summary();
    printSummary('Boundary', s);
    return s;
}

module.exports = { run, BEHIND_THE_WALL, scan };
