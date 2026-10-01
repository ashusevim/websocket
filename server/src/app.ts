import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import crypto from "node:crypto";
import RateLimit from "express-rate-limit";
import { URL } from "node:url";
import bcrypt from "bcrypt";
import pool from "./db.js";
import cors from "cors";
import jwt from "jsonwebtoken";
import * as Sentry from "@sentry/node";
import logger from "./logger.js";
import express from "express";
import { sanitize } from "./utils/sanitize.js";
import { issueTicket, consumeTicket } from "./utils/tickets.js";
import {
    isValidUsername,
    isValidPassword,
    isValidMessage,
} from "./utils/validation.js";

/** Chat connection rate limit: 20 messages per 10 seconds. */
const MESSAGE_RATE_LIMIT = 20;
const MESSAGE_RATE_LIMIT_INTERVAL_MS = 10 * 1000;

export interface ChatWebSocket extends WebSocket {
    username?: string;
}

/** The upgrade request, tagged with the identity from the consumed ticket. */
interface AuthenticatedRequest {
    username: string;
}

/**
 * Resolves the allowed-origin list.
 *
 * Single source of truth for both CORS and the WebSocket handshake. These used
 * to be two hand-maintained arrays that drifted apart: the handshake checked
 * `allowedOrigins` while `wsAllowedOrigins` sat beside it, unused, under a
 * comment claiming it was in use. One list, one check.
 *
 * There is deliberately no default list. A previous deployment's hostnames in
 * source go stale the moment the service is recreated, and an allowlist that
 * silently contains the wrong origins fails as an unexplained 403 rather than
 * as a startup error. The list is configuration or it does not exist.
 *
 * @throws when no usable origin is configured, or when one is not an absolute
 *         http(s) origin. Both are startup bugs, so both fail here rather than
 *         at the first connection attempt.
 */
export function resolveOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
    const configured = env.ALLOWED_ORIGINS ?? "";
    const entries = configured
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

    if (entries.length === 0) {
        throw new Error(
            "ALLOWED_ORIGINS is not set, so there is no origin allowlist and " +
            "every cross-origin request and WebSocket upgrade would be refused. " +
            "Set it to the client's exact origin, for local development " +
            "ALLOWED_ORIGINS=http://localhost:5500",
        );
    }

    const origins: string[] = [];
    for (const entry of entries) {
        let parsed: URL;
        try {
            parsed = new URL(entry);
        } catch {
            throw new Error(
                `ALLOWED_ORIGINS entry "${entry}" is not a URL. Expected an ` +
                "absolute origin such as https://chat.example.com",
            );
        }

        // The Origin header a browser sends is http/https with no path. A
        // ws:// or wss:// value can never match it, and "localhost:5500" parses
        // as scheme "localhost:" rather than failing — so both are startup
        // errors here rather than a 403 later that looks like a CORS problem.
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error(
                `ALLOWED_ORIGINS entry "${entry}" must be an absolute http:// or ` +
                `https:// origin; its scheme parsed as "${parsed.protocol}". The ` +
                "Origin header stays http/https even for a wss:// connection, so " +
                "ws:// and wss:// values can never match.",
            );
        }

        // A path, query or fragment can never appear in an Origin header.
        if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
            throw new Error(
                `ALLOWED_ORIGINS entry "${entry}" must be a bare origin with no ` +
                `path, query or fragment. Use "${parsed.origin}".`,
            );
        }

        // Normalise to what the browser will actually send: lowercased scheme
        // and host, no default port, no trailing slash. Comparisons are exact
        // string matches, so storing the canonical form removes a whole class
        // of "it looks right but never matches".
        origins.push(parsed.origin);
    }

    return [...new Set(origins)];
}

export interface AppOptions {
    /** Injected so tests can supply a throwaway secret. */
    jwtSecret?: string;
    /** Overrides process.env, for tests. */
    env?: NodeJS.ProcessEnv;
    /**
     * Lifts the request caps.
     *
     * The limiters are real and correctly enforced in production — the ticket
     * limiter allows 20 requests/minute per IP — but an integration suite
     * legitimately makes more than 20 ticket calls, so from one test onward
     * every request would 429 and the suite would fail for the wrong reason.
     * Raising the ceiling in tests exercises the same code path without
     * weakening the deployed limits.
     */
    rateLimitMax?: number;
}

