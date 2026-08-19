/**
 * MIRAGE ENGINE v2 — Local proxy session token
 *
 * mirage_server.py mints a random token per run and requires it on every
 * /api/proxy/* request. The token is served from /api/proxy/session with no CORS
 * header, so only this page — same-origin — can read it. That is what stops any
 * other site open in the browser from driving the proxy while Mirage is running.
 *
 * Cached for the life of the page. A server restart mints a new token, so a stale
 * one comes back as 403 and is refetched once.
 */
(function (global) {
    'use strict';

    const ENDPOINT = '/api/proxy/session';
    const HEADER = 'X-Mirage-Session';

    let tokenPromise = null;
    let cachedToken = '';

    async function fetchToken() {
        const res = await fetch(ENDPOINT, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin'
        });
        if (!res.ok) throw new Error(`Proxy session token refused (HTTP ${res.status})`);
        const data = await res.json();
        const token = String(data?.token || '').trim();
        if (!token) throw new Error('Proxy returned an empty session token');
        return token;
    }

    /** Resolves to the token, fetching at most once unless it is invalidated. */
    function ensureToken() {
        if (!tokenPromise) {
            tokenPromise = fetchToken()
                .then(t => { cachedToken = t; return t; })
                .catch(err => { tokenPromise = null; throw err; });
        }
        return tokenPromise;
    }

    /** Drop the cached token so the next call refetches — used after a 403. */
    function invalidate() {
        tokenPromise = null;
        cachedToken = '';
    }

    /** Merge the session header into a headers object. */
    async function withSession(headers) {
        const token = await ensureToken();
        return { ...(headers || {}), [HEADER]: token };
    }

    /** Synchronous read for callers that already awaited ensureToken(). */
    function current() {
        return cachedToken;
    }

    global.MirageProxySession = {
        HEADER,
        ensureToken,
        withSession,
        invalidate,
        current
    };
})(typeof window !== 'undefined' ? window : globalThis);
