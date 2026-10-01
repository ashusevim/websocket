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
- **Tests**: 63 unit and integration tests, no mocking of the database or the
  HTTP/WS stack
- **Monitoring**: Winston (JSON in production), Sentry error tracking
- **Modern UI**: responsive dark/light theme, connection status, user list
- **Graceful Shutdown**: closes sockets, flushes Sentry, then drains the pool
- **Production Ready**: multi-stage Docker image (non-root), health check,
  idempotent schema, Render deploy config

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
EOF

# 3. Install & run server
npm ci
npm run dev:hot

# 4. Serve client (new terminal)
npx serve client -l 5500

# 5. Open http://localhost:5500
```

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
│   │   ├── logger.ts         # Winston (JSON in production, colour in dev)
│   │   ├── instrument.ts     # Sentry setup
│   │   └── utils/
│   │       ├── tickets.ts    # Single-use WebSocket tickets
│   │       ├── validation.ts # Input validation (type-guarded → 400)
│   │       └── sanitize.ts   # Control-char stripping + trim
│   ├── test/
│   │   ├── utils.test.ts       # Unit: validation + sanitize
│   │   ├── tickets.test.ts     # Unit: ticket issue/consume/expiry
│   │   └── integration.test.ts # Real HTTP + WS against real Postgres
│   ├── scripts/
│   │   ├── test-db.mjs         # Throwaway Postgres for tests
│   │   └── run-integration.mjs # Test runner wrapper
│   ├── schema.sql           # Idempotent schema
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── client/
│   ├── index.html            # Chat UI with login/register
│   └── styles.css
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

# CORS + WebSocket origin allowlist (optional, comma-separated)
ALLOWED_ORIGINS=http://localhost:5500,https://your-client.example.com

# Database TLS (optional — SSL is negotiated on demand, not forced)
# PGSSLMODE=require
# PGSSLROOTCERT=/path/to/ca.pem

# Monitoring (optional)
SENTRY_DSN=your-sentry-dsn
```

### Allowed Origins

There is **one** list, used for both CORS and the WebSocket handshake. It lives
in `server/src/app.ts` and is overridable per environment:

```bash
ALLOWED_ORIGINS=https://your-client.example.com,https://staging.example.com
```

Without the variable, the built-in defaults in `app.ts` apply.

Values are matched against the `Origin` header exactly, so they must be
scheme-qualified origins (`https://host`, not `host`) and must **not** include
`ws://` or `wss://` — the `Origin` header on a WebSocket handshake is always
`http`/`https`, even for a `wss` connection. Getting this wrong is the most
common cause of a 403 on connect.

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
async function gracefulShutdown() {
    logger.info('Received shutdown signal...');
    
    server.close((err) => {           // 1. Stop accepting HTTP
        wss.close(() => {              // 2. Close WebSocket server
            Sentry.close(2000).then(() => {  // 3. Flush monitoring
                pool.end(() => {        // 4. Close database
                    process.exit(0);    // 5. Exit cleanly
                });
            });
        });
    });
    
    setTimeout(() => process.exit(1), 10000); // Force exit timeout
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
```

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

### Render.yaml (Production)

```yaml
services:
  - type: web
    name: websocket-chat-server
    env: docker
    dockerfilePath: ./server/Dockerfile
    healthCheckPath: /health
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: websocket-chat-db
          property: connectionString
      - key: JWT_SECRET
        generateValue: true
      - key: NODE_ENV
        value: production

  - type: web
    name: websocket-chat-client
    env: static
    staticPublishPath: ./client

databases:
  - name: websocket-chat-db
    plan: free
```

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

# Documentation only: the server reads PORT from the environment and defaults
# to 8080. Render sets PORT=10000 and routes traffic to whatever this listens
# on, so this value is not load-bearing.
EXPOSE 8080

USER node

CMD ["node", "dist/src/index.js"]
```

Two details worth knowing:

- The entrypoint is `dist/src/index.js`, not `dist/index.js`, because
  `tsconfig.json` sets `rootDir: "."` so that `test/` compiles alongside `src/`.
- `test/` is copied into the build stage for that reason. The tests are not
  shipped in the final image; they are only needed for the type-check.

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

**63 tests.** Node's built-in runner (`node --test`) — no test framework
dependency.

| Suite | Tests | Covers |
|-------|-------|--------|
| `utils.test.ts` | 16 | Validation bounds, type guards, sanitizer |
| `tickets.test.ts` | 9 | Issue, consume, single-use, expiry, sweep |
| `integration.test.ts` | 38 | Real HTTP + WebSocket against real Postgres |

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
- ✅ 63 unit + integration tests (`npm test`)

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
- **No CI.** `npm test` must be run by hand. The suite is self-contained
  (`npm run test:db` starts its own Postgres), so wiring it to a runner is
  configuration, not code.
- **No refresh tokens.** A 1-hour expiry means re-login; the `jti` and ticket
  plumbing would extend to refresh tokens without structural change.

---

## License

MIT
