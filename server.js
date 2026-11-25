require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use('/logos', express.static(path.join(__dirname, 'logos')));

app.get('/', (req, res) =>
  res.json({
    status: 'ok',
    app: 'API do José v4.7 (MaxPlayer + Vendas Sem Auto-Pause + Fotos no Chat + Lead Info Drawer)',
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const JWT_SECRET = process.env.JWT_SECRET || 'jose_super_secret_key';
const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;

const BASE_URL = (process.env.BASE_URL || 'https://bot-streaming-jose-api.celuyv.easypanel.host').replace(/\/$/, '');

const VIP_NATV_KEYS = (process.env.VIP_NATV_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

function isVipReseller(reseller) {
  return Boolean(reseller?.natv_api_key && VIP_NATV_KEYS.includes(reseller.natv_api_key.trim()));
}

const DEFAULT_PLAN_PRICES = {
  1: { 1: 29.9, 3: 74.9, 6: 149.9, 12: 279.9 },
  2: { 1: 50.0, 3: 149.9, 6: 299.9, 12: 499.9 },
  3: { 1: 70.0 },
  4: { 1: 90.0 },
};

function getResellerPrices(reseller) {
  const custom = reseller?.custom_prices;
  if (!custom || typeof custom !== 'object') return DEFAULT_PLAN_PRICES;
  return {
    1: {
      1: Number(custom?.[1]?.[1] ?? DEFAULT_PLAN_PRICES[1][1]),
      3: Number(custom?.[1]?.[3] ?? DEFAULT_PLAN_PRICES[1][3]),
      6: Number(custom?.[1]?.[6] ?? DEFAULT_PLAN_PRICES[1][6]),
      12: Number(custom?.[1]?.[12] ?? DEFAULT_PLAN_PRICES[1][12]),
    },
    2: {
      1: Number(custom?.[2]?.[1] ?? DEFAULT_PLAN_PRICES[2][1]),
      3: Number(custom?.[2]?.[3] ?? DEFAULT_PLAN_PRICES[2][3]),
      6: Number(custom?.[2]?.[6] ?? DEFAULT_PLAN_PRICES[2][6]),
      12: Number(custom?.[2]?.[12] ?? DEFAULT_PLAN_PRICES[2][12]),
    },
    3: { 1: Number(custom?.[3]?.[1] ?? DEFAULT_PLAN_PRICES[3][1]) },
    4: { 1: Number(custom?.[4]?.[1] ?? DEFAULT_PLAN_PRICES[4][1]) },
  };
}

function formatBRL(val) {
  return Number(val || 0).toFixed(2).replace('.', ',');
}

const DEFAULT_APPS_CONFIG = {
  samsung: [
    { name: 'HD PLAYER', logo: `${BASE_URL}/logos/hd-player.png`, instructions: '' },
    { name: 'MAXPLAYER', logo: `${BASE_URL}/logos/maxplayer.png`, instructions: '' },
    { name: 'WATCH HUB', logo: `${BASE_URL}/logos/watch-hub.png`, instructions: '' },
  ],
  roku: [
    { name: 'PLAYER MASTER', logo: `${BASE_URL}/logos/player-master.png`, instructions: '' },
    { name: 'WATCH HUB', logo: `${BASE_URL}/logos/watch-hub.png`, instructions: '' },
    { name: 'HD PLAYER', logo: `${BASE_URL}/logos/hd-player.png`, instructions: '' },
  ],
  lg: [
    { name: 'HD PLAYER', logo: `${BASE_URL}/logos/hd-player.png`, instructions: '' },
    { name: 'MAXPLAYER', logo: `${BASE_URL}/logos/maxplayer.png`, instructions: '' },
    { name: 'TOPTV', logo: `${BASE_URL}/logos/toptv.png`, instructions: '' },
  ],
  android: [
    { name: 'LOBO PLAYER', logo: `${BASE_URL}/logos/lobo-player.png`, instructions: '' },
    { name: 'HD PLAYER', logo: `${BASE_URL}/logos/hd-player.png`, instructions: '' },
    { name: 'TXS PRO PLAYER', logo: '', instructions: 'Via app Downloader usando o código 670156' },
  ],
};

function getResellerApps(reseller, filterMaxPlayer = false) {
  const cfg = reseller?.custom_apps;
  const raw =
    cfg && typeof cfg === 'object'
      ? {
          samsung: Array.isArray(cfg.samsung) && cfg.samsung.length ? cfg.samsung : DEFAULT_APPS_CONFIG.samsung,
          roku: Array.isArray(cfg.roku) && cfg.roku.length ? cfg.roku : DEFAULT_APPS_CONFIG.roku,
          lg: Array.isArray(cfg.lg) && cfg.lg.length ? cfg.lg : DEFAULT_APPS_CONFIG.lg,
          android: Array.isArray(cfg.android) && cfg.android.length ? cfg.android : DEFAULT_APPS_CONFIG.android,
        }
      : DEFAULT_APPS_CONFIG;

  if (!filterMaxPlayer || reseller?.maxplayer_token) return raw;

  const withoutMax = (list) =>
    list.filter((a) => !String(a.name || '').toUpperCase().includes('MAXPLAYER'));

  return {
    samsung: withoutMax(raw.samsung),
    roku: withoutMax(raw.roku),
    lg: withoutMax(raw.lg),
    android: withoutMax(raw.android),
  };
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ==========================================
// 1. CADASTRO E LOGIN DE REVENDEDORES
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO resellers (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, wallet_balance',
      [name, email, hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user, token });
  } catch {
    res.status(400).json({ error: 'E-mail já cadastrado ou dados inválidos' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM resellers WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });
    }
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        wallet_balance: user.wallet_balance,
        natv_credits: user.natv_credits,
        has_natv_key: Boolean(user.natv_api_key),
        watch_hub_code: user.watch_hub_code || '',
        has_maxplayer_token: Boolean(user.maxplayer_token),
        has_mp_token: Boolean(user.mp_access_token),
        support_whatsapp: user.support_whatsapp || '',
        bot_name: user.bot_name || 'José',
        is_vip: isVipReseller(user),
      },
    });
  } catch {
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

app.post('/api/auth/natv-login', async (req, res) => {
  const { natv_api_key } = req.body;
  if (!natv_api_key) {
    return res.status(400).json({ error: 'Informe sua Chave de API NATV' });
  }

  try {
    const cleanKey = natv_api_key.trim();
    const response = await fetch('https://revenda.pixbot.link/reseller/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cleanKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return res.status(401).json({ error: 'Chave de API NATV inválida' });
    }

    const natvData = await response.json();
    const credits = Number(natvData.credits ?? 0);
    const natvName = natvData.username || natvData.name || `revenda_${natvData.id || Date.now()}`;
    const fakeEmail = `${natvName.toLowerCase().replace(/[^a-z0-9]/g, '')}@natv.jose`;

    let result = await pool.query('SELECT * FROM resellers WHERE natv_api_key = $1', [cleanKey]);
    let user = result.rows[0];

    if (!user) {
      const dummyHash = await bcrypt.hash(cleanKey, 10);
      const insert = await pool.query(
        `INSERT INTO resellers (name, email, password_hash, natv_api_key, natv_credits)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE SET natv_api_key = $4, natv_credits = $5
         RETURNING *`,
        [natvName, fakeEmail, dummyHash, cleanKey, credits]
      );
      user = insert.rows[0];
    } else {
      const update = await pool.query(
        'UPDATE resellers SET natv_credits = $1, name = $2 WHERE id = $3 RETURNING *',
        [credits, natvName, user.id]
      );
      user = update.rows[0];
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        wallet_balance: user.wallet_balance,
        natv_credits: user.natv_credits,
        has_natv_key: true,
        watch_hub_code: user.watch_hub_code || '',
        has_maxplayer_token: Boolean(user.maxplayer_token),
        has_mp_token: Boolean(user.mp_access_token),
        support_whatsapp: user.support_whatsapp || '',
        bot_name: user.bot_name || 'José',
        is_vip: isVipReseller(user),
      },
    });
  } catch (err) {
    console.error('Erro detalhado no natv-login:', err);
    res.status(500).json({ error: `Erro interno: ${err.message}` });
  }
});

