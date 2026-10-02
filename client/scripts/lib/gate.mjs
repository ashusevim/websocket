/**
 * The contrast gate: measures what Chrome actually painted, not what the
 * stylesheet says it intends to paint.
 *
 * Why a browser. Deciding a foreground/background pair from styles.css alone
 * means reimplementing the cascade — inheritance, specificity, pseudo-states,
 * alpha compositing — and still not seeing the message rows, the member list
 * or the empty state, because index.html builds those with createElement()
 * rather than markup. Every one of those problems disappears if the question
 * is asked of a rendered page: getComputedStyle has already resolved the
 * cascade, the app's own functions have already built the DOM, and `:hover`,
 * `:focus-visible` and `:disabled` are the browser's to apply.
 *
 * What it does:
 *   1. serves the client over localhost (file:// would change origin
 *      behaviour);
 *   2. drives each theme x viewport x view, calling the page's own globals
 *      (showView, appendMessage, updateUserList, setStatus, showError, ...)
 *      so every class the app can add is actually added;
 *   3. hovers every `:hover` target and Tabs through every focusable, so
 *      `:hover`, `:focus` and `:focus-within` rules are live when measured;
 *   4. records the serialised colours of every ink, background stack, border
 *      and focus ring;
 *   5. requires every colour-bearing rule in the stylesheet to have every
 *      member of its selector list matched by a live element at some point,
 *      so a rule that never renders — or half of one that did — fails the
 *      gate instead of quietly escaping it.
 *
 * Chrome is the system install (`channel: 'chrome'`): no browser download,
 * nothing committed, the same binary a visitor uses.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
};

/** Serve `root` on an ephemeral port. Anything escaping root is a 404. */
export async function serve(root) {
    const base = path.resolve(root);
    const server = http.createServer(async (req, res) => {
        try {
            const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
            const file = path.join(base, pathname === '/' ? 'index.html' : pathname);
            if (!file.startsWith(base + path.sep) && file !== base) throw new Error('outside root');
            const info = await stat(file);
            if (!info.isFile()) throw new Error('not a file');
            const body = await readFile(file);
            res.writeHead(200, {
                'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
                'cache-control': 'no-store',
            });
            res.end(body);
        } catch {
            res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) };
}

/**
 * Launch the Chrome that is already installed. `channel: 'chrome'` is
 * Puppeteer's supported route to a system browser, so nothing is downloaded
 * and no path is hardcoded. The fallback list exists for machines where the
 * channel lookup misses a browser present under another name.
 */
export async function launchBrowser() {
    const attempts = [{ channel: 'chrome' }];
    for (const key of ['CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH']) {
        if (process.env[key]) attempts.push({ executablePath: process.env[key] });
    }
    for (const candidate of [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]) {
        attempts.push({ executablePath: candidate });
    }

    const misses = [];
    for (const attempt of attempts) {
        try {
            return await puppeteer.launch({ headless: true, ...attempt });
        } catch (error) {
            misses.push(`${attempt.channel ?? attempt.executablePath}: ${String(error.message).split('\n')[0]}`);
        }
    }
    throw new Error(
        'contrast gate: no Chrome found. Install Google Chrome, or set CHROME_PATH.\n  ' + misses.join('\n  '),
    );
}

/* ------------------------------------------------------------------ *
 * In-page: what the stylesheet could paint
 * ------------------------------------------------------------------ */

/**
 * Every style rule that declares a colour-bearing property, flattened across
 * @media blocks so each one remembers the media contexts it must be inside.
 *
 * The property list is matched against the raw declaration text rather than
 * through CSSOM longhands, because `background: var(--bg)` and
 * `border: 1px solid var(--hairline)` are shorthands, and whether
 * `style.backgroundColor` reflects them is an implementation detail. Reading
 * the text also catches `background: none` and `border: none`, which is what
 * we want: a rule that switches a colour off has to be exercised too, or
 * nobody notices when it stops matching anything.
 */
export function buildInventory() {
    const PROPERTIES = [
        'color', 'background', 'background-color', 'background-image',
        'border', 'border-color', 'border-top', 'border-right', 'border-bottom', 'border-left',
        'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
        'outline', 'outline-color', 'outline-top', 'outline-right', 'outline-bottom', 'outline-left',
        'fill', 'stroke', 'caret-color', 'text-decoration', 'text-decoration-color',
    ];

    const out = [];
    const visit = (rules, media) => {
        for (const rule of rules) {
            if (rule.media) {
                visit(rule.cssRules, [...media, rule.media.mediaText]);
            } else if (rule.selectorText !== undefined && rule.style) {
                const props = new Set();
                for (const line of rule.style.cssText.split(';')) {
                    const colon = line.indexOf(':');
                    if (colon < 0) continue;
                    const name = line.slice(0, colon).trim().toLowerCase();
                    if (PROPERTIES.includes(name)) props.add(name);
                }
                if (props.size > 0) out.push({ media, selector: rule.selectorText, props: [...props] });
            }
        }
    };

    for (const sheet of document.styleSheets) {
        let rules;
        try {
            rules = sheet.cssRules;
        } catch {
            continue; // cross-origin; none are ours
        }
        if (rules) visit(rules, []);
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * In-page: what was painted
 * ------------------------------------------------------------------ */

/**
 * Measure one slice of the document.
 *
 *   'ALL'    the whole document
 *   'FOCUS'  the focused element, plus ancestors and descendants
 *   <sel>    the first element matching that selector, plus the same closure
 *
 * The closure matters: `:hover` matches ancestors, and a hover rule can
 * recolour descendants by inheritance, so measuring only the hovered node
 * would miss both.
 *
 * Returns `{ records, matched, totals }`: the raw colour records, the selector
 * members that matched an element this pass, and how many members each rule
 * declares. Whether a rule counts as exercised is settled by the caller,
 * because the credit has to accumulate across passes — and because a rule only
 * earns it when the matching element was actually *visited and rendered* in
 * that pass: an element sitting behind `display: none` proves nothing about
 * the colours anyone sees. That is what makes `error-message` a rule the gate
 * had to be shown (the sweep drives it visible) rather than one it could wave
 * through.
 *
 * Motion is frozen by the harness (see runGate), so what is measured is the
 * settled style rather than a frame of an entrance animation. The `finish()`
 * below is the belt to that pair of braces: anything created after the
 * freeze — an animation started by a late class change — is driven to its end
 * state instead of being read at `opacity: 0` and filed as an inactive control.
 */
export function measureSlice(spec, inventory) {
    document.getAnimations().forEach((animation) => {
        try {
            animation.finish();
        } catch {
            // an infinite animation has no end state to finish to; the only
            // one here paints a dot with no ink of its own
        }
    });

    const describe = (el) => {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 7) {
            let text = node.tagName.toLowerCase();
            if (node.id) {
                parts.unshift(`${text}#${node.id}`);
                break;
            }
            if (node.classList.length > 0) text += `.${[...node.classList].slice(0, 3).join('.')}`;
            const parent = node.parentElement;
            if (parent) {
                const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
                if (siblings.length > 1) text += `:nth-${siblings.indexOf(node) + 1}`;
            }
            parts.unshift(text);
            node = parent;
        }
        return parts.join(' > ');
    };

    // Innermost first: the element's own background, then each ancestor, then
    // the UA canvas colour. The canvas entry only survives if every level
    // above it is translucent, which is the browser's own default anyway.
    const chainOf = (el, extra) => {
        const chain = [];
        if (extra) chain.push(extra);
        let node = el;
        while (node) {
            chain.push(getComputedStyle(node).backgroundColor);
            node = node.parentElement;
        }
        chain.push('rgb(255, 255, 255)');
        return chain;
    };

    const opacityOf = (el) => {
        let value = 1;
        let node = el;
        while (node) {
            value *= Number.parseFloat(getComputedStyle(node).opacity || '1');
            node = node.parentElement;
        }
        return value;
    };

    // Alpha of a computed colour, so a translucent layer can be told apart
    // from a colour that is genuinely its own.
    const alphaOf = (value) => {
        const numbers = value.match(/[\d.]+%?/g);
        if (!numbers || numbers.length < 3) return 0;
        if (numbers.length < 4) return 1;
        const last = numbers[3];
        return last.endsWith('%') ? Number.parseFloat(last) / 100 : Number.parseFloat(last);
    };

    let roots;
    if (spec === 'ALL') roots = [document.documentElement];
    else if (spec === 'FOCUS') roots = [document.activeElement || document.body];
    else {
        const target = document.querySelector(spec);
        if (!target) return null;
        roots = [target];
    }

    const nodes = new Set();
    for (const root of roots) {
        if (!root) continue;
        nodes.add(root);
        root.querySelectorAll('*').forEach((child) => nodes.add(child));
        let ancestor = root;
        while (ancestor) {
            nodes.add(ancestor);
            ancestor = ancestor.parentElement;
        }
    }

    /**
     * Split a rule's selector list into the complex selectors it actually
     * declares. Comma groups are counted per member because `matches()` on
     * the whole list says yes when *any* member matches: crediting
     * `.error-message, .success-message` because the error banner showed
     * would let `success-message` — a banner this sweep has to be *shown* —
     * pass without ever being measured, which is the exact hole the coverage
     * check exists to close. Pseudo-elements are stripped first so
     * `.divider::before, .divider::after` counts once, not twice, and once
     * each of them is matched there is nothing left to attribute.
     *
     * Defined inside measureSlice because page.evaluate serialises this
     * function alone and would lose a reference to anything outside it.
     */
    const memberCache = new Map();
    const membersOf = (selector) => {
        if (memberCache.has(selector)) return memberCache.get(selector);
        const parts = [];
        let current = '';
        let depth = 0;
        for (const char of selector) {
            if (char === '(' || char === '[') depth += 1;
            else if (char === ')' || char === ']') depth -= 1;
            if (char === ',' && depth === 0) {
                parts.push(current);
                current = '';
                continue;
            }
            current += char;
        }
        parts.push(current);
        const members = [...new Set(
            parts
                .map((part) => part.replace(/::[\w-]+(\([^)]*\))?/g, '').trim())
                .filter((part) => part !== ''),
        )];
        memberCache.set(selector, members);
        return members;
    };

    // A rule is credited only when *every* member of its selector list
    // matched an element this pass actually visited *and* rendered.
    // `querySelectorAll` would credit `.error-message` to a banner nobody
    // ever showed. Rules with no member left after stripping a bare
    // `::before` are dropped from `pending`: nothing can be attributed, so
    // they stay uncovered and are reported rather than waved through.
    const pending = inventory
        .map((rule, index) => ({ index, media: rule.media, members: membersOf(rule.selector) }))
        .filter((entry) => entry.members.length > 0)
        .filter((entry) => entry.media.every((query) => matchMedia(query).matches));
    // Matched members for this pass only. The caller merges across passes,
    // because `.error-message` and `.success-message` are mutually exclusive
    // states no single pass can be in at once.
    const credited = new Map();

    const records = [];
    for (const node of nodes) {
        const style = getComputedStyle(node);
        // Not painted in this state, so nothing about its colours can be
        // observed and it proves nothing. Every view and banner the sweep
        // drives is measured again once it is on screen.
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        for (let i = pending.length - 1; i >= 0; i -= 1) {
            const { index, members } = pending[i];
            let state = credited.get(index);
            if (!state) {
                state = new Set();
                credited.set(index, state);
            }
            for (const member of members) {
                if (state.has(member)) continue;
                let hit;
                try {
                    hit = node.matches(member);
                } catch (error) {
                    throw new Error(`contrast gate: cannot match ${JSON.stringify(member)}: ${error.message}`);
                }
                if (hit) state.add(member);
            }
            if (state.size >= members.length) pending.splice(i, 1);
        }

        const decorative = Boolean(node.closest('[aria-hidden="true"]'));
        const opacity = opacityOf(node);
        const inactive = Boolean(node.disabled)
            || node.getAttribute('aria-disabled') === 'true'
            || opacity < 0.999;
        const path = describe(node);

        const hasDirectText = [...node.childNodes].some(
            (child) => child.nodeType === 3 && child.textContent.trim() !== '',
        );
        const isField = node.tagName === 'INPUT' || node.tagName === 'TEXTAREA';
        // A *descendant* svg proves nothing about this element's colour: `html`
        // contains the whole page's svg. Only an svg this element lays out
        // itself, at its own font size and colour, is ink it paints — and it
        // has to be visible, since the theme toggle keeps both sun and moon in
        // the DOM and hides one of them.
        const hasSvg = [...node.children].some(
            (child) => child.tagName.toLowerCase() === 'svg' && getComputedStyle(child).display !== 'none',
        );

        const base = { path, chain: chainOf(node), inactive, decorative, spec };

        // A container whose text lives in element children is not ink-bearing
        // on its own: it only supplies the colour its children inherit, and
        // the children are measured with it. Judging both would double-count.
        if (hasDirectText || isField) {
            records.push({ ...base, role: 'text', color: style.color });
        } else if (hasSvg) {
            records.push({ ...base, role: 'graphic', color: style.color });
        }

        if (isField && typeof node.placeholder === 'string' && node.placeholder !== '') {
            records.push({
                ...base,
                role: 'text',
                color: getComputedStyle(node, '::placeholder').color,
                path: `${path}::placeholder`,
            });
        }

        // Generated content. An empty `content: ""` paints nothing — which is
        // every ::before/::after here; they are hairlines — so those are
        // skipped and covered by the rule sweep instead.
        for (const pseudo of ['::before', '::after']) {
            const generated = getComputedStyle(node, pseudo);
            const raw = generated.content;
            const value = raw === 'none' || raw === 'normal' ? '' : raw.replace(/^["']|["']$/g, '');
            if (value.trim() === '') continue;
            records.push({
                ...base,
                role: 'text',
                color: generated.color,
                path: `${path}${pseudo}`,
                chain: chainOf(node, generated.backgroundColor),
            });
        }

        // One record per distinct colour among the sides that are actually
        // painted. Zero-width and `border-style: none` sides are invisible,
        // which is what keeps `border: none` rules from producing phantoms.
        const sides = ['Top', 'Right', 'Bottom', 'Left'];
        const visible = sides.filter(
            (side) => style[`border${side}Style`] !== 'none'
                && Number.parseFloat(style[`border${side}Width`]) > 0,
        );
        for (const color of new Set(visible.map((side) => style[`border${side}Color`]))) {
            records.push({ ...base, role: 'border', color });
        }

        const outlineWidth = Number.parseFloat(style.outlineWidth);
        if (style.outlineStyle !== 'none' && outlineWidth > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)') {
            records.push({ ...base, role: 'outline', color: style.outlineColor });
        }

        // A leaf that only paints a background is a swatch: the presence dots
        // in the roster and in the status pill. No text, no icon — the colour
        // *is* the message — so it is judged as a graphic against whatever
        // contains it (SC 1.4.11). Translucent layers are excluded, because a
        // scrim is a filter over the content beneath it rather than a graphic
        // with a colour of its own; it already appears in every chain it sits
        // on top of.
        if (!hasDirectText && !isField && !hasSvg && node.children.length === 0
            && alphaOf(style.backgroundColor) > 0.999) {
            records.push({
                ...base,
                role: 'graphic',
                color: style.backgroundColor,
                path: `${path} [background]`,
                chain: chainOf(node).slice(1),
            });
        }
    }

    // Credit is settled by the caller, which merges these across passes:
    // `matched` is what this pass saw, `totals` is how many members each rule
    // has, and a rule is exercised once the union of `matched` covers them.
    const matched = [];
    for (const [index, members] of credited) {
        if (members.size > 0) matched.push([index, [...members]]);
    }
    const totals = inventory.map((rule, index) => [index, membersOf(rule.selector).length]);

    return { records, matched, totals };
}

/* ------------------------------------------------------------------ *
 * Driving the page
 * ------------------------------------------------------------------ */

/**
 * Run source against the page.
 *
 * Failures are recorded rather than thrown: a fixture legitimately has no
 * `showView`, and aborting the whole sweep on one missing hook would hide the
 * measurements that did succeed. The caller reports them, and the gate's own
 * test asserts the real client drives cleanly, so a genuine breakage here
 * surfaces as a failed run rather than as a silently thinner report.
 */
async function drive(page, code, failures) {
    await page.evaluate(`(() => { ${code} })()`).catch((error) => {
        failures.push(`${error.message.split('\n')[0]} — ${code.trim().split('\n')[0].slice(0, 90)}`);
    });
}

/**
 * Hover every element a `:hover` rule could apply to, measuring each pass.
 * Target selectors are derived by stripping `:hover` and `:not(...)` from the
 * rule's own selector, so nothing has to be listed by hand.
 */
async function hoverPass(page, rules, collect) {
    const targets = await page.evaluate((list) => {
        const out = [];
        for (const rule of list) {
            if (!rule.selector.includes(':hover')) continue;
            if (!rule.media.every((query) => matchMedia(query).matches)) continue;
            const base = rule.selector
                .replace(/:not\([^)]*\)/g, '')
                .replace(/:hover/g, '')
                .replace(/::[\w-]+(\([^)]*\))?/g, '')
                .trim();
            if (!base || out.includes(base)) continue;
            try {
                if (document.querySelector(base)) out.push(base);
            } catch {
                // reported by the coverage sweep if it is a real problem
            }
        }
        return out;
    }, rules);

    for (const selector of targets) {
        const hovered = await page.hover(selector).then(() => true, () => false);
        if (!hovered) continue;
        await collect(selector);
        await page.mouse.move(0, 0);
    }
}

