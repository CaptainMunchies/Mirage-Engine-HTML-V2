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

    // Keep stderr so a genuine startup failure is reported, not guessed at.
    const stderr = [];
    const child = spawn('python3', ['mirage_server.py'], {
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
