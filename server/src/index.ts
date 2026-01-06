import "./instrument.js";
import { WebSocketServer, WebSocket } from "ws";
import RateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { URL } from "url";
import bcrypt from "bcrypt";
import pool from "./db.js";
import cors from "cors";
import jwt from "jsonwebtoken"
import * as Sentry from "@sentry/node"
import logger from "./logger.js";
import express from "express";
import { sanitize } from "./utils/sanitize.js";
import { isValidUsername, isValidPassword, isValidMessage } from "./utils/validation.js";
dotenv.config();

const app = express();

// Configure CORS properly
const allowedOrigins = [
    "http://127.0.0.1:5500",
    "http://localhost:8080",
    "http://localhost:5500",
    "https://websocket-chat-client-ptfw.onrender.com",
    "https://websocket-chat-server-ptfw.onrender.com",
];

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

const limiter = RateLimit({
    max: 200,
    windowMs: 60 * 60 * 1000,
    message: "Too many request from this IP address",
});

app.use(express.json());
app.use(limiter);

const port = process.env.PORT || 8080;
const secret = process.env.JWT_SECRET;

const rateLimit = 20;
const rateLimitInterval = 10 * 1000

interface ChatWebSocket extends WebSocket {
    username?: string;
}

const server = app.listen(port, () => {
    logger.info(`Server is running on the localhost port: ${port} `)
});

// Update the allowedOrigins array for WebSocket
const wsAllowedOrigins = [
    "http://127.0.0.1:5500",
    "http://localhost:8080",
    "http://localhost:5500",
    "https://websocket-chat-client-ptfw.onrender.com",
    "wss://websocket-chat-server-ptfw.onrender.com",
    "https://websocket-chat-server-ptfw.onrender.com"
];

function getConnectedUsers(): string[] {
    const users: string[] = [];
    wss.clients.forEach((client: ChatWebSocket) => {
        if (client.readyState === WebSocket.OPEN && client.username)
            if(!users.includes(client.username)){
                users.push(client.username);
            }
    });
    return users;
}

//helper function to broadcast list of users to all the connected users(clients)
function broadcastUserlist() {
    const connectedUsers = getConnectedUsers();
    const userListMessage = {
        type: "userList",
        users: connectedUsers,
    };

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN)
            client.send(JSON.stringify(userListMessage));
    });
}

const wss = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
        const origin = info.origin;

        // check if the origin is in our allowedOrigns list
        if (!allowedOrigins.includes(origin)) {
            logger.error(`Connection to origin: ${origin} rejected`)
            return done(false);
        }

        if (!info.req.url) {
            logger.error('Connection request error: missing URL')
            return done(false);
        }

        const fullUrl = new URL(info.req.url, `http://${info.req.headers.host}`);
        const token = fullUrl.searchParams.get("token");

        if (!token) {
            logger.error('Connection rejected: Token not found in URL');
            return done(false)
        }

        if (!secret) {
            logger.error("server error: JWT Token is not defined")
            return done(false)
        }

        jwt.verify(token, secret, (error: jwt.VerifyErrors | null, decoded: string | jwt.JwtPayload | undefined) => {
            if (error) {
                logger.error("Token verification error", error.message)
                return done(false)
            }

            pool
                .query("SELECT * from active_tokens WHERE token= $1", [token])
                .then((result) => {
                    if (result.rows.length == 0) {
                        done(false);
                    } else {
                        (info.req as any).username = result.rows[0].username;
                        done(true);
                    }
                })
                .catch((error) => {
                    logger.error("Token verification error: ", error);
                    done(false);
                });
        })
    },
    //because the typical size of the chat message is less than 1024 kilobytes(1 kb)
    maxPayload: 1024,
});

app.post("/register", async (req, res) => {
    try {
        if (!req.body || typeof req.body !== "object") {
            return res.status(400).json({
                message: "Invalid request body",
            });
        }
        const { username, password } = req.body;

        if (!isValidUsername(username) || !isValidPassword(password)) {
            return res.status(400).json({
                message:
                    "Username and a password of at least 6 characters are required.",
            });
        }

        const saltRounds = 10;
        const password_hash = await bcrypt.hash(password, saltRounds);

        const newUser = await pool.query(
            "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING username",
            [username, password_hash],
        );

        res.status(201).json({
            message: "User created successfully",
            username: newUser.rows[0].username,
        });
    } catch (error) {
        // checking for a duplicate username
        if (error instanceof Error && "code" in error && error.code === "23505") {
            return res.status(409).json({
                message: "Username already exists",
            });
        }

        // Add more detailed logging
        logger.error("Registration error details:", {
            message: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined,
            code: error instanceof Error && "code" in error ? error.code : undefined
        });
        res.status(500).json({ message: "Internal server error" });
    }
});

