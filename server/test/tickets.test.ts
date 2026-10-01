import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
    issueTicket,
    consumeTicket,
    TICKET_TTL_MS,
    __reset,
    __size,
} from "../src/utils/tickets.js";

describe("tickets", () => {
    beforeEach(() => __reset());

    test("issues a ticket bound to the username", () => {
        const { ticket, username } = issueTicket("alice");
        assert.equal(username, "alice");
        assert.match(ticket, /^[0-9a-f]{64}$/, "should be 32 random bytes, hex");
    });

    test("tickets are unguessable and unique", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 500; i++) seen.add(issueTicket("alice").ticket);
        assert.equal(seen.size, 500, "no collisions across 500 issuances");
    });

    test("consumeTicket returns the username for a valid ticket", () => {
        const { ticket } = issueTicket("bob");
        assert.equal(consumeTicket(ticket), "bob");
    });

    // The core property: a ticket captured from an access log is worthless
    // once it has been used.
    test("a ticket is single-use", () => {
        const { ticket } = issueTicket("bob");
        assert.equal(consumeTicket(ticket), "bob");
        assert.equal(consumeTicket(ticket), undefined, "replay must fail");
        assert.equal(__size(), 0, "consumed ticket is not retained");
    });

    test("rejects an unknown ticket", () => {
        assert.equal(consumeTicket("deadbeef".repeat(8)), undefined);
    });

    test("rejects an expired ticket", () => {
        const now = 1_000_000;
        const { ticket } = issueTicket("carol", now);

        // One millisecond before expiry: still valid.
        assert.equal(consumeTicket(ticket, now + TICKET_TTL_MS - 1), "carol");

        const later = issueTicket("carol", now).ticket;
        assert.equal(consumeTicket(later, now + TICKET_TTL_MS), undefined);
        assert.equal(consumeTicket(later, now + TICKET_TTL_MS + 1), undefined);
    });

    test("an expired ticket is removed, not just rejected", () => {
        const now = 1_000_000;
        const { ticket } = issueTicket("dave", now);
        consumeTicket(ticket, now + TICKET_TTL_MS + 1);
        assert.equal(__size(), 0);
    });

    test("rejects missing or empty tickets", () => {
        assert.equal(consumeTicket(undefined), undefined);
        assert.equal(consumeTicket(""), undefined);
    });

    test("issuing sweeps expired tickets so memory stays bounded", () => {
        const start = 1_000_000;
        for (let i = 0; i < 100; i++) issueTicket("eve", start);
        assert.equal(__size(), 100);

        // Issuing after the TTL drops the whole batch.
        issueTicket("eve", start + TICKET_TTL_MS + 1);
        assert.equal(__size(), 1, "only the newly issued ticket remains");
    });
});
