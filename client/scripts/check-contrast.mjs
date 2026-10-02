#!/usr/bin/env node
/**
 * WCAG contrast gate for the chat client.
 *
 * The pairs are not listed anywhere. They are read off a rendered page —
 * Chrome loads client/, the sweep drives every view, theme, viewport and
 * interactive state the app can reach, and every ink/background/border/focus
 * combination that actually occurs is measured. styles.css is consulted for
 * one thing only: which rules must have been exercised for the measurement to
 * be complete.
 *
 * Two independent checks, both required:
 *
 *   contrast   each unique pair clears its floor (see ROLES in lib/contrast.mjs)
 *   coverage   every colour-bearing rule had every member of its selector
 *              list matched by a live element at some point
 *
 * A gate that measured correctly but skipped a rule would be worse than no
 * gate — it would assert completeness it had not earned — which is why the
 * second check exists and is not optional.
 *
 * Exits non-zero on any failure.
 *
 * Usage:
 *   node scripts/check-contrast.mjs                # measure client/
 *   node scripts/check-contrast.mjs --root <dir>   # measure another root
 *   node scripts/check-contrast.mjs --quiet        # summary and failures only
 *
 * Requires a system Chrome (or CHROME_PATH). Nothing is downloaded.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, runGate } from './lib/gate.mjs';
import { score, coverage, EXEMPT_REASON, INACTIVE_REASON } from './lib/contrast.mjs';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
    const args = { root: CLIENT_ROOT, quiet: false };
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i];
        if (flag === '--quiet') args.quiet = true;
        else if (flag === '--root') {
            const value = argv[i + 1];
            if (value === undefined) {
                console.error('check-contrast: --root needs a directory');
                process.exit(2);
            }
            args.root = path.resolve(value);
            i += 1;
        } else if (flag === '--help' || flag === '-h') {
            console.log('usage: check-contrast.mjs [--root <dir>] [--quiet]');
            process.exit(0);
        } else {
            console.error(`check-contrast: unknown argument ${JSON.stringify(flag)}`);
            process.exit(2);
        }
    }
    return args;
}

const themeMarks = (themes) => ['dark', 'light']
    .filter((theme) => themes.has(theme))
    .map((theme) => theme[0].toUpperCase())
    .join('') || '?';

const describe = (pair) => (pair.between
    ? `${pair.fg} between ${pair.on} and ${pair.between}`
    : `${pair.fg} on ${pair.on}`);

// The same colours can appear twice in the table — once judged, once exempt —
// because the exemption is part of what makes the pair a distinct decision.
// Without this tag two identical-looking rows would read as a duplicate.
const exemptTag = (pair) => (pair.exempt === INACTIVE_REASON
    ? ' [inactive]'
    : pair.exempt === EXEMPT_REASON ? ' [decorative]' : '');

function printPair(pair, indent = '  ') {
    const marks = themeMarks(pair.themes);
    // 64 fits the longest cell — the SC 1.4.3 reason (49) plus its tag — so
    // the exempt rows, which sit in this table as well as in their own
    // section, do not push the columns out of line.
    console.log(
        `${indent}${pair.value.toFixed(2)}:1  ${pair.role.padEnd(8)} `
        + `${(describe(pair) + exemptTag(pair)).padEnd(64)} `
        + `${marks.padEnd(3)} ×${String(pair.count).padEnd(5)} ${pair.examples[0]}`,
    );
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    console.log('WCAG contrast gate — measured in Chrome');
    console.log(`  root     ${path.relative(process.cwd(), args.root) || '.'}`);
    console.log('  themes   dark, light');
    console.log('  viewport 1280×900 (desktop) and 480×900 (mobile)');
    console.log('');

    const browser = await launchBrowser();
    let result;
    try {
        result = await runGate({ root: args.root, browser });
    } finally {
        await browser.close().catch(() => {});
    }

    const { pairs, failures, exempted } = score(result.records);
    const cover = coverage(result.rules, result.exercised);
    const exit = failures.length > 0 || cover.missing.length > 0 || result.failures.length > 0;

    if (failures.length > 0) {
        console.log('BELOW THE REQUIRED CONTRAST');
        for (const pair of failures) {
            console.log(`  ${pair.value.toFixed(2)}:1 needs ${pair.floor.toFixed(2)}  ${pair.role.padEnd(8)} ${describe(pair)}  [${themeMarks(pair.themes)}]`);
            console.log(`    seen on ${pair.examples.join(', ')}`);
        }
        console.log('');
    }

    if (cover.missing.length > 0) {
        console.log('COLOUR-BEARING RULES THAT WERE NEVER EXERCISED');
        console.log('  For each of these the sweep never saw a rendered element');
        console.log('  matching every selector in the rule, so nothing in the');
        console.log('  report above covers it.');
        for (const rule of cover.missing) {
            const media = rule.media.length > 0 ? `  @media ${rule.media.join(' and ')}` : '';
            console.log(`  ${rule.selector}${media}`);
            console.log(`    sets: ${rule.props.join(', ')}`);
        }
        console.log('');
    }

    if (result.failures.length > 0) {
        console.log('DRIVING ERRORS');
        console.log('  A state the gate tried to put the page into did not apply.');
        for (const failure of result.failures) console.log(`  ${failure}`);
        console.log('');
    }

    if (!args.quiet) {
        if (exempted.length > 0) {
            console.log('BELOW FLOOR BUT EXEMPT (SC 1.4.3 exceptions)');
            for (const pair of exempted) {
                console.log(`  ${pair.value.toFixed(2)}:1 (floor ${pair.floor.toFixed(2)})  ${pair.role.padEnd(8)} ${describe(pair).padEnd(48)} ${themeMarks(pair.themes)}  ${pair.exempt}`);
            }
            console.log('');
        }

        console.log(`PAIRS (${pairs.length} unique, grouped by role, lowest first)`);
        let lastRole = null;
        for (const pair of pairs) {
            if (pair.role !== lastRole) {
                lastRole = pair.role;
                console.log(`  ${pair.role} — min ${pair.floor.toFixed(2)}:1`);
            }
            printPair(pair, '    ');
        }
        console.log('');
    }

    const below = exempted.length;
    console.log(
        `${pairs.length} unique pairs · ${failures.length} below floor`
        + ` · ${below} exempt below floor`
        + ` · coverage ${cover.covered}/${cover.total} rules`
        + ` · ${result.failures.length} driving errors`,
    );

    if (exit) {
        console.log('FAILED');
        process.exitCode = 1;
    } else {
        console.log('OK');
    }
}

main().catch((error) => {
    console.error(`check-contrast: ${error.message}`);
    process.exitCode = 1;
});