app.post("/login", async (req, res) => {
    const { username, password } = req.body;

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
        if (user.rows.length === 0) {
            return res.status(401).json({ message: "Invalid username or password" });
        }

        const isValid = await bcrypt.compare(password, user.rows[0].password_hash);

        if (!isValid) {
            return res.status(401).json({ message: "Invalid username or password" });
        }

        if (!secret) {
            console.error("JWT_SECRET is not defined");
            return res.status(500).json({ message: "Internal server error" });
        }

        const token = jwt.sign({ username }, secret, { expiresIn: '1h' });

        await pool.query(
            "INSERT INTO active_tokens (token, username) VALUES ($1, $2)",
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
        const { token } = req.body;

        if (!token) {
            return res
                .status(400)
                .json({ message: "Token not found" })
        }

        const deletedUser = await pool.query('DELETE FROM active_tokens WHERE token=$1', [token])

        if (deletedUser.rowCount === 0) {
            return res.status(401).json({ message: "Invalid token" });
        }

        return res.status(200).json({
            message: "User logout successfully"
        })
    } catch (err) {
        logger.error("Logout error: ", err)
        return res.status(500).json({
            message: "Internal server error"
        })
    }
})

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timeStamp: new Date().toISOString() });
})

app.get('/debug-sentry', (req, res) => {
    throw new Error('Sentry test error!')
})

Sentry.setupExpressErrorHandler(app)

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error('Unhandled error: ', err);
    res.status(500).json({ message: 'Internal server error' });
})

wss.on("connection", (ws: ChatWebSocket, req) => {
    logger.info("New client has been connected!!");
    // when the new client connects
    ws.username = (req as any).username;

    let messageCounter = 0;
    const rateLimitTimer = setInterval(() => {
        messageCounter = 0
    }, rateLimitInterval)

    const announcement = {
        type: "announcement",
        message: `${ws.username || "unknown"} has joined the chat room`,
    };

    wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === ws.OPEN) {
            client.send(JSON.stringify(announcement));
        }
    });

    // sending broadcase message to all the connected users/clients
    broadcastUserlist();

    // listening for messages from specific client
    ws.on("message", (message) => {
        logger.debug(`Received message: ${message}`);
        messageCounter++;
        if (messageCounter > rateLimit) {
            logger.warn(`Rate limit exceded for ${ws.username}, disconnecting`)
            ws.close(1008, "You are sending messages too frequently")
            return;
        }
        try {
            const messageObject = JSON.parse(message.toString());
            if (messageObject.type === "chat") {
                if (!isValidMessage(messageObject.message)) { 
                    logger.warn(`Invalid message received from ${ws.username}`)
                    return;
                }
                const chatMessage = {
                    username: ws.username,
                    message: sanitize(messageObject.message),
                    timestamp: new Date().toLocaleTimeString(),
                };

                wss.clients.forEach((client) => {
                    if (client.readyState === ws.OPEN) {
                        client.send(JSON.stringify(chatMessage));
                    }
                });
            }
        } catch (error) {
            logger.error("Error Parsing JSON: ", error);
        }
    });

    // handling client disconnecting
    ws.on("close", () => {
        logger.info("Client has disconneted");

        // clean up the interval for memory leaks
        clearInterval(rateLimitTimer);

        setTimeout(() => {
            broadcastUserlist();
        }, 100);
    });
});

async function gracefulShutdown() {
    logger.info('Shutdown signal received, starting gracefull shutdown.....')

    // 1. stopping http server from receiving new connections
    server.close((err) => {
        if (err) {
            logger.error('Error during HTTP server shutdown: ', err)
            process.exit(1)
        }

        logger.info('HTTP server closed')

        // 2. closing the websocket server
        wss.close()
        logger.info('Websocket server ended')

        // 3. Flush Sentry events before closing DB
        Sentry.close(2000).then(() => {  // Wait up to 2 seconds for Sentry to flush
            // 4. closing the database connection
            pool.end(() => {
                logger.info('Database pool closed')

                // 5. exit the process clearly
                logger.info('Graceful shutdown complete.')
                process.exit(0)
            })
        }).catch((err) => {
            logger.error('Error during Sentry close: ', err)
            pool.end(() => {
                logger.info('Database pool closed despite Sentry error')
                process.exit(1)
            })
        })
    })
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)