// ==========================================
// 2. INTEGRAÇÕES E PERSONALIZAÇÕES DO REVENDEDOR
// ==========================================
app.post('/api/natv/validate', auth, async (req, res) => {
  const { natv_api_key } = req.body;
  try {
    const response = await fetch('https://revenda.pixbot.link/reseller/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${natv_api_key}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) return res.status(400).json({ error: 'Chave de API NATV inválida' });

    const natvData = await response.json();
    const credits = Number(natvData.credits ?? 0);
    await pool.query(
      'UPDATE resellers SET natv_api_key = $1, natv_credits = $2 WHERE id = $3',
      [natv_api_key, credits, req.user.id]
    );
    res.json({ success: true, credits, natvData });
  } catch {
    res.status(500).json({ error: 'Erro ao conectar na API NATV' });
  }
});

const natvCreditsCache = new Map();

app.get('/api/reseller/sync-credits', auth, async (req, res) => {
  const userId = req.user.id;
  try {
    const r = await pool.query(
      'SELECT natv_api_key, natv_credits, wallet_balance FROM resellers WHERE id = $1',
      [userId]
    );
    const reseller = r.rows[0];
    if (!reseller) return res.status(404).json({ error: 'Revendedor não encontrado' });

    const cached = natvCreditsCache.get(userId);
    if (cached && Date.now() - cached.ts < 60000) {
      return res.json({
        natv_credits: cached.credits,
        wallet_balance: reseller.wallet_balance,
      });
    }

    let credits = Number(reseller.natv_credits ?? 0);
    if (reseller.natv_api_key) {
      const natvRes = await fetch('https://revenda.pixbot.link/reseller/me', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${reseller.natv_api_key}`,
          'Content-Type': 'application/json',
        },
      });
      if (natvRes.ok) {
        const natvData = await natvRes.json();
        credits = Number(natvData.credits ?? credits);
        await pool.query('UPDATE resellers SET natv_credits = $1 WHERE id = $2', [credits, userId]);
        natvCreditsCache.set(userId, { ts: Date.now(), credits });
      }
    }

    res.json({ natv_credits: credits, wallet_balance: reseller.wallet_balance });
  } catch {
    res.status(500).json({ error: 'Erro ao sincronizar créditos' });
  }
});

const INOVE_API_BASE = 'https://api.gestorinove.com.br/api';
const NOTIFIQUE_API_BASE = 'https://apiv1.notifique.net/v1';

function extractInoveWorkspaceId(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const match = value.match(/workspaces\/([^/?#]+)/i);
  return match ? match[1] : value.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

async function syncClientToInove(reseller, lead, months, screens) {
  const workspaceId = extractInoveWorkspaceId(reseller.gestor_webhook_url);
  const apiKey = String(reseller.gestor_token || '').trim();
  if (!workspaceId || !apiKey || !lead?.natv_username) return;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const expDate = new Date();
  expDate.setDate(expDate.getDate() + Number(months || 1) * 30);
  const expiresAt = expDate.toISOString();

  const rawDigits = String(lead.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
  const fullPhone = rawDigits ? `+${rawDigits.startsWith('55') ? rawDigits : '55' + rawDigits}` : undefined;
  const externalId = String(lead.natv_username).trim();

  try {
    const findRes = await fetch(
      `${INOVE_API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/clients/external/${encodeURIComponent(externalId)}`,
      { method: 'GET', headers }
    );

    if (findRes.ok) {
      const foundJson = await findRes.json();
      const clientId = foundJson?.data?.id;
      if (clientId) {
        await fetch(
          `${INOVE_API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/clients/${encodeURIComponent(clientId)}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              expiresAt,
              notes: `Renovado via José (${months}m / ${screens} tela(s))`,
            }),
          }
        );
        return;
      }
    }

    const clientName = String(lead.name || externalId).trim();
    await fetch(`${INOVE_API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/clients`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: clientName.length >= 2 ? clientName : `Cliente ${externalId}`,
        username: externalId,
        ...(fullPhone ? { fullPhone } : {}),
        externalId,
        expiresAt,
        notes: `Ativado via José (${months}m / ${screens} tela(s))`,
        optInMessages: true,
        sendWelcomeMessage: false,
      }),
    });
  } catch (err) {
    console.error('❌ [INOVE] Falha:', err.message);
  }
}

