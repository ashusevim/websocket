import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

// Use DATABASE_URL for Supabase (recommended)
const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    })
    : new Pool({
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || "5432"),
        database: process.env.DB_NAME || "postgres",
        ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    });

export default pool;