export interface CreatedApp {
    app: express.Express;
    wss: WebSocketServer;
    close: () => Promise<void>;
    /**
     * Clears rate-limit hit counters.
     *
     * Provided for tests that need to drop accumulated hits between cases.
     * Note the limiters key by client IP, so this only resets the bucket for
     * the key given; passing "*" is not a wildcard.
     */
    resetRateLimits: (clientKey: string) => void;
}

/**
 * Builds the Express app and attaches the WebSocket server.
 *
 * This is a factory rather than a module-level singleton so tests can create an
 * isolated instance (own rate-limit buckets, own ticket store) and shut it
 * down afterwards, instead of spawning a process and racing a fixed port.
 */
export function createApp(options: AppOptions = {}): CreatedApp {
    const env = options.env ?? process.env;
    const secret = options.jwtSecret ?? env.JWT_SECRET;
    const rateLimitMax = options.rateLimitMax;
    const allowedOrigins = resolveOrigins(env);

    const isOriginAllowed = (origin: string | undefined): boolean =>
        origin !== undefined && allowedOrigins.includes(origin);

    // Held as named consts so their stores can be reset between tests.
    const apiLimiter = RateLimit({
        max: rateLimitMax ?? 200,
        windowMs: 60 * 60 * 1000,
        message: "Too many requests from this IP address",
    });

    // This endpoint mints credentials, so it gets a much tighter budget than
    // the general limiter.
    const ticketLimiter = RateLimit({
        max: rateLimitMax ?? 20,
        windowMs: 60 * 1000,
        message: "Too many ticket requests from this IP address",
    });

    const app = express();

    app.use(cors({
        origin: allowedOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    }));

    app.use(express.json());
    app.use(apiLimiter);

    app.post("/register", async (req, res) => {
        try {
            const { username, password } = req.body ?? {};

            if (!isValidUsername(username) || !isValidPassword(password)) {
                return res.status(400).json({
                    message:
                        "Username must be 3-50 characters (letters, digits, underscore) and password at least 6 characters.",
                });
            }

            const password_hash = await bcrypt.hash(password, 10);

            const newUser = await pool.query(
                "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING username",
                [username, password_hash],
            );

            res.status(201).json({
                message: "User created successfully",
                username: newUser.rows[0].username,
            });
        } catch (error) {
            // 23505 = unique_violation.
            if (error instanceof Error && "code" in error && error.code === "23505") {
                return res.status(409).json({ message: "Username already exists" });
            }

            logger.error("Registration error:", {
                message: error instanceof Error ? error.message : error,
                stack: error instanceof Error ? error.stack : undefined,
            });
            res.status(500).json({ message: "Internal server error" });
        }
    });

    app.post("/login", async (req, res) => {
        const { username, password } = req.body ?? {};

        if (!isValidUsername(username) || !isValidPassword(password)) {
            return res
                .status(400)
                .json({ message: "username and password are required" });
        }

        try {
            const user = await pool.query(
                "SELECT password_hash from users WHERE username = $1",
                [username],
            );

            // Compare a dummy hash when the user is absent so that a missing
            // username and a wrong password take the same time. Without this,
            // response latency leaks which usernames exist.
            const hash = user.rows[0]?.password_hash ?? DUMMY_HASH;
            const isValid = await bcrypt.compare(password, hash);

            if (user.rows.length === 0 || !isValid) {
                return res.status(401).json({ message: "Invalid username or password" });
            }

            if (!secret) {
                logger.error("JWT_SECRET is not defined");
                return res.status(500).json({ message: "Internal server error" });
            }

            // A `jti` claim is required for correctness here, not decoration.
            // Without it, two logins by the same user inside the same second
            // produce byte-identical JWTs (same payload, same iat, same exp),
            // so the second INSERT into active_tokens violates the UNIQUE
            // constraint on `token` and the login fails with a 500.
            const jti = crypto.randomUUID();

            const token = jwt.sign({ username, jti }, secret, { expiresIn: '1h' });

            // Upsert rather than plain INSERT: a re-login replaces the previous
            // session for that user instead of accumulating rows, and cannot
            // fail on a constraint violation.
            await pool.query(
                `INSERT INTO active_tokens (token, username) VALUES ($1, $2)
                 ON CONFLICT (username) DO UPDATE
                    SET token = EXCLUDED.token, created_at = CURRENT_TIMESTAMP`,
                [token, username],
            );

            res.json({ token, username });
        } catch (error) {
            logger.error("Login error: ", error);
            res.status(500).json({ message: "Internal server error" });
        }
    });

    app.post('/logout', async (req, res) => {
        try {
            const { token } = req.body ?? {};

            if (!token) {
                return res.status(400).json({ message: "Token not found" });
            }

            const deleted = await pool.query(
                'DELETE FROM active_tokens WHERE token=$1',
                [token],
            );

            if (deleted.rowCount === 0) {
                return res.status(401).json({ message: "Invalid token" });
            }

            return res.status(200).json({ message: "User logout successfully" });
        } catch (err) {
            logger.error("Logout error: ", err);
            return res.status(500).json({ message: "Internal server error" });
        }
    });

    /**
     * Exchanges a valid JWT for a short-lived, single-use WebSocket ticket.
     *
     * The JWT arrives in an Authorization header rather than a URL, so it is
     * never written to access logs, proxies or browser history. The ticket is
     * what goes in the WebSocket URL: worthless if leaked, because it expires
     * in seconds and is destroyed on first use.
     */
    app.post("/ws-ticket", ticketLimiter, async (req, res) => {
        const auth = req.headers.authorization;
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;

        if (!token) {
            return res.status(401).json({ message: "Authorization token missing" });
        }

        if (!secret) {
            logger.error("JWT_SECRET is not defined");
            return res.status(500).json({ message: "Internal server error" });
        }

        const payload = await new Promise<jwt.JwtPayload | undefined>((resolve) => {
            jwt.verify(token, secret, (error, decoded) => {
                if (error) {
                    logger.warn(`Ticket request rejected: ${error.message}`);
                    return resolve(undefined);
                }
                resolve(
                    typeof decoded === "object" && decoded !== null ? decoded : undefined,
                );
            });
        });

        if (!payload) {
            return res.status(401).json({ message: "Invalid or expired token" });
        }

        try {
            // The active_tokens lookup is what makes logout invalidate a JWT
            // that has not yet expired.
            const active = await pool.query(
                "SELECT username FROM active_tokens WHERE token = $1",
                [token],
            );

            if (active.rows.length === 0) {
                return res.status(401).json({ message: "Session revoked" });
            }

            const { ticket } = issueTicket(active.rows[0].username);
            res.json({ ticket });
        } catch (error) {
            logger.error("Ticket issuance error: ", error);
            res.status(500).json({ message: "Internal server error" });
        }
    });

    app.get('/health', (req, res) => {
        res.status(200).json({ status: 'ok', timeStamp: new Date().toISOString() });
    })

    /**
     * Verifies the Sentry pipeline end to end.
     *
     * Development only. In production the route is never registered: a public
     * endpoint whose only job is to throw is a free error-spam machine against
     * your own Sentry quota, and an unauthenticated 500 generator.
     */
    if (env.NODE_ENV !== "production") {
        app.get('/debug-sentry', (req, res) => {
            throw new Error('Sentry test error!')
        })
    }

    Sentry.setupExpressErrorHandler(app)

    app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
        logger.error('Unhandled error: ', err);
        res.status(500).json({ message: 'Internal server error' });
    })

    const wss = new WebSocketServer({
        noServer: true,
        /**
         * Purely synchronous: the ticket was already validated against the
         * in-memory store when it was issued, so there is no database round trip
         * on the upgrade path. The previous version awaited `jwt.verify` and a
         * Postgres query here, holding up the event loop mid-handshake.
         */
        verifyClient: (info, done) => {
            if (!isOriginAllowed(info.origin)) {
                logger.warn(`Connection from origin "${info.origin}" rejected`);
                return done(false, 403, "Forbidden");
            }

            if (!info.req.url) {
                logger.warn("Connection rejected: missing URL");
                return done(false, 400, "Bad Request");
            }

            const { searchParams } = new URL(
                info.req.url,
                `http://${info.req.headers.host}`,
            );

            // Note the absence of `token` here by design. See utils/tickets.ts.
            const username = consumeTicket(searchParams.get("ticket") ?? undefined);

            if (!username) {
                logger.warn("Connection rejected: invalid, expired or reused ticket");
                return done(false, 401, "Unauthorized");
            }

            (info.req as unknown as AuthenticatedRequest).username = username;
            done(true);
        },
        maxPayload: 8 * 1024,
    });

    const getConnectedUsers = (): string[] => {
        const users: string[] = [];
        wss.clients.forEach((client: ChatWebSocket) => {
            if (client.readyState === WebSocket.OPEN && client.username) {
                if (!users.includes(client.username)) users.push(client.username);
            }
        });
        return users;
    };

    const broadcastUserlist = (): void => {
        const payload = JSON.stringify({
            type: "userList",
            users: getConnectedUsers(),
        });

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) client.send(payload);
        });
    };

    wss.on("connection", (ws: ChatWebSocket, req) => {
        ws.username = (req as unknown as AuthenticatedRequest).username;
        logger.info(`Client connected: ${ws.username}`);

        let messageCounter = 0;
        const rateLimitTimer = setInterval(() => {
            messageCounter = 0;
        }, MESSAGE_RATE_LIMIT_INTERVAL_MS);

        const announcement = {
            type: "announcement",
            message: `${ws.username || "unknown"} has joined the chat room`,
        };

        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(announcement));
            }
        });

        broadcastUserlist();

        ws.on("message", (message) => {
            messageCounter++;
            if (messageCounter > MESSAGE_RATE_LIMIT) {
                logger.warn(`Rate limit exceeded for ${ws.username}, disconnecting`);
                ws.close(1008, "You are sending messages too frequently");
                return;
            }

            try {
                const parsed = JSON.parse(message.toString());

                if (parsed.type === "chat") {
                    // Sanitize first, then validate: sanitize() trims, so a
                    // whitespace-only message is empty by the time it is
                    // checked. Validating the raw input would let "   " through.
                    const text = sanitize(String(parsed.message ?? ""));

                    if (!isValidMessage(text)) {
                        logger.warn(`Invalid message received from ${ws.username}`);
                        return;
                    }

                    const chatMessage = {
                        username: ws.username,
                        message: text,
                        timestamp: new Date().toLocaleTimeString(),
                    };

                    const payload = JSON.stringify(chatMessage);
                    wss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) client.send(payload);
                    });
                }
            } catch (error) {
                logger.error("Error parsing message: ", error);
            }
        });

        ws.on("close", () => {
            clearInterval(rateLimitTimer);
            logger.info(`Client disconnected: ${ws.username}`);
            setTimeout(broadcastUserlist, 100);
        });
    });

    const close = async (): Promise<void> => {
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
    };

    return {
        app,
        wss,
        close,
        resetRateLimits: (clientKey: string) => {
            apiLimiter.resetKey(clientKey);
            ticketLimiter.resetKey(clientKey);
        },
    };
}

