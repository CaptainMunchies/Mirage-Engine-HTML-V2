/**
 * MIRAGE ENGINE v2 — IndexedDB connection helper
 *
 * The three stores (images, anchors, media library) each had their own copy of the
 * same twenty lines, with the same two gaps:
 *
 *   1. `dbPromise` was assigned the promise *before* it settled and never cleared on
 *      failure. One transient open error — private browsing, storage pressure, a
 *      corrupted profile — poisoned that store for the rest of the session: every
 *      later save, read and delete rejected against the same cached failure, with no
 *      retry short of a page reload.
 *
 *   2. No `onblocked` handler. Harmless while all three sit at version 1, but the
 *      moment a schema change bumps a version, a second open tab blocks the upgrade,
 *      the open request never settles, and every awaiting operation hangs forever
 *      with no error. The handler has to exist *before* the first migration, not
 *      after it.
 *
 * Also handles `versionchange`: when another tab wants to upgrade, this connection
 * closes itself so it doesn't become the thing blocking the upgrade.
 */
(function (global) {
    'use strict';

    /** How long to wait on a blocked upgrade before giving up with a real message. */
    const BLOCKED_TIMEOUT_MS = 10000;

    /**
     * @param {{name: string, version: number, upgrade: (db: IDBDatabase, event: IDBVersionChangeEvent) => void}} spec
     * @returns {{ open: () => Promise<IDBDatabase>, reset: () => void }}
     */
    function createConnection({ name, version, upgrade }) {
        let dbPromise = null;

        function reset() {
            dbPromise = null;
        }

        function open() {
            if (dbPromise) return dbPromise;

            const pending = new Promise((resolve, reject) => {
                let settled = false;
                let blockedTimer = null;

                const finish = (fn, value) => {
                    if (settled) return;
                    settled = true;
                    if (blockedTimer) clearTimeout(blockedTimer);
                    fn(value);
                };

                let req;
                try {
                    req = indexedDB.open(name, version);
                } catch (err) {
                    // Private browsing in some engines throws here rather than firing onerror.
                    finish(reject, err);
                    return;
                }

                req.onerror = () => finish(reject, req.error || new Error(`Could not open ${name}`));

                req.onupgradeneeded = (event) => {
                    try {
                        upgrade(req.result, event);
                    } catch (err) {
                        finish(reject, err);
                    }
                };

                req.onblocked = () => {
                    // Another tab holds an older version open. Give it a moment to
                    // respond to versionchange, then fail with something actionable
                    // instead of hanging every caller forever.
                    blockedTimer = setTimeout(() => {
                        finish(reject, new Error(
                            `${name} is blocked by another open Mirage tab. `
                            + 'Close the other tabs and reload.'
                        ));
                    }, BLOCKED_TIMEOUT_MS);
                };

                req.onsuccess = () => {
                    const db = req.result;
                    // Don't be the tab that blocks someone else's upgrade.
                    db.onversionchange = () => {
                        db.close();
                        reset();
                    };
                    db.onclose = () => reset();
                    finish(resolve, db);
                };
            });

            // Cache only while it is in flight or succeeded. A rejection clears the
            // cache so the next call gets a fresh attempt rather than the old failure.
            dbPromise = pending.catch(err => {
                reset();
                throw err;
            });
            return dbPromise;
        }

        return { open, reset };
    }

    global.MirageIDB = { createConnection };
})(typeof window !== 'undefined' ? window : globalThis);
