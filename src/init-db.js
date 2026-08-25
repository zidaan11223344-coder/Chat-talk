require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required. Add Railway PostgreSQL before running db:init.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'true' || connectionString.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
});

async function main() {
  const schemaPath = path.join(__dirname, '..', 'drizzle', 'schema.sql');
  const schema = await fs.readFile(schemaPath, 'utf8');
  await pool.query(schema);
  console.log('Chat Buzz database is ready.');
}

main()
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
