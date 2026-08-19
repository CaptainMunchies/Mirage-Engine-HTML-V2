/**
 * Start and stop the real mirage_server.py for a test run.
 *
 * The tests drive the actual app over http, not a stripped-down copy, because half
 * of what they need to cover — the proxy, the session token, IndexedDB, module load
 * order — only exists when it is served properly.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8080;
const ORIGIN = `http://localhost:${PORT}`;

function ping(timeoutMs = 800) {
    return new Promise(resolve => {
        const req = http.get(`${ORIGIN}/index.html`, { timeout: timeoutMs }, res => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

async function waitForServer(attempts = 40, delayMs = 250) {
    for (let i = 0; i < attempts; i++) {
        if (await ping()) return true;
        await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
}

/**
 * Reuse a server that's already running (someone has the app open), otherwise
 * start one and own it. Returns a stop() that only kills what it started.
 */
async function startServer({ quiet = true } = {}) {
    if (await ping()) {
        return { origin: ORIGIN, borrowed: true, stop: async () => {} };
    }

    // Same problem the launcher had: `python3` is not what Windows calls it, and a
    // machine may only have one of these. Take the first that reports 3.8+.
    const { execFileSync } = require('child_process');
    const CANDIDATES = process.platform === 'win32'
        ? [['py', ['-3']], ['python', []], ['python3', []]]
        : [['python3', []], ['python', []], ['py', ['-3']]];

    let python = null;
    for (const [cmd, prefix] of CANDIDATES) {
        try {
            execFileSync(cmd, [...prefix, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)'],
                { stdio: 'ignore' });
            python = [cmd, prefix];
            break;
        } catch { /* try the next one */ }
    }
    if (!python) {
        throw new Error(
            'No usable Python 3.8+ found (tried py -3, python, python3).\n'
            + 'Mirage needs it to serve the app. Install from https://www.python.org/downloads/ '
            + 'and tick "Add python.exe to PATH".'
        );
    }

    // Keep stderr so a genuine startup failure is reported, not guessed at.
    const stderr = [];
    const child = spawn(python[0], [...python[1], 'mirage_server.py'], {
        cwd: REPO_ROOT,
        stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
        detached: false
    });
    child.stderr?.on('data', d => stderr.push(String(d)));

    const ready = await waitForServer();
    if (!ready) {
        child.kill('SIGTERM');
        const detail = stderr.join('').trim();
        throw new Error(
            `mirage_server.py did not answer on ${ORIGIN}.`
            + (detail ? `\n${detail}` : ' Is port 8080 taken by something else?')
        );
    }

    return {
        origin: ORIGIN,
        borrowed: false,
        async stop() {
            child.kill('SIGTERM');
            // Give the socket a moment so a following run can rebind.
            await new Promise(r => setTimeout(r, 400));
        }
    };
}

module.exports = { startServer, ORIGIN, PORT, REPO_ROOT };