async function syncClientToNotifique(reseller, lead, months, screens) {
  const apiKey = String(reseller.gestor_token || '').trim();
  if (!apiKey || !lead?.phone) return;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const rawDigits = String(lead.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
  if (rawDigits.length < 10) return;
  const whats = rawDigits.startsWith('55') ? rawDigits : `55${rawDigits}`;

  try {
    const findRes = await fetch(`${NOTIFIQUE_API_BASE}/clientes?whats=${encodeURIComponent(whats)}`, {
      method: 'GET',
      headers,
    });
    if (!findRes.ok) return;

    const foundData = await findRes.json();
    if (foundData?.cliente === false) return;

    const clientObj = foundData?.cliente || foundData?.data || foundData;
    const clientId = clientObj?.id || clientObj?.idBanco;
    if (!clientId) return;

    const syncRes = await fetch(`${NOTIFIQUE_API_BASE}/clientes/${encodeURIComponent(clientId)}/sincronizar`, {
      method: 'POST',
      headers,
    });
    if (syncRes.ok) return;

    const expDate = new Date();
    expDate.setDate(expDate.getDate() + Number(months || 1) * 30);
    const vencimentoBr = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(expDate);

    await fetch(`${NOTIFIQUE_API_BASE}/clientes/${encodeURIComponent(clientId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        editar_vencimento: true,
        editar_nota: true,
        informacoes: { vencimento: vencimentoBr, nota: `Ativado via José (${months}m / ${screens} tela(s))` },
        sincronizar: true,
      }),
    });
  } catch (err) {
    console.error('❌ [NOTIFIQUE] Falha:', err.message);
  }
}

async function syncClientToGestor(reseller, lead, months, screens) {
  if (reseller?.gestor_provider === 'inove') {
    await syncClientToInove(reseller, lead, months, screens);
  } else if (reseller?.gestor_provider === 'notifique') {
    await syncClientToNotifique(reseller, lead, months, screens);
  }
}

app.get('/api/reseller/gestor', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT gestor_provider, gestor_webhook_url, gestor_token FROM resellers WHERE id = $1',
      [req.user.id]
    );
    const row = r.rows[0] || {};
    res.json({
      provider: row.gestor_provider || 'native',
      webhook_url: row.gestor_webhook_url || '',
      token: row.gestor_token || '',
    });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar gestor' });
  }
});

app.post('/api/reseller/gestor', auth, async (req, res) => {
  const provider = String(req.body?.provider || 'native').trim().toLowerCase();
  let webhook_url = String(req.body?.webhook_url || '').trim();
  const token = String(req.body?.token || '').trim();

  if (provider === 'native') {
    await pool.query(
      `UPDATE resellers SET gestor_provider = 'native', gestor_webhook_url = NULL, gestor_token = NULL WHERE id = $1`,
      [req.user.id]
    );
    return res.json({ success: true, provider: 'native' });
  }

  try {
    let servidores = [];
    if (provider === 'inove') {
      const workspaceId = extractInoveWorkspaceId(webhook_url);
      const checkRes = await fetch(`${INOVE_API_BASE}/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!checkRes.ok) return res.status(400).json({ error: 'Gestor Inove recusou a conexão.' });
    }
    if (provider === 'notifique') {
      const checkRes = await fetch(`${NOTIFIQUE_API_BASE}/servidores`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!checkRes.ok) return res.status(400).json({ error: 'Chave Notifique inválida.' });
      const data = await checkRes.json();
      servidores = Array.isArray(data?.servidores) ? data.servidores : [];
      if (!webhook_url && servidores[0]?.id) webhook_url = String(servidores[0].id);
    }

    await pool.query(
      `UPDATE resellers SET gestor_provider = $1, gestor_webhook_url = $2, gestor_token = $3 WHERE id = $4`,
      [provider, webhook_url, token, req.user.id]
    );
    res.json({ success: true, provider, webhook_url, servidores });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar gestor' });
  }
});