/** Tab through the document, measuring the focused slice after each press. */
async function focusPass(page, collect) {
    let previous = null;
    for (let press = 0; press < 40; press++) {
        await page.keyboard.press('Tab');
        const current = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body || el === document.documentElement) return null;
            return el.id ? `#${el.id}` : (el.className || el.tagName).toString().split(' ')[0];
        });
        if (current === null || current === previous) break;
        previous = current;
        await collect('FOCUS');
    }
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/**
 * Drive the page and return every raw colour record, the stylesheet's colour
 * inventory, the indices of the inventory that were exercised, and any
 * driving step that threw.
 *
 * @param {object} options
 * @param {string} options.root      directory to serve (client/ or a fixture)
 * @param {import('puppeteer-core').Browser} options.browser
 * @param {Array<{width: number, height: number}>} [options.viewports]
 * @param {string[]} [options.themes]
 */
export async function runGate({
    root,
    browser,
    viewports = [{ width: 1280, height: 900 }, { width: 480, height: 900 }],
    themes = ['dark', 'light'],
}) {
    const server = await serve(root);
    const page = await browser.newPage();
    const exercised = new Set();
    const records = [];
    const failures = [];
    // Held outside the theme loop because `collect` is defined before it:
    // a closure only sees bindings that enclose it.
    let activeTheme = '';

    /**
     * Back to a state nothing has toggled: buttons enabled, banners hidden.
     * Written as source rather than as a closure because page.evaluate
     * serialises the function alone, not the scope it was created in.
     */
    const RESET = `
        document.querySelectorAll('.demo-account, #send, #login-btn, #register-btn, .submit-btn')
            .forEach((button) => { button.disabled = false; });
        document.querySelectorAll('.error-message, .success-message')
            .forEach((el) => el.classList.remove('visible'));
        const setLoading = (id) => {
            const button = document.getElementById(id);
            if (button && typeof setButtonLoading === 'function') setButtonLoading(button, false);
        };
        setLoading('login-btn');
        setLoading('register-btn');
    `;

    const CHAT_BASELINE = `
        ${RESET}
        const box = document.getElementById('message-box');
        if (box) box.value = '';
        if (typeof updateCounter === 'function') updateCounter();
        if (typeof hideEmptyState === 'function') hideEmptyState();
        if (typeof setDrawer === 'function') setDrawer(false);
        if (typeof setStatus === 'function') setStatus(true, 'Connected');
    `;

    try {
        await page.setViewport(viewports[0]);
        await page.goto(`${server.origin}/`, { waitUntil: 'domcontentloaded' });
        // Freeze motion. Every animation here resolves to its base style
        // (`rise`, `bubble`, `shake`, `breathe` all end where they started) and
        // every transition interpolates between two declared values, so the
        // settled state is the design — and a frame caught mid-flight is not.
        // Without this the sweep can read a half-switched theme colour or a
        // message still at `opacity: 0` from its entrance keyframe, and file
        // both as real findings. Disabling motion also removes the need to
        // guess how long to wait before measuring.
        await page.addStyleTag({
            content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
        });
        const rules = await page.evaluate(buildInventory);

        // Selector members credited so far, keyed by inventory index. A rule
        // is exercised once every member of its selector list has matched a
        // rendered element at some point in the run — not necessarily in the
        // same pass, since `.error-message` and `.success-message` are
        // opposite states of the same form and one collect can never see both.
        const credited = new Map();

        const collect = async (spec) => {
            const slice = await page.evaluate(measureSlice, spec, rules);
            if (!slice) return;
            for (const [index, members] of slice.matched) {
                let state = credited.get(index);
                if (!state) {
                    state = new Set();
                    credited.set(index, state);
                }
                for (const member of members) state.add(member);
            }
            for (const [index, total] of slice.totals) {
                if (total > 0 && (credited.get(index)?.size ?? 0) >= total) exercised.add(index);
            }
            // The theme is stamped here rather than read in-page: styles.css
            // keys off `data-theme`, but the same DOM is measured under both
            // values and the report needs to know which pass produced what.
            records.push(...slice.records.map((record) => ({ ...record, theme: activeTheme })));
        };

        const setTheme = (theme) => page.evaluate((value) => {
            if (typeof applyTheme === 'function') applyTheme(value);
            document.documentElement.dataset.theme = value;
            document.documentElement.dataset.themePreference = value;
        }, theme);

        const measureView = async (view, baseline) => {
            await drive(page, `if (typeof showView === 'function') showView('${view}');`, failures);
            await drive(page, baseline, failures);
            await collect('ALL');
        };

        for (const theme of themes) {
            activeTheme = theme;
            await setTheme(theme);

            for (const viewport of viewports) {
                await page.setViewport(viewport);
                // Hover and focus are measured on the desktop viewport only:
                // colour does not vary with width, and the one rule set that
                // does is the drawer, driven explicitly below.
                const desktop = viewport.width > 860;

                /* -- Sign-in ------------------------------------------------ */
                await measureView('login', RESET);
                if (desktop) {
                    await hoverPass(page, rules, collect);
                    await focusPass(page, collect);
                }

                // The error banner, which only exists once showError has run.
                await drive(page, `
                    const banner = document.getElementById('login-error');
                    const text = document.getElementById('login-error-text');
                    if (banner && text) {
                        if (typeof showError === 'function') {
                            showError(banner, text, 'Incorrect username or password.');
                        } else {
                            banner.classList.add('visible');
                            text.textContent = 'Incorrect username or password.';
                        }
                    }
                `, failures);
                await collect('ALL');

                // Submit in flight: rows disabled, button showing its wait label.
                await drive(page, `
                    document.querySelectorAll('.demo-account').forEach((b) => { b.disabled = true; });
                    const button = document.getElementById('login-btn');
                    if (button && typeof setButtonLoading === 'function') setButtonLoading(button, true);
                `, failures);
                await collect('ALL');
                await drive(page, RESET, failures);

                /* -- Register ----------------------------------------------- */
                await measureView('register', RESET);
                if (desktop) {
                    await hoverPass(page, rules, collect);
                    await focusPass(page, collect);
                }
                await drive(page, `
                    const banner = document.getElementById('register-success');
                    if (banner) {
                        banner.classList.add('visible');
                        const button = document.getElementById('register-btn');
                        if (button && typeof setButtonLoading === 'function') setButtonLoading(button, true);
                    }
                `, failures);
                await collect('ALL');
                await drive(page, RESET, failures);

                /* -- Chat ---------------------------------------------------- */
                await measureView('chat', CHAT_BASELINE);

                // Empty room.
                await drive(page, 'if (typeof showEmptyState === "function") showEmptyState();', failures);
                await collect('ALL');
                await drive(page, 'if (typeof hideEmptyState === "function") hideEmptyState();', failures);

                // A run of messages: someone else's, a grouped continuation,
                // and the signed-in user's own — which is what gives the
                // `.my-message`, `.is-grouped` and accent meta line.
                await drive(page, `
                    if (typeof appendMessage === 'function') {
                        appendMessage({ sender: 'alice', text: 'Morning — did the deploy go out?', timestamp: '09:14' });
                        appendMessage({ sender: 'alice', text: 'It did.', timestamp: '09:15' });
                        appendMessage({ sender: 'bob', text: 'Checking in now.', timestamp: '09:16', mine: true });
                        appendMessage({ sender: 'alice', text: 'A long message that wraps across a couple of lines, so the bubble has to grow past its first row.', timestamp: '09:17' });
                    }
                    if (typeof appendAnnouncement === 'function') appendAnnouncement('bob joined the room');
                `, failures);
                await collect('ALL');

                // Presence, including the highlighted "you" row.
                await drive(page, `
                    if (typeof updateUserList === 'function') {
                        try { username = 'bob'; } catch {}
                        updateUserList(['alice', 'bob', 'carol']);
                    }
                `, failures);
                await collect('ALL');

                await drive(page, 'if (typeof setStatus === "function") setStatus(false, "Reconnecting…");', failures);
                await collect('ALL');
                await drive(page, 'if (typeof setStatus === "function") setStatus(true, "Connected");', failures);
                await collect('ALL');

                // Character-counter thresholds: 240 crosses into `is-near`,
                // 251 past MAX_MESSAGE into `is-over`.
                for (const length of [240, 251]) {
                    await page.evaluate((value) => {
                        const box = document.getElementById('message-box');
                        if (box) {
                            // `maxlength` bounds typing, not assignment, but
                            // lifting it costs nothing and removes any doubt
                            // that the 251-character state was really reached.
                            box.removeAttribute('maxlength');
                            box.value = 'x'.repeat(value);
                        }
                        if (typeof updateCounter === 'function') updateCounter();
                    }, length);
                    await collect('ALL');
                }
                await page.evaluate(() => {
                    const box = document.getElementById('message-box');
                    if (box) box.value = '';
                    if (typeof updateCounter === 'function') updateCounter();
                });

                // The drawer and its scrim only exist below 860px.
                if (!desktop) {
                    await drive(page, 'if (typeof setDrawer === "function") setDrawer(true);', failures);
                    await collect('ALL');
                    await drive(page, 'if (typeof setDrawer === "function") setDrawer(false);', failures);
                }

                if (desktop) {
                    await hoverPass(page, rules, collect);
                    await focusPass(page, collect);
                }
            }
        }

        return { records, rules, exercised: [...exercised], failures };
    } finally {
        await page.close().catch(() => {});
        await server.close();
    }
}
