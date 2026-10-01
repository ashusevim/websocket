import * as Sentry from "@sentry/node";
import dotenv from "dotenv";

import logger from "./logger.js";

dotenv.config();

const dsn = process.env.SENTRY_DSN;

/**
 * Sentry is entirely optional.
 *
 * The profiling integration is loaded lazily via dynamic import, and only when
 * a DSN is actually configured. Importing it unconditionally crashed the
 * process on any machine without its native binding built — even with no
 * Sentry configured at all, because the top-level import ran regardless.
 */
if (dsn) {
    const isProduction = process.env.NODE_ENV === "production";

    // Profiling is a nice-to-have; a missing or incompatible native binding
    // must never stop the server from starting.
    let profilingIntegration;
    try {
        const { nodeProfilingIntegration } = await import(
            "@sentry/profiling-node"
        );
        profilingIntegration = nodeProfilingIntegration();
    } catch (error) {
        logger.warn(
            "Sentry profiling unavailable, continuing without it:",
            error instanceof Error ? error.message : error,
        );
    }

    Sentry.init({
        dsn,
        environment: process.env.NODE_ENV ?? "development",
        sendDefaultPii: true,
        integrations: profilingIntegration ? [profilingIntegration] : [],
        tracesSampleRate: isProduction ? 0.1 : 1.0,
        profilesSampleRate: isProduction ? 0.1 : 1.0,
        enableLogs: true,
    });

    logger.info("Sentry monitoring enabled");
} else {
    logger.warn(
        "SENTRY_DSN not set. Sentry monitoring is disabled. This is expected in development.",
    );
}
