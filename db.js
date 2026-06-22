/**
 * db.js — Databashantering med PostgreSQL (Neon)
 *
 * Ansluter via DATABASE_URL (connection string från Neon-dashboarden).
 * SSL aktiveras automatiskt när DATABASE_URL är satt — krävs av Neon.
 *
 * Samma interface som SQLite-versionen, men alla funktioner är async.
 * server.js awaitar alla anrop — inget annat behöver ändras om du
 * vill byta databas igen längre fram.
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌  DATABASE_URL saknas i .env — servern kan inte starta utan databaskoppling.');
  process.exit(1);
}

// ─────────────────────────────────────────────
// Connection pool
// SSL med rejectUnauthorized: false krävs för Neon och de flesta
// hanterade Postgres-tjänster (deras cert valideras mot systemets CA-store).
// ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,              // Max anslutningar i poolen
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('❌  Postgres pool-fel:', err.message);
});

// ─────────────────────────────────────────────
// Schema
// Körs en gång vid serverstart — skapar tabellen om den inte finns.
// Neon behåller schemat över omstarter.
// ─────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id            TEXT    PRIMARY KEY,
      type          TEXT    NOT NULL,          -- 'takeaway' | 'booking'
      phone         TEXT,
      items         TEXT,                      -- JSON: [{name, num, note}]
      order_summary TEXT,                      -- Fri text (Telavox-format)
      guests        INTEGER,
      date_time     TEXT,
      name          TEXT,
      notes         TEXT,
      status        TEXT    NOT NULL DEFAULT 'active',  -- 'active' | 'resolved'
      created_at    TEXT    NOT NULL,
      resolved_at   TEXT
    )
  `);
  console.log('✅  Databas: schema OK');
}

// ─────────────────────────────────────────────
// Exporterade funktioner
// ─────────────────────────────────────────────

/**
 * Spara en order eller bokning.
 */
async function insertOrder(order) {
  await pool.query(`
    INSERT INTO orders
      (id, type, phone, items, order_summary, guests, date_time, name, notes, status, created_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
    order.id,
    order.type,
    order.phone       ?? null,
    order.items       ?? null,
    order.order_summary ?? null,
    order.guests      ?? null,
    order.date_time   ?? null,
    order.name        ?? null,
    order.notes       ?? null,
    order.status,
    order.created_at,
  ]);
}

/**
 * Hämta aktiva ordrar, nyaste först.
 */
async function getActiveOrders() {
  const { rows } = await pool.query(`
    SELECT * FROM orders
    WHERE status = 'active'
    ORDER BY created_at DESC
  `);
  return rows.map(parseRow);
}

/**
 * Hämta historik (klargjorda), nyaste först.
 */
async function getHistory() {
  const { rows } = await pool.query(`
    SELECT * FROM orders
    WHERE status = 'resolved'
    ORDER BY resolved_at DESC
    LIMIT 100
  `);
  return rows.map(parseRow);
}

/**
 * Markera en order som klargjord.
 * @returns {boolean} true om ordern hittades och uppdaterades
 */
async function resolveOrder(id) {
  const { rowCount } = await pool.query(`
    UPDATE orders
    SET status = 'resolved', resolved_at = $1
    WHERE id = $2 AND status = 'active'
  `, [new Date().toISOString(), id]);
  return rowCount > 0;
}

/**
 * Parsar items-kolumnen från JSON-sträng till objekt.
 */
function parseRow(row) {
  return {
    ...row,
    items: row.items ? JSON.parse(row.items) : null,
  };
}

module.exports = { initDb, insertOrder, getActiveOrders, getHistory, resolveOrder };
