/**
 * The state gallery — every thread state, from fake data, in one page.
 *
 * Rule, and the whole reason this is worth having: **the gallery writes none of
 * the app's markup.** Every bubble, caption, alert and phone card here comes out
 * of `MirageChatView`, the same function `simulation.js` calls. A gallery that
 * draws its own copy of the UI is decoration — it drifts within a week and then
 * lies to you about what the product looks like.
 *
 * What it does own is its own chrome (the nav, the section headings) and the
 * container shells those entries sit in, which are lifted from `index.html`.
 * Those are the one place drift is still possible; they are static markup and a
 * short list, but they are not yet behind the wall.
 *
 * No engine, no network, no credits. Seeing "blocked by safety filter" used to
 * mean playing until you hit it.
 */
(function () {
    'use strict';

    const V = window.MirageChatView;

    /** A stand-in photo: inline SVG, so the page needs no network and no credits. */
    const FAKE_PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="270" height="480" viewBox="0 0 270 480">
            <defs>
                <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#3a3550"/>
                    <stop offset="100%" stop-color="#16141f"/>
                </linearGradient>
            </defs>
            <rect width="270" height="480" fill="url(#g)"/>
            <circle cx="135" cy="185" r="58" fill="#5b5375"/>
            <rect x="72" y="262" width="126" height="150" rx="46" fill="#5b5375"/>
            <text x="135" y="452" font-family="system-ui,sans-serif" font-size="13"
                  fill="#9d95bb" text-anchor="middle">fake frame</text>
        </svg>`.trim());

    const HER = 'adi dahan';

    /** Shorthand so a scene reads as a list of beats rather than a wall of objects. */
    const her = (text, timeLabel = '4:18 AM') => ({ role: 'ai', text, timeLabel, name: HER });
    const you = (text, timeLabel = '4:17 AM') => ({ role: 'user', text, timeLabel });
    const caption = (text) => ({ kind: 'caption', text });
    const command = (text, clockNote = '') => ({ kind: 'command', role: 'user', text, clockNote, timeLabel: '4:20 AM' });
    const alert = (title, body, alertType = 'warn') => ({ kind: 'alert', title, body, alertType });
    const story = (text, timeLabel = '4:18 AM') => ({ role: 'ai', kind: 'story', text, timeLabel });

    /**
     * The inventory. Each scene is a name, a one-line note on why it is worth
     * looking at, and the entries / cards that make it up.
     */
    const SCENES = [
        {
            id: 'empty',
            name: 'Empty thread',
            note: 'First launch, before anything has happened.',
            entries: [],
            cards: []
        },
        {
            id: 'first-turn',
            name: 'First turn',
            note: 'One message out, one reply back.',
            entries: [you('hey'), her('hey you 🙈')],
            cards: [{ text: 'hey you 🙈', imageUrl: FAKE_PHOTO, mode: 'DM', name: HER, timeLabel: '4:18 AM' }]
        },
        {
            id: 'text-only',
            name: 'Text only',
            note: 'Images off, or a turn that did not warrant one.',
            entries: [you('you up?'), her('barely 💀')],
            cards: [{ text: 'barely 💀', mode: 'DM', textOnly: true, name: HER, timeLabel: '4:19 AM' }]
        },
        {
            id: 'with-photo',
            name: 'With photo',
            note: 'The ordinary case — DM card with a generated frame.',
            entries: [you('send me a pic'), her('only for you 🥺')],
            cards: [{ text: 'only for you 🥺', imageUrl: FAKE_PHOTO, mode: 'DM', name: HER, timeLabel: '4:21 AM' }]
        },
        {
            id: 'story',
            name: 'Story',
            note: 'A public post, not a DM. Different badge, different card chrome.',
            entries: [story('מי עוד ער בארבע בבוקר ולמה המוח שלי לא נכבה 💀')],
            cards: [{
                text: 'מי עוד ער בארבע בבוקר ולמה המוח שלי לא נכבה 💀',
                imageUrl: FAKE_PHOTO, mode: 'STORY', name: HER, timeLabel: '4:18 AM'
            }]
        },
        {
            id: 'double-text',
            name: 'Double text',
            note: 'Two bubbles from her, no message from you in between.',
            entries: [
                you('sorry was in a meeting'),
                her('mhm 🙄', '4:31 AM'),
                her('kidding. how was it?', '4:31 AM')
            ],
            cards: []
        },
        {
            id: 'reaction',
            name: 'Reaction',
            note: 'She reacts instead of replying — a designed outcome, not a failure.',
            entries: [you('look at this'), her('[reaction 😂]', '4:33 AM')],
            cards: []
        },
        {
            id: 'left-on-read',
            name: 'Left on read',
            note: 'She read it and said nothing. The caption is the only thing you get.',
            entries: [you('you there?'), caption('Left on read…')],
            cards: []
        },
        {
            id: 'went-quiet',
            name: 'Went quiet',
            note: 'A longer withdrawal than left-on-read.',
            entries: [you('helloo'), caption('She’s gone quiet — she’ll text when she’s ready.')],
            cards: []
        },
        {
            id: 'ghost-type',
            name: 'Typing, then deleted',
            note: 'Typing dots appear, then nothing. Without the caption this looks like a bug.',
            entries: [you('what are you up to'), caption('She was typing… then deleted it.')],
            cards: []
        },
        {
            id: 'wait-running',
            name: 'Wait running',
            note: 'Sim time passing while you wait on her.',
            entries: [
                you('?'),
                caption('1h 20m passed without a reply.'),
                caption('She’s gone quiet — she’ll text when she’s ready.')
            ],
            cards: []
        },
        {
            id: 'failed-image',
            name: 'Failed image',
            note: 'Her text survives; only the photo is gone. The card says so rather than showing a gap.',
            entries: [
                you('one more'),
                her('here 🫠'),
                alert('Image failed to generate', 'Something went wrong during image generation. Retry the last image, or Test Connection in Settings if it keeps failing.', 'image-fail')
            ],
            cards: [{ text: 'here 🫠', mode: 'DM', imageFailed: true, name: HER, timeLabel: '4:40 AM' }]
        },
        {
            id: 'safety-block',
            name: 'Blocked by safety filter',
            note: 'Distinct from a generic failure — the card names the filter.',
            entries: [
                you('take it off'),
                alert('Image blocked by safety filter', 'Text still sent. Use Retry Last Image, or switch models in Settings if this keeps happening.', 'image-fail')
            ],
            cards: [{ text: 'no 🙈', mode: 'DM', imageFailed: true, imageFailReason: 'filtered', name: HER, timeLabel: '4:41 AM' }]
        },
        {
            id: 'thinking-timeout',
            name: 'Thinking never answered',
            note: 'No text, no photo attempted — the copy has to not send you to the image buttons.',
            entries: [
                you('את תתחרטי על זה'),
                alert('Thinking model never answered', 'The thinking model did not answer in time (model: gemini-3.7-flash). She never wrote anything and no photo was attempted, so there is nothing half-finished to recover — send the message again.')
            ],
            cards: []
        },
        {
            id: 'command',
            name: 'Operator command',
            note: 'Not a message to her — an instruction, with the clock move it caused.',
            entries: [
                command('/next scene', '7:24 AM → 10:24 AM'),
                her('מי בכלל מתפקד לפני הקפה הראשון של הבוקר ☕️🥴', '10:24 AM')
            ],
            cards: []
        },
        {
            id: 'languages',
            name: 'Hebrew, English, mixed',
            note: 'RTL, LTR and both in one bubble — the case most likely to lay out wrong.',
            entries: [
                you('מה את עושה עכשיו'),
                her('כלום ממש, סתם מסתובבת בבית 🫠'),
                you('send me something then'),
                her('רגע אחד ok? 🙈 אני מוצאת אור טוב'),
                her('ok found it — הנה 📸')
            ],
            cards: [{ text: 'ok found it — הנה 📸', imageUrl: FAKE_PHOTO, mode: 'DM', name: HER, timeLabel: '4:45 AM' }]
        },
        {
            id: 'mock-image',
            name: 'Mock image (developer mode)',
            note: 'Badged so a dev frame is never mistaken for a real one.',
            entries: [her('mock turn')],
            cards: [{ text: 'mock turn', mode: 'DM', mock: true, name: HER, timeLabel: '4:50 AM' }]
        }
    ];

    function el(tag, className, html) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (html != null) node.innerHTML = html;
        return node;
    }

    /** The chat log shell, lifted from index.html. */
    function renderThread(entries) {
        const log = el('div', 'chat-log card');
        entries.forEach((view) => {
            const painted = V.chatEntry(view);
            const entry = el('div', painted.className, painted.html);
            log.appendChild(entry);
        });
        if (!entries.length) {
            log.appendChild(el('div', 'gallery-empty', 'chat log, empty'));
        }
        return log;
    }

    /** The phone shell, lifted from index.html. */
    function renderPhone(cards) {
        const shell = el('div', 'gallery-phone');
        shell.innerHTML = `
            <div class="phone-chat-header">
                <span class="phone-header-avatar" aria-hidden="true">A</span>
                <div class="phone-header-text">
                    <strong>${V.escapeHtml(HER)}</strong>
                    <span class="phone-presence" data-state="idle">Active now</span>
                </div>
            </div>`;
        const screen = el('div', 'phone-screen');
        const feed = el('div', 'phone-feed');
        if (!cards.length) {
            screen.appendChild(el('div', 'phone-empty', '<p>Visuals appear here</p><span>Send a message to generate the first turn</span>'));
        }
        cards.forEach((view) => {
            const painted = V.phoneCard(view);
            const card = el('div', painted.className, painted.html);
            const meta = el('div', 'phone-card-meta');
            meta.textContent = view.timeLabel || '';
            card.appendChild(meta);
            feed.appendChild(card);
        });
        screen.appendChild(feed);
        shell.appendChild(screen);
        return shell;
    }

    function renderScene(scene) {
        const section = el('section', 'gallery-scene');
        section.id = `scene-${scene.id}`;
        section.appendChild(el('h2', 'gallery-scene-name', V.escapeHtml(scene.name)));
        section.appendChild(el('p', 'gallery-scene-note', V.escapeHtml(scene.note)));
        const split = el('div', 'gallery-split');
        split.appendChild(renderThread(scene.entries));
        split.appendChild(renderPhone(scene.cards));
        section.appendChild(split);
        return section;
    }

    function render() {
        const nav = document.getElementById('galleryNav');
        const main = document.getElementById('galleryMain');
        if (!nav || !main) return;

        SCENES.forEach((scene) => {
            const link = el('a', 'gallery-nav-link', V.escapeHtml(scene.name));
            link.href = `#scene-${scene.id}`;
            nav.appendChild(link);
            main.appendChild(renderScene(scene));
        });

        const count = document.getElementById('galleryCount');
        if (count) count.textContent = `${SCENES.length} states`;
    }

    // Exposed so the suite can assert every scene still renders something.
    window.MirageGallery = { SCENES, render, renderScene };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render, { once: true });
    } else {
        render();
    }
})();
