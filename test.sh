#!/usr/bin/env bash
# test.sh — Testar Thai Corner API lokalt och mot Render
#
# Lokalt:
#   chmod +x test.sh
#   API_KEY=din-nyckel ./test.sh
#
# Mot Render (efter deploy):
#   API_KEY=din-nyckel BASE_URL=https://thai-corner-api.onrender.com ./test.sh

set -e

API_KEY="${API_KEY:-test-key}"
BASE_URL="${BASE_URL:-http://localhost:3000}"

# Färgkoder
G='\033[0;32m'; B='\033[0;34m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'

pjson() { python3 -m json.tool 2>/dev/null || cat; }

echo -e "${B}══════════════════════════════════════════${N}"
echo -e "${B}   Thai Corner API — Testskript${N}"
echo -e "${B}══════════════════════════════════════════${N}"
echo    "URL:      $BASE_URL"
echo    "API-key:  ${API_KEY:0:4}****"
echo ""

# ── Health check ──────────────────────────────────────────
echo -e "${Y}▶  Health check${N}"
curl -sf "$BASE_URL/api/health" | pjson
echo ""

# ── Telavox verifiering: GET på POST-endpoints ────────────
echo -e "${Y}▶  Telavox verifiering (GET /api/order)${N}"
curl -sf "$BASE_URL/api/order" | pjson
echo ""

echo -e "${Y}▶  Telavox verifiering (GET /api/booking)${N}"
curl -sf "$BASE_URL/api/booking" | pjson
echo ""

# ── Telavox verifiering: POST med tom body ────────────────
echo -e "${Y}▶  POST med tom body (verifieringsanrop)${N}"
curl -sf -X POST "$BASE_URL/api/order" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{}' | pjson
echo ""

# ── Takeaway — strukturerat format ────────────────────────
echo -e "${Y}▶  Takeaway (strukturerat)${N}"
curl -sf -X POST "$BASE_URL/api/order" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "phone": "0701234567",
    "items": [
      {"name": "Kycklingfilé chili & cashew", "num": "9A", "note": "extra stark"},
      {"name": "Pad Thai räkor", "num": "15", "note": null},
      {"name": "Vårrullar", "num": "39", "note": null}
    ]
  }' | pjson
echo ""

# ── Takeaway — fri text (Telavox AI-format) ───────────────
echo -e "${Y}▶  Takeaway (fri text — Telavox AI-format)${N}"
curl -sf -X POST "$BASE_URL/api/order" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "phone": "0709876543",
    "order_summary": "Kunden vill ha kycklingfilé chili och cashew nummer 9A med extra stark sås, pad thai räkor nummer 15, och en portion vårrullar nummer 39."
  }' | pjson
echo ""

# ── Bordsbokning ──────────────────────────────────────────
echo -e "${Y}▶  Bordsbokning${N}"
curl -sf -X POST "$BASE_URL/api/booking" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "guests": 4,
    "date_time": "Lördag 22 juni kl 19:00",
    "name": "Anna Svensson",
    "phone": "0703456789",
    "notes": "Glutenallergi"
  }' | pjson
echo ""

# ── Hämta aktiva ordrar ───────────────────────────────────
echo -e "${Y}▶  Aktiva beställningar${N}"
curl -sf "$BASE_URL/api/active-orders" \
  -H "X-API-Key: $API_KEY" | pjson
echo ""

# ── Test av felaktig API-nyckel ───────────────────────────
echo -e "${Y}▶  Felaktig API-nyckel (ska ge 401)${N}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/active-orders" \
  -H "X-API-Key: fel-nyckel")
if [ "$HTTP_CODE" = "401" ]; then
  echo -e "${G}✅  Korrekt — fick 401 Unauthorized${N}"
else
  echo -e "${R}⚠️   Fick HTTP $HTTP_CODE (förväntade 401)${N}"
fi
echo ""

echo -e "${G}✅  Klar! Öppna dashboarden: $BASE_URL${N}"
