-- Database schema for the flash-reservation engine.
-- Postgres is the durable source of truth for SOLD seats. It is written only by the async
-- persist workers (never by API routes). UNIQUE(event_id, unit_id) is the final guard against
-- a seat ever being sold twice, even if every other layer failed.
-- This file runs automatically on the FIRST start of the postgres container (docker-entrypoint-initdb.d)
-- and is also applied (idempotently) by `npm run reset`.

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  booking_id UUID NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  unit_id INT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (event_id, unit_id)
);

-- Stream entries that could never be persisted (e.g. a second booking for an already-sold seat).
-- This must stay empty; the persist worker logs loudly whenever it writes here.
CREATE TABLE IF NOT EXISTS dead_letters (
  id SERIAL PRIMARY KEY,
  payload JSONB NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
