import crypto from "node:crypto";

/**
 * Short-lived, single-use tickets for the WebSocket handshake.
 *
 * ## Why this exists
 *
 * Browsers cannot set custom headers on a WebSocket handshake, so the JWT used
 * to be passed as `?token=<jwt>`. Query strings are recorded in proxy logs,
 * CDN/Render access logs, and browser history, which means a long-lived
 * credential ends up in places it should never be. Anyone with log access could
 * replay it.
 *
 * ## The exchange
 *
 * 1. Client already holds a JWT (from /login).
 * 2. Client POSTs that JWT to /ws-ticket over authenticated HTTPS, where it
 *    travels in a request body and is not written to access logs.
 * 3. Server returns a random, opaque ticket valid for TICKET_TTL_MS.
 * 4. Client connects with `?ticket=<ticket>` — worthless if leaked, because it
 *    expires in seconds and is destroyed on first use.
 * 5. On connect, the ticket is consumed (deleted) before the socket is accepted.
 *
 * A leaked ticket is therefore only useful in a narrow race window, and a
 * leaked *log line* is useless once the ticket is consumed. The JWT itself
 * never appears in a URL.
 */

export const TICKET_TTL_MS = 10_000;

export interface Ticket {
    ticket: string;
    username: string;
    expiresAt: number;
}

const tickets = new Map<string, Ticket>();

/** Drops expired entries. Cheap, and bounds memory on a long-lived process. */
function sweepExpired(now: number): void {
    for (const [key, value] of tickets) {
        if (value.expiresAt <= now) tickets.delete(key);
    }
}

export function issueTicket(username: string, now = Date.now()): Ticket {
    sweepExpired(now);

    const ticket: Ticket = {
        ticket: crypto.randomBytes(32).toString("hex"),
        username,
        expiresAt: now + TICKET_TTL_MS,
    };

    tickets.set(ticket.ticket, ticket);
    return ticket;
}

/**
 * Validates and atomically consumes a ticket.
 *
 * Single-use matters: without the delete, a ticket captured from a log could
 * be replayed for the remainder of its TTL.
 */
export function consumeTicket(
    ticket: string | undefined,
    now = Date.now(),
): string | undefined {
    if (!ticket) return undefined;

    const found = tickets.get(ticket);
    if (!found) return undefined;

    // Delete first, then check expiry. An expired ticket is still removed.
    tickets.delete(ticket);

    if (found.expiresAt <= now) return undefined;
    return found.username;
}

/** Test seam. */
export function __reset(): void {
    tickets.clear();
}

export function __size(): number {
    return tickets.size;
}
