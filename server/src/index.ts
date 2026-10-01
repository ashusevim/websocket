import "./instrument.js";
import * as Sentry from "@sentry/node";
import pool, { applySchema } from "./db.js";
import logger from "./logger.js";
import { createChatServer } from "./app.js";

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

    server.listen(port, () => {
        logger.info(`Server listening on port ${port}`);
    });
}

void start();

let shuttingDown = false;

async function gracefulShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutdown signal received, starting graceful shutdown...');

    // 1. Stop accepting new connections.
    await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info('HTTP server closed');

    // 2. Tear down live WebSocket connections and the HTTP listener.
    await shutdown();
    logger.info('WebSocket server closed');

    // 3. Flush buffered Sentry events before the process goes away, so a
    //    crash on shutdown is not silently dropped.
    try {
        await Sentry.close(2000);
        logger.info('Sentry flushed');
    } catch (err) {
        logger.error('Error during Sentry close: ', err);
    }

    // 4. Release database connections.
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
