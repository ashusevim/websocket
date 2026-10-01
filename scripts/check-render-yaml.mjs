#!/usr/bin/env node
/*
 * Gate: render.yaml must satisfy Render's own published Blueprint schema.
 *
 * WHY THIS EXISTS
 * ---------------
 * Render rejects a Blueprint at deploy time, not at push time. A typo such as
 * `type: db` under `databases` — where no `type` field exists at all — costs a
 * failed deploy and a round trip to the dashboard to read the message. This
 * moves that failure to CI.
 *
 * The schema is fetched from Render rather than reimplemented here. Encoding a
 * subset of the rules would produce a check that passes on exactly the files it
 * was written against, which is worse than no check.
 *
 * THE CANARY
 * ----------
 * A validator that has never been seen to reject anything proves nothing. After
 * validating the real file, this injects the `databases[0].type` mistake into
 * an in-memory copy and asserts it IS caught. If the schema fetch silently
 * degrades or the validation stops applying, the canary fails and says so.
 *
 * Usage:
 *   node scripts/check-render-yaml.mjs [path/to/render.yaml]
 *   node scripts/check-render-yaml.mjs --schema local-schema.json
 */

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_URL = 'https://render.com/schema/render.yaml.json';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BLUEPRINT = path.join(REPO_ROOT, 'render.yaml');

const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const blueprintPath = path.resolve(args.find((a) => !a.startsWith('--')) ?? DEFAULT_BLUEPRINT);
const localSchema = argValue('--schema');

/** Reads and parses the Blueprint, with a message that names the file. */
async function loadBlueprint() {
  let source;
  try {
    source = await readFile(blueprintPath, 'utf8');
  } catch (err) {
    fail(`cannot read ${blueprintPath}: ${err.message}`);
  }

  try {
    const doc = yaml.load(source, { filename: blueprintPath });
    if (doc === null || doc === undefined || typeof doc !== 'object') {
      fail(`${blueprintPath} parsed to ${JSON.stringify(doc)}, expected a YAML mapping`);
    }
    return doc;
  } catch (err) {
    // A YAML syntax error is a different failure from a schema violation, so
    // report it as itself rather than burying it under validator output.
    fail(`YAML syntax error in ${blueprintPath}:\n  ${err.message}`);
  }
}

/**
 * Fetches Render's schema, retrying because this is the one network dependency
 * in the gate. A transient 5xx should not fail a pull request; a persistent
 * one should, because otherwise the gate is silently off.
 */
async function loadSchema() {
  if (localSchema) {
    const p = path.resolve(localSchema);
    return JSON.parse(await readFile(p, 'utf8'));
  }

  const attempts = 3;
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(SCHEMA_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  fail(
    `could not fetch Render's schema after ${attempts} attempts (${lastError.message}).\n` +
      `  This is a network failure, not a render.yaml problem.\n` +
      `  Pass --schema <file> to validate against a local copy.`
  );
}

function compile(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Prints each violation with the path and, when present, the offending key. */
function report(validate, data, label) {
  console.error(`\n${label}`);
  for (const err of validate.errors ?? []) {
    const where = err.instancePath || '(root)';
    console.error(`  ${where}  ${err.message}`);
    if (err.params?.additionalProperty) {
      console.error(`      -> unexpected key: ${err.params.additionalProperty}`);
    }
    if (err.params?.allowedValues) {
      console.error(`      -> allowed: ${JSON.stringify(err.params.allowedValues)}`);
    }
  }
}

function fail(message) {
  console.error(`check-render-yaml: ${message}`);
  process.exit(1);
}

/**
 * Proves the gate rejects the mistake it was written for. Mutating a copy of
 * the real file — rather than checking against a hardcoded fixture — keeps the
 * canary honest if the Blueprint's structure changes later.
 */
function canary(schema, validData) {
  const databases = validData?.databases;
  if (!Array.isArray(databases) || databases.length === 0) {
    fail(
      'canary aborted: render.yaml declares no databases, so the canary has nothing to mutate.\n' +
        '  The gate is not proving anything. Add a databases entry or retire this check.'
    );
  }

  const mutated = structuredClone(validData);
  mutated.databases[0] = { type: 'db', ...mutated.databases[0] };

  const validate = compile(schema);
  if (validate(mutated)) {
    fail(
      'CANARY FAILED: the validator accepted `databases[0].type`, which Render rejects.\n' +
        '  The check is running but not catching anything. Do not trust a green result.'
    );
  }
}

const blueprint = await loadBlueprint();
const schema = await loadSchema();
const validate = compile(schema);

if (validate(blueprint)) {
  // Fail loudly if the canary cannot run: a passing check that never had to
  // reject anything is indistinguishable from a broken one.
  canary(schema, blueprint);
  console.log(`check-render-yaml: ${path.relative(REPO_ROOT, blueprintPath)} passes Render's schema.`);
  console.log('  canary: injected `databases[0].type` and confirmed it is rejected.');
  process.exit(0);
}

report(validate, blueprint, `${path.relative(REPO_ROOT, blueprintPath)} does NOT match Render's schema:`);
canary(schema, blueprint);
fail('fix the fields above, then re-run.');
