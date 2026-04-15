// ✈️ FLIGHT DEAL BOT — version corrigée
// Corrections : token caché, dates obligatoires, prix historiques, retry, logs

import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";

// ─────────────────────────────────────────
// 🔑 CONFIG — remplace par tes vraies clés
// ─────────────────────────────────────────
const TELEGRAM_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const CHAT_ID        = "YOUR_CHAT_ID";
const AMADEUS_KEY    = "YOUR_AMADEUS_KEY";
const AMADEUS_SECRET = "YOUR_AMADEUS_SECRET";

const bot = new TelegramBot(TELEGRAM_TOKEN);

// ─────────────────────────────────────────
// ✈️ PARAMÈTRES DE RECHERCHE
// ─────────────────────────────────────────
const DEPARTURES  = ["MRS", "MXP", "BCN", "CDG"];
const DESTINATIONS = ["DXB", "BKK", "JFK", "HND"];
const MAX_BUDGET  = 900;          // € budget max
const DEAL_RATIO  = 0.70;         // 30% sous la moyenne = bonne affaire
const DAYS_AHEAD  = 7;            // chercher les 7 prochains jours
const SCAN_INTERVAL = 5 * 60 * 1000; // toutes les 5 minutes

// ─────────────────────────────────────────
// 🧠 ANTI-DOUBLON persistant (fichier JSON)
// ─────────────────────────────────────────
const SENT_FILE = "./sent_deals.json";

function loadSentDeals() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SENT_FILE, "utf8")));
  } catch {
    return new Set();
  }
}

function saveSentDeals(set) {
  fs.writeFileSync(SENT_FILE, JSON.stringify([...set]), "utf8");
}

const sentDeals = loadSentDeals();

// ─────────────────────────────────────────
// 📈 HISTORIQUE DES PRIX (baseline réelle)
// ─────────────────────────────────────────
const priceHistory = {}; // { "MRS-DXB": [420, 390, 455, ...] }

function recordPrice(route, price) {
  if (!priceHistory[route]) priceHistory[route] = [];
  priceHistory[route].push(price);
  if (priceHistory[route].length > 50) priceHistory[route].shift(); // max 50 samples
}

function getBaseline(route) {
  const h = priceHistory[route] || [];
  if (h.length < 5) return null; // pas assez de données encore
  return h.reduce((a, b) => a + b, 0) / h.length;
}

// ─────────────────────────────────────────
// 🔐 TOKEN AMADEUS — caché 25 min
// ─────────────────────────────────────────
let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  console.log("🔐 Renouvellement du token Amadeus...");
  const res = await fetch("https://test.api.amadeus.com/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${AMADEUS_KEY}&client_secret=${AMADEUS_SECRET}`,
  });

  if (!res.ok) throw new Error(`Token Amadeus impossible : HTTP ${res.status}`);

  const data = await res.json();
  _token = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // 60s de marge
  console.log("✅ Token OK (expire dans ~25 min)");
  return _token;
}

// ─────────────────────────────────────────
// 📅 GÉNÉRATION DES DATES
// ─────────────────────────────────────────
function getNextDates(n = DAYS_AHEAD) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() + (i + 3) * 86_400_000); // J+3 à J+N
    return d.toISOString().split("T")[0]; // "2025-08-10"
  });
}

// ─────────────────────────────────────────
// 🔎 RECHERCHE DE VOLS (avec date obligatoire)
// ─────────────────────────────────────────
async function fetchFlights(token, from, to, date) {
  const url = new URL("https://test.api.amadeus.com/v2/shopping/flight-offers");
  url.searchParams.set("originLocationCode",      from);
  url.searchParams.set("destinationLocationCode", to);
  url.searchParams.set("departureDate",           date); // ← obligatoire !
  url.searchParams.set("adults",                  "1");
  url.searchParams.set("travelClass",             "BUSINESS");
  url.searchParams.set("currencyCode",            "EUR");
  url.searchParams.set("max",                     "5");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429) {
    console.warn(`⚠️  Rate limit atteint pour ${from}→${to} le ${date}. Pause 10s...`);
    await sleep(10_000);
    return [];
  }

  if (!res.ok) {
    console.warn(`⚠️  Erreur ${res.status} pour ${from}→${to} le ${date}`);
    return [];
  }

  const { data = [] } = await res.json();

  return data.map((offer) => ({
    from,
    to,
    date,
    price:   parseFloat(offer.price.total),
    airline: offer.validatingAirlineCodes[0],
    id:      `${from}-${to}-${date}-${offer.price.total}`,
  }));
}

