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
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
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
// Personal på jobb — jour-endpoints
// GET  /api/on-duty    → hämta aktuellt jour-nummer
// POST /api/on-duty    → sätt jour-nummer
// DELETE /api/on-duty  → ta bort jour-nummer
// ─────────────────────────────────────────────
app.get('/api/on-duty', requireApiKey, async (req, res) => {
  try {
    const duty = await db.getOnDuty();
    res.json(duty);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/on-duty', requireApiKey, async (req, res) => {
  try {
    const { phone, name } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone krävs' });
    await db.setOnDuty(phone, name ?? null);
    console.log(`👤 Jour satt: ${name ?? '(namnlös)'} — ${phone}`);
    res.json({ success: true, phone, name: name ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/on-duty', requireApiKey, async (req, res) => {
  try {
    await db.deleteOnDuty();
    console.log('👤 Jour borttagen');
    res.json({ success: true, phone: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
// TEST-LÄGE: tvinga restaurangen att verka öppen
// ─────────────────────────────────────────────
let forceOpen = false;

app.post('/api/force-open', requireApiKey, (req, res) => {
  forceOpen = req.body?.enabled === true;
  console.log(`🧪 Test-läge: forceOpen = ${forceOpen}`);
  res.json({ force_open: forceOpen });
});

app.get('/api/force-open', requireApiKey, (req, res) => {
  res.json({ force_open: forceOpen });
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
    0: { opens: '11:30', closes: '22:00' }, // söndag
    1: { opens: '11:30', closes: '22:00' }, // måndag
    2: { opens: '11:30', closes: '22:00' }, // tisdag
    3: { opens: '11:30', closes: '22:00' }, // onsdag
    4: { opens: '11:30', closes: '22:00' }, // torsdag
    5: { opens: '11:30', closes: '23:00' }, // fredag
    6: { opens: '11:30', closes: '23:00' }, // lördag
  };

  const { opens, closes } = hours[dowNum];
  const [oH, oM] = opens.split(':').map(Number);
  const [cH, cM] = closes.split(':').map(Number);
  const nowMins   = hour * 60 + minute;
  const is_open_real    = nowMins >= oH * 60 + oM && nowMins < cH * 60 + cM;
  const is_open         = forceOpen ? true : is_open_real;
  const next_open_today = !is_open && nowMins < oH * 60 + oM;
  const status          = is_open ? 'open' : next_open_today ? 'before_opening' : 'closed_for_day';

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
    next_open_today,
    status,
    opens_at: opens,
    closes_at: closes,
  });
});

// ─────────────────────────────────────────────
// GET /api/order-by-phone/:phone
// ─────────────────────────────────────────────
app.get('/api/order-by-phone/:phone', requireApiKey, async (req, res) => {
  try {
    const order = await db.getActiveOrderByPhone(req.params.phone);
    if (!order) return res.status(404).json({ found: false, message: 'Ingen aktiv order hittades för detta nummer' });
    res.json({ found: true, order });
  } catch (err) {
    console.error('Fel i /api/order-by-phone:', err.message);
    res.status(500).json({ error: 'Kunde inte hämta order' });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/order-by-phone/:phone — Ändra order via telefonnummer
// Telavox använder {{system__caller_id}} direkt — inget order_id behövs
// ─────────────────────────────────────────────
app.patch('/api/order-by-phone/:phone', requireApiKey, async (req, res) => {
  try {
    const phone = req.params.phone;
    const { order_summary, notes, date_time } = req.body || {};

    if (!order_summary && !notes && !date_time) {
      return res.status(400).json({ error: 'Inga fält att uppdatera' });
    }

    // Hitta senaste ordern oavsett status (active eller resolved)
    const order = await db.getLatestOrderByPhone(phone);
    if (!order) {
      console.warn(`⚠️  PATCH by-phone: ingen order hittad för ${phone}`);
      return res.status(404).json({
        found: false,
        message: 'Ingen order hittades för detta telefonnummer',
      });
    }

    const wasResolved = order.status === 'resolved';
    console.log(`✏️  PATCH order-by-phone/${phone} → order ${order.id} (${order.status}) — body:`, JSON.stringify(req.body));

    // Spara gamla order_summary som previous_summary (om den inte redan är satt)
    const previous_summary = order.previous_summary || order.order_summary || null;
    const updated = await db.updateOrder(order.id, {
      order_summary, notes, date_time, previous_summary,
      reactivate: wasResolved,   // återaktivera om den låg i historiken
    });
    if (!updated) {
      return res.status(500).json({ error: 'Kunde inte uppdatera ordern' });
    }

    if (wasResolved) {
      console.log(`🔄 Order återaktiverad från historik: ${order.id}`);
    }

    console.log(`✅ Order uppdaterad via telefon: ${order.id}`);
    res.json({
      success: true,
      message: 'Ordern har uppdaterats.',
      order_id:         order.id,
      created_at:       order.created_at,
      previous_summary: previous_summary,
      order_summary:    order_summary ?? order.order_summary,
    });
  } catch (err) {
    console.error('Fel i PATCH /api/order-by-phone:', err.message);
    res.status(500).json({ error: 'Kunde inte uppdatera ordern', details: err.message });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/order/:id
// ─────────────────────────────────────────────
app.patch('/api/order/:id', requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { items, notes, date_time } = req.body || {};
    let { order_summary } = req.body || {};

    if (!items && !order_summary && !notes && !date_time) {
      return res.status(400).json({ error: 'Inga fält att uppdatera' });
    }

    // Om items skickas men order_summary saknas — bygg en ny summary automatiskt
    // så att dashboarden alltid visar rätt innehåll
    if (items && !order_summary) {
      if (Array.isArray(items)) {
        order_summary = items.map(i => {
          const qty = i.qty || i.quantity || 1;
          const num = i.num || i.number || i.id || '?';
          const variant = i.variant || '';
          return `${qty} x nummer ${num}${variant}`;
        }).join(', ');
      }
    }

    console.log(`✏️  PATCH /api/order/${id} — body:`, JSON.stringify(req.body));

    const updated = await db.updateOrder(id, { items, order_summary, notes, date_time });
    if (!updated) {
      console.warn(`⚠️  PATCH: ingen aktiv order hittades med id=${id}`);
      return res.status(404).json({ error: `Hittade ingen aktiv order med id: ${id}` });
    }

    console.log(`✅ Order uppdaterad: ${id}`);
    res.json({ success: true, message: 'Ordern har uppdaterats.' });
  } catch (err) {
    console.error('Fel i PATCH /api/order:', err.message);
    res.status(500).json({ error: 'Kunde inte uppdatera ordern', details: err.message });
  }
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
