import "./instrument.js";
import * as Sentry from "@sentry/node";
import pool, { applySchema } from "./db.js";
import logger from "./logger.js";
import { createChatServer, resolveOrigins } from "./app.js";
import { seedDemoAccounts } from "./demo.js";

/**
 * Process entrypoint.
 *
 * All wiring lives in app.ts so it can be constructed and torn down in tests.
 * This file only owns concerns that genuinely belong to a running process:
 * verifying the database, binding a port, and shutting down cleanly.
 */

const port = Number(process.env.PORT ?? 8080);
const secret = process.env.JWT_SECRET;

if (!secret) {
    logger.error(
        "JWT_SECRET is not set. Generate one with: openssl rand -hex 32",
    );
    process.exit(1);
}

// Checked here rather than left to throw inside createChatServer, so a missing
// or malformed allowlist reads as one line in the deploy log instead of a stack
// trace. resolveOrigins throws on purpose: an empty allowlist would refuse
// every connection while still passing the health check.
try {
    logger.info(`Origin allowlist: ${resolveOrigins(process.env).join(", ")}`);
} catch (error) {
    logger.error(error instanceof Error ? error.message : error);
    process.exit(1);
}

const { server, shutdown } = createChatServer({ jwtSecret: secret });

/**
 * Verifies the database and applies the schema before accepting traffic.
 *
 * Without this the server would bind the port, pass the health check, and then
 * return 500 for every request that touches the database. Failing here instead
 * means a misconfigured DATABASE_URL surfaces as a crash loop in the deploy
 * log, which is far easier to diagnose.
 */
async function start(): Promise<void> {
    try {
        await pool.query("SELECT 1");
        logger.info("Database connection established");
    } catch (error) {
        logger.error(
            "Cannot reach the database. Check DATABASE_URL and that the " +
            "database allows connections from this service.",
        );
        logger.error(
            "Underlying error:",
            error instanceof Error ? error.message : error,
        );
        process.exit(1);
    }

    try {
        await applySchema();
        logger.info("Database schema verified");
    } catch (error) {
        logger.error("Failed to apply the database schema:", error);
        process.exit(1);
    }

    // The sign-in screen prints two demo accounts, so the database has to
    // actually contain them. Fails the same way as the schema above: a seeder
    // that half-ran would leave the card advertising credentials that do not
    // work, which is a worse first impression than a deploy log that names the
    // error.
    try {
        const report = await seedDemoAccounts(pool);

        if (report.created.length > 0) {
            logger.info(`Demo accounts created: ${report.created.join(", ")}`);
        }
        if (report.verified.length > 0) {
            logger.info(`Demo accounts already present: ${report.verified.join(", ")}`);
        }
        if (report.taken.length > 0) {
            logger.warn(
                `Demo account name(s) already registered by someone else: ${report.taken.join(", ")}. ` +
                "The rows were left untouched, so the credentials shown on the sign-in " +
                "screen will not match them.",
            );
        }
    } catch (error) {
        logger.error("Failed to seed the demo accounts:", error);
        process.exit(1);
    }

    server.listen(port, () => {
        logger.info(`Server listening on port ${port}`);
    });
}

void start();

let shuttingDown = false;

/**
 * How long the graceful path gets before the process exits anyway.
 *
 * A deadline rather than an open-ended wait: a client that holds a socket open
 * would otherwise keep the process alive until the platform's SIGKILL, which is
 * exactly what skips the Sentry flush and the pool drain below — the two things
 * this function exists to do.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;

async function gracefulShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutdown signal received, starting graceful shutdown...');

    const deadline = setTimeout(() => {
        logger.error(
            `Shutdown did not finish within ${SHUTDOWN_DEADLINE_MS}ms, exiting anyway`,
        );
        process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    // unref so the timer never holds the event loop open on its own.
    deadline.unref();

    // 1. Tear down the WebSocket clients and stop the listener, as one step.
    //
    //    These must not be split. `server.close()` resolves only once every
    //    connection it is tracking has ended, and the upgraded sockets are
    //    still counted by it — so awaiting `server.close()` *before*
    //    terminating the clients waits for connections that only shutdown()
    //    can close, and shutdown() is never reached. One live chat deadlocked
    //    the process until SIGKILL; shutdown() owns the sequence, and the
    //    entrypoint does not reorder it.
    await shutdown();
    logger.info('HTTP and WebSocket server closed');

    // 2. Flush buffered Sentry events before the process goes away, so a
    //    crash on shutdown is not silently dropped.
    try {
        await Sentry.close(2000);
        logger.info('Sentry flushed');
    } catch (err) {
        logger.error('Error during Sentry close: ', err);
    }

    // 3. Release database connections.
    await pool.end();
    logger.info('Database pool closed');

    logger.info('Graceful shutdown complete.');
    process.exit(0);
}

process.on('SIGINT', () => void gracefulShutdown());
process.on('SIGTERM', () => void gracefulShutdown());

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection: ', reason);
});