app.post('/api/reseller/watch-hub', auth, async (req, res) => {
  await pool.query('UPDATE resellers SET watch_hub_code = $1 WHERE id = $2', [req.body.watch_hub_code, req.user.id]);
  res.json({ success: true });
});

app.post('/api/reseller/maxplayer', auth, async (req, res) => {
  await pool.query('UPDATE resellers SET maxplayer_token = $1 WHERE id = $2', [req.body.maxplayer_token, req.user.id]);
  res.json({ success: true });
});

const MAXPLAYER_API_BASE = 'https://api.maxplayer.tv/v3/api/public';

async function syncUserToMaxPlayer(reseller, lead, natvUser) {
  const apiToken = String(reseller?.maxplayer_token || '').trim();
  if (!apiToken || !natvUser?.username || !natvUser?.password) {
    return { ok: false, error: 'Token MaxPlayer ou dados NATV ausentes.' };
  }

  const headers = { 'Api-Token': apiToken, 'Content-Type': 'application/json' };
  try {
    const domRes = await fetch(`${MAXPLAYER_API_BASE}/domains`, { method: 'GET', headers });
    if (!domRes.ok) return { ok: false, error: 'Falha ao consultar domínios no MaxPlayer.' };
    const domJson = await domRes.json();
    const domains = Array.isArray(domJson?.data) ? domJson.data : [];
    if (!domains.length) return { ok: false, error: 'Nenhum domínio aprovado.' };

    const natvHost = String(natvUser.domain || '').replace(/^https?:\/\//i, '').replace(/[:/].*$/, '').trim().toLowerCase();
    const matchedDomain = domains.find((d) => String(d.domain || '').trim().toLowerCase() === natvHost) || domains[0];
    const domainId = String(matchedDomain.id);
    const username = String(natvUser.username).trim();
    const password = String(natvUser.password).trim();
    const fullname = String(lead?.name || username).trim();

    const createRes = await fetch(`${MAXPLAYER_API_BASE}/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ domain_id: domainId, iptv_user: username, iptv_pass: password, username, user_password: password, fullname }),
    });

    if (createRes.ok) {
      const created = await createRes.json();
      return { ok: true, user_id: created.user_id };
    }

    if (createRes.status === 409) {
      const searchRes = await fetch(`${MAXPLAYER_API_BASE}/users/search?limit=10`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ username }),
      });
      if (searchRes.ok) {
        const searchJson = await searchRes.json();
        const existing = (searchJson?.users || []).find((u) => String(u.username || '').toLowerCase() === username.toLowerCase());
        if (existing?.id) {
          await fetch(`${MAXPLAYER_API_BASE}/users/password`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ user_id: String(existing.id), password }),
          });
          await fetch(`${MAXPLAYER_API_BASE}/users/list`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ user_id: String(existing.id), domain_id: domainId, iptv_username: username, iptv_password: password }),
          });
          return { ok: true, user_id: existing.id };
        }
      }
    }
    return { ok: false };
  } catch (err) {
    console.error('❌ [MAXPLAYER] Erro:', err.message);
    return { ok: false };
  }
}

app.post('/api/reseller/mercadopago', auth, async (req, res) => {
  await pool.query('UPDATE resellers SET mp_access_token = $1 WHERE id = $2', [req.body.mp_access_token, req.user.id]);
  res.json({ success: true });
});

app.post('/api/reseller/support-whatsapp', auth, async (req, res) => {
  const cleanPhone = String(req.body?.support_whatsapp || '').replace(/\D/g, '');
  await pool.query('UPDATE resellers SET support_whatsapp = $1 WHERE id = $2', [cleanPhone, req.user.id]);
  res.json({ success: true, support_whatsapp: cleanPhone });
});

app.get('/api/reseller/apps', auth, async (req, res) => {
  const r = await pool.query('SELECT custom_apps, maxplayer_token FROM resellers WHERE id = $1', [req.user.id]);
  res.json({ apps: getResellerApps(r.rows[0], false) });
});

app.post('/api/reseller/apps', auth, async (req, res) => {
  await pool.query('UPDATE resellers SET custom_apps = $1 WHERE id = $2', [JSON.stringify(req.body.apps), req.user.id]);
  res.json({ success: true });
});

app.get('/api/reseller/customizations', auth, async (req, res) => {
  const r = await pool.query('SELECT bot_name, custom_prices FROM resellers WHERE id = $1', [req.user.id]);
  const row = r.rows[0] || {};
  res.json({ bot_name: row.bot_name || 'José', prices: getResellerPrices(row) });
});

app.post('/api/reseller/customizations', auth, async (req, res) => {
  const botName = String(req.body?.bot_name || 'José').trim() || 'José';
  await pool.query('UPDATE resellers SET bot_name = $1, custom_prices = $2 WHERE id = $3', [botName, JSON.stringify(req.body.prices), req.user.id]);
  res.json({ success: true });
});

// ==========================================
// 3. CONECTAR WHATSAPP
// ==========================================
app.post('/api/whatsapp/connect', auth, async (req, res) => {
  const botType = req.body?.type === 'support' ? 'support' : 'sales';
  const instanceName = botType === 'support' ? `jose_sup_${req.user.id.slice(0, 8)}` : `jose_${req.user.id.slice(0, 8)}`;

  const webhookConfig = {
    enabled: true,
    url: `${BASE_URL}/api/webhooks/evolution`,
    byEvents: false,
    base64: false,
    events: ['MESSAGES_UPSERT'],
  };

  try {
    await fetch(`${EVOLUTION_URL}/instance/create`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS', webhook: webhookConfig }),
    });

    const qrRes = await fetch(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
      method: 'GET',
      headers: { apikey: EVOLUTION_KEY },
    });
    const qrData = await qrRes.json();
    const qrBase64 = qrData.base64 || qrData.qrcode?.base64 || null;

    await pool.query(
      `INSERT INTO whatsapp_instances (reseller_id, instance_name, status, qr_code_base64, bot_type)
       VALUES ($1, $2, 'qr_pending', $3, $4)
       ON CONFLICT (instance_name) DO UPDATE SET status = 'qr_pending', qr_code_base64 = $3, bot_type = $4, updated_at = now()`,
      [req.user.id, instanceName, qrBase64, botType]
    );

    res.json({ instanceName, bot_type: botType, qr_code_base64: qrBase64 });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar QR Code' });
  }
});

app.get('/api/whatsapp/status', auth, async (req, res) => {
  const salesInstance = `jose_${req.user.id.slice(0, 8)}`;
  const supportInstance = `jose_sup_${req.user.id.slice(0, 8)}`;

  async function checkState(instanceName) {
    try {
      const r = await fetch(`${EVOLUTION_URL}/instance/connectionState/${instanceName}`, { headers: { apikey: EVOLUTION_KEY } });
      const data = await r.json();
      return data?.instance?.state || data?.state || 'close';
    } catch {
      return 'close';
    }
  }

  const [salesState, supportState] = await Promise.all([checkState(salesInstance), checkState(supportInstance)]);
  res.json({ sales: salesState === 'open', support: supportState === 'open' });
});

// ==========================================
// 4. CARTEIRA E WEBHOOKS MP
// ==========================================
app.post('/api/wallet/recharge', auth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 5) return res.status(400).json({ error: 'Mínimo R$ 5,00' });

  try {
    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transaction_amount: Number(amount),
        description: `Recarga Carteira José`,
        payment_method_id: 'pix',
        payer: { email: req.user.email },
        external_reference: req.user.id,
        notification_url: `${BASE_URL}/api/webhooks/mercadopago`,
      }),
    });
    const payment = await mpRes.json();
    const pixData = payment.point_of_interaction?.transaction_data;
    res.json({ payment_id: payment.id, pix_copia_e_cola: pixData?.qr_code, qr_code_base64: pixData?.qr_code_base64 });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar Pix' });
  }
});

async function processWalletRecharge(paymentId) {
  const cleanId = String(paymentId || '').replace(/\D/g, '');
  if (!cleanId) return { ok: false };

  const already = await pool.query('SELECT 1 FROM processed_payments WHERE payment_id = $1', [`wallet_${cleanId}`]);
  if (already.rows.length > 0) return { ok: true };

  const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${cleanId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  const payment = await mpRes.json();

  if (payment.status === 'approved' && payment.external_reference) {
    const resellerId = payment.external_reference;
    const amount = Number(payment.transaction_amount);
    await pool.query('INSERT INTO processed_payments (payment_id, reseller_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [`wallet_${cleanId}`, resellerId]);
    await pool.query('UPDATE resellers SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2', [amount, resellerId]);
    return { ok: true };
  }
  return { ok: false };
}

app.post('/api/webhooks/mercadopago', async (req, res) => {
  res.sendStatus(200);
  const paymentId = req.body?.data?.id || req.query?.id;
  if (paymentId) await processWalletRecharge(paymentId);
});

// ==========================================
// 5. MOTOR DO JOSÉ (VENDAS + SUPORTE)
// ==========================================
const APP_LOGOS = {
  'WATCH HUB': `${BASE_URL}/logos/watch-hub.png`,
  'HD PLAYER': `${BASE_URL}/logos/hd-player.png`,
  'MAXPLAYER': `${BASE_URL}/logos/maxplayer.png`,
  'PLAYER MASTER': `${BASE_URL}/logos/player-master.png`,
  'LOBO PLAYER': `${BASE_URL}/logos/lobo-player.png`,
};

function buildSalesPrompt(reseller) {
  const botName = reseller?.bot_name || 'José';
  const prices = getResellerPrices(reseller);
  return `Você é o ${botName}, atendente comercial de streaming no WhatsApp. Respostas curtas e naturais. Plano mensal R$ ${formatBRL(prices[1][1])}. Ofereça teste grátis de 1 hora.`;
}

function buildSupportPrompt(reseller) {
  const botName = reseller?.bot_name || 'José';
  return `Você é o ${botName} Suporte, assistente técnico. Ajude com login NATV, verifique status e renove planos.`;
}

const processedMessages = new Set();

app.post('/api/webhooks/evolution', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body || {};
    const instance = body.instance;
    const dataObj = body.data || body;
    const key = dataObj.key || dataObj.data?.key;
    const remoteJid = key?.remoteJid || dataObj.remoteJid;
    const fromMe = key?.fromMe || dataObj.fromMe;
    const msgId = key?.id || `${remoteJid}:${Date.now()}`;

    if (!remoteJid || remoteJid.includes('@g.us')) return;

    if (fromMe) {
      if (!remoteJid.endsWith('@lid')) {
        const instCheck = await pool.query(`SELECT reseller_id, COALESCE(bot_type, 'sales') AS bot_type FROM whatsapp_instances WHERE instance_name = $1`, [instance]);
        const inst = instCheck.rows[0];
        if (inst?.reseller_id && inst.bot_type === 'support') {
          await pool.query(`UPDATE leads SET needs_human = true WHERE reseller_id = $1 AND phone = $2`, [inst.reseller_id, remoteJid]);
        }
      }
      return;
    }

    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);
    setTimeout(() => processedMessages.delete(msgId), 60000);

    const messageContainer = dataObj.message || dataObj.data?.message || {};
    let text = messageContainer.conversation || messageContainer.extendedTextMessage?.text || dataObj.text || '';
    let mediaUrl = null;

    if (messageContainer.imageMessage) {
      mediaUrl = messageContainer.imageMessage.url || dataObj.mediaUrl || messageContainer.imageMessage.jpegThumbnail || null;
      if (!text) text = '[O cliente enviou uma foto]';
    }

    if (!text && !mediaUrl) return;

    const instRes = await pool.query(`SELECT r.*, COALESCE(wi.bot_type, 'sales') AS bot_type FROM whatsapp_instances wi JOIN resellers r ON r.id = wi.reseller_id WHERE wi.instance_name = $1`, [instance]);
    const activeReseller = instRes.rows[0];
    if (!activeReseller || !activeReseller.bot_active) return;

    let leadRes = await pool.query('SELECT * FROM leads WHERE reseller_id = $1 AND phone = $2', [activeReseller.id, remoteJid]);
    let lead = leadRes.rows[0];

    if (!lead) {
      const insert = await pool.query(`INSERT INTO leads (reseller_id, phone, name, instance_name) VALUES ($1, $2, 'Cliente', $3) RETURNING *`, [activeReseller.id, remoteJid, instance]);
      lead = insert.rows[0];
    }

    await pool.query(`INSERT INTO messages (lead_id, sender, content, media_url) VALUES ($1, 'client', $2, $3)`, [lead.id, text, mediaUrl]);

    if (lead.needs_human) return;

    const tools = [
      { type: 'function', function: { name: 'gerar_teste', parameters: {} } },
      { type: 'function', function: { name: 'consultar_status_natv', parameters: { type: 'object', properties: { username: { type: 'string' } } } } },
      { type: 'function', function: { name: 'chamar_humano', parameters: {} } }
    ];

    const messagesPayload = [
      { role: 'system', content: activeReseller.bot_type === 'support' ? buildSupportPrompt(activeReseller) : buildSalesPrompt(activeReseller) },
      { role: 'user', content: text }
    ];

    const apiKey = process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
    const aiRes = await callGeminiWithFallback(apiKey, messagesPayload, tools);
    let replyText = aiRes.data?.choices?.[0]?.message?.content;

    if (replyText) {
      await fetch(`${EVOLUTION_URL}/message/sendText/${instance}`, {
        method: 'POST',
        headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: remoteJid, delay: 1000, text: replyText }),
      });
      await pool.query(`INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'jose_ai', $2)`, [lead.id, replyText]);
    }
  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
});

async function callGeminiWithFallback(apiKey, messagesPayload, tools) {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-2.5-flash', messages: messagesPayload, tools }),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

// ==========================================
// 6. ROTAS DE LEADS E INICIALIZAÇÃO
// ==========================================
app.get('/api/leads', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM leads WHERE reseller_id = $1 ORDER BY last_interaction DESC', [req.user.id]);
  res.json(result.rows);
});

app.get('/api/leads/:leadId', auth, async (req, res) => {
  try {
    const leadRes = await pool.query(
      `SELECT id, phone, name, last_message, last_interaction, stage, chosen_app, natv_username, natv_password, needs_human, tab, test_created_at, created_at
       FROM leads WHERE id = $1 AND reseller_id = $2`,
      [req.params.leadId, req.user.id]
    );
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    res.json({
      success: true,
      lead: {
        ...lead,
        whatsapp_link: `https://wa.me/${String(lead.phone || '').replace(/\D/g, '')}`,
      },
    });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar dados do lead' });
  }
});

