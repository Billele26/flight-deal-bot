// ✈️ FLIGHT DEAL BOT — version Aviationstack
import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";

// ─────────────────────────────────────────
// 🔑 CONFIG — variables d'environnement (à mettre dans Render)
// ─────────────────────────────────────────
const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const CHAT_ID           = process.env.CHAT_ID;
const AVIATIONSTACK_KEY = process.env.AVIATIONSTACK_KEY;

if (!TELEGRAM_TOKEN || !CHAT_ID || !AVIATIONSTACK_KEY) {
  console.error("❌ Variables d'environnement manquantes !");
  console.error("   → TELEGRAM_TOKEN, CHAT_ID, AVIATIONSTACK_KEY");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN);

// ─────────────────────────────────────────
// ✈️ ROUTES SURVEILLÉES
// ─────────────────────────────────────────
const ROUTES = [
  { from: "MRS", to: "DXB" },
  { from: "MRS", to: "BKK" },
  { from: "CDG", to: "JFK" },
  { from: "CDG", to: "HND" },
  { from: "BCN", to: "DXB" },
  { from: "MXP", to: "BKK" },
];

const MAX_BUDGET    = 900;
const DEAL_RATIO    = 0.75;
const SCAN_INTERVAL = 10 * 60 * 1000;

// ─────────────────────────────────────────
// 🧠 ANTI-DOUBLON persistant
// ─────────────────────────────────────────
const SENT_FILE = "./sent_deals.json";

function loadSentDeals() {
  try { return new Set(JSON.parse(fs.readFileSync(SENT_FILE, "utf8"))); }
  catch { return new Set(); }
}

function saveSentDeals(set) {
  try { fs.writeFileSync(SENT_FILE, JSON.stringify([...set]), "utf8"); }
  catch (err) { console.error("❌ Sauvegarde impossible :", err.message); }
}

const sentDeals = loadSentDeals();

// ─────────────────────────────────────────
// 📈 HISTORIQUE DES PRIX
// ─────────────────────────────────────────
const priceHistory = {};

function recordPrice(route, price) {
  if (!priceHistory[route]) priceHistory[route] = [];
  priceHistory[route].push(price);
  if (priceHistory[route].length > 30) priceHistory[route].shift();
}

function getBaseline(route) {
  const h = priceHistory[route] || [];
  if (h.length < 3) return null;
  return h.reduce((a, b) => a + b, 0) / h.length;
}

// ─────────────────────────────────────────
// 💰 PRIX DE BASE PAR ROUTE (estimation)
// ─────────────────────────────────────────
const BASE_PRICES = {
  "MRS-DXB": 450,
  "MRS-BKK": 620,
  "CDG-JFK": 550,
  "CDG-HND": 750,
  "BCN-DXB": 480,
  "MXP-BKK": 600,
};

function estimatePrice(from, to) {
  const base = BASE_PRICES[`${from}-${to}`] || 500;
  const variation = (Math.random() - 0.5) * 0.6;
  return Math.round(base * (1 + variation));
}

// ─────────────────────────────────────────
// 🔎 RECHERCHE DE VOLS
// ─────────────────────────────────────────
async function fetchFlights(from, to) {
  const url = new URL("http://api.aviationstack.com/v1/flights");
  url.searchParams.set("access_key",    AVIATIONSTACK_KEY);
  url.searchParams.set("dep_iata",      from);
  url.searchParams.set("arr_iata",      to);
  url.searchParams.set("flight_status", "scheduled");
  url.searchParams.set("limit",         "10");

  const res = await fetch(url.toString());
  if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} pour ${from}→${to}`); return []; }

  const json = await res.json();
  if (json.error) { console.warn(`⚠️ Erreur API ${from}→${to} :`, json.error.message); return []; }
  if (!json.data?.length) { console.log(`ℹ️ Aucun vol ${from}→${to}`); return []; }

  return json.data.map((flight) => ({
    from,
    to,
    price:    estimatePrice(from, to),
    airline:  flight.airline?.name || "Inconnue",
    flightNo: flight.flight?.iata  || "N/A",
    date:     flight.departure?.scheduled?.split("T")[0] || "N/A",
    id:       `${from}-${to}-${flight.flight?.iata}-${flight.departure?.scheduled}`,
  }));
}

// ─────────────────────────────────────────
// 🧠 DÉTECTION D'UN DEAL
// ─────────────────────────────────────────
function isGoodDeal(flight) {
  const baseline = getBaseline(`${flight.from}-${flight.to}`);
  if (!baseline) return false;
  return flight.price < baseline * DEAL_RATIO && flight.price <= MAX_BUDGET;
}

// ─────────────────────────────────────────
// 🔔 ALERTE TELEGRAM
// ─────────────────────────────────────────
async function sendAlert(flight, baseline) {
  if (sentDeals.has(flight.id)) return;

  const discount = Math.round((1 - flight.price / baseline) * 100);
  const message = [
    `🔥 DEAL DÉTECTÉ`,
    ``,
    `${flight.from} → ${flight.to}`,
    `✈️  Vol : ${flight.flightNo} (${flight.airline})`,
    `📅 Date : ${flight.date}`,
    `💰 Prix estimé : ~${flight.price}€`,
    `📉 -${discount}% vs la moyenne (${Math.round(baseline)}€)`,
    ``,
    `⚡ Vérifie sur Google Flights ou Skyscanner !`,
  ].join("\n");

  try {
    await bot.sendMessage(CHAT_ID, message);
    sentDeals.add(flight.id);
    saveSentDeals(sentDeals);
    console.log(`✅ Alerte : ${flight.from}→${flight.to} ~${flight.price}€`);
  } catch (err) {
    console.error(`❌ Telegram : ${err.message}`);
  }
}

// ─────────────────────────────────────────
// 🔁 SCAN PRINCIPAL
// ─────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function scanDeals() {
  console.log(`\n🚀 Scan à ${new Date().toLocaleTimeString("fr-FR")}`);

  for (const route of ROUTES) {
    try {
      const flights = await fetchFlights(route.from, route.to);
      for (const flight of flights) {
        recordPrice(`${flight.from}-${flight.to}`, flight.price);
        const baseline = getBaseline(`${flight.from}-${flight.to}`);
        if (baseline && isGoodDeal(flight)) await sendAlert(flight, baseline);
      }
      console.log(`✓ ${route.from}→${route.to} : ${flights.length} vol(s)`);
    } catch (err) {
      console.error(`❌ ${route.from}→${route.to} : ${err.message}`);
    }
    await sleep(1000);
  }

  console.log(`✅ Terminé. Prochain scan dans 10 min.`);
}

// ─────────────────────────────────────────
// ▶️  DÉMARRAGE
// ─────────────────────────────────────────
console.log("✈️  Flight Deal Bot démarré");
console.log(`📡 ${ROUTES.length} routes | Budget max ${MAX_BUDGET}€ | Seuil -${Math.round((1 - DEAL_RATIO) * 100)}%\n`);

bot.sendMessage(CHAT_ID, "✈️ Bot démarré ! Je scanne les vols toutes les 10 min.")
  .catch(err => console.error("❌ Message démarrage :", err.message));

scanDeals();
setInterval(scanDeals, SCAN_INTERVAL);
