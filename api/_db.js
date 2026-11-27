import { neon } from '@neondatabase/serverless';

let schemaReady;
export function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return neon(process.env.DATABASE_URL);
}

export async function prepareDatabase(sql) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS employees (
        id text PRIMARY KEY,
        first_name text NOT NULL,
        last_name text NOT NULL,
        telegram_id text NOT NULL,
        access_hash text NOT NULL UNIQUE,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS employees_telegram_unique ON employees (telegram_id) WHERE active = true`;
      await sql`CREATE TABLE IF NOT EXISTS registration_invites (
        id text PRIMARY KEY,
        token_hash text NOT NULL UNIQUE,
        token_encrypted text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`ALTER TABLE registration_invites ADD COLUMN IF NOT EXISTS token_encrypted text`;
      await sql`CREATE TABLE IF NOT EXISTS points (
        id text PRIMARY KEY,
        name text NOT NULL,
        address text NOT NULL DEFAULT '',
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS point_days (
        point_id text NOT NULL REFERENCES points(id),
        work_date date NOT NULL,
        is_open boolean NOT NULL DEFAULT true,
        opens_at time NOT NULL DEFAULT '10:00',
        closes_at time NOT NULL DEFAULT '22:00',
        required_count integer NOT NULL DEFAULT 1 CHECK (required_count >= 0),
        PRIMARY KEY (point_id, work_date)
      )`;
      await sql`CREATE TABLE IF NOT EXISTS availability (
        employee_id text NOT NULL REFERENCES employees(id),
        work_date date NOT NULL,
        available_from time NOT NULL,
        available_to time NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (employee_id, work_date),
        CHECK (available_from < available_to)
      )`;
      await sql`CREATE TABLE IF NOT EXISTS shifts (
        id text PRIMARY KEY,
        work_date date NOT NULL,
        point_id text NOT NULL REFERENCES points(id),
        employee_id text REFERENCES employees(id),
        starts_at time NOT NULL,
        ends_at time NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (starts_at < ends_at)
      )`;
    })().catch((error) => { schemaReady = undefined; throw error; });
  }
  return schemaReady;
}

