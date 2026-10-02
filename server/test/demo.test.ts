import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DEMO_ACCOUNTS } from "../src/demo.js";
import { isValidPassword, isValidUsername } from "../src/utils/validation.js";

/**
 * The published demo credentials are only useful if the API accepts them.
 *
 * /register and /login both run these validators before touching the database,
 * so a password shortened below the 6 character floor — or a username with a
 * character outside [a-zA-Z0-9_] — would make the sign-in card advertise
 * credentials the server rejects with a 400 before it ever looks them up.
 * Nothing else would fail: the seeder would happily insert the row, because
 * INSERT does not consult the validators.
 *
 * Needs no database, which is the point — this is the invariant that can be
 * checked before anything boots. The behaviour that does need Postgres
 * (idempotency, and the published password actually logging in) lives in
 * integration.test.ts.
 */
describe("demo credentials", () => {
    test("every account passes the validators /register and /login use", () => {
        // The sign-in card offers two seats, so two is the floor.
        assert.ok(
            DEMO_ACCOUNTS.length >= 2,
            `expected at least 2 demo accounts, got ${DEMO_ACCOUNTS.length}`,
        );

        for (const { username, password } of DEMO_ACCOUNTS) {
            assert.ok(
                isValidUsername(username),
                `username "${username}" would be rejected with a 400`,
            );
            assert.ok(
                isValidPassword(password),
                `password for "${username}" would be rejected with a 400`,
            );
        }
    });

    test("usernames are unique", () => {
        // Two identical names would seed as one row, and the card would show
        // the same account twice with no way to reach the second seat.
        const names = DEMO_ACCOUNTS.map((account) => account.username);
        assert.equal(
            new Set(names).size,
            names.length,
            `duplicate demo username in: ${names.join(", ")}`,
        );
    });
});