/**
 * A real bcrypt hash of a value nobody can log in with.
 *
 * Compared against when the username does not exist, to keep the timing of a
 * failed login constant. See the comment at its use site.
 */
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

/** Attaches the WebSocket upgrade handler. Called once the HTTP server exists. */
export function attachWebSocket(
    server: Server,
    wss: WebSocketServer,
): void {
    server.on("upgrade", (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit("connection", ws, request);
        });
    });
}

export interface ChatServer extends CreatedApp {
    server: Server;
    /** Port once listening, or undefined before. */
    port: number | undefined;
    listen: (port?: number) => Promise<number>;
    /** Closes sockets, the WS server and the HTTP listener. */
    shutdown: () => Promise<void>;
}

/**
 * Builds the full stack — Express, the WebSocket server and an HTTP listener
 * with the upgrade handler attached.
 *
 * The production entrypoint and the integration tests both go through here, so
 * the handshake policy that ships is the policy under test. Tests that
 * reimplemented `verifyClient` would be testing their own copy, not the app's.
 */
export function createChatServer(options: AppOptions = {}): ChatServer {
    const { app, wss, close, resetRateLimits } = createApp(options);
    const server = createServer(app);
    attachWebSocket(server, wss);

    return {
        app,
        wss,
        server,
        close,
        resetRateLimits,
        get port() {
            const address = server.address();
            return address && typeof address === "object" ? address.port : undefined;
        },
        listen(listenPort = 0) {
            return new Promise<number>((resolve, reject) => {
                server.once("error", reject);
                server.listen(listenPort, () => {
                    const address = server.address() as { port: number };
                    resolve(address.port);
                });
            });
        },
        async shutdown() {
            for (const client of wss.clients) client.terminate();
            await close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