app.get('/api/leads/:leadId/messages', auth, async (req, res) => {
  try {
    const msgs = await pool.query('SELECT id, sender, content, content AS text, media_url, created_at FROM messages WHERE lead_id = $1 ORDER BY created_at ASC', [req.params.leadId]);
    res.json(msgs.rows);
  } catch {
    res.status(500).json({ error: 'Erro ao carregar mensagens' });
  }
});

app.post('/api/leads/:leadId/messages', auth, async (req, res) => {
  const { text } = req.body;
  const leadRes = await pool.query('SELECT * FROM leads WHERE id = $1 AND reseller_id = $2', [req.params.leadId, req.user.id]);
  const lead = leadRes.rows[0];
  if (!lead) return res.status(404).json({ error: 'Não encontrado' });

  await fetch(`${EVOLUTION_URL}/message/sendText/${lead.instance_name}`, {
    method: 'POST',
    headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: lead.phone, text }),
  });
  await pool.query(`INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'human', $2)`, [lead.id, text]);
  res.json({ success: true });
});

async function initTables() {
  try {
    await pool.query(`
      ALTER TABLE resellers ADD COLUMN IF NOT EXISTS maxplayer_token TEXT;
      ALTER TABLE resellers ADD COLUMN IF NOT EXISTS support_whatsapp TEXT;
      ALTER TABLE resellers ADD COLUMN IF NOT EXISTS custom_apps JSONB;
      ALTER TABLE resellers ADD COLUMN IF NOT EXISTS bot_name TEXT DEFAULT 'José';
      ALTER TABLE resellers ADD COLUMN IF NOT EXISTS custom_prices JSONB;
      ALTER TABLE resellers ADD COLUMN IF NOT EXISTS gestor_provider TEXT;
      ALTER TABLE resellers ADD COLUMN IF NOT EXISTS gestor_webhook_url TEXT;
      ALTER TABLE resellers ADD COLUMN IF NOT EXISTS gestor_token TEXT;
      ALTER TABLE whatsapp_instances ADD COLUMN IF NOT EXISTS bot_type TEXT DEFAULT 'sales';
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;
      CREATE TABLE IF NOT EXISTS processed_payments (payment_id TEXT PRIMARY KEY, reseller_id UUID, created_at TIMESTAMP DEFAULT now());
    `);
  } catch (err) {
    console.error('Erro initTables:', err.message);
  }
}
initTables();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API do José rodando na porta ${PORT}`));
