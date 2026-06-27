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
      type          TEXT    NOT NULL,
      phone         TEXT,
      items         TEXT,
      order_summary TEXT,
      guests        TEXT,
      date_time     TEXT,
      name          TEXT,
      notes         TEXT,
      status        TEXT    NOT NULL DEFAULT 'active',
      created_at    TEXT    NOT NULL,
      resolved_at   TEXT,
      updated_at    TEXT,
      was_modified  BOOLEAN NOT NULL DEFAULT false
    )
  `);
  // Lägg till kolumner om de saknas (för befintliga databaser)
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at        TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS was_modified      BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS previous_summary  TEXT`);
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
 * Hämtar senaste aktiva ordern för ett telefonnummer.
 */
async function getActiveOrderByPhone(phone) {
  const normalized = phone.startsWith('00') ? '+' + phone.slice(2) : phone;
  const { rows } = await pool.query(`
    SELECT * FROM orders
    WHERE phone IN ($1, $2) AND type = 'takeaway' AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  `, [normalized, phone]);
  return rows.length ? parseRow(rows[0]) : null;
}

/**
 * Hämtar senaste ordern för ett telefonnummer oavsett status (active eller resolved).
 * Används av PATCH-by-phone för att kunna återaktivera en redan klarmarkerad order.
 */
async function getLatestOrderByPhone(phone) {
  const normalized = phone.startsWith('00') ? '+' + phone.slice(2) : phone;
  const { rows } = await pool.query(`
    SELECT * FROM orders
    WHERE phone IN ($1, $2) AND type = 'takeaway'
    ORDER BY created_at DESC
    LIMIT 1
  `, [normalized, phone]);
  return rows.length ? parseRow(rows[0]) : null;
}

/**
 * Uppdaterar en befintlig order (items, order_summary, notes, date_time).
 */
async function updateOrder(id, updates) {
  const now = new Date().toISOString();
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.items !== undefined)            { fields.push(`items = $${idx++}`);            values.push(JSON.stringify(updates.items)); }
  if (updates.order_summary !== undefined)   { fields.push(`order_summary = $${idx++}`);   values.push(updates.order_summary); }
  if (updates.previous_summary !== undefined){ fields.push(`previous_summary = $${idx++}`); values.push(updates.previous_summary); }
  if (updates.notes !== undefined)           { fields.push(`notes = $${idx++}`);            values.push(updates.notes); }
  if (updates.date_time !== undefined)       { fields.push(`date_time = $${idx++}`);        values.push(updates.date_time); }

  if (fields.length === 0) return false;

  fields.push(`updated_at = $${idx++}`);   values.push(now);
  fields.push(`was_modified = $${idx++}`); values.push(true);

  // Återaktivera om ordern är resolved
  if (updates.reactivate) {
    fields.push(`status = $${idx++}`);      values.push('active');
    fields.push(`resolved_at = $${idx++}`); values.push(null);
  }

  values.push(id);

  const { rowCount } = await pool.query(
    `UPDATE orders SET ${fields.join(', ')} WHERE id = $${idx}`,
    values
  );
  return rowCount > 0;
}

/**
 * Sammanfattning för aktiva takeaway-ordrar.
 * Returnerar { total_active, sushi_active }.
 */
async function getActiveOrdersSummary() {
  const { rows } = await pool.query(`
    SELECT items, order_summary FROM orders
    WHERE status = 'active' AND type = 'takeaway'
  `);

  const total_active = rows.length;

  const sushiKeywords = /sushi|roll|nigiri|maki/i;

  const sushi_active = rows.filter(row => {
    // Kolla items-arrayen (strukturerad data)
    if (row.items) {
      try {
        const items = JSON.parse(row.items);
        if (items.some(item => {
          const numMatch = item.num && Number(item.num) >= 26 && Number(item.num) <= 71;
          const nameMatch = item.name && sushiKeywords.test(item.name);
          return numMatch || nameMatch;
        })) return true;
      } catch (_) {}
    }
    // Kolla fritext (order_summary)
    if (row.order_summary && sushiKeywords.test(row.order_summary)) return true;
    return false;
  }).length;

  return { total_active, sushi_active };
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

module.exports = { initDb, insertOrder, getActiveOrders, getHistory, resolveOrder, getActiveOrdersSummary, getActiveOrderByPhone, getLatestOrderByPhone, updateOrder };
