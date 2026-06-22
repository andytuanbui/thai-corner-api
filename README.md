# Thai Corner — Beställningssystem

REST-API + realtidsdashboard för Thai Corner i Ystad.  
Telavox AI Receptionist anropar API:et under samtal och skickar in beställningar och bokningar.

---

## Projektstruktur

```
thai-corner/
├── server.js        # Express API (alla endpoints)
├── db.js            # SQLite-databaslager
├── package.json
├── .env.example     # Miljövariabler (kopiera till .env)
├── render.yaml      # Render deployment-config
├── test.sh          # Curl-testskript
└── public/
    └── index.html   # Dashboard för personalen
```

---

## 1. Lokal installation och test

```bash
# Klona projektet
git clone https://github.com/DITT-REPO/thai-corner.git
cd thai-corner

# Installera dependencies
npm install

# Skapa .env från mall
cp .env.example .env
# Öppna .env och sätt API_KEY till valfri hemlig sträng

# Starta servern
npm start
# Eller med auto-reload: npm run dev

# Öppna dashboarden
open http://localhost:3000

# Kör testskript (i ett annat terminalfönster)
API_KEY=din-nyckel ./test.sh
```

Servern loggar alla inkommande requests i terminalen — bra för att se exakt vad Telavox skickar.

---

## 2. Deploy till Render

### Steg-för-steg

1. Pusha koden till ett GitHub-repo
2. Gå till [render.com](https://render.com) och skapa ett nytt **Web Service**
3. Välj ditt GitHub-repo
4. Render hittar `render.yaml` automatiskt — klicka **Apply**
5. Under **Environment** → notera det auto-genererade värdet för `API_KEY`  
   (det här är nyckeln du anger i Telavox och i dashboardens inloggprompt)
6. Under **Disks** → bekräfta att disken `/data` är skapad (kräver Starter-plan, $7/mån)  
   *På gratisnivån: data försvinner vid omstart. OK för test, ej för produktion.*
7. Klicka **Deploy**

### Verifiera deploy

```bash
API_KEY=din-nyckel BASE_URL=https://thai-corner-api.onrender.com ./test.sh
```

---

## 3. Konfigurera Telavox AI Receptionist

I Telavox-gränssnittet: **Settings → Tools → Add tool → API**

### Verktyg 1: Takeaway-beställning

| Fält      | Värde |
|-----------|-------|
| Name      | `skicka_bestellning` |
| Method    | `POST` |
| URL       | `https://thai-corner-api.onrender.com/api/order` |
| Header 1  | `Content-Type: application/json` |
| Header 2  | `X-API-Key: DIN-API-NYCKEL` |

**Body (JSON):**
```json
{
  "phone": "{{system__caller_id}}",
  "order_summary": "{OrderSummary}"
}
```

> `{OrderSummary}` är en Telavox-platshållare som AI:n fyller i med en sammanfattning av vad kunden beställt under samtalet. Instruera AI:n i systemprompten att samla ihop hela beställningen och placera den här.  
> `{{system__caller_id}}` fylls i automatiskt av Telavox med kundens telefonnummer.

**Systemprompt-instruktion till Telavox AI (lägg till i AI:ns instruktioner):**
```
När en kund har lagt en takeaway-beställning och bekräftat alla rätter, 
anropa verktyget "skicka_bestellning" med:
- phone: kundens telefonnummer
- order_summary: en komplett sammanfattning av beställningen på svenska, 
  t.ex. "Kycklingfilé chili och cashew (nr 9A) extra stark, Pad Thai räkor (nr 15) extra ris"

Läs upp bekräftelsen du får tillbaka från verktyget ordagrant för kunden.
```

---

### Verktyg 2: Bordsbokning

| Fält      | Värde |
|-----------|-------|
| Name      | `skicka_bokning` |
| Method    | `POST` |
| URL       | `https://thai-corner-api.onrender.com/api/booking` |
| Header 1  | `Content-Type: application/json` |
| Header 2  | `X-API-Key: DIN-API-NYCKEL` |

**Body (JSON):**
```json
{
  "name": "{GuestName}",
  "phone": "{{system__caller_id}}",
  "guests": "{NumberOfGuests}",
  "date_time": "{BookingDateTime}",
  "notes": "{SpecialRequests}"
}
```

**Systemprompt-instruktion till Telavox AI:**
```
När en kund vill boka bord och du har samlat in alla uppgifter (namn, datum/tid, antal gäster), 
anropa verktyget "skicka_bokning". Fyll i:
- name: kundens namn
- phone: kundens telefonnummer  
- guests: antal gäster (bara siffran, t.ex. "4")
- date_time: datum och tid på svenska, t.ex. "Lördag 22 juni kl 19:00"
- notes: allergier eller specialönskemål, annars null

Läs upp bekräftelsen från verktyget för kunden.
```

---

## 4. Felsökning

### "Saved, but webhook registration wasn't confirmed"

Telavox verifierar endpoints vid registrering. Den här servern hanterar det på tre sätt:
- Svarar på **OPTIONS** med 200 (preflight)
- Svarar på **GET /api/order** och **GET /api/booking** med 200 + JSON
- Svarar på **POST med tom body** med 200 + JSON (istället för 400/422)

Om verifieringen fortfarande misslyckas: titta i serverloggen (Render Dashboard → Logs) direkt efter du sparar verktyget i Telavox. Loggen visar exakt vilken request Telavox skickar.

### Dashboard visar inget

- Kontrollera att du angett rätt API-nyckel i inloggpromten
- Kolla att servern är igång: `https://thai-corner-api.onrender.com/api/health`
- På Render gratisnivå: servern somnar efter 15 min inaktivitet — vänta 30 sek

---

## 5. API-referens (curl-exempel)

```bash
# Ny beställning (fri text)
curl -X POST https://thai-corner-api.onrender.com/api/order \
  -H "Content-Type: application/json" \
  -H "X-API-Key: DIN-NYCKEL" \
  -d '{"phone":"0701234567","order_summary":"Pad Thai räkor nr 15, extra ris"}'

# Ny bokning
curl -X POST https://thai-corner-api.onrender.com/api/booking \
  -H "Content-Type: application/json" \
  -H "X-API-Key: DIN-NYCKEL" \
  -d '{"name":"Anna","phone":"073123","guests":4,"date_time":"Fredag 20 juni 19:00"}'

# Aktiva ordrar
curl https://thai-corner-api.onrender.com/api/active-orders \
  -H "X-API-Key: DIN-NYCKEL"

# Markera som klar
curl -X POST https://thai-corner-api.onrender.com/api/resolve/ORDER-ID-HÄR \
  -H "X-API-Key: DIN-NYCKEL"
```

---

## 6. Utöka systemet

### Byta SQLite mot Postgres

1. `npm install pg`
2. Skapa `postgres.js` med samma exporterade funktioner som `db.js`
3. Ersätt `require('./db')` med `require('./postgres')` i `server.js`

### Integrera med Trivec kassasystem

I `server.js`, sök efter `// TODO: Trivec-integration` och lägg till ditt API-anrop där.

### WebSockets istället för polling

Installera `socket.io`, emit ett event i POST-handlerna, och prenumerera i `index.html`.  
Polling var 6 sekund är tillräckligt för restaurangbruk och kräver inga extra dependencies.