// ─────────────────────────────────────────
// 🧠 DÉTECTION D'UNE BONNE AFFAIRE
// ─────────────────────────────────────────
function isGoodDeal(flight) {
  const baseline = getBaseline(`${flight.from}-${flight.to}`);
  if (!baseline) return false; // pas encore assez de données
  return flight.price < baseline * DEAL_RATIO && flight.price <= MAX_BUDGET;
}

// ─────────────────────────────────────────
// 🔔 ENVOI DE L'ALERTE TELEGRAM
// ─────────────────────────────────────────
async function sendAlert(flight, baseline) {
  if (sentDeals.has(flight.id)) return; // déjà envoyé

  const discount = Math.round((1 - flight.price / baseline) * 100);
  const message = [
    `🔥 BUSINESS DEAL DÉTECTÉ`,
    ``,
    `${flight.from} → ${flight.to}`,
    `✈️  Compagnie : ${flight.airline}`,
    `📅 Date : ${flight.date}`,
    `💰 Prix : ${flight.price}€`,
    `📉 -${discount}% vs la moyenne (${Math.round(baseline)}€)`,
    ``,
    `⚡ Offre rare — réserve vite !`,
  ].join("\n");

  try {
    await bot.sendMessage(CHAT_ID, message);
    sentDeals.add(flight.id);
    saveSentDeals(sentDeals);
    console.log(`✅ Alerte envoyée : ${flight.from}→${flight.to} ${flight.date} — ${flight.price}€`);
  } catch (err) {
    console.error(`❌ Erreur Telegram : ${err.message}`);
  }
}

// ─────────────────────────────────────────
// 🛠️  UTILITAIRE
// ─────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────
// 🔁 SCAN PRINCIPAL
// ─────────────────────────────────────────
async function scanDeals() {
  console.log(`\n🚀 Scan démarré à ${new Date().toLocaleTimeString("fr-FR")}`);

  let token;
  try {
    token = await getToken();
  } catch (err) {
    console.error(`❌ Impossible d'obtenir le token : ${err.message}`);
    return;
  }

  const dates = getNextDates(DAYS_AHEAD);

  for (const from of DEPARTURES) {
    for (const to of DESTINATIONS) {
      const route = `${from}-${to}`;

      for (const date of dates) {
        try {
          const flights = await fetchFlights(token, from, to, date);

          for (const flight of flights) {
            // On enregistre TOUS les prix pour construire la baseline
            recordPrice(route, flight.price);

            const baseline = getBaseline(route);
            if (baseline && isGoodDeal(flight)) {
              console.log(`🔥 DEAL : ${route} ${date} — ${flight.price}€ (baseline ${Math.round(baseline)}€)`);
              await sendAlert(flight, baseline);
            }
          }
        } catch (err) {
          console.error(`❌ Erreur sur ${route} ${date} : ${err.message}`);
        }

        // Petite pause entre chaque requête pour éviter le rate limit
        await sleep(300);
      }
    }
  }

  console.log(`✅ Scan terminé. Prochain scan dans 5 min.`);
}

// ─────────────────────────────────────────
// ▶️  DÉMARRAGE
// ─────────────────────────────────────────
console.log("✈️  Flight Deal Bot démarré");
console.log(`📡 Routes : ${DEPARTURES.length} départs × ${DESTINATIONS.length} destinations × ${DAYS_AHEAD} jours`);
console.log(`💰 Budget max : ${MAX_BUDGET}€ | Seuil deal : -${Math.round((1 - DEAL_RATIO) * 100)}% vs moyenne\n`);

scanDeals();
setInterval(scanDeals, SCAN_INTERVAL);

// ─────────────────────────────────────────
// 🚀 UPGRADES SUGGÉRÉES
// ─────────────────────────────────────────
// [ ] Ajouter MongoDB pour persister priceHistory entre redémarrages
// [ ] Ajouter p-limit pour paralléliser les requêtes sans spam API
// [ ] Utiliser l'endpoint Amadeus Flight Price Analysis (baseline officielle)
// [ ] Ajouter aller-retour (returnDate)
// [ ] Déploiement VPS (PM2 + systemd) pour 24/7
// [ ] Dashboard web pour voir les deals en temps réel
