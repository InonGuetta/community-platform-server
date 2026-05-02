import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
