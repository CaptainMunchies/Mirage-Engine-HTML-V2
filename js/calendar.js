/**
 * MIRAGE ENGINE v2 — Holiday / identity calendar catalog
 *
 * Downloads major-religion + civic + identity observances once on first boot,
 * persists them in localStorage, and answers lookups from her sim clock (TZ).
 * LIVE STATE only gets a short DATE CONTEXT — never the full catalog.
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'mirage_v2_holiday_catalog';
    const PACK_VERSION = 1;
    const FETCH_MS = 8000;
    const CORE_COUNTRIES = ['US', 'GB', 'IL', 'IN', 'CA', 'AU'];

    /** @type {{ version: number, fetchedAt: string|null, sources: object, fetchedYears: number[], years: Record<string, object[]> } | null} */
    let catalog = null;
    /** @type {Map<string, object[]>} */
    let byDate = new Map();
    let readyPromise = null;
    let fetchInFlight = null;
    const attemptedThisSession = new Set();

    const WEEKDAY_IX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

    const COUNTRY_HINTS = [
        { re: /israel|tel[\s-]?aviv|jerusalem|haifa|herzliya|netanya|eilat|beer[\s-]?sheva|רמת|תל[\s-]?אביב|ישראל|ירושלים/i, code: 'IL' },
        { re: /\b(usa|u\.s\.a\.|united states|new york|los angeles|chicago|miami|boston|seattle|austin|dallas|houston|denver|atlanta|san francisco|brooklyn|manhattan)\b/i, code: 'US' },
        { re: /\b(uk|united kingdom|england|scotland|wales|london|manchester|edinburgh|dublin)\b/i, code: 'GB' },
        { re: /\b(ireland|dublin)\b/i, code: 'IE' },
        { re: /\b(canada|toronto|vancouver|montreal|ottawa)\b/i, code: 'CA' },
        { re: /\b(australia|sydney|melbourne|brisbane)\b/i, code: 'AU' },
        { re: /\b(india|mumbai|delhi|bangalore|bengaluru|hyderabad|kolkata|chennai)\b/i, code: 'IN' },
        { re: /\b(france|paris|lyon|marseille)\b/i, code: 'FR' },
        { re: /\b(germany|berlin|munich|hamburg|köln|cologne)\b/i, code: 'DE' },
        { re: /\b(mexico|cdmx|guadalajara|monterrey)\b/i, code: 'MX' },
        { re: /\b(brazil|brasil|s[aã]o paulo|rio de janeiro)\b/i, code: 'BR' },
        { re: /\b(japan|tokyo|osaka|kyoto)\b/i, code: 'JP' },
        { re: /\b(korea|seoul)\b/i, code: 'KR' },
        { re: /\b(uae|dubai|abu dhabi)\b/i, code: 'AE' },
        { re: /\b(saudi|riyadh|jeddah)\b/i, code: 'SA' },
        { re: /\b(turkey|t[uü]rkiye|istanbul|ankara)\b/i, code: 'TR' },
        { re: /\b(nigeria|lagos|abuja)\b/i, code: 'NG' },
        { re: /\b(south africa|johannesburg|cape town)\b/i, code: 'ZA' },
        { re: /\b(philippines|manila)\b/i, code: 'PH' },
        { re: /\b(indonesia|jakarta|bali)\b/i, code: 'ID' },
        { re: /\b(pakistan|karachi|lahore)\b/i, code: 'PK' },
        { re: /\b(egypt|cairo)\b/i, code: 'EG' },
        { re: /\b(spain|madrid|barcelona)\b/i, code: 'ES' },
        { re: /\b(italy|rome|milan)\b/i, code: 'IT' },
        { re: /\b(netherlands|amsterdam)\b/i, code: 'NL' },
        { re: /\b(sweden|stockholm)\b/i, code: 'SE' },
        { re: /\b(poland|warsaw)\b/i, code: 'PL' },
        { re: /\b(china|beijing|shanghai|hong kong)\b/i, code: 'CN' }
    ];

    const GROUP_LABELS = {
        jewish: 'Jewish',
        muslim: 'Muslim',
        christian: 'Christian',
        orthodox: 'Orthodox Christian',
        hindu: 'Hindu',
        buddhist: 'Buddhist',
        sikh: 'Sikh',
        bahai: "Bahá'í",
        lgbtq: 'LGBTQ+',
        black: 'Black / African diaspora',
        latine: 'Latino/a',
        asian: 'East/Southeast Asian',
        indigenous: 'Indigenous',
        women: 'family / motherhood',
        iranian: 'Iranian / Persian'
    };

    const RELIGION_GROUPS = ['jewish', 'muslim', 'christian', 'orthodox', 'hindu', 'buddhist', 'sikh', 'bahai', 'iranian'];

    const GROUP_MATCH = [
        { group: 'jewish', re: /jew(?:ish)?|judaism|israeli|israelite|hebrew|yiddish|ashkenazi|sephardi|mizrahi|shabbat|shabbos|kosher|synagogue|chabad|pesach|passover|hanukkah|chanukah|yom[\s-]?kippur|rosh[\s-]?hashanah|bar[\s-]?mitzvah|bat[\s-]?mitzvah|sabbath|tel[\s-]?aviv|יהוד[ייה]|דתי[יה]?|שומרת[\s-]?שבת|ישראל/i },
        { group: 'muslim', re: /muslim|islam|islamic|ramadan|hijab|mosque|masjid|halal|sunni|shia|shi'?ite/i },
        { group: 'christian', re: /christian|catholic|protestant|evangelical|\bchurch\b|baptist|lutheran|methodist|presbyterian|born[\s-]?again/i },
        { group: 'orthodox', re: /orthodox|greek orthodox|russian orthodox|coptic|eastern orthodox/i },
        { group: 'hindu', re: /hindu|diwali|holi|vedic/i },
        { group: 'buddhist', re: /buddhist|buddhism|vesak/i },
        { group: 'sikh', re: /sikh|vaisakhi|gurdwara|punjabi sikh/i },
        { group: 'bahai', re: /bah[aá]['’]?[ií]|baha'i/i },
        { group: 'lgbtq', re: /lgbt|queer|gay|lesbian|bisexual|trans\b|nonbinary|non-binary|pride/i },
        { group: 'black', re: /black|african[\s-]american|afro|caribbean|nigeria|kenya|ghana/i },
        { group: 'latine', re: /latin[oaex]|hispanic|mexico|mexican|brazil|colombian|puerto ric/i },
        { group: 'asian', re: /chinese|korean|japanese|vietnamese|filipino|taiwan|lunar new year|aapi/i },
        { group: 'indigenous', re: /indigenous|native american|first nations|aboriginal|m[aā]ori/i },
        { group: 'women', re: /\b(mother|mom\b|mum\b|kids|children|son|daughter|parent)\b/i },
        { group: 'iranian', re: /iran|persian|farsi|nowruz/i }
    ];

    const LUNAR_NEW_YEAR = {
        2024: ['2024-02-10', 'Dragon'],
        2025: ['2025-01-29', 'Snake'],
        2026: ['2026-02-17', 'Horse'],
        2027: ['2027-02-06', 'Goat'],
        2028: ['2028-01-26', 'Monkey'],
        2029: ['2029-02-13', 'Rooster'],
        2030: ['2030-02-03', 'Dog'],
        2031: ['2031-01-23', 'Pig'],
        2032: ['2032-02-11', 'Rat'],
        2033: ['2033-01-31', 'Ox']
    };
    const DIWALI = {
        2024: '2024-11-01', 2025: '2025-10-20', 2026: '2026-11-08', 2027: '2027-10-29',
        2028: '2028-10-17', 2029: '2029-11-05', 2030: '2030-10-26', 2031: '2031-11-14',
        2032: '2032-11-02', 2033: '2033-10-22'
    };
    const HOLI = {
        2024: '2024-03-25', 2025: '2025-03-14', 2026: '2026-03-03', 2027: '2027-03-22',
        2028: '2028-03-11', 2029: '2029-03-01', 2030: '2030-03-20', 2031: '2031-03-09',
        2032: '2032-03-27', 2033: '2033-03-16'
    };
    const VESAK = {
        2024: '2024-05-22', 2025: '2025-05-12', 2026: '2026-05-31', 2027: '2027-05-20',
        2028: '2028-05-08', 2029: '2029-05-27', 2030: '2030-05-16', 2031: '2031-05-06',
        2032: '2032-05-24', 2033: '2033-05-14'
    };
    const GURU_NANAK = {
        2024: '2024-11-15', 2025: '2025-11-05', 2026: '2026-11-24', 2027: '2027-11-14',
        2028: '2028-11-02', 2029: '2029-11-21', 2030: '2030-11-10', 2031: '2031-10-31',
        2032: '2032-11-18', 2033: '2033-11-07'
    };
    const MID_AUTUMN = {
        2024: '2024-09-17', 2025: '2025-10-06', 2026: '2026-09-25', 2027: '2027-09-15',
        2028: '2028-10-03', 2029: '2029-09-22', 2030: '2030-09-12', 2031: '2031-10-01',
        2032: '2032-09-19', 2033: '2033-09-08'
    };
    const ORTHODOX_EASTER = {
        2024: '2024-05-05', 2025: '2025-04-20', 2026: '2026-04-12', 2027: '2027-05-02',
        2028: '2028-04-16', 2029: '2029-04-08', 2030: '2030-04-28', 2031: '2031-04-13',
        2032: '2032-05-02', 2033: '2033-04-16'
    };

    /**
     * Major Jewish civil dates (sunset-start approximated to the listed Gregorian day).
     * Hebcal overwrites/enriches these after the first successful download.
     * Each span is [startIso, dayCount].
     */
    const JEWISH_YEARS = {
        2024: { purim: '2024-03-24', pesach: ['2024-04-23', 8], shavuot: ['2024-06-12', 2], tisha: '2024-08-13', rh: ['2024-10-03', 2], yk: '2024-10-12', sukkot: ['2024-10-17', 7], st: '2024-10-25', hanukkah: ['2024-12-26', 8] },
        2025: { tu: '2025-02-13', purim: '2025-03-14', pesach: ['2025-04-13', 8], shavuot: ['2025-06-02', 2], tisha: '2025-08-03', rh: ['2025-09-23', 2], yk: '2025-10-02', sukkot: ['2025-10-07', 7], st: '2025-10-15', hanukkah: ['2025-12-15', 8] },
        2026: { tu: '2026-02-03', purim: '2026-03-03', pesach: ['2026-04-02', 8], shavuot: ['2026-05-22', 2], tisha: '2026-07-23', rh: ['2026-09-12', 2], yk: '2026-09-21', sukkot: ['2026-09-26', 7], st: '2026-10-04', hanukkah: ['2026-12-05', 8] },
        2027: { tu: '2027-01-23', purim: '2027-03-23', pesach: ['2027-04-22', 8], shavuot: ['2027-06-11', 2], tisha: '2027-08-12', rh: ['2027-10-02', 2], yk: '2027-10-11', sukkot: ['2027-10-16', 7], st: '2027-10-24', hanukkah: ['2027-12-25', 8] },
        2028: { tu: '2028-02-12', purim: '2028-03-12', pesach: ['2028-04-11', 8], shavuot: ['2028-05-31', 2], tisha: '2028-08-01', rh: ['2028-09-21', 2], yk: '2028-09-30', sukkot: ['2028-10-05', 7], st: '2028-10-13', hanukkah: ['2028-12-13', 8] },
        2029: { tu: '2029-01-31', purim: '2029-03-01', pesach: ['2029-03-31', 8], shavuot: ['2029-05-20', 2], tisha: '2029-07-22', rh: ['2029-09-10', 2], yk: '2029-09-19', sukkot: ['2029-09-24', 7], st: '2029-10-02', hanukkah: ['2029-12-02', 8] },
        2030: { tu: '2030-01-21', purim: '2030-03-19', pesach: ['2030-04-18', 8], shavuot: ['2030-06-07', 2], tisha: '2030-08-08', rh: ['2030-09-28', 2], yk: '2030-10-07', sukkot: ['2030-10-12', 7], st: '2030-10-20', hanukkah: ['2030-12-21', 8] },
        2031: { tu: '2031-02-08', purim: '2031-03-09', pesach: ['2031-04-08', 8], shavuot: ['2031-05-28', 2], tisha: '2031-07-29', rh: ['2031-09-18', 2], yk: '2031-09-27', sukkot: ['2031-10-02', 7], st: '2031-10-10', hanukkah: ['2031-12-10', 8] },
        2032: { tu: '2032-01-28', purim: '2032-02-26', pesach: ['2032-03-27', 8], shavuot: ['2032-05-16', 2], tisha: '2032-07-18', rh: ['2032-09-06', 2], yk: '2032-09-15', sukkot: ['2032-09-20', 7], st: '2032-09-28', hanukkah: ['2032-11-28', 8] },
        2033: { tu: '2033-02-16', purim: '2033-03-17', pesach: ['2033-04-14', 8], shavuot: ['2033-06-04', 2], tisha: '2033-08-04', rh: ['2033-09-24', 2], yk: '2033-10-03', sukkot: ['2033-10-08', 7], st: '2033-10-16', hanukkah: ['2033-12-17', 8] }
    };

    function pad(n) {
        return String(n).padStart(2, '0');
    }

    function iso(y, m, d) {
        return `${y}-${pad(m)}-${pad(d)}`;
    }

    function parseIso(s) {
        const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return null;
        return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    }

    function addDaysIso(dateStr, n) {
        const p = parseIso(dateStr);
        if (!p) return dateStr;
        const dt = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
        return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }

    function ev(date, name, group, tags, extra) {
        return {
            date,
            name,
            group,
            tags: tags || [group],
            source: 'local',
            ...(extra || {})
        };
    }

    function nthWeekday(year, month, n, weekday) {
        const first = new Date(Date.UTC(year, month - 1, 1));
        const firstWd = first.getUTCDay();
        const day = 1 + ((weekday - firstWd + 7) % 7) + (n - 1) * 7;
        return iso(year, month, day);
    }

    function lastWeekday(year, month, weekday) {
        const last = new Date(Date.UTC(year, month, 0));
        const lastDay = last.getUTCDate();
        const lastWd = last.getUTCDay();
        const delta = (lastWd - weekday + 7) % 7;
        return iso(year, month, lastDay - delta);
    }

    /** Anonymous Gregorian computus → { month, day }. */
    function gregorianEaster(year) {
        const a = year % 19;
        const b = Math.floor(year / 100);
        const c = year % 100;
        const d = Math.floor(b / 4);
        const e = b % 4;
        const f = Math.floor((b + 8) / 25);
        const g = Math.floor((b - f + 1) / 3);
        const h = (19 * a + b - d - g + 15) % 30;
        const i = Math.floor(c / 4);
        const k = c % 4;
        const l = (32 + 2 * e + 2 * i - h - k) % 7;
        const m = Math.floor((a + 11 * h + 22 * l) / 451);
        const month = Math.floor((h + l - 7 * m + 114) / 31);
        const day = ((h + l - 7 * m + 114) % 31) + 1;
        return { month, day };
    }

    /** Kuwaiti algorithm — civil Hijri approximation. */
    function gregorianToHijri(gy, gm, gd) {
        const jd = Math.trunc((1461 * (gy + 4800 + Math.trunc((gm - 14) / 12))) / 4)
            + Math.trunc((367 * (gm - 2 - 12 * Math.trunc((gm - 14) / 12))) / 12)
            - Math.trunc((3 * Math.trunc((gy + 4900 + Math.trunc((gm - 14) / 12)) / 100)) / 4)
            + gd - 32075;
        const l = jd - 1948440 + 10632;
        const n = Math.trunc((l - 1) / 10631);
        const l2 = l - 10631 * n + 354;
        const j = (Math.trunc((10985 - l2) / 5316)) * (Math.trunc((50 * l2) / 17719))
            + (Math.trunc(l2 / 5670)) * (Math.trunc((43 * l2) / 15238));
        const l3 = l2 - (Math.trunc((30 - j) / 15)) * (Math.trunc((17719 * j) / 50))
            - (Math.trunc(j / 16)) * (Math.trunc((15238 * j) / 43)) + 29;
        const hm = Math.trunc((24 * l3) / 709);
        const hd = l3 - Math.trunc((709 * hm) / 24);
        const hy = 30 * n + j - 30;
        return { hy, hm, hd };
    }

    function pushSpan(out, startIso, days, name, group, tags) {
        const n = Math.max(1, Number(days) || 1);
        for (let i = 0; i < n; i += 1) {
            const label = n > 1 ? `${name} (day ${i + 1}/${n})` : name;
            out.push(ev(addDaysIso(startIso, i), label, group, tags));
        }
    }

    function computeLocalYear(year) {
        const y = Number(year);
        const out = [];

        out.push(ev(iso(y, 1, 1), "New Year's Day", 'secular', ['secular', 'universal']));
        out.push(ev(iso(y, 1, 7), 'Orthodox Christmas', 'orthodox', ['religious', 'christian', 'orthodox']));
        out.push(ev(nthWeekday(y, 1, 3, 1), 'Martin Luther King Jr. Day', 'black', ['civic', 'black', 'us']));
        out.push(ev(iso(y, 2, 14), "Valentine's Day", 'secular', ['secular', 'universal']));
        out.push(ev(iso(y, 3, 8), "International Women's Day", 'women', ['identity', 'women', 'universal']));
        out.push(ev(iso(y, 3, 17), "St. Patrick's Day", 'secular', ['secular', 'cultural']));
        out.push(ev(iso(y, 3, 21), 'Nowruz (Persian New Year)', 'iranian', ['religious', 'iranian', 'cultural']));
        out.push(ev(iso(y, 3, 21), "Bahá'í Naw-Rúz", 'bahai', ['religious', 'bahai']));
        out.push(ev(iso(y, 3, 31), 'Trans Day of Visibility', 'lgbtq', ['identity', 'lgbtq']));
        out.push(ev(iso(y, 4, 13), 'Vaisakhi', 'sikh', ['religious', 'sikh']));
        out.push(ev(iso(y, 4, 14), 'Vaisakhi (observed)', 'sikh', ['religious', 'sikh']));
        out.push(ev(iso(y, 4, 22), 'Earth Day', 'secular', ['secular', 'universal']));
        out.push(ev(iso(y, 5, 1), 'International Workers’ Day', 'civic', ['civic', 'universal']));
        out.push(ev(iso(y, 5, 5), 'Cinco de Mayo', 'latine', ['identity', 'latine', 'cultural']));
        out.push(ev(iso(y, 5, 17), 'IDAHOBIT (Against Homophobia, Biphobia & Transphobia)', 'lgbtq', ['identity', 'lgbtq']));
        out.push(ev(nthWeekday(y, 5, 2, 0), "Mother's Day (US/most)", 'women', ['identity', 'women', 'family']));
        out.push(ev(lastWeekday(y, 5, 1), 'Memorial Day (US)', 'civic', ['civic', 'us']));
        out.push(ev(iso(y, 6, 1), 'Pride Month begins', 'lgbtq', ['identity', 'lgbtq']));
        out.push(ev(iso(y, 6, 12), 'Loving Day / Pulse Night of Remembrance', 'lgbtq', ['identity', 'lgbtq']));
        out.push(ev(iso(y, 6, 19), 'Juneteenth', 'black', ['civic', 'black', 'us']));
        out.push(ev(nthWeekday(y, 6, 3, 0), "Father's Day (US/most)", 'secular', ['secular', 'family']));
        out.push(ev(iso(y, 6, 28), 'Stonewall anniversary / Pride weekend', 'lgbtq', ['identity', 'lgbtq']));
        out.push(ev(iso(y, 7, 4), 'Independence Day (US)', 'civic', ['civic', 'us']));
        out.push(ev(nthWeekday(y, 9, 1, 1), 'Labor Day (US)', 'civic', ['civic', 'us']));
        out.push(ev(iso(y, 9, 15), 'Hispanic Heritage Month begins', 'latine', ['identity', 'latine']));
        out.push(ev(nthWeekday(y, 10, 2, 1), 'Canadian Thanksgiving', 'civic', ['civic', 'ca']));
        out.push(ev(iso(y, 10, 11), 'National Coming Out Day', 'lgbtq', ['identity', 'lgbtq']));
        out.push(ev(nthWeekday(y, 10, 2, 1), 'Indigenous Peoples’ Day / Columbus Day (US)', 'indigenous', ['civic', 'indigenous', 'us']));
        out.push(ev(iso(y, 10, 31), 'Halloween', 'secular', ['secular', 'universal']));
        out.push(ev(iso(y, 11, 1), "All Saints' Day / Día de los Muertos", 'christian', ['religious', 'christian', 'latine']));
        out.push(ev(iso(y, 11, 2), 'Día de los Muertos / All Souls’ Day', 'latine', ['identity', 'latine', 'christian']));
        out.push(ev(nthWeekday(y, 11, 4, 4), 'Thanksgiving (US)', 'civic', ['civic', 'us', 'family']));
        out.push(ev(iso(y, 12, 1), 'World AIDS Day', 'lgbtq', ['identity', 'lgbtq', 'universal']));
        out.push(ev(iso(y, 12, 3), 'International Day of Persons with Disabilities', 'secular', ['identity', 'disability', 'universal']));
        out.push(ev(iso(y, 12, 25), 'Christmas', 'christian', ['religious', 'christian', 'universal']));
        out.push(ev(iso(y, 12, 26), 'Kwanzaa begins / Boxing Day', 'black', ['identity', 'black', 'civic']));
        out.push(ev(iso(y, 12, 31), "New Year's Eve", 'secular', ['secular', 'universal']));
        for (let d = 26; d <= 31; d += 1) {
            out.push(ev(iso(y, 12, d), `Kwanzaa (day ${d - 25}/7)`, 'black', ['identity', 'black']));
        }
        out.push(ev(iso(y + 1, 1, 1), 'Kwanzaa (day 7/7)', 'black', ['identity', 'black']));

        const easter = gregorianEaster(y);
        const easterIso = iso(y, easter.month, easter.day);
        out.push(ev(addDaysIso(easterIso, -46), 'Ash Wednesday', 'christian', ['religious', 'christian']));
        out.push(ev(addDaysIso(easterIso, -7), 'Palm Sunday', 'christian', ['religious', 'christian']));
        out.push(ev(addDaysIso(easterIso, -2), 'Good Friday', 'christian', ['religious', 'christian']));
        out.push(ev(easterIso, 'Easter Sunday', 'christian', ['religious', 'christian']));
        out.push(ev(addDaysIso(easterIso, 1), 'Easter Monday', 'christian', ['religious', 'christian', 'civic']));
        out.push(ev(addDaysIso(easterIso, 49), 'Pentecost', 'christian', ['religious', 'christian']));

        const oe = ORTHODOX_EASTER[y];
        if (oe) out.push(ev(oe, 'Orthodox Easter', 'orthodox', ['religious', 'christian', 'orthodox']));

        const lny = LUNAR_NEW_YEAR[y];
        if (lny) {
            out.push(ev(lny[0], `Lunar New Year (Year of the ${lny[1]})`, 'asian', ['religious', 'asian', 'cultural']));
            out.push(ev(addDaysIso(lny[0], 1), 'Lunar New Year (day 2)', 'asian', ['asian', 'cultural']));
        }
        if (DIWALI[y]) out.push(ev(DIWALI[y], 'Diwali', 'hindu', ['religious', 'hindu']));
        if (HOLI[y]) out.push(ev(HOLI[y], 'Holi', 'hindu', ['religious', 'hindu']));
        if (VESAK[y]) out.push(ev(VESAK[y], 'Vesak (Buddha Day)', 'buddhist', ['religious', 'buddhist']));
        if (GURU_NANAK[y]) out.push(ev(GURU_NANAK[y], 'Guru Nanak Gurpurab', 'sikh', ['religious', 'sikh']));
        if (MID_AUTUMN[y]) out.push(ev(MID_AUTUMN[y], 'Mid-Autumn Festival', 'asian', ['asian', 'cultural']));

        const jew = JEWISH_YEARS[y];
        if (jew) {
            if (jew.tu) out.push(ev(jew.tu, 'Tu BiShvat', 'jewish', ['religious', 'jewish']));
            if (jew.purim) out.push(ev(jew.purim, 'Purim', 'jewish', ['religious', 'jewish']));
            if (jew.pesach) pushSpan(out, jew.pesach[0], jew.pesach[1], 'Passover (Pesach)', 'jewish', ['religious', 'jewish']);
            if (jew.shavuot) pushSpan(out, jew.shavuot[0], jew.shavuot[1], 'Shavuot', 'jewish', ['religious', 'jewish']);
            if (jew.tisha) out.push(ev(jew.tisha, "Tisha B'Av", 'jewish', ['religious', 'jewish']));
            if (jew.rh) pushSpan(out, jew.rh[0], jew.rh[1], 'Rosh Hashanah', 'jewish', ['religious', 'jewish']);
            if (jew.yk) out.push(ev(jew.yk, 'Yom Kippur', 'jewish', ['religious', 'jewish']));
            if (jew.sukkot) pushSpan(out, jew.sukkot[0], jew.sukkot[1], 'Sukkot', 'jewish', ['religious', 'jewish']);
            if (jew.st) out.push(ev(jew.st, 'Simchat Torah', 'jewish', ['religious', 'jewish']));
            if (jew.hanukkah) pushSpan(out, jew.hanukkah[0], jew.hanukkah[1], 'Hanukkah', 'jewish', ['religious', 'jewish']);
        }

        const start = Date.UTC(y, 0, 1);
        const end = Date.UTC(y + 1, 0, 1);
        for (let t = start; t < end; t += 86400000) {
            const dt = new Date(t);
            const gy = dt.getUTCFullYear();
            const gm = dt.getUTCMonth() + 1;
            const gd = dt.getUTCDate();
            const h = gregorianToHijri(gy, gm, gd);
            const d = iso(gy, gm, gd);
            if (h.hm === 9) {
                out.push(ev(d, `Ramadan (day ${h.hd})`, 'muslim', ['religious', 'muslim']));
                if (h.hd === 27) out.push(ev(d, 'Laylat al-Qadr (approx.)', 'muslim', ['religious', 'muslim']));
            }
            if (h.hm === 10 && h.hd === 1) out.push(ev(d, 'Eid al-Fitr', 'muslim', ['religious', 'muslim']));
            if (h.hm === 12 && h.hd >= 10 && h.hd <= 12) {
                out.push(ev(d, h.hd === 10 ? 'Eid al-Adha' : `Eid al-Adha (day ${h.hd - 9})`, 'muslim', ['religious', 'muslim']));
            }
            if (h.hm === 1 && h.hd === 10) out.push(ev(d, 'Ashura', 'muslim', ['religious', 'muslim']));
            if (h.hm === 3 && h.hd === 12) out.push(ev(d, 'Mawlid (Prophet’s birthday, approx.)', 'muslim', ['religious', 'muslim']));
            if (h.hm === 7 && h.hd === 27) out.push(ev(d, 'Isra and Miʿraj (approx.)', 'muslim', ['religious', 'muslim']));
        }

        return out;
    }

    function emptyCatalog() {
        return {
            version: PACK_VERSION,
            fetchedAt: null,
            sources: { local: true, hebcal: false, nager: [] },
            fetchedYears: [],
            years: {}
        };
    }

    function rebuildIndex() {
        byDate = new Map();
        if (!catalog?.years) return;
        Object.keys(catalog.years).forEach((year) => {
            (catalog.years[year] || []).forEach((item) => {
                const k = String(item.date || '').slice(0, 10);
                if (!k) return;
                if (!byDate.has(k)) byDate.set(k, []);
                byDate.get(k).push(item);
            });
        });
    }

    function persist() {
        if (!catalog) return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(catalog));
        } catch (err) {
            console.warn('[Mirage] Holiday catalog could not persist', err);
        }
    }

    function loadStored() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== PACK_VERSION || !parsed.years) return null;
            return parsed;
        } catch {
            return null;
        }
    }

    function normName(name) {
        return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    function mergeYear(year, incoming) {
        const key = String(year);
        const existing = Array.isArray(catalog.years[key]) ? catalog.years[key].slice() : [];
        const seen = new Set(existing.map(e => `${e.date}|${normName(e.name)}`));
        incoming.forEach((item) => {
            if (!item?.date || !item?.name) return;
            const k = `${String(item.date).slice(0, 10)}|${normName(item.name)}`;
            if (seen.has(k)) return;
            seen.add(k);
            existing.push({
                date: String(item.date).slice(0, 10),
                name: String(item.name).trim(),
                group: item.group || 'civic',
                tags: Array.isArray(item.tags) ? item.tags : [],
                source: item.source || 'remote',
                country: item.country || undefined
            });
        });
        catalog.years[key] = existing;
    }

    function ensureYearLocal(year) {
        const y = Number(year);
        if (!Number.isFinite(y)) return;
        if (!catalog) catalog = emptyCatalog();
        const key = String(y);
        if (Array.isArray(catalog.years[key]) && catalog.years[key].length) return;
        catalog.years[key] = computeLocalYear(y);
        rebuildIndex();
        persist();
    }

    function locationText(profile) {
        const p = profile || global.EngineState?.profile || {};
        return String(p.location || '').trim();
    }

    function inferCountry(profile) {
        const loc = locationText(profile);
        if (loc) {
            for (let i = 0; i < COUNTRY_HINTS.length; i += 1) {
                if (COUNTRY_HINTS[i].re.test(loc)) return COUNTRY_HINTS[i].code;
            }
        }
        const blob = profileBlob(profile);
        for (let i = 0; i < COUNTRY_HINTS.length; i += 1) {
            if (COUNTRY_HINTS[i].re.test(blob)) return COUNTRY_HINTS[i].code;
        }
        return 'US';
    }

    function flattenValue(value, depth, acc) {
        if (value == null || depth > 8) return;
        const t = typeof value;
        if (t === 'string') {
            if (value.length > 4000) return;
            if (/^data:|^[A-Za-z0-9+/=]{180,}$/.test(value)) return;
            acc.push(value);
            return;
        }
        if (t === 'number' || t === 'boolean') {
            acc.push(String(value));
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(v => flattenValue(v, depth + 1, acc));
            return;
        }
        if (t === 'object') {
            Object.keys(value).forEach((k) => {
                if (/base64|dataUrl|objectUrl|thumbnail|embedding|Ref_Pointer/i.test(k)) return;
                flattenValue(value[k], depth + 1, acc);
            });
        }
    }

    /**
     * Description / backstory first, then EDF, then location.
     * A Jewish woman in LA must still match Jewish — location is civic, not identity.
     */
    function profileBlob(profile) {
        const p = profile || global.EngineState?.profile || {};
        const edf = global.EngineState?.edf || {};
        const acc = [];
        [
            p.notes, p.description, p.backstory, p.archetype, p.personality,
            p.relationship, p.name, p.culture, p.religion, p.ethnicity
        ].forEach(v => flattenValue(v, 0, acc));
        flattenValue(edf, 0, acc);
        flattenValue(p.location, 0, acc);
        return acc.join(' ');
    }

    function profileGroups(profile) {
        const blob = profileBlob(profile);
        const groups = new Set();
        GROUP_MATCH.forEach((row) => {
            if (row.re.test(blob)) groups.add(row.group);
        });
        const loc = locationText(profile);
        if (/israel|tel[\s-]?aviv|ירושל|תל[\s-]?אביב|ישראל/i.test(loc)) groups.add('jewish');
        return groups;
    }

    function calendarsInPlay(profile) {
        const groups = profileGroups(profile);
        const country = inferCountry(profile);
        const loc = locationText(profile) || 'her location';
        const bits = [];
        RELIGION_GROUPS.forEach((g) => {
            if (groups.has(g)) bits.push(`${GROUP_LABELS[g]} (from her description)`);
        });
        ['lgbtq', 'black', 'latine', 'asian', 'indigenous', 'women'].forEach((g) => {
            if (groups.has(g)) bits.push(`${GROUP_LABELS[g]} (from her description)`);
        });
        bits.push(`${country} civic (${loc})`);
        return { groups, country, loc, bits };
    }

    async function fetchJson(url) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => ctrl?.abort?.(), FETCH_MS);
        try {
            const res = await fetch(url, { signal: ctrl?.signal, mode: 'cors' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    function hebcalToEvent(item) {
        const cat = String(item.category || item.subcat || '');
        if (/candles|havdalah|parashat|roshchodesh/i.test(cat)) return null;
        const date = String(item.date || '').slice(0, 10);
        const name = String(item.title || item.hebrew || '').trim();
        if (!date || !name) return null;
        return {
            date,
            name,
            group: 'jewish',
            tags: ['religious', 'jewish', cat || 'hebcal'],
            source: 'hebcal'
        };
    }

    function nagerToEvent(item, country) {
        const date = String(item.date || '').slice(0, 10);
        const name = String(item.name || item.localName || '').trim();
        if (!date || !name) return null;
        const local = String(item.localName || '').trim();
        const label = local && local !== name ? `${name} (${local})` : name;
        return {
            date,
            name: label,
            group: 'civic',
            country,
            tags: ['civic', 'public', String(country).toLowerCase()],
            source: 'nager'
        };
    }

    async function fetchYearRemote(year, countries) {
        const y = Number(year);
        const jobs = [
            fetchJson(`https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&nx=on&year=${y}&yt=G&lg=s&c=off&geo=none&ss=off&mf=on`)
                .then((data) => {
                    const items = Array.isArray(data?.items) ? data.items : [];
                    return items.map(hebcalToEvent).filter(Boolean);
                })
                .catch(() => [])
        ];
        (countries || CORE_COUNTRIES).forEach((cc) => {
            jobs.push(
                fetchJson(`https://date.nager.at/api/v3/PublicHolidays/${y}/${cc}`)
                    .then((data) => (Array.isArray(data) ? data : []).map(row => nagerToEvent(row, cc)).filter(Boolean))
                    .catch(() => [])
            );
        });
        const batches = await Promise.all(jobs);
        const hebcal = batches[0] || [];
        const nager = batches.slice(1).flat();
        return { hebcal, nager };
    }

    async function enrichYears(years, profile) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        const countries = Array.from(new Set([
            ...CORE_COUNTRIES,
            inferCountry(profile)
        ]));
        const wanted = years.filter(y => !catalog.fetchedYears.includes(Number(y)));
        if (!wanted.length) return;

        const results = await Promise.allSettled(wanted.map(y => fetchYearRemote(y, countries)));
        let gotHebcal = false;
        const nagerSet = new Set(catalog.sources.nager || []);
        results.forEach((res, i) => {
            if (res.status !== 'fulfilled') return;
            const y = wanted[i];
            const { hebcal, nager } = res.value;
            if (hebcal.length) {
                mergeYear(y, hebcal);
                gotHebcal = true;
            }
            if (nager.length) {
                mergeYear(y, nager);
                countries.forEach(cc => nagerSet.add(cc));
            }
            if (hebcal.length || nager.length) {
                if (!catalog.fetchedYears.includes(Number(y))) catalog.fetchedYears.push(Number(y));
            }
        });
        if (gotHebcal) catalog.sources.hebcal = true;
        catalog.sources.nager = Array.from(nagerSet);
        catalog.fetchedAt = new Date().toISOString();
        rebuildIndex();
        persist();
    }

    function wallYear() {
        try {
            return new Date().getFullYear();
        } catch {
            return 2026;
        }
    }

    function hydrate(profile) {
        catalog = loadStored() || emptyCatalog();
        const y = wallYear();
        [y - 1, y, y + 1, y + 2].forEach(ensureYearLocal);
        rebuildIndex();
        persist();
        return [y - 1, y, y + 1];
    }

    function ensureReady(profile) {
        if (readyPromise) return readyPromise;
        readyPromise = (async () => {
            const years = hydrate(profile);
            years.forEach((y) => attemptedThisSession.add(Number(y)));
            try {
                fetchInFlight = enrichYears(years, profile);
                await fetchInFlight;
            } catch (err) {
                console.warn('[Mirage] Holiday catalog download skipped', err);
            } finally {
                fetchInFlight = null;
            }
            return status();
        })();
        return readyPromise;
    }

    function ensureYear(year, profile) {
        const y = Number(year);
        ensureYearLocal(y);
        if (!Number.isFinite(y)) return;
        if (catalog.fetchedYears.includes(y) || attemptedThisSession.has(y)) return;
        if (fetchInFlight) return;
        attemptedThisSession.add(y);
        fetchInFlight = enrichYears([y], profile || global.EngineState?.profile)
            .catch(err => console.warn('[Mirage] Holiday year fetch failed', err))
            .finally(() => { fetchInFlight = null; });
    }

    function lookup(dateStr) {
        const k = String(dateStr || '').slice(0, 10);
        if (!k) return [];
        const p = parseIso(k);
        if (p) ensureYearLocal(p.year);
        return (byDate.get(k) || []).slice();
    }

    function getSimDateParts(profile) {
        const loc = profile?.location || global.EngineState?.profile?.location;
        const tz = global.MiragePhoneUX?.resolveTimeZone?.(loc) || 'UTC';
        const now = typeof global.MiragePhoneUX?.herNow === 'function'
            ? global.MiragePhoneUX.herNow()
            : new Date();
        const z = typeof global.MiragePhoneUX?.getZonedParts === 'function'
            ? global.MiragePhoneUX.getZonedParts(now, tz)
            : {
                year: now.getFullYear(),
                month: now.getMonth() + 1,
                day: now.getDate(),
                hour: now.getHours(),
                minute: now.getMinutes()
            };
        let weekday = 'Thursday';
        let weekdayShort = 'Thu';
        try {
            weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
            weekdayShort = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
        } catch { /* keep */ }
        let dateLabel = `${weekday}, ${z.year}-${pad(z.month)}-${pad(z.day)}`;
        try {
            dateLabel = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                weekday: 'long',
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            }).format(now);
        } catch { /* keep */ }
        return {
            ...z,
            tz,
            weekday,
            weekdayShort,
            weekdayIndex: WEEKDAY_IX[weekdayShort] ?? 0,
            iso: iso(z.year, z.month, z.day),
            dateLabel,
            now
        };
    }

    function eventScore(item, groups, country) {
        const tags = (item.tags || []).concat(item.group || '');
        const tagBlob = tags.join(' ').toLowerCase();
        let score = 1;
        if (item.group && groups.has(item.group)) score += 6;
        if (tags.some(t => groups.has(String(t).toLowerCase()))) score += 3;
        if (item.country && item.country === country) score += 3;
        if (item.country && item.country !== country && item.group === 'civic') score -= 2;
        if (/universal/.test(tagBlob)) score += 2;
        if (item.source === 'hebcal' && groups.has('jewish')) score += 1;
        return score;
    }

    function uniqueNames(items) {
        const seen = new Set();
        const out = [];
        items.forEach((item) => {
            const k = normName(item.name).replace(/\s+day \d+\/\d+$/, '');
            if (seen.has(k)) return;
            seen.add(k);
            out.push(item);
        });
        return out;
    }

    function pickForPrompt(dateIso, parts, profile) {
        const groups = profileGroups(profile);
        const country = inferCountry(profile);
        const raw = lookup(dateIso);
        if (parts.weekdayIndex === 6 || (parts.weekdayIndex === 5 && (parts.hour || 0) >= 16)) {
            if (groups.has('jewish')) {
                raw.unshift(ev(dateIso, parts.weekdayIndex === 6
                    ? 'Shabbat (observant Jewish weekly rest)'
                    : 'Shabbat begins (Friday evening)', 'jewish', ['religious', 'jewish', 'weekly']));
            }
        }
        const scored = uniqueNames(raw)
            .map(item => ({ item, score: eventScore(item, groups, country) }))
            .filter(row => row.score >= 3 || /universal/.test((row.item.tags || []).join(' ')))
            .sort((a, b) => b.score - a.score);
        const picked = [];
        scored.forEach((row) => {
            if (picked.length >= 4) return;
            if (row.score < 2) return;
            picked.push(row.item);
        });
        if (!picked.length && scored[0]?.score >= 2) picked.push(scored[0].item);
        return picked;
    }

    function formatDateContext(profile) {
        const parts = getSimDateParts(profile);
        ensureYear(parts.year, profile);
        const play = calendarsInPlay(profile);
        const today = pickForPrompt(parts.iso, parts, profile);
        const upcoming = [];
        [1, 2].forEach((n) => {
            const isoN = addDaysIso(parts.iso, n);
            const pN = { ...parts, iso: isoN, weekdayIndex: (parts.weekdayIndex + n) % 7, hour: 12 };
            pickForPrompt(isoN, pN, profile).forEach((item) => {
                if (upcoming.length >= 3) return;
                if (today.some(t => normName(t.name) === normName(item.name))) return;
                upcoming.push(`${item.name} (${n === 1 ? 'tomorrow' : 'in 2 days'})`);
            });
        });

        const todayLine = today.length
            ? today.map(t => t.name).join(' · ')
            : 'none that clearly fit her life';

        return [
            'DATE CONTEXT (flavor only — never overrides PERSONA LOCK, CLOCK LOCK, operator commands, or lighting):',
            `Date: ${parts.dateLabel}.`,
            `Weekday: ${parts.weekday}.`,
            `Calendars in play: ${play.bits.join(' · ')}.`,
            `Observances today: ${todayLine}.`,
            upcoming.length ? `Upcoming (48h): ${upcoming.join(' · ')}.` : '',
            'Match holidays to her description/backstory FIRST, then location (a Jewish woman in LA still keeps Jewish holidays; civic days follow where she lives). She may notice a fitting observance in passing. Do not greet the calendar unless it would naturally come up.'
        ].filter(Boolean).join('\n');
    }

    function shortBezelName(name) {
        let s = String(name || '').trim();
        if (!s) return '';
        s = s.replace(/\s*\(day\s+\d+\s*\/\s*\d+\)\s*/ig, '');
        s = s.replace(/\s*\((?:US\/most|US|CA|observed)\)\s*/ig, '');
        s = s.replace(/\s*\([^)]{18,}\)\s*$/, '');
        if (/^shabbat/i.test(s)) return 'Shabbat';
        if (/hanukkah/i.test(s)) return 'Hanukkah';
        if (/passover|pesach/i.test(s)) return 'Passover';
        if (/rosh hashanah/i.test(s)) return 'Rosh Hashanah';
        if (/yom kippur/i.test(s)) return 'Yom Kippur';
        if (/martin luther/i.test(s)) return 'MLK Day';
        if (/valentine/i.test(s)) return "Valentine's";
        if (/new year'?s eve/i.test(s)) return 'NYE';
        if (/new year'?s day/i.test(s)) return 'New Year';
        if (/lunar new year/i.test(s)) return 'Lunar NY';
        if (/independence day/i.test(s)) return 'July 4';
        if (/día de los muertos|dia de los muertos/i.test(s)) return 'Muertos';
        if (/international women/i.test(s)) return "Women's Day";
        if (/pride month/i.test(s)) return 'Pride';
        s = s.replace(/^International\s+/i, '').replace(/^National\s+/i, '');
        if (s.length > 22) s = `${s.slice(0, 20).trim()}…`;
        return s;
    }

    /** Compact weekday + top observance for the phone status bar. */
    function statusBezel(profile) {
        const parts = getSimDateParts(profile);
        try { ensureYear(parts.year, profile); } catch { /* local pack is enough */ }
        const today = pickForPrompt(parts.iso, parts, profile);
        const top = today[0];
        return {
            weekday: parts.weekdayShort || '',
            weekdayLong: parts.weekday || '',
            special: top ? shortBezelName(top.name) : '',
            specialFull: today.map(t => t.name).filter(Boolean).join(' · ')
        };
    }

    function status() {
        const years = catalog?.years ? Object.keys(catalog.years).sort() : [];
        let events = 0;
        years.forEach((y) => { events += (catalog.years[y] || []).length; });
        return {
            version: catalog?.version || PACK_VERSION,
            fetchedAt: catalog?.fetchedAt || null,
            sources: catalog?.sources || { local: true },
            years,
            events,
            fetchedYears: catalog?.fetchedYears || []
        };
    }

    function debugLine() {
        const s = status();
        const src = [
            s.sources.local ? 'local' : null,
            s.sources.hebcal ? 'hebcal' : null,
            (s.sources.nager || []).length ? `nager:${(s.sources.nager || []).join(',')}` : null
        ].filter(Boolean).join('+') || 'local';
        return `${s.events} events · years ${s.years.join(',') || '—'} · ${src}`
            + (s.fetchedAt ? ` · fetched ${s.fetchedAt.slice(0, 10)}` : ' · not downloaded yet');
    }

    global.MirageCalendar = {
        ensureReady,
        ensureYear,
        lookup,
        getSimDateParts,
        formatDateContext,
        statusBezel,
        inferCountry,
        profileGroups,
        calendarsInPlay,
        status,
        debugLine,
        STORAGE_KEY,
        PACK_VERSION
    };
})(typeof window !== 'undefined' ? window : globalThis);
