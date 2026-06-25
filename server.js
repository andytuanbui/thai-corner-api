/**
 * server.js — Thai Corner API
 *
 * Hanterar takeaway-beställningar och bordsbokningar från Telavox AI Receptionist,
 * och exponerar ett REST-API för personal-dashboarden.
 *
 * Endpoints:
 *   POST /api/order          — Ny takeaway-beställning (Telavox anropar denna)
 *   POST /api/booking         — Ny bordsbokning (Telavox anropar denna)
 *   GET  /api/active-orders   — Aktiva ordrar (dashboard polling)
 *   GET  /api/history         — Klargjorda ordrar (dashboard historik)
 *   POST /api/resolve/:id     — Markera order som klar (personal klickar i dashboard)
 *   GET  /api/health          — Hälsokontroll
 *
 * Utöka senare:
 *   - Trivec-integration: lägg till anrop i /api/order-handlern (se TODO-kommentar)
 *   - WebSockets: ersätt polling med socket.io för direktnotifieringar
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
}));

// Svara omedelbart på OPTIONS preflight
app.options('*', (req, res) => res.status(200).end());

app.use(express.json({ limit: '50kb' }));

// ─────────────────────────────────────────────
// Request-loggning
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] ${req.method} ${req.url}`);

  const safeHeaders = { ...req.headers };
  if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = '***MASKERAD***';
  console.log('Headers:', JSON.stringify(safeHeaders, null, 2));

  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    console.log('Body: (tom — troligen verifieringsanrop)');
  }

  next();
});

// ─────────────────────────────────────────────
// Auth-middleware
// ─────────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!API_KEY) {
    console.warn('⚠️  Ingen API_KEY konfigurerad — öppen åtkomst');
    return next();
  }
  const provided = req.headers['x-api-key'] || req.query.key;
  if (provided === API_KEY) return next();

  console.log('🔒 Auth misslyckades');
  return res.status(401).json({
    error: 'Unauthorized',
    hint: 'Skicka rätt API-nyckel i X-API-Key headern',
  });
}

// ─────────────────────────────────────────────
// Statiska filer (dashboard)
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Thai Corner API', time: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// Telavox verifieringsroutes (GET på POST-endpoints)
// ─────────────────────────────────────────────
app.get('/api/order',   (req, res) => res.json({ status: 'ok', endpoint: 'POST /api/order',   service: 'Thai Corner API' }));
app.get('/api/booking', (req, res) => res.json({ status: 'ok', endpoint: 'POST /api/booking', service: 'Thai Corner API' }));

// ─────────────────────────────────────────────
// POST /api/order — Takeaway-beställning
// ─────────────────────────────────────────────
app.post('/api/order', requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const { phone, items, order_summary } = body;

    // Tom body = verifieringsanrop från Telavox
    if (!phone && !items && !order_summary) {
      console.log('📋 Tom body — verifieringsanrop, svarar OK');
      return res.status(200).json({
        status: 'ok',
        message: 'Endpoint aktiv och redo att ta emot beställningar',
        service: 'Thai Corner API',
      });
    }

    const id = uuidv4();
    const createdAt = new Date().toISOString();

    await db.insertOrder({
      id,
      type: 'takeaway',
      phone: phone || null,
      items: items ? JSON.stringify(items) : null,
      order_summary: order_summary || null,
      guests: null,
      date_time: null,
      name: null,
      notes: null,
      status: 'active',
      created_at: createdAt,
    });

    console.log(`✅ Takeaway sparad: ${id} | Telefon: ${phone || 'okänd'}`);

    // TODO: Trivec-integration
    // await trivec.createOrder({ id, phone, items, order_summary, createdAt });

    res.status(200).json({
      success: true,
      message: 'Beställningen har tagits emot och visas nu för personalen. Tack för din beställning!',
      order_id: id,
      created_at: createdAt,
    });
  } catch (err) {
    console.error('Fel i /api/order:', err.message);
    res.status(500).json({ error: 'Kunde inte spara beställningen', details: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/booking — Bordsbokning
// ─────────────────────────────────────────────
app.post('/api/booking', requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const { date_time, name, phone, notes } = body;
   const guests = body.guests != null ? (parseInt(body.guests, 10) || null) : null;

    if (!name && !date_time) {
      console.log('📋 Tom body — verifieringsanrop, svarar OK');
      return res.status(200).json({
        status: 'ok',
        message: 'Endpoint aktiv och redo att ta emot bokningar',
        service: 'Thai Corner API',
      });
    }

    if (!name)      return res.status(400).json({ error: 'Fältet "name" saknas' });
    if (!date_time) return res.status(400).json({ error: 'Fältet "date_time" saknas' });

    const id = uuidv4();
    const createdAt = new Date().toISOString();

    await db.insertOrder({
      id,
      type: 'booking',
      phone: phone || null,
      items: null,
      order_summary: null,
      guests: guests || null,
      date_time,
      name,
      notes: notes || null,
      status: 'active',
      created_at: createdAt,
    });

    console.log(`✅ Bokning sparad: ${id} | ${name} | ${guests} gäster | ${date_time}`);

    const guestStr = guests ? ` (${guests} gäster)` : '';
    res.status(200).json({
      success: true,
      message: `Bordsbokingen för ${name}${guestStr} den ${date_time} är bekräftad. Välkommen till Thai Corner!`,
      booking_id: id,
      created_at: createdAt,
    });
  } catch (err) {
    console.error('Fel i /api/booking:', err.message);
    res.status(500).json({ error: 'Kunde inte spara bokningen', details: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/current-time
// ─────────────────────────────────────────────
app.get('/api/current-time', requireApiKey, (req, res) => {
  const TZ = 'Europe/Stockholm';
  const now = new Date();

  // Tid i Stockholm
  const fmt = (opts) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, ...opts }).format(now);

  const hour   = parseInt(fmt({ hour: 'numeric', hour12: false }), 10);
  const minute = parseInt(fmt({ minute: 'numeric' }), 10);
  const dowNum = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now) === 'Sun' ? 0
               : ['Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(
                   new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now)
                 ) + 1, 10);

  const weekdays = ['söndag','måndag','tisdag','onsdag','torsdag','fredag','lördag'];
  const weekday  = weekdays[dowNum];

  // Öppettider per veckodag (0=sön, 1=mån, ..., 6=lör)
  const hours = {
    0: { opens: '11:30', closes: '21:00' }, // söndag
    1: { opens: '11:30', closes: '21:00' }, // måndag
    2: { opens: '11:30', closes: '21:00' }, // tisdag
    3: { opens: '11:30', closes: '21:00' }, // onsdag
    4: { opens: '11:30', closes: '21:00' }, // torsdag
    5: { opens: '11:30', closes: '22:00' }, // fredag
    6: { opens: '11:30', closes: '22:00' }, // lördag
  };

  const { opens, closes } = hours[dowNum];
  const [oH, oM] = opens.split(':').map(Number);
  const [cH, cM] = closes.split(':').map(Number);
  const nowMins   = hour * 60 + minute;
  const is_open   = nowMins >= oH * 60 + oM && nowMins < cH * 60 + cM;

  const timeStr = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
  const isoStr  = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'shortOffset',
  }).format(now).replace(' ', 'T').replace(' ', '');

  res.json({
    current_datetime: isoStr,
    weekday,
    time: timeStr,
    is_open,
    opens_at: opens,
    closes_at: closes,
  });
});

// ─────────────────────────────────────────────
// GET /api/active-orders-summary
// ─────────────────────────────────────────────
app.get('/api/active-orders-summary', requireApiKey, async (req, res) => {
  try {
    const summary = await db.getActiveOrdersSummary();
    res.json(summary);
  } catch (err) {
    console.error('Fel i /api/active-orders-summary:', err.message);
    res.status(500).json({ error: 'Kunde inte hämta sammanfattning' });
  }
});

// ─────────────────────────────────────────────
// GET /api/active-orders
// ─────────────────────────────────────────────
app.get('/api/active-orders', requireApiKey, async (req, res) => {
  try {
    const orders = await db.getActiveOrders();
    res.json(orders);
  } catch (err) {
    console.error('Fel i /api/active-orders:', err.message);
    res.status(500).json({ error: 'Kunde inte hämta ordrar' });
  }
});

// ─────────────────────────────────────────────
// GET /api/history
// ─────────────────────────────────────────────
app.get('/api/history', requireApiKey, async (req, res) => {
  try {
    const orders = await db.getHistory();
    res.json(orders);
  } catch (err) {
    console.error('Fel i /api/history:', err.message);
    res.status(500).json({ error: 'Kunde inte hämta historik' });
  }
});

// ─────────────────────────────────────────────
// POST /api/resolve/:id
// ─────────────────────────────────────────────
app.post('/api/resolve/:id', requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const resolved = await db.resolveOrder(id);

    if (!resolved) {
      return res.status(404).json({ error: `Hittade ingen aktiv order med id: ${id}` });
    }

    console.log(`✅ Order klargjord: ${id}`);
    res.json({ success: true, message: 'Order markerad som klar.' });
  } catch (err) {
    console.error('Fel i /api/resolve:', err.message);
    res.status(500).json({ error: 'Kunde inte uppdatera ordern' });
  }
});

// ─────────────────────────────────────────────
// Felhantering
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Oväntat fel:', err);
  res.status(500).json({ error: 'Internt serverfel', details: err.message });
});

// ─────────────────────────────────────────────
// Starta server — initiera databas först
// ─────────────────────────────────────────────
async function start() {
  try {
    await db.initDb();
    app.listen(PORT, () => {
      console.log(`\n🍜  Thai Corner API startat`);
      console.log(`📡  Port: ${PORT}`);
      console.log(`🌐  Dashboard: http://localhost:${PORT}`);
      console.log(`🔑  API-nyckel: ${API_KEY ? '***konfigurerad***' : '⚠️  EJ SATT — öppen åtkomst'}`);
      console.log('');
    });
  } catch (err) {
    console.error('❌  Serverstart misslyckades:', err.message);
    process.exit(1);
  }
}

start();
