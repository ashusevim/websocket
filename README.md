# WebSocket Chat Application

Real-time chat with authentication, built with Express 5, PostgreSQL, `ws`, and
JWT sessions.

The interesting part is the credential handling: browsers cannot set headers on
a WebSocket handshake, so the JWT is exchanged for a short-lived single-use
ticket before connecting. See [WebSocket authentication](#websocket-authentication).

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [WebSocket Protocol](#websocket-protocol)
  - [WebSocket authentication](#websocket-authentication)
- [Configuration](#configuration)
- [Security](#security)
- [Technical Deep Dive](#technical-deep-dive)
- [Deployment](#deployment)
  - [Schema management](#schema-management)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)


## Features

- **Authentication**: bcrypt password hashing, JWT sessions, one active session
  per user, revocable logout
- **Credential-safe WebSocket handshake**: short-lived single-use tickets keep
  the JWT out of URLs, access logs and browser history
- **Real-time Chat**: broadcast messaging, live user presence, automatic
  reconnection with exponential backoff
- **Security**: rate limiting, type-guarded input validation, single origin
  allowlist for CORS and the handshake, parameterized SQL
- **Tests**: 91 unit and integration tests (plus 36 on the client), no mocking
  of the database or the HTTP/WS stack
- **Monitoring**: Winston (JSON in production), Sentry error tracking
- **Graceful Shutdown**: closes sockets, flushes Sentry, then drains the pool,
  under a 10s deadline so a stuck socket cannot defer the work to SIGKILL
- **Production Ready**: multi-stage Docker image (non-root), health check,
  idempotent schema, Render deploy config

### Client

- **Design direction taken from real production apps.** The palette, type
  treatment and radii are derived from sites in the
  [inspo](https://github.com/Nutlope/inspo) archive — Linear as the archetype,
  corroborated by Bun, Algolia, Superlist, CodePen and Apple Developer, which
  independently agree on a near-black base, one contrasting accent, tight radii
  and high-contrast monochrome type. The token pairs that meet are then checked
  against WCAG by a script that runs in CI. The pairs are not listed anywhere:
  the script loads the client into real Chrome, drives every view, theme,
  viewport and interactive state, and measures every combination that actually
  occurs — so a new surface is covered the moment it renders, and a second
  check confirms the sweep really did reach every colour-bearing rule rather
  than a comfortable subset of them.
- **The favicon is the app's own mark, not a default.** `client/favicon.svg`
  redraws the speech bubble from the sign-in screen as a filled silhouette on
  the accent tile — the stroked header version loses its dots below ~32px. SVG
  rather than `favicon.ico` so nothing binary is committed, and the tile colour
  is pinned to the dark theme's `--accent` by a test: the palette has two
  accents, and a favicon can only carry one, so the brighter of the pair is the
  one that reads on both light and dark tab strips.
- **Two demo accounts, one click away.** The sign-in screen lists `demo` and
  `guest` with the passwords the server seeds at boot; clicking a row fills
  the form and submits it through the ordinary submit path, so validation, the
  loading state and error handling stay in one place. The rows are disabled
  while a login is in flight.
- **Dark, light, or system — with a toggle.** Three-state cycle on every screen,
  including before sign-in. Two complete token sets rather than one plus
  inverted greys. The choice persists, is applied before first paint so there is
  no flash of the wrong theme, and an explicit choice is never overwritten by a
  later system change. On `system` the toggle shows a monitor icon while
  rendering whatever the OS asks for.
- **Chat-native layout.** The page never scrolls; only the message list does.
  The composer is pinned to the bottom and grows with its content.
- **Live presence.** Connection state, room member count, per-user status
  dots, and join/leave announcements.
- **Accessible by construction**: semantic landmarks, a visible label on every
  input (never a placeholder standing in for one), `aria-live` on the log and
  status, keyboard-operable drawer, and `prefers-reduced-motion` honoured.
- **Responsive down to 375px**, with the member list becoming a drawer.

## Quick Start

```bash
# 1. Database setup
createdb websocket_chat
psql -U postgres -d websocket_chat -f server/schema.sql

# 2. Configure environment
cd server
cat > .env << EOF
DB_USER=postgres
DB_PASSWORD=your_password
DB_HOST=localhost
DB_PORT=5432
DB_NAME=websocket_chat
PORT=8080
JWT_SECRET=$(openssl rand -hex 32)
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:5500
EOF

# 3. Install & run server
npm ci
npm run dev:hot

# 4. Serve client (new terminal)
npx serve client -l 5500

# 5. Open http://localhost:5500
```

The sign-in screen carries a **Demo accounts** panel. Click a row to sign in
as `demo` / `demo1234` or `guest` / `guest1234` — the server seeds both on
its first boot, so there is nothing to register. Two rows are the point: open
an incognito window, take the other account, and the two of you are in the
same room.

`server/schema.sql` is idempotent, so it is safe to re-run against an existing
database. Two of its indexes are load-bearing:

- `active_tokens_username_key` — the login upsert matches on it. Without it,
  logging in twice fails.
- `active_tokens_token_key` (from `UNIQUE`) — makes logout revocation and the
  ticket exchange's session lookup an index scan.

To run the tests instead:

```bash
cd server
npm test    # starts its own Postgres in Docker
```

---

## Project Structure

```
websocket/
├── server/
│   ├── src/
│   │   ├── index.ts          # Entrypoint: binds the port, handles signals
│   │   ├── app.ts            # createApp/createChatServer factories
│   │   ├── db.ts             # PostgreSQL pool (SSL negotiated, not assumed)
│   │   ├── demo.ts           # DEMO_ACCOUNTS + the idempotent boot seeder
│   │   ├── logger.ts         # Winston (JSON in production, colour in dev)
│   │   ├── instrument.ts     # Sentry setup
│   │   └── utils/
│   │       ├── tickets.ts    # Single-use WebSocket tickets
│   │       ├── validation.ts # Input validation (type-guarded → 400)
│   │       └── sanitize.ts   # Control-char stripping + trim
│   ├── test/
│   │   ├── utils.test.ts       # Unit: validation + sanitize
│   │   ├── tickets.test.ts     # Unit: ticket issue/consume/expiry
│   │   ├── origins.test.ts     # Unit: allowlist parsing + rejection
│   │   ├── demo.test.ts        # Unit: demo credentials + boot order
│   │   ├── integration.test.ts # Real HTTP + WS against real Postgres
│   │   └── shutdown.test.ts    # Real process: SIGTERM with a chat open
│   ├── scripts/
│   │   ├── test-db.mjs         # Throwaway Postgres for tests
│   │   └── run-integration.mjs # Test runner wrapper
│   ├── schema.sql           # Idempotent schema
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── client/
│   ├── index.html            # Chat UI with login/register
│   ├── styles.css            # Two complete token sets, keyed off <html data-theme>
│   ├── api.js                # Body reading, host resolution, failure wording
│   ├── config.js             # Deployed API host (one-line retarget)
│   ├── favicon.svg           # SVG mark; tile colour pinned to --accent
│   └── test/
│       └── client.test.mjs   # Unit: response bodies, host rules, markup gates
├── render.yaml               # Render deployment config
└── README.md
```

`app.ts` exposes `createApp()` and `createChatServer()` rather than running on
import. The production entrypoint and the integration tests build the server
through the same factory, so the handshake policy under test is the policy that
ships.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          CLIENT (Browser)                           │
│   Login/Register ──► holds JWT in memory (never localStorage)        │
│   Chat UI: message input, user list, connection status              │
└───────────────┬──────────────────────────────┬───────────────────────┘
                │ HTTPS                        │ WSS ?ticket=…
                │ POST /login, /ws-ticket      │ (ticket, not JWT)
                ▼                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        EXPRESS SERVER                                │
│                                                                      │
│  Middleware        REST              WebSocket                      │
│  ─────────         ─────             ─────────                      │
│  • CORS            • /register       • origin check                │
│  • rate limit      • /login          • ticket consume (sync)       │
│  • JSON limit      • /logout         • broadcast + presence         │
│                    • /ws-ticket      • per-connection rate limit    │
│                    • /health                                             │
└───────────────┬──────────────────────────────┬───────────────────────┘
                │                              │
                ▼                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          POSTGRESQL                                  │
│  users              active_tokens              (in memory)           │
│  ─────              ──────────────            ──────────────         │
│  id                 id                        ticket → username      │
│  username (unique)  token (unique)            TTL 10s, single use    │
│  password_hash      username (unique, FK)                          │
│  created_at         created_at                                      │
└──────────────────────────────────────────────────────────────────────┘
```

The ticket store is deliberately **in memory and separate from Postgres**. It
holds credentials for at most 10 seconds, and keeping it out of the database is
what lets the upgrade handler stay synchronous. The trade-off — it does not
survive a restart or span instances — is listed under
[Known Gaps](#known-gaps).

### Data Flow

1. **Registration/Login**: Client sends credentials via HTTP POST
2. **Token Generation**: Server creates JWT, stores in database
3. **Ticket Exchange**: Client POSTs the JWT to `/ws-ticket` in an
   `Authorization` header, receives a short-lived single-use ticket
4. **WebSocket Connection**: Client connects with `?ticket=…`; the server
   validates origin and consumes the ticket — no database round trip
5. **Real-time Messaging**: Bidirectional communication over WebSocket
6. **Logout**: Token removed from `active_tokens`, so the JWT can no longer
   obtain a ticket


## API Reference

### POST /register

```json
// Request
{ "username": "alice", "password": "secret123" }

// Response (201)
{ "message": "User created successfully", "username": "alice" }
```

### POST /login

```json
// Request
{ "username": "alice", "password": "secret123" }

// Response (200)
{ "token": "jwt-token-string", "username": "alice" }
```

Each login issues a JWT carrying a random `jti` claim and **replaces** any
existing session for that user (one active session per user, enforced by a
unique index on `active_tokens.username`).

The `jti` is load-bearing, not decoration. Two logins by the same user within
the same second would otherwise produce byte-identical tokens — same payload,
same `iat`, same `exp` — and the second insert would violate the unique
constraint on `token`, failing the login with a 500.

### POST /logout

```json
// Request
{ "token": "jwt-token-string" }

// Response (200)
{ "message": "User logout successfully" }
```

### POST /ws-ticket

Exchanges a valid JWT for a short-lived, single-use ticket for the WebSocket
handshake. See [WebSocket authentication](#websocket-authentication) for why
this exists.

```http
POST /ws-ticket
Authorization: Bearer <jwt>
```

```json
// Response (200)
{ "ticket": "9f2c1e…" }
```

| Status | Meaning |
|--------|---------|
| 401 | Missing, malformed, expired, or revoked token |
| 429 | Rate limited (20 requests/minute/IP) |
| 500 | `JWT_SECRET` not configured |

### GET /health

```json
// Response (200)
{ "status": "ok", "timeStamp": "2025-10-14T12:34:56.789Z" }
```

### GET /debug-sentry

Triggers a test error to verify the Sentry pipeline. **Registered only when
`NODE_ENV` is not `production`** — in production this route does not exist and
returns 404. A public endpoint whose only job is to throw is a free
error-spam machine against your own Sentry quota.


## WebSocket Protocol

**Connection**: `ws://localhost:8080?ticket=<ticket>` — see
[WebSocket authentication](#websocket-authentication) for how to obtain the
ticket. A `?token=` connection is rejected.

### WebSocket authentication

Browsers cannot set custom headers on a WebSocket handshake, so the obvious
approach is `?token=<jwt>`. That is what this project used to do, and it is a
leak: query strings are recorded in proxy logs, CDN access logs and browser
history, so a long-lived credential ends up written down in places it should
never be.

Instead the client performs a two-step exchange:

```
1. POST /ws-ticket          Authorization: Bearer <jwt>     →  { ticket }
2. GET  /?ticket=<ticket>    (WebSocket upgrade)
```

The ticket is 32 random bytes, expires after **10 seconds**, and is **destroyed
on first use**. A ticket captured from a log line is therefore useless once it
has been spent, and the JWT itself never appears in a URL.

The handshake check is fully synchronous — the ticket was already validated
when issued, so there is no database round trip on the upgrade path.

| Rejection | Cause |
|-----------|-------|
| 403 | Origin not in the allowlist |
| 401 | Missing, unknown, expired, or already-used ticket |

### Client → Server

```json
{ "type": "chat", "message": "Hello!" }
```

### Server → Client

```json
// Chat message
{ "username": "alice", "message": "Hello!", "timestamp": "12:34:56 PM" }

// System announcement
{ "type": "announcement", "message": "alice has joined the chat room" }

// User list update
{ "type": "userList", "users": ["alice", "bob"] }
```

### Message Types

These mirror the implementation in `server/src/app.ts`.

```typescript
// Client → Server
type ClientMessage = { type: "chat"; message: string };

// Server → Client
type ServerMessage =
    | { username: string; message: string; timestamp: string }   // chat
    | { type: "announcement"; message: string }
    | { type: "userList"; users: string[] };
```

A chat message is broadcast to every connected client. Messages that are
whitespace-only, longer than 250 characters, or not valid JSON are dropped
without closing the connection. Exceeding 20 messages in 10 seconds closes the
socket with code `1008`.

## Configuration

### Environment Variables

```env
# Database
DB_USER=postgres
DB_PASSWORD=your_password
DB_HOST=localhost
DB_PORT=5432
DB_NAME=websocket_chat

# Server
PORT=8080
NODE_ENV=development

# Auth (required — the server refuses to start without it)
JWT_SECRET=your-secret-key  # Generate with: openssl rand -hex 32

# CORS + WebSocket origin allowlist (required — comma-separated, no path)
ALLOWED_ORIGINS=http://localhost:5500

# Database TLS (optional — SSL is negotiated on demand, not forced)
# PGSSLMODE=require
# PGSSLROOTCERT=/path/to/ca.pem

# Monitoring (optional)
SENTRY_DSN=your-sentry-dsn
```

### Allowed Origins

There is **one** list, used for both CORS and the WebSocket handshake, and it
is configuration only — `ALLOWED_ORIGINS`, comma-separated:

```bash
ALLOWED_ORIGINS=http://localhost:5500,https://your-client.example.com
```

**There is no built-in default.** An earlier version shipped a previous
deployment's hostnames as defaults, which meant the first deploy after a
service was recreated checked origins that no longer existed and failed as an
unexplained 403. Leaving the variable unset now fails at boot with a message
naming it, instead of starting up and refusing every connection.

Each entry is validated at startup by `resolveOrigins()`:

- must parse as a URL, and use `http://` or `https://`. `localhost:5500`
  parses as scheme `localhost:`, so a missing scheme is caught explicitly;
- must be a bare origin — no path, query or fragment;
- is normalised to `parsed.origin`, so lowercasing, a trailing slash or a
  default port cannot cause a mismatch.

Matching is an exact string comparison against the `Origin` header, which is
why `ws://` and `wss://` are rejected: that header is always `http`/`https`,
even on a `wss` connection. Getting it wrong was the most common cause of a
403 on connect, and it now fails at boot instead.

This project previously kept two lists, `allowedOrigins` and
`wsAllowedOrigins`, and validated the handshake against the first while the
second sat unused. One list, one check.

### Development Scripts

```bash
npm run dev:hot        # Hot reload (TypeScript + Nodemon)
npm run dev:watch      # Watch TypeScript compilation only
npm run start:watch    # Watch and restart server only
npm run build          # Compile TypeScript to JavaScript
npm run start          # Run the compiled JavaScript server
```

## Security

### Security Features Overview

| Feature | Implementation | Purpose |
|---------|----------------|---------|
| Password Hashing | bcrypt (10 rounds) | Protect stored passwords |
| Timing-Equal Login | Dummy-hash compare | Response time does not reveal which usernames exist |
| Input Validation | Type-guarded predicates | Malformed bodies get a 400, not a 500 |
| XSS Prevention | `textContent` at the sink | No HTML is ever parsed from a message |
| Credential Transport | Single-use tickets | Keeps the JWT out of URLs and access logs |
| Rate Limiting | 200 req/hr, 20 tickets/min, 20 msg/10s | Prevent DoS/spam |
| Origin Validation | Single allowlist for CORS + handshake | Prevent unauthorized access |
| SQL Injection | Parameterized queries | Protect database |
| Token Invalidation | Database-backed sessions | Revoke on logout; one session per user |
| Dev-Only Routes | `/debug-sentry` gated on `NODE_ENV` | No public error-spam endpoint in production |

### Password Hashing

```typescript
// Registration - hash password
const saltRounds = 10;
const hashedPassword = await bcrypt.hash(password, saltRounds);

// Login - verify password
const match = await bcrypt.compare(password, user.password_hash);
```

**Why 10 salt rounds?** Takes ~100ms to hash, balancing security with UX.

### XSS Prevention

**Output encoding happens at the sink, not on the wire.** The client renders
every message with `textContent` / `document.createTextNode`, so HTML
metacharacters in a message are already inert at the point of display.

The server therefore does **not** HTML-encode messages. Doing both would
double-encode: the user who typed `<b>bold</b>` would see
`&lt;b&gt;bold&lt;/b&gt;` on screen.

The server's job is to strip control characters and bound the length:

```typescript
export function sanitize(str: string): string {
    return str
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/\r\n?/g, "\n")
        .trim();
}
```

### Input Validation

Validators accept `unknown` and narrow before reading `.length`. Request
bodies are attacker-controlled, so `username` may be missing, a number, or an
object — reading `.length` off those throws, and a malformed body must be a
`400`, not a `500`.

```typescript
export function isValidUsername(username: unknown): username is string {
    return (
        isBoundedString(username, LIMITS.username) &&
        /^[a-zA-Z0-9_]+$/.test(username)
    );
}

export function isValidPassword(password: unknown): password is string {
    return isBoundedString(password, LIMITS.password); // 6..128
}

export function isValidMessage(message: unknown): message is string {
    return isBoundedString(message, LIMITS.message); // 1..250
}
```

In the message handler, `sanitize()` runs **before** `isValidMessage()`,
because `sanitize()` trims — a whitespace-only message is empty by the time it
is validated, and would otherwise broadcast as an empty bubble.

### Rate Limiting

```typescript
// HTTP rate limiting (Express middleware)
const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 200,                  // 200 requests per hour
    message: 'Too many requests, please try again later'
});

// WebSocket message rate limiting
const MESSAGE_LIMIT = 20;
const TIME_WINDOW = 10000; // 10 seconds

ws.on("message", () => {
    ws.messageCount = (ws.messageCount || 0) + 1;
    if (ws.messageCount > MESSAGE_LIMIT) {
        ws.close(1008, "Rate limit exceeded");
    }
});
```

### SQL Injection Prevention

```typescript
// ❌ VULNERABLE
// const query = \`SELECT * FROM users WHERE username = '\${username}'\`;

// ✅ SAFE - parameterized queries
const query = 'SELECT * FROM users WHERE username = $1';
const result = await pool.query(query, [username]);
```

## Technical Deep Dive

### WebSocket vs HTTP

| Feature | HTTP Polling | WebSocket |
|---------|-------------|-----------|
| Connection | New per request | Persistent |
| Latency | High (polling interval) | Low (<50ms) |
| Server Load | High (constant requests) | Low |
| Bidirectional | No (client initiates) | Yes |
| Overhead | HTTP headers each time | Minimal frame headers |

```typescript
// WebSocket: Persistent bidirectional connection
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
    ws.on("message", (msg) => { /* handle */ });
    ws.send(JSON.stringify({ type: "announcement", message: "..." }));
});
```

### JWT Authentication Flow

```
┌──────────┐                          ┌──────────┐              ┌──────────┐
│  Client  │                          │  Server  │              │ Database │
└────┬─────┘                          └────┬─────┘              └────┬─────┘
     │  1. POST /login (user, password)     │                           │
     │────────────────────────────────────►│                           │
     │                                     │  2. Query user            │
     │                                     │──────────────────────────►│
     │                                     │  3. Return user + hash    │
     │                                     │◄──────────────────────────│
     │                                     │  4. bcrypt.compare()      │
     │                                     │  5. Sign JWT (jti, 1h)    │
     │                                     │  6. Upsert active_tokens  │
     │                                     │──────────────────────────►│
     │  7. Return { token }                 │                           │
     │◄────────────────────────────────────│                           │
     │                                     │                           │
     │  8. POST /ws-ticket                  │                           │
     │     Authorization: Bearer <jwt>      │                           │
     │────────────────────────────────────►│                           │
     │                                     │  9. Verify signature      │
     │                                     │ 10. Confirm session live  │
     │                                     │──────────────────────────►│
     │                                     │ 11. Issue ticket (10s)    │
     │  12. Return { ticket }               │                           │
     │◄────────────────────────────────────│                           │
     │                                     │                           │
     │  13. GET /?ticket=<ticket>  (upgrade) │                           │
     │────────────────────────────────────►│                           │
     │                                     │ 14. Check origin          │
     │                                     │ 15. Consume ticket        │
     │  16. Connection established          │  (in-memory, no DB)       │
     │◄───────────────────────────────────►│                           │
```

Steps 9–12 are where the security property comes from: the JWT travels in a
header, and only the short-lived ticket is ever exposed to a URL. Step 15 needs
no database round trip, which is why the upgrade handler is synchronous.

**Hybrid JWT approach**: tokens are stored in the database, so logout can
invalidate them, while verification stays cheap. Each login carries a unique
`jti` and supersedes the user's previous session.

| Pure JWT | Hybrid Approach |
|----------|-----------------|
| Cannot invalidate tokens | Can invalidate on logout |
| Stateless | Minimal state (one row per user) |
| Fast verification | One indexed lookup at login and at ticket exchange |
| Vulnerable if stolen | Token can be revoked; tickets expire in 10s |

### Graceful Shutdown

```typescript
async function gracefulShutdown(): Promise<void> {
    if (shuttingDown) return;            // SIGINT and SIGTERM can both arrive
    shuttingDown = true;

    // Force-exit if the graceful path wedges. Without it, a client holding a
    // socket open would keep the process alive until the platform's SIGKILL,
    // which is exactly what skips the flush and the drain below.
    setTimeout(() => {
        logger.error('Shutdown did not finish in time, exiting anyway');
        process.exit(1);
    }, 10_000).unref();

    await shutdown();                    // 1. terminate WS clients, close listener
    await Sentry.close(2000);            // 2. flush monitoring
    await pool.end();                    // 3. release the pool
    logger.info('Graceful shutdown complete.');
    process.exit(0);
}

process.on('SIGINT', () => void gracefulShutdown());
process.on('SIGTERM', () => void gracefulShutdown());
```

**The order is the whole bug.** `server.close()` resolves only once every
connection it is tracking has ended, and upgraded WebSocket sockets are still
counted by it. Awaiting it *before* terminating the clients therefore waits for
connections that only `shutdown()` can close — and `shutdown()` is never
reached. Nobody connected exited cleanly, which is how it went unnoticed; one
open chat hung the process until SIGKILL, silently skipping the Sentry flush
and the pool drain this function exists for. `shutdown.test.ts` starts the
real entrypoint, opens a chat, signals it the way a platform does, and fails
on either a hang or a non-zero exit.

### Real-time User Presence

```typescript
interface ChatWebSocket extends WebSocket {
    username?: string;
    isAlive?: boolean;
    messageCount?: number;
}

function getConnectedUsers(): string[] {
    const users: string[] = [];
    wss.clients.forEach((client: ChatWebSocket) => {
        if (client.readyState === WebSocket.OPEN && client.username) {
            if (!users.includes(client.username)) {
                users.push(client.username);
            }
        }
    });
    return users;
}

function broadcastUserlist() {
    const connectedUsers = getConnectedUsers();
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "userList", users: connectedUsers }));
        }
    });
}
```


## Deployment

### Docker Compose (Local)

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: websocket_chat
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data

  app:
    build: .
    depends_on: [postgres]
    environment:
      DB_HOST: postgres
      JWT_SECRET: \${JWT_SECRET}
    ports:
      - "8080:8080"

volumes:
  postgres_data:
```

```bash
docker-compose up -d
```

### Render (production)

`render.yaml` at the repo root is a Render Blueprint. It creates three
resources: the API/WebSocket service, the static client, and a Postgres
database.

The Blueprint is validated against Render's published schema in CI
(`npm run check:render`), so a file Render would reject fails on push rather
than partway through a deploy.

**Deploy:**

1. Push the branch.
2. In Render: **New +** → **Blueprint** → connect the repo → apply.
3. Set `ALLOWED_ORIGINS` on the server to the client's origin, e.g.
   `https://chat.ashusevim.dev` (comma-separate a second one, such as
   `https://websocket-chat-client.onrender.com`, if you serve both). Render
   marks it `sync: false`, so it will prompt you. **A wrong value here shows
   up as a 403 on connect, not a CORS error** — the WebSocket handshake checks
   the same list.
4. Deploy the client, then open its URL.

No manual migration step is needed. The server applies `schema.sql` at boot
(see [Schema management](#schema-management)), and the file ships inside the
image.

Two things to know about the free plan:

- **Instances sleep after ~15 minutes idle** and are restarted roughly monthly.
  The first request after a sleep takes 30–60 seconds while the instance wakes.
  The client's exponential-backoff reconnect handles the WebSocket side.
- **The database sleeps too** and can be unavailable for a minute after a long
  idle period. The server now refuses to start without a working database
  connection rather than serving 500s, so a cold start either succeeds or
  crash-loops visibly in the logs.

### Pointing the client at the API

Once the client and the API are on different hosts, tell the client where the
API is by editing one line in `client/config.js`:

```js
window.SERVER_HOST = 'socketchatapi.ashusevim.dev';   // no scheme, no trailing slash
```

The file exists so retargeting the client is a one-line change with no code
edit and no rebuild of anything else. It carries the *deployed* API's hostname:
a static site has no build step, so there is no environment variable to read.

**Local development ignores it.** `resolveServerHost()` in `client/api.js` only
honours `SERVER_HOST` when the page itself is not on localhost. Otherwise a
localhost session would send its traffic to production — and to an origin the
server's `ALLOWED_ORIGINS` refuses — so a local page talks to `localhost:8080`
instead. That rule lives in `api.js` rather than inline precisely so it can be
tested (`client/test/client.test.mjs`).

To aim a local page at a remote API, or override either host, use the query
parameter, which always wins:

```
https://chat.ashusevim.dev/?server=api.example.com
http://localhost:5500/?server=localhost:8081
```

### Schema management

`server/schema.sql` is idempotent and is applied on every boot:

- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so re-running is
  a no-op and concurrent starts are safe.
- The unique index `active_tokens_username_key` is **load-bearing** — the login
  upsert matches on it. Without it, logging in twice fails.
- Set `AUTO_MIGRATE=false` to manage the schema by hand instead.

This is deliberately not a migration framework. There is one schema file and no
versioned history yet; `node-pg-migrate` or Prisma becomes worth it at the
first change that must not re-run.

### Demo accounts

The sign-in screen shows two ready-made accounts, so a visitor can start
talking to somebody without registering:

| Username | Password |
|----------|----------|
| `demo`   | `demo1234` |
| `guest`  | `guest1234` |

`server/src/demo.ts` seeds them after the schema is applied, on every boot.
Three properties matter more than the accounts themselves:

- **Idempotent.** `INSERT ... ON CONFLICT (username) DO NOTHING`: the first
  boot on an empty database creates them, every boot after that is a no-op.
- **Never overwrites.** An upsert here would reset the password of whoever
  registered `demo` first — an account takeover triggered by a deploy. A name
  that is already taken is reported in the boot log and left untouched.
- **Checked before it is trusted.** The card is a claim about the database, so
  a name that was taken before the seeder ran and no longer accepts the
  published password logs a warning naming it, rather than leaving a card that
  silently cannot log in.

Each side is pinned by a test on the other end. `server/test/demo.test.ts`
fails if `DEMO_ACCOUNTS` stops passing the same validators `/register` and
`/login` use — the seeder does `INSERT`, which consults no validator, so a
short password would otherwise insert cleanly and then be rejected with a 400
at sign-in. `client/test/client.test.mjs` fails if the card stops matching
`DEMO_ACCOUNTS`, or if a row stops displaying the credentials it submits.

Nothing joins the two at runtime: a static site cannot read server source, and
an endpoint that hands out passwords would be a worse smell than the
duplicate. The values are published in the client by design — they gate no
privilege and are ordinary rows in `users`. If you delete them, delete the
card in `client/index.html` in the same change.

The sequence that makes the card trustworthy — schema, then seed, then port —
is pinned in the same file as a source gate: `server/src/index.ts` binds a real
process and so carries no other tests, and the ordering is a property of that
source rather than of anything observable from outside.

### Dockerfile

`server/Dockerfile`, verbatim:

```dockerfile
# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

# `test/` must be present: tsconfig.json has rootDir ".", so the compiler
# type-checks the whole project and fails if the test files are absent.
COPY tsconfig.json ./
COPY src ./src
COPY test ./test

RUN npx tsc

# Production stage
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# The schema is applied at boot (see src/db.ts). It must be in the final image,
# or a fresh managed database leaves the server with no tables and every write
# fails with a 500.
COPY schema.sql ./schema.sql

# Documentation only: the server reads PORT from the environment and defaults
# to 8080. Render injects PORT and routes traffic to whatever this listens on,
# so this value is not load-bearing.
EXPOSE 8080

USER node

CMD ["node", "dist/src/index.js"]
```

Three details worth knowing:

- The entrypoint is `dist/src/index.js`, not `dist/index.js`, because
  `tsconfig.json` sets `rootDir: "."` so that `test/` compiles alongside `src/`.
- `test/` is copied into the **build** stage for the type-check, but is not in
  the final image.
- `schema.sql` must be in the final image for the boot-time migration.

### Scaling Strategy

```
                    ┌─────────────────┐
                    │  Load Balancer  │
                    │ (Sticky Sessions)│
                    └────────┬────────┘
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │ Server 1 │        │ Server 2 │        │ Server 3 │
   └────┬─────┘        └────┬─────┘        └────┬─────┘
        └───────────────────┼───────────────────┘
                    ┌───────▼───────┐
                    │  Redis Pub/Sub │
                    └───────┬───────┘
                    ┌───────▼───────┐
                    │   PostgreSQL   │
                    │ (+ Read Replicas)│
                    └────────────────┘
```

**Key scaling changes:**
1. Redis Pub/Sub for cross-server message broadcasting
2. Sticky sessions or shared session store
3. Load balancer with WebSocket support (nginx)
4. Message queues (RabbitMQ/Kafka) for guaranteed delivery
5. Database read replicas for authentication queries

## Testing

```bash
cd server
npm test              # unit + integration (starts a throwaway Postgres)
npm run test:unit     # no database required
npm run test:db:down  # stop the throwaway container
npm run typecheck
```

**91 server tests + 68 client tests + 5 browser contrast tests.** Node's
built-in runner (`node --test`) — no test framework dependency.

| Suite | Tests | Covers |
|-------|-------|--------|
| `utils.test.ts` | 16 | Validation bounds, type guards, sanitizer |
| `tickets.test.ts` | 9 | Issue, consume, single-use, expiry, sweep |
| `origins.test.ts` | 20 | Allowlist parsing, normalisation, rejection |
| `demo.test.ts` | 3 | Published credentials clear the API's validators, boot order |
| `integration.test.ts` | 43 | Real HTTP + WebSocket against real Postgres |
| `shutdown.test.ts` | 1 | SIGTERM with a chat open still exits cleanly |
| `client/client.test.mjs` | 36 | Response bodies, failure wording, host rules, markup gates |
| `client/contrast.test.mjs` | 32 | Colour parsing, compositing, WCAG maths, thresholds, scoring, coverage |
| `client/browser/contrast-gate.test.mjs` | 5 | The gate end to end in real Chrome, positive and negative controls |

The client suite runs from the repo root and covers response-body handling,
host resolution, and source gates on the markup itself — the favicon link, that
`favicon.svg` still parses, and that no call site regressed (the defects that
suite exists for are all the kind where nothing else would fail):

```bash
npm run test:client    # fast, no browser
```

That suite also carries the colour maths the contrast gate depends on —
parsing every notation Chrome emits, source-over compositing, WCAG relative
luminance, the per-role floors, and the scoring that decides pass or fail — so
it is unit-tested like any other module, with no browser in the loop.

The gate itself does need one, and lives in its own command because five Chrome
runs are an order of magnitude slower than everything above:

```bash
npm run test:contrast  # pass, fail, uncovered, half-listed, control
```

It exists to prove the gate can fail. The shipped client must clear both
halves; a fixture with one deliberately unreadable pair must exit 1 naming that
pair; a fixture whose stylesheet declares a rule no element ever carries must
exit 1 naming the rule; and a fixture where only one member of a selector list
renders must do the same, because `matches('.a, .b')` answers for `.a` and
would otherwise wave `.b` through unmeasured. A fourth fixture exits 0, so the
three exits of 1 mean something. A check that could not fail would be worth
nothing, so most of these tests exist purely to make sure it can.

The integration tests mock nothing. They exercise the actual Express app, the
actual WebSocket upgrade, and a real database, because the behaviour under test
depends on things a mock cannot reproduce:

- the `409` on duplicate username comes from a real unique constraint;
- logout revocation depends on a real row delete;
- the handshake is a real HTTP upgrade, verified by asserting a replayed
  ticket is refused.

They build the server through the same `createChatServer()` factory the
production entrypoint uses, so the handshake policy under test is the policy
that ships.

A throwaway Postgres runs in Docker (`npm run test:db`). Point the suite
elsewhere with `TEST_DATABASE_URL`.

### Config gates

```bash
npm run check            # both gates, from the repo root
npm run check:contrast   # WCAG AA over every pair the rendered page produces
npm run check:render     # render.yaml against Render's published schema
```

`check:contrast` needs no list, because there is none to maintain. It serves
`client/`, opens it in Chrome, and drives the app through both themes, both
viewport widths, and every state the globals can reach — logged out, connected,
offline, drawer open, counter near and over the limit, hover, focus-visible.
Whatever ink lands on whatever background during that sweep is what gets
measured: text to 4.5:1, non-text and focus rings to 3:1, borders to a 1.2:1
visibility floor. Two SC 1.4.3 exceptions are reported in their own section
instead of being skipped, so an exemption is a visible decision rather than a
silent gap.

Measuring what happened is not enough on its own — a sweep that quietly failed
to reach a rule would produce a clean report. So the run also cross-checks
against the stylesheet: every rule declaring a colour-bearing property must
have matched a live element at some point, and any that did not is listed as
uncovered. A rule with a selector list (`.error-message, .success-message`)
counts only when *each* member matched: `matches()` answers for the whole list
as soon as any one member hits, so under the looser rule the error banner
alone satisfied it and deleting the step that shows the success banner would
have cost the gate nothing. Both checks must pass.

`check:render` exists because Render rejects a bad Blueprint at *deploy* time,
after the push, when the only feedback is a message in the dashboard. It
fetches [`render.com/schema/render.yaml.json`](https://render.com/schema/render.yaml.json)
and validates against it, so an unknown field fails in CI with a JSON path
instead of three minutes into a deploy.

It also carries a canary: after validating the real file, it injects
`type: db` under `databases` into a copy and asserts that this is *rejected*.
A validator that has never rejected anything proves nothing, so the gate
checks its own ability to fail.

### Regressions covered

Each of these was a real bug, and each has a test that fails without the fix:

- **Double-escaping** — the server HTML-encoded messages while the client
  rendered via `textContent`, so a user typing `<b>bold</b>` saw
  `&lt;b&gt;bold&lt;/b&gt;`.
- **Malformed bodies returned 500** — validators read `.length` off
  attacker-controlled values and threw a `TypeError`.
- **Double login returned 500** — two logins in the same second produced
  byte-identical JWTs, violating the unique constraint on `token`. Fixed with a
  `jti` claim plus an upsert.
- **`db.ts` forced SSL** — it enabled TLS whenever `DATABASE_URL` was set, so
  any plain-Postgres deployment failed with *"The server does not support SSL
  connections"*.
- **Dead origin allowlist** — `wsAllowedOrigins` sat next to `allowedOrigins`
  unused, while the handshake validated against the other one.
- **A previous deployment's hostnames as default origins** — `defaultOrigins`
  hardcoded old Render service URLs, so a deploy against recreated services
  checked origins that no longer existed and failed as an unexplained 403 on
  connect. The list is configuration only now: an unset `ALLOWED_ORIGINS` fails
  at boot naming the variable, and each entry is validated and normalised to
  what the browser will actually send. `origins.test.ts` covers all of it.
- **An empty 200 became the login error** — `Login` called `response.json()`
  with no guard, so a 2xx with an empty body threw `SyntaxError: Unexpected end
  of JSON input` and the catch rendered that parser message to the user. Fixed
  with `ChatAPI.readJSON`, plus a count gate: a single stray `.json()` on a
  success path reintroduces it silently, because nothing else fails.
- **The favicon rendered as a broken image** — `favicon.svg` carried a doubled
  hyphen inside an XML comment. Legal-looking, fatal: the parser rejects the
  whole document, and browsers report that as a missing image rather than a
  parse error, so nothing appeared in the console. The suite now parses the
  comment bodies, checks the icon link, and pins the tile colour to `--accent`.
- **The favicon was the wrong colour** — `index.html` declared the icon twice:
  `favicon.svg`, and further down a violet data-URI left over from the previous
  palette. Browsers honour the *last* link, so the stale one won; the test
  passed because it matched the *first*. It now counts the links instead of
  finding one, which is the whole difference between the two assertions.
- **A live chat wedged the shutdown** — `gracefulShutdown()` awaited
  `server.close()` before tearing down the WebSockets, but `close()` resolves
  only once every connection it tracks has ended and upgraded sockets are
  still counted by it. With nobody connected it exited cleanly, which is why
  it survived every prior test; with one chat open it waited for sockets only
  `shutdown()` could close, and `shutdown()` never ran. The process hung until
  SIGKILL, skipping the Sentry flush and the pool drain the function exists
  for. `shutdown.test.ts` starts the real entrypoint, opens a chat, signals it
  the way a platform does, and fails on a hang *or* on a non-zero exit — the
  10s deadline turns the hang into the latter.

Not every regression belongs in the server suite. **The Blueprint rejected on
deploy** — `render.yaml` declared `type: db` under `databases`, a key that does
not exist — is covered by `npm run check:render` instead, which validates the
file against Render's published schema. `node --test` cannot see a YAML file.

---

## Troubleshooting

**Can't connect to database?**
```bash
sudo systemctl status postgresql
psql -U postgres -d websocket_chat -c "SELECT 1;"
```

**WebSocket handshake fails?**

| Status | Cause | Fix |
|--------|-------|-----|
| 403 | Origin not allowlisted | Serve over HTTP, not `file://`; check `ALLOWED_ORIGINS` |
| 401 | Ticket missing/invalid/used | Fetch a fresh one from `/ws-ticket` — tickets are single-use and expire in 10s |

**"Session expired" in the UI?**
The JWT was rejected by `/ws-ticket` — it expired (1 hour) or the session was
revoked. Log in again.

**`The server does not support SSL connections`?**
Set `PGSSLMODE` only if your database actually requires TLS. SSL is negotiated
on demand, not forced.

**JWT_SECRET error?**
```bash
# Add to .env
JWT_SECRET=\$(openssl rand -hex 32)
```
The server refuses to start without it rather than running with unsigned tokens.

**Rate limit hit?**
- Wait 10 seconds (20 messages per 10 seconds limit)
- Client reconnects automatically


## Technologies

| Category | Technology | Why |
|----------|------------|-----|
| Runtime | Node.js | Event-driven, perfect for WebSockets |
| Language | TypeScript | Type safety, compile-time errors |
| Framework | Express 5 | Mature, middleware ecosystem |
| WebSocket | ws | Lightweight, no Socket.io overhead |
| Database | PostgreSQL | ACID compliance, reliable |
| Auth | JWT + bcrypt | Stateless tokens, secure hashing |
| Logging | Winston | Log levels, environment-aware |
| Monitoring | Sentry | Error tracking, alerting |
| Deployment | Docker + Render | Reproducible, scalable |

## Configuration Reference

| Setting | Value |
|---------|-------|
| Password hashing | bcrypt, 10 salt rounds |
| JWT expiry | 1 hour |
| Sessions per user | 1 (re-login supersedes) |
| Ticket TTL | 10 seconds, single use |
| Username length | 3–50, `[a-zA-Z0-9_]` |
| Password length | 6–128 |
| Message length | 1–250 characters |
| HTTP rate limit | 200 requests / hour / IP |
| Ticket rate limit | 20 requests / minute / IP |
| WebSocket rate limit | 20 messages / 10 seconds / connection |
| WebSocket max payload | 8 KB |

Latency and memory figures are deliberately omitted — they need to be measured
against a real deployment, not asserted.

### Checklist

- ✅ Health check endpoint
- ✅ Graceful shutdown
- ✅ Environment-based config
- ✅ Multi-stage Docker image, runs as non-root
- ✅ Idempotent schema (`server/schema.sql`)
- ✅ CORS configuration
- ✅ Rate limiting
- ✅ Error monitoring (Sentry), debug route disabled in production
- ✅ Structured logging (Winston)
- ✅ 91 unit + integration tests, 36 client tests

### Known Gaps

Stated plainly, because knowing these is part of the design:

- **Tickets live in process memory.** They are lost on restart and are not
  shared between instances, so the server does not currently scale horizontally
  without sticky sessions. Redis would fix both.
- **Expired tokens are never swept.** `active_tokens` relies on the one-session-
  per-user upsert to stay small, so it does not grow without bound, but there is
  no scheduled cleanup of rows older than the JWT lifetime.
- **No message persistence.** Chat is broadcast only; a message is gone once
  delivered. There is no history to load on reconnect.
- **The demo card is only checked at boot.** `server/src/demo.ts` seeds the
  rows and `client/index.html` prints them, but nothing compares the two when
  the page is served. The seeder runs before `listen()`, so on a fresh
  database the card is true from the first request; what no request can catch
  is a row changed afterwards — a manually replaced hash, or a password-change
  feature added later — where the boot log's warning naming the account is the
  only signal. An endpoint serving the current state would close it, at the
  cost of an API that returns passwords.
- **No refresh tokens.** A 1-hour expiry means re-login; the `jti` and ticket
  plumbing would extend to refresh tokens without structural change.

---

## License

MIT
