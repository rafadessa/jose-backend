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

// Serve os logos hospedados na pasta /logos do repositório
app.use('/logos', express.static(path.join(__dirname, 'logos')));

app.get('/', (req, res) =>
  res.json({
    status: 'ok',
    app: 'API do José v5.0 (Vendedor Total + Conferência de Login na Foto + Abas Vendas/Suporte + Meta Ads)',
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const JWT_SECRET = process.env.JWT_SECRET || 'jose_super_secret_key';
const EVOLUTION_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const BASE_URL = (process.env.BASE_URL || 'https://bot-streaming-jose-api.celuyv.easypanel.host').replace(/\/$/, '');

const VIP_NATV_KEYS = (process.env.VIP_NATV_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

function isVipReseller(reseller) {
  return Boolean(reseller?.natv_api_key && VIP_NATV_KEYS.includes(reseller.natv_api_key.trim()));
}

// Tabela padrão de preços (pode ser sobrescrita por revendedor em custom_prices)
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

function parseNatvCredits(rawVal, fallback = 0) {
  if (rawVal === undefined || rawVal === null || rawVal === '') return fallback;
  const parsed = Number(String(rawVal).replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

app.get('/api/reseller/sync-credits', auth, async (req, res) => {
  const userId = req.user.id;
  const forceSync = req.query.force === '1' || req.query.force === 'true';
  try {
    const r = await pool.query(
      'SELECT natv_api_key, natv_credits, wallet_balance FROM resellers WHERE id = $1',
      [userId]
    );
    const reseller = r.rows[0];
    if (!reseller) return res.status(404).json({ error: 'Revendedor não encontrado' });

    const cached = natvCreditsCache.get(userId);
    if (!forceSync && cached && Date.now() - cached.ts < 15000) {
      return res.json({
        natv_credits: cached.credits,
        credits: cached.credits,
        wallet_balance: reseller.wallet_balance,
      });
    }

    let credits = parseNatvCredits(reseller.natv_credits, 0);
    if (reseller.natv_api_key) {
      const baseUrl = (process.env.NATV_API_URL || 'https://revenda.pixbot.link').replace(/\/$/, '');
      const natvRes = await fetch(`${baseUrl}/reseller/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${reseller.natv_api_key.trim()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
      if (natvRes.ok) {
        const natvData = await natvRes.json().catch(() => ({}));
        const rawCredits =
          natvData.credits ??
          natvData.data?.credits ??
          natvData.reseller?.credits ??
          natvData.balance;
        credits = parseNatvCredits(rawCredits, credits);
        await pool.query('UPDATE resellers SET natv_credits = $1 WHERE id = $2', [credits, userId]);
        natvCreditsCache.set(userId, { ts: Date.now(), credits });
      } else {
        const errText = await natvRes.text().catch(() => '');
        console.error(`❌ [SYNC-CREDITS] NATV retornou ${natvRes.status}: ${errText.slice(0, 200)}`);
      }
    }

    res.json({
      natv_credits: credits,
      credits,
      wallet_balance: reseller.wallet_balance,
    });
  } catch (err) {
    console.error('❌ [SYNC-CREDITS] Erro:', err.message);
    res.status(500).json({ error: 'Erro ao sincronizar créditos' });
  }
});

// Integração Gestor Inove & Gestor Notifique
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
        console.log(`✅ [INOVE] Cliente ${externalId} atualizado`);
        return;
      }
    }

    const clientName = String(lead.name || externalId).trim();
    const createRes = await fetch(
      `${INOVE_API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/clients`,
      {
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
      }
    );

    if (createRes.ok) {
      console.log(`✅ [INOVE] Cliente ${externalId} criado no workspace ${workspaceId}`);
    } else {
      console.error('❌ [INOVE] Erro ao criar cliente:', createRes.status, await createRes.text());
    }
  } catch (err) {
    console.error('❌ [INOVE] Falha na sincronização:', err.message);
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
    const findRes = await fetch(
      `${NOTIFIQUE_API_BASE}/clientes?whats=${encodeURIComponent(whats)}`,
      { method: 'GET', headers }
    );
    if (!findRes.ok) {
      console.error('❌ [NOTIFIQUE] Erro ao buscar cliente:', findRes.status);
      return;
    }

    const foundData = await findRes.json();
    if (foundData?.cliente === false) {
      console.log(`ℹ️ [NOTIFIQUE] Cliente ${whats} ainda não existe no Gestor Notifique.`);
      return;
    }

    const clientObj = foundData?.cliente || foundData?.data || foundData;
    const clientId = clientObj?.id || clientObj?.idBanco;
    if (!clientId) return;

    // Sincroniza com o painel IPTV (atualiza vencimento SEM gastar crédito em dobro)
    const syncRes = await fetch(
      `${NOTIFIQUE_API_BASE}/clientes/${encodeURIComponent(clientId)}/sincronizar`,
      { method: 'POST', headers }
    );

    if (syncRes.ok) {
      console.log(`✅ [NOTIFIQUE] Cliente #${clientId} (${whats}) sincronizado com o painel.`);
      return;
    }

    const expDate = new Date();
    expDate.setDate(expDate.getDate() + Number(months || 1) * 30);
    const vencimentoBr = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
    }).format(expDate);

    await fetch(`${NOTIFIQUE_API_BASE}/clientes/${encodeURIComponent(clientId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        editar_vencimento: true,
        editar_nota: true,
        informacoes: {
          vencimento: vencimentoBr,
          nota: `Ativado via José (${months}m / ${screens} tela(s))`,
        },
        sincronizar: true,
      }),
    });
    console.log(`✅ [NOTIFIQUE] Cliente #${clientId} atualizado via PATCH (${vencimentoBr})`);
  } catch (err) {
    console.error('❌ [NOTIFIQUE] Falha na sincronização:', err.message);
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
    res.status(500).json({ error: 'Erro ao carregar configuração do gestor' });
  }
});

app.post('/api/reseller/gestor', auth, async (req, res) => {
  const provider = String(req.body?.provider || 'native').trim().toLowerCase();
  let webhook_url = String(req.body?.webhook_url || '').trim();
  const token = String(req.body?.token || '').trim();

  if (provider === 'native') {
    try {
      await pool.query(
        `UPDATE resellers
         SET gestor_provider = 'native', gestor_webhook_url = NULL, gestor_token = NULL
         WHERE id = $1`,
        [req.user.id]
      );
      return res.json({ success: true, provider: 'native' });
    } catch {
      return res.status(500).json({ error: 'Erro ao ativar Gestor Nativo' });
    }
  }

  if (!['inove', 'notifique'].includes(provider)) {
    return res.status(400).json({ error: 'Provedor inválido' });
  }
  if (!token) {
    return res.status(400).json({ error: 'Informe o Token / API Key de integração.' });
  }

  try {
    let servidores = [];

    if (provider === 'inove') {
      if (!webhook_url) {
        return res.status(400).json({ error: 'Informe o Workspace ID do Gestor Inove.' });
      }
      const workspaceId = extractInoveWorkspaceId(webhook_url);
      const checkRes = await fetch(
        `${INOVE_API_BASE}/workspaces/${encodeURIComponent(workspaceId)}`,
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } }
      );
      if (!checkRes.ok) {
        return res.status(400).json({
          error:
            'Gestor Inove recusou a conexão. Verifique o Workspace ID e os escopos (workspace:read, clients:read, clients:write).',
        });
      }
    }

    if (provider === 'notifique') {
      const checkRes = await fetch(`${NOTIFIQUE_API_BASE}/servidores`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!checkRes.ok) {
        return res.status(400).json({
          error: 'Chave da API Notifique inválida ou revogada. Confira sua chave no painel Notifique.',
        });
      }
      const data = await checkRes.json();
      servidores = Array.isArray(data?.servidores) ? data.servidores : [];
      if (!webhook_url && servidores[0]?.id) {
        webhook_url = String(servidores[0].id);
      }
    }

    await pool.query(
      `UPDATE resellers
       SET gestor_provider = $1, gestor_webhook_url = $2, gestor_token = $3
       WHERE id = $4`,
      [provider, webhook_url, token, req.user.id]
    );

    res.json({ success: true, provider, webhook_url, servidores });
  } catch {
    res.status(500).json({ error: 'Erro ao validar/salvar configuração do gestor' });
  }
});

app.post('/api/reseller/watch-hub', auth, async (req, res) => {
  try {
    await pool.query('UPDATE resellers SET watch_hub_code = $1 WHERE id = $2', [req.body.watch_hub_code, req.user.id]);
    res.json({ success: true, watch_hub_code: req.body.watch_hub_code });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar código do Watch Hub' });
  }
});

app.post('/api/reseller/maxplayer', auth, async (req, res) => {
  try {
    await pool.query('UPDATE resellers SET maxplayer_token = $1 WHERE id = $2', [req.body.maxplayer_token, req.user.id]);
    res.json({ success: true, maxplayer_token: req.body.maxplayer_token });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar Token do MaxPlayer' });
  }
});

const MAXPLAYER_API_BASE = 'https://api.maxplayer.tv/v3/api/public';

async function syncUserToMaxPlayer(reseller, lead, natvUser) {
  const apiToken = String(reseller?.maxplayer_token || '').trim();
  if (!apiToken || !natvUser?.username || !natvUser?.password) {
    return { ok: false, error: 'Token MaxPlayer ou dados NATV ausentes.' };
  }

  const headers = {
    'Api-Token': apiToken,
    'Content-Type': 'application/json',
  };

  try {
    const domRes = await fetch(`${MAXPLAYER_API_BASE}/domains`, { method: 'GET', headers });
    if (!domRes.ok) {
      const errText = await domRes.text();
      console.error('❌ [MAXPLAYER] Erro ao listar domínios:', domRes.status, errText);
      return { ok: false, error: 'Falha ao consultar domínios no MaxPlayer.' };
    }

    const domJson = await domRes.json();
    const domains = Array.isArray(domJson?.data) ? domJson.data : [];
    if (!domains.length) {
      return { ok: false, error: 'Nenhum domínio aprovado encontrado na conta MaxPlayer.' };
    }

    const natvHost = String(natvUser.domain || '')
      .replace(/^https?:\/\//i, '')
      .replace(/[:/].*$/, '')
      .trim()
      .toLowerCase();

    const matchedDomain =
      domains.find((d) => String(d.domain || '').trim().toLowerCase() === natvHost) ||
      domains.find((d) => String(d.status || '').toLowerCase() === 'approved') ||
      domains[0];

    const domainId = String(matchedDomain.id);
    const username = String(natvUser.username).trim();
    const password = String(natvUser.password).trim();
    const fullname = String(lead?.name || username).trim();

    const createRes = await fetch(`${MAXPLAYER_API_BASE}/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        domain_id: domainId,
        iptv_user: username,
        iptv_pass: password,
        username,
        user_password: password,
        fullname,
      }),
    });

    if (createRes.ok) {
      const created = await createRes.json();
      console.log(`✅ [MAXPLAYER] Usuário ${username} criado (user_id: ${created.user_id})`);
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
        const existing = (searchJson?.users || []).find(
          (u) => String(u.username || '').toLowerCase() === username.toLowerCase()
        );

        if (existing?.id) {
          await fetch(`${MAXPLAYER_API_BASE}/users/password`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ user_id: String(existing.id), password }),
          });
          await fetch(`${MAXPLAYER_API_BASE}/users/list`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              user_id: String(existing.id),
              domain_id: domainId,
              iptv_username: username,
              iptv_password: password,
            }),
          });
          console.log(`✅ [MAXPLAYER] Usuário ${username} atualizado (user_id: ${existing.id})`);
          return { ok: true, user_id: existing.id, updated: true };
        }
      }
    }

    const errBody = await createRes.text();
    console.error('❌ [MAXPLAYER] Erro ao criar usuário:', createRes.status, errBody);
    return { ok: false, error: `MaxPlayer retornou erro ${createRes.status}` };
  } catch (err) {
    console.error('❌ [MAXPLAYER] Exceção:', err.message);
    return { ok: false, error: err.message };
  }
}

app.post('/api/reseller/mercadopago', auth, async (req, res) => {
  try {
    await pool.query('UPDATE resellers SET mp_access_token = $1 WHERE id = $2', [req.body.mp_access_token, req.user.id]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar Token do Mercado Pago' });
  }
});

app.post('/api/reseller/support-whatsapp', auth, async (req, res) => {
  const cleanPhone = String(req.body?.support_whatsapp || '').replace(/\D/g, '');
  try {
    await pool.query('UPDATE resellers SET support_whatsapp = $1 WHERE id = $2', [cleanPhone, req.user.id]);
    res.json({ success: true, support_whatsapp: cleanPhone });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar WhatsApp de suporte' });
  }
});

app.get('/api/reseller/apps', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT custom_apps, maxplayer_token FROM resellers WHERE id = $1', [req.user.id]);
    res.json({ apps: getResellerApps(r.rows[0], false) });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar aplicativos' });
  }
});

app.post('/api/reseller/apps', auth, async (req, res) => {
  const { apps } = req.body;
  if (!apps || typeof apps !== 'object') return res.status(400).json({ error: 'Configuração de apps inválida' });
  try {
    await pool.query('UPDATE resellers SET custom_apps = $1 WHERE id = $2', [JSON.stringify(apps), req.user.id]);
    res.json({ success: true, apps });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar aplicativos' });
  }
});

// Personalizações (Nome do Assistente + Preços Personalizados)
app.get('/api/reseller/customizations', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT bot_name, custom_prices FROM resellers WHERE id = $1', [req.user.id]);
    const row = r.rows[0] || {};
    res.json({
      bot_name: row.bot_name || 'José',
      prices: getResellerPrices(row),
    });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar personalizações' });
  }
});

app.post('/api/reseller/customizations', auth, async (req, res) => {
  const botName = String(req.body?.bot_name || 'José').trim() || 'José';
  const prices = req.body?.prices;
  if (!prices || typeof prices !== 'object') {
    return res.status(400).json({ error: 'Tabela de preços inválida' });
  }
  try {
    await pool.query(
      'UPDATE resellers SET bot_name = $1, custom_prices = $2 WHERE id = $3',
      [botName, JSON.stringify(prices), req.user.id]
    );
    res.json({ success: true, bot_name: botName, prices });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar personalizações' });
  }
});

// ==========================================
// 3. CONECTAR WHATSAPP
// ==========================================
app.post('/api/whatsapp/connect', auth, async (req, res) => {
  const botType = req.body?.type === 'support' ? 'support' : 'sales';
  const instanceName =
    botType === 'support'
      ? `jose_sup_${req.user.id.slice(0, 8)}`
      : `jose_${req.user.id.slice(0, 8)}`;

  const webhookConfig = {
    enabled: true,
    url: `${BASE_URL}/api/webhooks/evolution`,
    byEvents: false,
    base64: true,
    events: ['MESSAGES_UPSERT'],
  };

  try {
    await fetch(`${EVOLUTION_URL}/instance/create`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        webhook: webhookConfig,
      }),
    });

    await fetch(`${EVOLUTION_URL}/webhook/set/${instanceName}`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook: webhookConfig }),
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
       ON CONFLICT (instance_name)
       DO UPDATE SET status = 'qr_pending', qr_code_base64 = $3, bot_type = $4, updated_at = now()`,
      [req.user.id, instanceName, qrBase64, botType]
    );

    res.json({ instanceName, bot_type: botType, qr_code_base64: qrBase64 });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar QR Code na Evolution API' });
  }
});

app.get('/api/whatsapp/status', auth, async (req, res) => {
  const salesInstance = `jose_${req.user.id.slice(0, 8)}`;
  const supportInstance = `jose_sup_${req.user.id.slice(0, 8)}`;

  async function checkState(instanceName) {
    try {
      const r = await fetch(`${EVOLUTION_URL}/instance/connectionState/${instanceName}`, {
        method: 'GET',
        headers: { apikey: EVOLUTION_KEY },
      });
      if (!r.ok) return 'close';
      const data = await r.json();
      return data?.instance?.state || data?.state || 'close';
    } catch {
      return 'close';
    }
  }

  const [salesState, supportState] = await Promise.all([
    checkState(salesInstance),
    checkState(supportInstance),
  ]);

  res.json({ sales: salesState === 'open', support: supportState === 'open' });
});

// ==========================================
// 4. RECARGA DA CARTEIRA DO JOSÉ (WEBHOOK BLINDADO)
// ==========================================
app.post('/api/wallet/recharge', auth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 5) return res.status(400).json({ error: 'Valor mínimo de recarga é R$ 5,00' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MERCADO_PAGO_ACCESS_TOKEN não configurado.' });

  try {
    const payerEmail = req.user.email?.endsWith('.jose')
      ? req.user.email.replace(/\.jose$/, '.com')
      : (req.user.email || 'cliente@josebot.com');

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `${req.user.id}-${Date.now()}`,
      },
      body: JSON.stringify({
        transaction_amount: Number(amount),
        description: `Recarga Carteira José - ${payerEmail}`,
        payment_method_id: 'pix',
        payer: { email: payerEmail },
        external_reference: req.user.id,
        notification_url: `${BASE_URL}/api/webhooks/mercadopago`,
      }),
    });

    const payment = await mpRes.json();
    if (!mpRes.ok) {
      return res.status(400).json({
        error: payment.message || payment.cause?.[0]?.description || 'Mercado Pago recusou a criação do Pix.',
      });
    }

    const pixData = payment.point_of_interaction?.transaction_data;
    res.json({
      payment_id: payment.id,
      pix_copia_e_cola: pixData?.qr_code,
      qr_code_base64: pixData?.qr_code_base64,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar cobrança Pix' });
  }
});

async function processWalletRecharge(paymentId) {
  const cleanId = String(paymentId || '').replace(/\D/g, '');
  if (!cleanId) return { ok: false, status: 'invalid_id' };

  const already = await pool.query(
    'SELECT 1 FROM processed_payments WHERE payment_id = $1',
    [`wallet_${cleanId}`]
  );
  if (already.rows.length > 0) {
    return { ok: true, status: 'already_processed' };
  }

  const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${cleanId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  const payment = await mpRes.json();

  if (!mpRes.ok) {
    console.error('❌ [WEBHOOK MP CARTEIRA] Erro ao consultar MP:', mpRes.status, payment);
    return { ok: false, status: 'mp_error', detail: payment.message };
  }

  if (payment.status === 'approved' && payment.external_reference) {
    const resellerId = payment.external_reference;
    const amount = Number(payment.transaction_amount);

    await pool.query(
      'INSERT INTO processed_payments (payment_id, reseller_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [`wallet_${cleanId}`, resellerId]
    );
    await pool.query(
      'UPDATE resellers SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2',
      [amount, resellerId]
    );
    await pool.query(
      `INSERT INTO wallet_transactions (reseller_id, type, category, amount, description)
       VALUES ($1, 'recharge', 'pix_recharge', $2, $3)`,
      [resellerId, amount, `Recarga Pix #${cleanId}`]
    );

    console.log(`✅ [CARTEIRA CREDITADA] Revendedor ${resellerId} +R$ ${amount.toFixed(2)} (Pix #${cleanId})`);
    return { ok: true, status: 'credited', amount, resellerId };
  }

  return { ok: false, status: payment.status || 'not_approved' };
}

app.post('/api/webhooks/mercadopago', async (req, res) => {
  res.sendStatus(200);
  const paymentId =
    req.body?.data?.id ||
    req.query?.['data.id'] ||
    req.query?.id ||
    req.body?.id;

  if (!paymentId) return;

  try {
    await processWalletRecharge(paymentId);
  } catch (err) {
    console.error('❌ [ERRO WEBHOOK CARTEIRA]:', err.message);
  }
});

app.post('/api/wallet/confirm/:paymentId', auth, async (req, res) => {
  try {
    const result = await processWalletRecharge(req.params.paymentId);
    res.json(result);
  } catch (err) {
    console.error('❌ [ERRO CONFIRM CARTEIRA]:', err.message);
    res.status(500).json({ error: 'Erro ao verificar pagamento no Mercado Pago' });
  }
});

// ==========================================
// 5. WEBHOOK DE VENDA DE PLANOS
// ==========================================
app.post('/api/webhooks/mp-reseller/:resellerId', async (req, res) => {
  res.sendStatus(200);
  const paymentId =
    req.body?.data?.id ||
    req.query?.['data.id'] ||
    req.query?.id ||
    req.body?.id;
  const { resellerId } = req.params;
  if (!paymentId || !resellerId) return;

  try {
    const already = await pool.query('SELECT 1 FROM processed_payments WHERE payment_id = $1', [String(paymentId)]);
    if (already.rows.length > 0) return;

    const resRes = await pool.query('SELECT * FROM resellers WHERE id = $1', [resellerId]);
    const reseller = resRes.rows[0];
    if (!reseller?.mp_access_token || !reseller?.natv_api_key) return;

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${reseller.mp_access_token}` },
    });
    const payment = await mpRes.json();

    if (payment.status === 'approved' && payment.external_reference) {
      const [leadId, monthsStr, screensStr] = payment.external_reference.split('|');
      const months = Number(monthsStr) || 1;
      const screens = Number(screensStr) || 1;

      const leadRes = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
      const lead = leadRes.rows[0];
      if (!lead?.natv_username) return;

      const actBody = {
        username: lead.natv_username,
        months,
        ...(screens > 1 ? { connections: screens } : {}),
      };

      const actRes = await fetch('https://revenda.pixbot.link/user/activation', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${reseller.natv_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(actBody),
      });
      const actData = await actRes.json();

      if (actRes.ok) {
        await pool.query(
          'INSERT INTO processed_payments (payment_id, reseller_id, lead_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [String(paymentId), reseller.id, lead.id]
        );
        await pool.query(`UPDATE leads SET stage = 'ATIVO' WHERE id = $1`, [lead.id]);

        await syncClientToGestor(reseller, lead, months, screens);

        if (!isVipReseller(reseller)) {
          await debitWallet(
            reseller.id,
            Number(reseller.cost_per_activation ?? 0.18),
            'activation',
            `Ativação (${months}m / ${screens} tela(s)): ${lead.natv_username}`
          );
        }

        if (actData.owner?.credits !== undefined) {
          await pool.query('UPDATE resellers SET natv_credits = $1 WHERE id = $2', [Number(actData.owner.credits), reseller.id]);
        }

        let instanceName = lead.instance_name;
        if (!instanceName) {
          const instRes = await pool.query(
            `SELECT instance_name FROM whatsapp_instances
             WHERE reseller_id = $1 AND COALESCE(bot_type, 'sales') = 'sales' LIMIT 1`,
            [reseller.id]
          );
          instanceName = instRes.rows[0]?.instance_name;
        }

        if (instanceName) {
          await sendWhatsAppText(
            instanceName,
            lead.phone,
            `Pagamento confirmado! 🎉 Seu plano de ${months} ${months === 1 ? 'mês' : 'meses'} (${screens} ${screens === 1 ? 'tela' : 'telas'}) já foi ativado automaticamente. Bom entretenimento!`
          );

          // Notificação de venda para o WhatsApp de suporte humano da revenda
          if (reseller.support_whatsapp) {
            const digits = String(reseller.support_whatsapp).replace(/\D/g, '');
            const supportNumber = digits.length <= 11 ? `55${digits}` : digits;
            const supportJid = `${supportNumber}@s.whatsapp.net`;
            const clientPhone = String(lead.phone || '').replace(/@.*$/, '');
            const amountPaid = formatBRL(payment.transaction_amount);

            const saleAlert =
              `💰 *Nova Venda Confirmada!*\n\n` +
              `Cliente: ${lead.name || 'Sem nome'}\n` +
              `WhatsApp: ${clientPhone}\n` +
              `Usuário NATV: ${lead.natv_username}\n` +
              `Plano: ${months} ${months === 1 ? 'mês' : 'meses'} (${screens} ${screens === 1 ? 'tela' : 'telas'})\n` +
              `Valor: R$ ${amountPaid}\n\n` +
              `✅ Ativado automaticamente pelo ${reseller.bot_name || 'José'}.`;

            await sendWhatsAppText(instanceName, supportJid, saleAlert);
            console.log(`💰 [ALERTA VENDA] Enviado para ${supportJid}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('Erro no webhook mp-reseller:', err);
  }
});

// ==========================================
// 6. MOTOR DO JOSÉ (VENDAS + SUPORTE + ÁUDIO + VISÃO)
// ==========================================
const APP_LOGOS = {
  'WATCH HUB': `${BASE_URL}/logos/watch-hub.png`,
  'HD PLAYER': `${BASE_URL}/logos/hd-player.png`,
  'MAXPLAYER': `${BASE_URL}/logos/maxplayer.png`,
  'PLAYER MASTER': `${BASE_URL}/logos/player-master.png`,
  'LOBO PLAYER': `${BASE_URL}/logos/lobo-player.png`,
  'MEGATV PLAYER': `${BASE_URL}/logos/megatv.png`,
  'TOPTV': `${BASE_URL}/logos/toptv.png`,
};

function buildSalesPrompt(reseller) {
  const botName = reseller?.bot_name || 'José';
  const prices = getResellerPrices(reseller);
  const apps = getResellerApps(reseller, true);
  const hasMaxPlayer = Boolean(reseller?.maxplayer_token);

  const formatLine = (list) =>
    list
      .map((app, i) => `${i + 1}º ${app.name}${app.instructions ? ` (${app.instructions})` : ''}`)
      .join(' | ');

  const maxPlayerBlock = hasMaxPlayer
    ? `  - Se o app escolhido for MAXPLAYER, entregue EXATAMENTE neste formato:
    Seu teste está pronto! Já cadastrei o seu acesso no MaxPlayer.
    Para assistir, basta abrir o app no seu aparelho e usar estes dados:

    Usuário: [usuario]
    Senha: [senha]\n`
    : `  - NUNCA recomende nem mencione o aplicativo MAXPLAYER (não está habilitado nesta revenda).\n`;

  return `Você é o ${botName}, um vendedor especialista, engajado, educado e consultivo de streaming no WhatsApp.
Seu objetivo principal é encantar o cliente, conduzir até o teste grátis sem atrito e CONVERTER A VENDA do plano.
Estilo: leve, entusiasmado na medida certa, simpático e natural. Mensagens CURTAS (máx. 2 a 3 linhas) e APENAS UMA pergunta por vez.

POSTURA DE VENDEDOR (CONVERSÃO):
- Sempre valorize o que o cliente vai ganhar (canais abertos e fechados, esportes ao vivo, filmes e séries atualizados sem travar).
- Assim que o cliente entrar no teste ou disser que gostou, conduza naturalmente para o fechamento oferecendo o plano mensal ou trimestral (destacando a economia do trimestral) e já se colocando à disposição para gerar o Pix na hora.
- Se o cliente tiver objeção de preço ou dúvida, responda com educação, destaque o custo-benefício (menos de R$ 1 por dia) e puxe para o fechamento.

CONFERÊNCIA DE ERRO DE DIGITAÇÃO (MUITO IMPORTANTE):
- Se o cliente disser que "não entrou", "deu erro", "servidor rejeitou as credenciais", "usuário/senha inválidos" ou mandar foto da tela de login:
  1. Compare CARACTERE POR CARACTERE o Código, Usuário e Senha que aparecem na foto com os [DADOS ATUAIS DO LEAD] informados no contexto.
  2. Se encontrar qualquer erro de digitação (ex: digitou dois "55" no começo como 5555..., faltou/sobrou um número, espaço extra, código errado), avise com muita educação exatamente onde foi o erro (ex: "Vi aqui na foto que acabou indo um 55 a mais no começo do usuário! 😉").
  3. Reenvie os dados corretos bem organizados e peça para apagar e digitar novamente com calma. Só chame \`chamar_humano\` se os dados na foto estiverem 100% idênticos aos gerados e mesmo assim não entrar.

PLANOS (até 4 telas simultâneas):
- 1 tela: Mensal R$ ${formatBRL(prices[1][1])} | Trimestral R$ ${formatBRL(prices[1][3])} | Semestral R$ ${formatBRL(prices[1][6])} | Anual R$ ${formatBRL(prices[1][12])}
- 2 telas: Mensal R$ ${formatBRL(prices[2][1])} | Trimestral R$ ${formatBRL(prices[2][3])} | Semestral R$ ${formatBRL(prices[2][6])} | Anual R$ ${formatBRL(prices[2][12])}
- 3 telas: Mensal R$ ${formatBRL(prices[3][1])}
- 4 telas: Mensal R$ ${formatBRL(prices[4][1])}
- Teste grátis: 1 hora.
Regra: nunca jogue a tabela completa antes de oferecer o teste grátis (se perguntar preço, diga "a partir de R$ ${formatBRL(prices[1][1])}/mês" e puxe para o teste). Só informe opções de 2, 3 ou 4 telas se o cliente perguntar ou demonstrar interesse em mais telas.

CANAIS ADULTOS (+18):
- Se o cliente perguntar se tem canais adultos (+18), responda de forma natural e discreta que SIM, o pacote já inclui canais adultos protegidos por senha (a senha padrão dos aplicativos costuma ser 0000 ou 1234).
- Avise que, se preferir, eles ficam bloqueados por senha para segurança caso tenha crianças em casa, e continue conduzindo normalmente para o teste grátis.

APPS POR APARELHO (indique sempre a 1ª opção primeiro, seguindo exatamente esta ordem):
- Samsung: ${formatLine(apps.samsung)} | Última opção: Chamar atendente humano (\`chamar_humano\`)
- Roku: ${formatLine(apps.roku)}
- LG: ${formatLine(apps.lg)}
- Android/Google TV / TV Box / Fire Stick: ${formatLine(apps.android)}
- iPhone / iPad (iOS): 1º WATCH HUB (chame \`enviar_logo_app\` para WATCH HUB e, ao gerar o teste, entregue com o \`codigo_watch_hub\`, Usuário e Senha)

REGRA DO DOWNLOADER (ANDROID / TV BOX / FIRE STICK):
- Se o cliente disser que usa o app Downloader para baixar (ou se for para a 3ª opção no Android/Fire Stick), peça para ele digitar o código **670156** no Downloader para instalar o **TXS PRO PLAYER**.
- Quando o cliente instalar o TXS PRO PLAYER e confirmar que pode testar agora, chame \`gerar_teste\` e entregue APENAS Usuário e Senha:
  Seu teste está pronto! Basta abrir o TXS PRO PLAYER e entrar com:
  Usuário: [usuario]
  Senha: [senha]

SMART TVS ANTIGAS E OUTRAS MARCAS (PERGUNTE SEMPRE O SISTEMA/ANO):
- Se o cliente citar TVs Philips, AOC, TCL, Sharp, Multilaser, Panasonic ou Samsung antiga, pergunte primeiro qual é o sistema da TV (se é Android/Google TV, Roku ou Smart antiga) antes de indicar o app.

ROTEIRO DO APLICATIVO CLOUDDY (PASSO A PASSO CURTO — UM PASSO POR VEZ):
- Sempre que o cliente for usar o aplicativo CLOUDDY, conduza neste ritmo (sem mandar tudo de uma vez):
  1. Passo 1 (Instalar): Peça para instalar o app **Clouddy** na loja da TV e avisar quando estiver instalado.
  2. Passo 2 (Criar conta): Assim que instalar, envie exatamente:
     "Agora pelo celular, acesse https://console.clouddy.online e crie sua conta com seu e-mail e uma senha simples. Depois abra seu e-mail e clique no link de confirmação que eles enviam. Me avisa assim que confirmar!"
  3. Passo 3 (Entrar na TV): Quando o cliente confirmar que criou e validou o e-mail, peça para ele abrir o Clouddy na TV, fazer login com esse e-mail e senha e avisar quando aparecer a tela inicial.
  4. Passo 4 (Teste): Só então chame gerar_teste e envie os dados (Usuário, Senha e Domínio) orientando o cliente a adicionar a lista no site do Clouddy (ou, se ele preferir que o suporte coloque a lista pra ele, chame chamar_humano).

1) AOC ANTIGA (só Smart, sem Roku/Android):
- 1ª opção: procurar o app CLOUDDY na loja da TV. Se não achar, orientar a clicar no botão VERDE do controle e ir mudando o país olhando um por um.
- 2ª opção (via DNS + app LOOKE): passar o passo a passo:
  1. Pressione Menu ou Configurações (engrenagem) no controle.
  2. Vá em Rede / Configurações de rede e escolha sua rede (Wi-Fi ou cabo).
  3. Em Configuração de IP / Avançado, mude de Automático (DHCP) para Manual/Estático.
  4. Coloque no DNS Primário e Secundário: 45.139.122.240
  5. Depois abra o app LOOKE.
- Se não funcionar, orientar usar Clouddy ou SSIPTV pelo navegador da TV, ou recomendar comprar um Mi Stick / Fire Stick.

2) PHILIPS / AOC / TCL / SHARP / MULTILASER (Smarts antigas):
- Indicar o app CLOUDDY (avisando que é um app pago da loja).

3) PANASONIC:
- Indicar o app WOWTV via DNS e enviar o vídeo tutorial: meajuda.top/dns_pan.mp4
- Passo a passo: Menu → Rede → Conexão de Rede → Manual → Sem fio ou Com fio → Conectar (Sim) → Endereço DNS: 45.139.122.240 → Status de Rede → Sair. Depois instalar o app WOWTV e entrar com login e senha.

4) SAMSUNG MAIS ANTIGA (menu preto, séries J e H):
- Opções disponíveis: TOP TV (via IP, app próprio e grátis — RECOMENDADO), CLOUDDY (via IP, pago), SMART STB (DNS grátis), LOOKE (DNS grátis), SMART UP (DNS grátis).
- Para instalação VIA IP (Develop), enviar o vídeo: meajuda.top/develop.mp4 e informar o IP conforme o app escolhido:
  • TOPT V (app próprio e grátis - recomendado): 45.139.122.240
  • CLOUDDY (pago): 46.165.236.165
  • SSIPTV (grátis): 91.122.100.196
  • DUPLEX PLAY (pago): 192.185.7.111 (só funciona se o controle remoto tiver o botão SMART HUB colorido)
  • SMART UP (grátis): 193.201.81.128 (só roda com DNS configurado na rede da TV)

CONDUÇÃO FIRME DE APPS (MUITO IMPORTANTE):
- Se o cliente mandar foto de um app diferente do recomendado, NÃO tente configurar esse app. Reconheça qual app ele abriu, confirme a marca da TV e peça com educação e firmeza para abrir o app certo que você indicou e mandar foto da tela inicial dele.
- Se o app mostrar tela de pagamento, licença ou ativação paga, tranquilize o cliente dizendo que ele NÃO precisa pagar nada ali dentro do app.
- Se a 1ª opção der problema, não abrir ou não tiver opção de sair/login, mude na hora para a 2ª opção da lista daquela TV, chame \`enviar_logo_app\` para o novo app e conduza a instalação dele. Só chame \`chamar_humano\` se todas as opções da TV falharem.

FERRAMENTAS:
- Ao indicar um app pela primeira vez (ou ao trocar para a 2ª/3ª opção), chame \`enviar_logo_app\` com o nome exato do app (exceto para TXS PRO PLAYER via Downloader).
- Quando o cliente instalar o app e confirmar que pode testar AGORA, chame \`gerar_teste\`.
  - Se o app escolhido for WATCH HUB e existir \`codigo_watch_hub\`, entregue EXATAMENTE neste formato:
    Seu teste está pronto, aqui os dados:
    Código: [codigo_watch_hub]
    Usuário: [usuario]
    Senha: [senha]
  - Se o app escolhido for HD PLAYER, entregue EXATAMENTE neste formato:
    Seu teste está pronto! Acesse o link abaixo e siga o passo a passo do site com o app aberto:
    https://hd.activation.click

    Código do servidor: 4200
    Usuário: [usuario]
    Senha: [senha]
  - Se o app escolhido for PLAYER MASTER, entregue EXATAMENTE neste formato:
    Seu teste está pronto! Basta abrir o PLAYER MASTER e entrar com estes dados:

    Código: 4100
    Usuário: [usuario]
    Senha: [senha]
${maxPlayerBlock}  - Se o app escolhido for TXS PRO PLAYER, entregue apenas Usuário e Senha.
  - Para os demais apps, entregue usuário, senha e domínio normalmente.
- Quando o cliente quiser fechar/comprar um plano, chame \`gerar_pix_plano\` passando \`months\` (1, 3, 6 ou 12) e \`screens\` (1, 2, 3 ou 4; padrão 1) e envie o código Pix Copia e Cola retornado avisando que a ativação é automática após o pagamento.
- Se for cliente relatando travamento, problema de pagamento, pedir humano ou esgotar as opções de app da TV, chame \`chamar_humano\`.`;
}

function buildSupportPrompt(reseller) {
  const botName = reseller?.bot_name || 'José';
  const prices = getResellerPrices(reseller);
  const hasMaxPlayer = Boolean(reseller?.maxplayer_token);

  const maxPlayerRule = hasMaxPlayer
    ? `- Esta revenda possui integração com MaxPlayer ativa. Se o problema for especificamente de lista no MaxPlayer, você pode auxiliar normalmente (além da consulta no painel NATV).`
    : `- IMPORTANTE: Esta revenda NÃO utiliza integração com MaxPlayer. Consulte os usuários APENAS pelo painel NATV (\`consultar_status_natv\`) e NUNCA mencione ou tente consultar o MaxPlayer.`;

  return `Você é o ${botName} Suporte, assistente técnico e gestor de renovações de streaming no WhatsApp.
Estilo: calmo, prestativo, paciente e objetivo. Mensagens CURTAS (máx. 3 linhas) e UM passo por vez.

REGRA DE PAINEL:
${maxPlayerRule}

FLUXO DE ATENDIMENTO DE SUPORTE:
1. PRIMEIRO PASSO (VERIFICAÇÃO NA NATV): Se o cliente disser que caiu, não funciona o reprodutor, não entra, deu erro de login ou está sem sinal, peça o usuário dele (se ainda não souber) e chame \`consultar_status_natv\` para checar se o plano está ativo, bloqueado, vencido ou já ONLINE em outra tela.
   - Se o cliente pedir ou disser que perdeu a senha/dados de acesso, consulte o status NATV e informe normalmente o usuário e a senha retornados pela ferramenta.
   - Se possivel_tela_ocupada for true, avise o cliente que o plano dele é de 1 tela e consta um acesso recente (informe o horário de ultimo_acesso), explique que abrir em dois aparelhos ao mesmo tempo derruba o sinal e pergunte se ficou aberto em outra TV/celular ou se deseja adicionar uma 2ª tela (Mensal R$ ${formatBRL(prices[2][1])}).
   - Na NATV, o nome de usuário do cliente geralmente é o próprio número de telefone (ex.: 55119...). Sempre que o cliente enviar um número ou login, chame consultar_status_natv imediatamente sem questionar.
   - Se estiver VENCIDO: avise a data de vencimento com educação e ofereça renovar na hora via Pix (usando \`gerar_pix_plano\`).
2. TRAVAMENTO / TELA PRETA / CARREGANDO (com plano ativo e livre):
   - Passo 1: Pergunte se ninguém está usando o login em outra TV/celular e peça para tirar a TV/TV Box e o roteador da tomada por 2 minutos, ligar de novo e testar.
   - Passo 2: Pergunte se está travando em todos os canais ou apenas em um canal específico.
   - Passo 3: Se continuar em todos, peça para testar no 4G do celular ou mandar foto da tela de erro.
3. FOTOS DE ERRO / APP:
   - Analise a imagem enviada. Se o app pedir pagamento/licença, tranquilize dizendo que NÃO precisa pagar nada ali dentro.
   - Se o app deslogou ou travou na tela inicial, oriente a fechar e abrir novamente ou reinstalar.
3.1. LISTA CAIU / SUMIU NO HD PLAYER (MUITO COMUM):
   - Se o cliente disser que usa o HD PLAYER e a lista caiu, sumiu ou aparece tela vazia (e o plano estiver ATIVO na consulta NATV), garanta que chamou \`consultar_status_natv\` e oriente:
     Sua lista caiu do HD Player, mas é bem rápido colocar de volta! Com o app aberto na TV, acesse este site pelo celular:
     https://hd.activation.click

     Siga o passo a passo do site (colocando o código/MAC que aparece na tela da TV) e preencha com seus dados:
     Código do servidor: 4200
     Usuário: [usuario]
     Senha: [senha]

     Depois de salvar no site, feche e abra o HD Player na TV que os canais já voltam!
4. CLIENTE DIZ QUE PAGOU E NÃO ATIVOU:
   - Peça o comprovante e chame \`chamar_humano\` se não constar ativação automática.
5. QUANDO CHAMAR HUMANO (\`chamar_humano\`):
   - Sempre que o passo a passo técnico não resolver, canal específico fora do ar, comprovante fora do Mercado Pago, estorno/alteração manual ou se o cliente insistir em falar com atendente.
6. SENHA DOS CANAIS ADULTOS (+18):
   - Informe de forma natural e discreta que a senha padrão costuma ser **0000** ou **1234**. Se nenhuma das duas funcionar, chame \`chamar_humano\`.

PLANOS PARA RENOVAÇÃO / UPGRADE:
- 1 tela: Mensal R$ ${formatBRL(prices[1][1])} | Trimestral R$ ${formatBRL(prices[1][3])} | Semestral R$ ${formatBRL(prices[1][6])} | Anual R$ ${formatBRL(prices[1][12])}
- 2 telas: Mensal R$ ${formatBRL(prices[2][1])} | Trimestral R$ ${formatBRL(prices[2][3])} | Semestral R$ ${formatBRL(prices[2][6])} | Anual R$ ${formatBRL(prices[2][12])}
- 3 telas: Mensal R$ ${formatBRL(prices[3][1])} | 4 telas: Mensal R$ ${formatBRL(prices[4][1])}`;
}

// Registro de envios do bot (evita que o eco da Evolution pause a IA)
const botSentIds = new Set();
const botSendingWindow = new Map();
const botInstanceWindow = new Map();

function markBotSending(instanceName, remoteJid) {
  const now = Date.now();
  if (instanceName) botInstanceWindow.set(instanceName, now);
  if (remoteJid) {
    const clean = String(remoteJid).replace(/@.*$/, '');
    botSendingWindow.set(clean, now);
  }
}

function isBotEcho(instanceName, remoteJid, msgId) {
  if (msgId && botSentIds.has(msgId)) return true;
  const now = Date.now();
  const clean = String(remoteJid || '').replace(/@.*$/, '');
  const lastJid = botSendingWindow.get(clean);
  if (lastJid && now - lastJid < 10000) return true;
  const lastInst = botInstanceWindow.get(instanceName);
  if (lastInst && now - lastInst < 6000) return true;
  return false;
}

function trackBotSentId(id) {
  if (!id) return;
  botSentIds.add(id);
  setTimeout(() => botSentIds.delete(id), 120000);
}

async function sendWhatsAppText(instanceName, remoteJid, text) {
  markBotSending(instanceName, remoteJid);
  try {
    const res = await fetch(`${EVOLUTION_URL}/message/sendText/${instanceName}`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: remoteJid, delay: 1200, text }),
    });
    const data = await res.json().catch(() => ({}));
    const sentId = data?.key?.id || data?.data?.key?.id;
    trackBotSentId(sentId);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error('❌ [ERRO sendWhatsAppText]:', err.message);
    return { ok: false };
  }
}

async function sendWhatsAppImage(instanceName, remoteJid, imageUrl, caption) {
  if (!imageUrl || imageUrl.includes('SEU_LINK_DO_JOSE_API')) return;
  markBotSending(instanceName, remoteJid);

  const isJpg = /\.jpe?g(\?|$)/i.test(imageUrl);
  const isWebp = /\.webp(\?|$)/i.test(imageUrl);
  const mimetype = isJpg ? 'image/jpeg' : isWebp ? 'image/webp' : 'image/png';
  const fileName = isJpg ? 'logo.jpg' : isWebp ? 'logo.webp' : 'logo.png';

  try {
    console.log(`🖼️ [ENVIANDO LOGO] Para: ${remoteJid} | URL: ${imageUrl}`);
    const res = await fetch(`${EVOLUTION_URL}/message/sendMedia/${instanceName}`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        number: remoteJid,
        mediatype: 'image',
        mimetype,
        caption,
        media: imageUrl,
        fileName,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`❌ [ERRO AO ENVIAR LOGO] Status ${res.status}:`, errBody);
    } else {
      const data = await res.json().catch(() => ({}));
      trackBotSentId(data?.key?.id || data?.data?.key?.id);
      console.log('🖼️ [LOGO ENVIADO COM SUCESSO]');
    }
  } catch (err) {
    console.error('❌ [EXCEÇÃO AO ENVIAR LOGO]:', err.message);
  }
}

async function debitWallet(resellerId, amount, category, description) {
  await pool.query(
    'UPDATE resellers SET wallet_balance = GREATEST(COALESCE(wallet_balance, 0) - $1, 0) WHERE id = $2',
    [amount, resellerId]
  );
  await pool.query(
    `INSERT INTO wallet_transactions (reseller_id, type, category, amount, description)
     VALUES ($1, 'debit', $2, $3, $4)`,
    [resellerId, category, amount, description]
  );
}

// Extrai o conteúdo real da mensagem (suporta ephemeralMessage / viewOnceMessage)
function unwrapMessageContainer(dataObj) {
  let container = dataObj?.message || dataObj?.data?.message || {};
  if (container.ephemeralMessage?.message) container = container.ephemeralMessage.message;
  if (container.viewOnceMessage?.message) container = container.viewOnceMessage.message;
  if (container.viewOnceMessageV2?.message) container = container.viewOnceMessageV2.message;
  if (container.documentWithCaptionMessage?.message) container = container.documentWithCaptionMessage.message;
  return container;
}

// Baixa mídia (áudio ou imagem) em base64 puro com 3 camadas de fallback
async function getEvolutionMediaBase64(instanceName, dataObj, key) {
  const cleanB64 = (raw) => {
    if (!raw || typeof raw !== 'string') return null;
    const stripped = raw.includes(',') ? raw.split(',')[1] : raw;
    return stripped.trim() || null;
  };

  // Camada 1: base64 já incluído no payload do webhook da Evolution API
  const inlineB64 =
    cleanB64(dataObj?.message?.base64) ||
    cleanB64(dataObj?.data?.message?.base64) ||
    cleanB64(dataObj?.base64) ||
    cleanB64(dataObj?.messageBase64);
  if (inlineB64) {
    console.log('📦 [MÍDIA] Base64 obtido diretamente do webhook.');
    return inlineB64;
  }

  // Camada 2: Endpoint oficial Evolution API v2 (/chat/getBase64FromMediaMessage)
  const msgKey = key || dataObj?.key || dataObj?.data?.key;
  const payloadsToTry = [
    ...(msgKey ? [{ message: { key: msgKey }, convertToMp4: false }] : []),
    { message: dataObj?.data || dataObj, convertToMp4: false },
  ];

  for (const payload of payloadsToTry) {
    try {
      const res = await fetch(`${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${instanceName}`, {
        method: 'POST',
        headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        const found = cleanB64(json.base64 || json.data?.base64);
        if (found) {
          console.log('📦 [MÍDIA] Base64 obtido via getBase64FromMediaMessage.');
          return found;
        }
      } else {
        const errText = await res.text().catch(() => '');
        console.warn(`⚠️ [MÍDIA] Evolution retornou ${res.status}: ${errText.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn('⚠️ [MÍDIA] Erro na chamada getBase64FromMediaMessage:', err.message);
    }
  }

  console.error('❌ [MÍDIA] Não foi possível obter base64 da mídia na Evolution API.');
  return null;
}

// Analisa áudio ou imagem diretamente via API nativa do Gemini com retry + fallback de modelos
async function analyzeMediaWithGemini(base64, mimeType, promptText) {
  const apiKey = (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey || !base64) {
    console.error('❌ [GEMINI MÍDIA] Chave de API ou base64 ausente.');
    return null;
  }

  const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '').trim();
  const cleanMime = String(mimeType || 'audio/ogg').split(';')[0].trim();
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: promptText },
                    { inlineData: { mimeType: cleanMime, data: cleanBase64 } },
                  ],
                },
              ],
            }),
          }
        );

        if (res.ok) {
          const data = await res.json();
          const resultText = data?.candidates?.[0]?.content?.parts
            ?.map((p) => p.text)
            .filter(Boolean)
            .join('\n')
            .trim();
          if (resultText) return resultText;
        } else {
          const errText = await res.text().catch(() => '');
          console.error(`❌ [GEMINI MÍDIA ${model} tentativa ${attempt}] Status ${res.status}: ${errText.slice(0, 250)}`);
          if (res.status === 503 || res.status === 429) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          break;
        }
      } catch (err) {
        console.error(`❌ [GEMINI MÍDIA ${model}] Exceção:`, err.message);
      }
    }
  }
  return null;
}

async function callGeminiWithFallback(apiKey, messagesPayload, tools) {
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0.3, messages: messagesPayload, tools }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, status: res.status, data };
      if (res.status === 503 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      return { ok: false, status: res.status, data };
    }
  }
  return { ok: false, status: 503, data: { error: 'Todos os modelos Gemini indisponíveis.' } };
}

const processedMessages = new Set();

app.post('/api/webhooks/evolution', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body || {};
    const event = body.event || body.type;
    const instance = body.instance;
    const dataObj = body.data || body;

    if (event && (event.includes('contact') || event.includes('chat') || event.includes('connection') || event.includes('presence'))) {
      return;
    }

    const key = dataObj.key || dataObj.data?.key;
    const remoteJid = key?.remoteJid || dataObj.remoteJid;
    const fromMe = key?.fromMe || dataObj.fromMe;
    const msgId = key?.id || `${remoteJid}:${Date.now()}`;

    if (!remoteJid || remoteJid.includes('@g.us')) return;

    // DETECÇÃO DE INTERVENÇÃO HUMANA PELO CELULAR (pausa apenas no José Suporte)
    if (fromMe) {
      if (!remoteJid.endsWith('@lid') && !isBotEcho(instance, remoteJid, msgId)) {
        const instCheck = await pool.query(
          `SELECT reseller_id, COALESCE(bot_type, 'sales') AS bot_type
           FROM whatsapp_instances WHERE instance_name = $1`,
          [instance]
        );
        const inst = instCheck.rows[0];
        if (inst?.reseller_id && inst.bot_type === 'support') {
          await pool.query(
            `UPDATE leads SET needs_human = true, last_interaction = now() WHERE reseller_id = $1 AND phone = $2`,
            [inst.reseller_id, remoteJid]
          );
          console.log(`✋ [HUMANO ASSUMIU NO CELULAR] IA pausada no Suporte para ${remoteJid}`);
        }
      }
      return;
    }

    // 1. TRAVA IMEDIATA CONTRA DUPLICIDADE
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);
    setTimeout(() => processedMessages.delete(msgId), 60000);

    const messageContainer = unwrapMessageContainer(dataObj);
    let text =
      messageContainer.conversation ||
      messageContainer.extendedTextMessage?.text ||
      dataObj.text ||
      '';
    let mediaUrl = null;

    const audioMsg = messageContainer.audioMessage || messageContainer.pttMessage;
    const imageMsg = messageContainer.imageMessage;

    console.log(
      `2. [MENSAGEM CAPTURADA] De: ${remoteJid} | Instância: ${instance} | Tipo: ${
        audioMsg ? 'ÁUDIO' : imageMsg ? 'IMAGEM' : 'TEXTO'
      } | Texto: ${text || '[Mídia]'}`
    );

    // PROCESSAMENTO DE ÁUDIO (PTT / Voice Note / Audio)
    if (!text && audioMsg) {
      const base64 = await getEvolutionMediaBase64(instance, dataObj, key);
      if (base64) {
        const mimeType = (audioMsg.mimetype || 'audio/ogg').split(';')[0].trim();
        const transcript = await analyzeMediaWithGemini(
          base64,
          mimeType,
          'Transcreva fielmente em português tudo o que a pessoa falou neste áudio. Retorne apenas a transcrição, sem comentários.'
        );
        if (transcript) {
          text = `[Áudio transcrito]: ${transcript}`;
          console.log(`🎙️ [ÁUDIO TRANSCRITO]: ${transcript}`);
        }
      }
      if (!text) text = '[O cliente enviou um áudio que não pôde ser transcrito.]';
    }

    // PROCESSAMENTO DE IMAGEM (FOTOS DE TV, APP, ERRO, COMPROVANTE)
    if (imageMsg) {
      const caption = (imageMsg.caption || '').trim();
      const mimeType = (imageMsg.mimetype || 'image/jpeg').split(';')[0].trim();
      const base64 = await getEvolutionMediaBase64(instance, dataObj, key);

      if (base64) {
        mediaUrl = `data:${mimeType};base64,${base64}`;
        const visionPrompt =
          'Analise esta imagem enviada por um cliente de streaming/IPTV no WhatsApp. ' +
          'Descreva objetivamente em português: ' +
          '1) Qual aplicativo está aberto na tela (se identificável); ' +
          '2) Se for tela de login, TRANSCREVA EXATAMENTE caractere por caractere o que está digitado nos campos de Código/Servidor, Usuário e Senha; ' +
          '3) Qualquer mensagem de erro exibida (ex: "Servidor rejeitou as credenciais", "Invalid credentials"); ' +
          '4) Se aparece tela de pagamento/licença, código/MAC/Device Key, ou comprovante PIX (com valor e status). Seja direto e preciso.';
        const visionAnalysis = await analyzeMediaWithGemini(base64, mimeType, visionPrompt);

        if (visionAnalysis) {
          console.log(`👁️ [IMAGEM ANALISADA]: ${visionAnalysis.slice(0, 150)}...`);
          text = caption
            ? `${caption}\n[Análise da foto enviada pelo cliente]: ${visionAnalysis}`
            : `[Análise da foto enviada pelo cliente]: ${visionAnalysis}`;
        } else {
          text = caption || '[O cliente enviou uma foto.]';
        }
      } else {
        if (imageMsg.jpegThumbnail) {
          const thumb = typeof imageMsg.jpegThumbnail === 'string'
            ? imageMsg.jpegThumbnail
            : Buffer.from(imageMsg.jpegThumbnail).toString('base64');
          mediaUrl = `data:image/jpeg;base64,${thumb}`;
        }
        text = caption || '[O cliente enviou uma foto.]';
      }
    }

    if (!text && !mediaUrl) return;

    const pushName = dataObj.pushName || body.pushName || 'Cliente';

    // 2. Busca o revendedor
    const instRes = await pool.query(
      `SELECT r.*, COALESCE(wi.bot_type, 'sales') AS bot_type
       FROM whatsapp_instances wi
       JOIN resellers r ON r.id = wi.reseller_id
       WHERE wi.instance_name = $1`,
      [instance]
    );
    const activeReseller = instRes.rows[0];
    if (!activeReseller) return;

    const isVip = isVipReseller(activeReseller);
    const isSupportBot = activeReseller?.bot_type === 'support';

    if (!activeReseller.bot_active || (!isVip && Number(activeReseller.wallet_balance) <= 0)) return;

    // 3. Busca ou cria Lead
    let leadRes = await pool.query(
      'SELECT * FROM leads WHERE reseller_id = $1 AND phone = $2',
      [activeReseller.id, remoteJid]
    );
    let lead = leadRes.rows[0];

    const previewMsg = imageMsg ? (imageMsg.caption || '📷 Foto enviada') : text;

    if (!lead) {
      const insertLead = await pool.query(
        `INSERT INTO leads (reseller_id, phone, name, last_message, instance_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [activeReseller.id, remoteJid, pushName, previewMsg, instance]
      );
      lead = insertLead.rows[0];
    } else {
      await pool.query(
        'UPDATE leads SET last_message = $1, last_interaction = now(), followup_step = 0, instance_name = $2 WHERE id = $3',
        [previewMsg, instance, lead.id]
      );
      lead.instance_name = instance;
    }

    await pool.query(
      `INSERT INTO messages (lead_id, sender, content, media_url) VALUES ($1, 'client', $2, $3)`,
      [lead.id, text, mediaUrl]
    );

    // Se humano já assumiu, para aqui!
    if (lead.needs_human) {
      console.log(`⏸️ [IA PAUSADA] Ignorando resposta automática para ${remoteJid}`);
      return;
    }

    // 4. Histórico recente
    const histRes = await pool.query(
      `SELECT sender, content FROM messages WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 12`,
      [lead.id]
    );
    const history = histRes.rows.reverse().map((m) => ({
      role: m.sender === 'client' ? 'user' : 'assistant',
      content: m.content,
    }));

    const tools = [
      {
        type: 'function',
        function: {
          name: 'enviar_logo_app',
          description: 'Envia a imagem do logo do aplicativo recomendado para o cliente.',
          parameters: {
            type: 'object',
            properties: { app_name: { type: 'string', description: 'Nome exato do aplicativo recomendado.' } },
            required: ['app_name'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'gerar_teste',
          description: 'Gera um teste grátis de 60 minutos na conta NATV do revendedor.',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'consultar_status_natv',
          description: 'Consulta na NATV se o usuário do cliente está ativo, vencido, bloqueado e telas.',
          parameters: {
            type: 'object',
            properties: { username: { type: 'string', description: 'Nome de usuário do cliente na NATV.' } },
            required: ['username'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'gerar_pix_plano',
          description: 'Gera o Pix Copia e Cola na conta Mercado Pago do revendedor.',
          parameters: {
            type: 'object',
            properties: {
              months: { type: 'number', enum: [1, 3, 6, 12] },
              screens: { type: 'number', enum: [1, 2, 3, 4] },
            },
            required: ['months'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'chamar_humano',
          description: 'Pausa a IA e alerta o revendedor no WhatsApp de suporte humano para assumir o atendimento.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];

    const leadContextNote =
      `[DADOS ATUAIS DO LEAD PARA CONFERÊNCIA]\n` +
      `- Estágio: ${lead.stage || 'NOVO'}\n` +
      `- App escolhido: ${lead.chosen_app || 'Ainda não escolhido'}\n` +
      `- Usuário NATV gerado: ${lead.natv_username || 'Nenhum'}\n` +
      `- Senha NATV gerada: ${lead.natv_password || 'Nenhuma'}\n` +
      `- Código Watch Hub da revenda: ${activeReseller.watch_hub_code || 'Não configurado'}`;

    const messagesPayload = [
      {
        role: 'system',
        content: `${isSupportBot ? buildSupportPrompt(activeReseller) : buildSalesPrompt(activeReseller)}\n\n${leadContextNote}`,
      },
      ...history,
    ];

    const apiKey = (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '').trim();

    // 5. Primeira chamada ao Gemini
    let aiRes = await callGeminiWithFallback(apiKey, messagesPayload, tools);
    let aiData = aiRes.data;
    if (!aiRes.ok) {
      console.error('❌ [ERRO API GEMINI]:', aiRes.status, JSON.stringify(aiData));
      return;
    }

    let msg = aiData.choices?.[0]?.message;
    let sentLogoApp = null;

    // 6. Execução de ferramentas
    if (msg?.tool_calls?.length) {
      messagesPayload.push(msg);

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');
        let toolResult = 'ok';

        if (fnName === 'enviar_logo_app') {
          const appName = String(args.app_name || '').trim();
          const resellerApps = Object.values(getResellerApps(activeReseller, true)).flat();
          const customMatch = resellerApps.find((a) => a.name.toUpperCase() === appName.toUpperCase());
          const logoUrl = customMatch?.logo || APP_LOGOS[appName.toUpperCase()] || '';

          lead.chosen_app = appName;
          sentLogoApp = appName;
          await pool.query('UPDATE leads SET chosen_app = $1 WHERE id = $2', [appName, lead.id]);

          if (logoUrl) {
            await sendWhatsAppImage(instance, remoteJid, logoUrl, `Procura por esse ícone na loja: ${appName} 📺`);
            await pool.query(
              `INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'jose_ai', $2)`,
              [lead.id, `[Logo enviado: ${appName}]`]
            );
            toolResult = `Logo do ${appName} enviado com sucesso. Agora responda ao cliente em texto curto pedindo para instalar o ${appName} na loja da TV e mandar foto da tela inicial quando abrir.`;
          } else {
            toolResult = `App ${appName} registrado (sem imagem de logo). Agora responda ao cliente em texto curto orientando a instalar o ${appName} e avisar quando abrir.`;
          }
        }

        if (fnName === 'consultar_status_natv') {
          const busca = String(args.username || lead.natv_username || lead.phone || '').trim().toLowerCase();
          if (!activeReseller.natv_api_key) {
            toolResult = 'Erro: revendedor sem chave NATV configurada.';
          } else {
            try {
              const baseUrl = (process.env.NATV_API_URL || 'https://revenda.pixbot.link').replace(/\/$/, '');
              const natvRes = await fetch(`${baseUrl}/report/allusers`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeReseller.natv_api_key}` },
              });
              if (natvRes.ok) {
                const data = await natvRes.json();
                const lista = Array.isArray(data) ? data : data.users || data.data || data.clients || [];
                const buscaLimpa = busca.replace(/\D/g, '');
                const found = lista.find((u) => {
                  const userLogin = String(u.u || '').trim().toLowerCase();
                  const userLimpo = userLogin.replace(/\D/g, '');
                  return userLogin === busca || (buscaLimpa.length >= 8 && userLimpo.endsWith(buscaLimpa.slice(-8)));
                });
                if (!found) {
                  toolResult = JSON.stringify({ encontrado: false, mensagem: 'Usuário não encontrado no painel NATV.' });
                } else {
                  lead.natv_username = found.u;
                  await pool.query('UPDATE leads SET natv_username = $1, natv_password = COALESCE($2, natv_password) WHERE id = $3', [
                    found.u,
                    found.p || null,
                    lead.id,
                  ]);
                  const expMs = found.e ? Date.parse(String(found.e).replace(' ', 'T')) : NaN;
                  const expired = !Number.isNaN(expMs) && expMs < Date.now();
                  const ultimoAcesso = found.l || null;
                  const maxTelas = Number(found.c || 1);
                  let usoRecente = false;
                  if (ultimoAcesso) {
                    const dataAcesso = new Date(ultimoAcesso.replace(' ', 'T') + '-03:00');
                    const diffMinutos = (Date.now() - dataAcesso.getTime()) / 60000;
                    if (!Number.isNaN(diffMinutos) && diffMinutos >= -5 && diffMinutos <= 15) usoRecente = true;
                  }
                  toolResult = JSON.stringify({
                    encontrado: true,
                    usuario: found.u,
                    senha: found.p || null,
                    status: expired ? 'VENCIDO' : String(found.t || 'ATIVO').toUpperCase(),
                    bloqueado: found.b === 'Yes' || found.b === true,
                    vencimento: found.e || 'Não informado',
                    max_telas: maxTelas,
                    ultimo_acesso: ultimoAcesso,
                    possivel_tela_ocupada: maxTelas === 1 && usoRecente,
                  });
                }
              } else {
                toolResult = JSON.stringify({ encontrado: false, erro: 'Painel NATV temporariamente ocupado.' });
              }
            } catch {
              toolResult = JSON.stringify({ encontrado: false, erro: 'Erro interno ao consultar NATV.' });
            }
          }
        }

        if (fnName === 'gerar_teste') {
          if (!activeReseller.natv_api_key) {
            toolResult = 'Erro: revendedor sem chave NATV configurada.';
          } else {
            const clientPhone = String(lead.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
            const natvRes = await fetch('https://revenda.pixbot.link/user', {
              method: 'POST',
              headers: { Authorization: `Bearer ${activeReseller.natv_api_key}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ minutes: '60', ...(clientPhone ? { username: clientPhone } : {}) }),
            });
            const natvUser = await natvRes.json();
            if (natvRes.ok) {
              lead.natv_username = natvUser.username;
              await pool.query(
                `UPDATE leads SET stage = 'TESTE', natv_username = $1, natv_password = $2, followup_step = 0, test_created_at = now() WHERE id = $3`,
                [natvUser.username, natvUser.password || null, lead.id]
              );
              if (!isVip) {
                await debitWallet(
                  activeReseller.id,
                  Number(activeReseller.cost_per_test ?? 0.18),
                  'test_created',
                  `Teste gerado: ${natvUser.username}`
                );
              }

              let maxplayerCadastrado = false;
              const isMaxPlayer = String(lead.chosen_app || '').toUpperCase().includes('MAXPLAYER');
              if (isMaxPlayer && activeReseller.maxplayer_token) {
                const mpSync = await syncUserToMaxPlayer(activeReseller, lead, natvUser);
                maxplayerCadastrado = Boolean(mpSync.ok);
              }

              toolResult = JSON.stringify({
                app_escolhido: lead.chosen_app || '',
                codigo_watch_hub: activeReseller.watch_hub_code || '',
                maxplayer_cadastrado: maxplayerCadastrado,
                usuario: natvUser.username,
                senha: natvUser.password,
                dominio: natvUser.domain,
              });
            } else {
              toolResult = 'Erro ao gerar teste na NATV.';
            }
          }
        }

        if (fnName === 'gerar_pix_plano') {
          const screens = Number(args.screens) || 1;
          const months = Number(args.months) || 1;
          const prices = getResellerPrices(activeReseller);
          const amount = prices[screens]?.[months];
          if (!amount) {
            toolResult = `Plano indisponível para ${screens} tela(s) e ${months} mês(es).`;
          } else if (!activeReseller.mp_access_token) {
            toolResult = 'Erro: revendedor sem Mercado Pago configurado. Chame um humano.';
          } else if (!lead.natv_username) {
            toolResult = 'Erro: cliente ainda não possui usuário identificado.';
          } else {
            const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${activeReseller.mp_access_token}`,
                'Content-Type': 'application/json',
                'X-Idempotency-Key': `plan-${lead.id}-${Date.now()}`,
              },
              body: JSON.stringify({
                transaction_amount: amount,
                description: `Plano ${months} mês(es) - ${screens} tela(s) - ${lead.natv_username}`,
                payment_method_id: 'pix',
                payer: { email: `${lead.natv_username}@cliente.com` },
                external_reference: `${lead.id}|${months}|${screens}`,
                notification_url: `${BASE_URL}/api/webhooks/mp-reseller/${activeReseller.id}`,
              }),
            });
            const payment = await mpRes.json();
            const pixCode = payment.point_of_interaction?.transaction_data?.qr_code;
            toolResult = pixCode
              ? JSON.stringify({ valor: amount, meses: months, telas: screens, pix_copia_e_cola: pixCode })
              : 'Erro ao gerar Pix no Mercado Pago.';
          }
        }

        if (fnName === 'chamar_humano') {
          await pool.query(`UPDATE leads SET needs_human = true, tab = 'suporte' WHERE id = $1`, [lead.id]);
          if (activeReseller.support_whatsapp) {
            const digits = String(activeReseller.support_whatsapp).replace(/\D/g, '');
            const supportNumber = digits.length <= 11 ? `55${digits}` : digits;
            const supportJid = `${supportNumber}@s.whatsapp.net`;
            const clientPhone = String(lead.phone || '').replace(/@.*$/, '');
            const botLabel = activeReseller.bot_name || 'José';
            const originLabel = isSupportBot ? `${botLabel} Suporte` : `${botLabel} Vendas`;
            const alertMsg = `🚨 *Atendimento Humano Solicitado (${originLabel})*\n\nCliente: ${lead.name || 'Sem nome'}\nNúmero: ${clientPhone}\nÚltima msg: ${previewMsg}\n\nA IA foi pausada nessa conversa para você assumir.`;
            const sent = await sendWhatsAppText(instance, supportJid, alertMsg);
            console.log(`📣 [ALERTA HUMANO] Enviado para ${supportJid} (${originLabel}) | OK: ${sent.ok}`);
          } else {
            console.warn(`⚠️ [ALERTA HUMANO] Revendedor ${activeReseller.id} sem WhatsApp de suporte humano cadastrado.`);
          }
          toolResult = 'Atendimento transferido para humano.';
        }

        messagesPayload.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
      }

      // 7. Segunda chamada ao Gemini
      aiRes = await callGeminiWithFallback(apiKey, messagesPayload, tools);
      aiData = aiRes.data;
      if (!aiRes.ok) {
        console.error('❌ [ERRO API GEMINI - PASSO 7]:', aiRes.status, JSON.stringify(aiData));
      }
      msg = aiData.choices?.[0]?.message;
    }

    let replyText = msg?.content?.trim();

    if (!replyText && sentLogoApp) {
      replyText = `Te enviei o ícone do ${sentLogoApp} acima 👆 Pode procurar ele na loja da sua TV, instalar e me mandar uma foto da tela inicial dele?`;
    }

    if (replyText) {
      await sendWhatsAppText(instance, remoteJid, replyText);
      console.log('6. [ENVIADO COM SUCESSO]');

      if (!isVip) {
        await debitWallet(activeReseller.id, Number(activeReseller.cost_per_reply ?? 0.09), 'reply', `Resposta IA: ${lead.name || lead.phone}`);
      }
      await pool.query(`INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'jose_ai', $2)`, [lead.id, replyText]);
      await pool.query('UPDATE leads SET last_message = $1, last_interaction = now() WHERE id = $2', [replyText, lead.id]);
    }
  } catch (err) {
    console.error('❌ ERRO CRÍTICO NO WEBHOOK:', err);
  }
});

// ==========================================
// 7. CHAT AO VIVO, ESTATÍSTICAS E BOTÕES DA GAVETA DE LEADS
// ==========================================
app.get('/api/leads', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         id, phone, name, last_message, last_interaction, stage, chosen_app,
         natv_username, natv_password, needs_human, needs_human AS ai_paused,
         tab, instance_name, test_created_at, created_at,
         CASE
           WHEN COALESCE(instance_name, '') LIKE 'jose_sup_%' OR COALESCE(tab, '') = 'suporte' THEN 'support'
           ELSE 'sales'
         END AS bot_type
       FROM leads
       WHERE reseller_id = $1
       ORDER BY last_interaction DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: 'Erro ao carregar conversas' });
  }
});

app.get('/api/leads/stats', auth, async (req, res) => {
  try {
    const todayBrStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const startOfTodayBr = new Date(`${todayBrStr}T00:00:00-03:00`);

    const [leadsResult, salesResult] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE last_interaction >= $2) AS conversations_today,
           COUNT(*) FILTER (WHERE test_created_at >= $2) AS tests_today
         FROM leads
         WHERE reseller_id = $1`,
        [req.user.id, startOfTodayBr]
      ),
      pool.query(
        `SELECT COUNT(*) AS sales_today
         FROM processed_payments
         WHERE reseller_id = $1
           AND created_at >= $2`,
        [req.user.id, startOfTodayBr]
      ),
    ]);

    const conversationsToday = Number(leadsResult.rows[0]?.conversations_today || 0);
    const testsToday = Number(leadsResult.rows[0]?.tests_today || 0);
    const salesToday = Number(salesResult.rows[0]?.sales_today || 0);
    const conversionRate =
      conversationsToday > 0
        ? Number(((salesToday / conversationsToday) * 100).toFixed(1))
        : 0;

    console.log(
      `📊 [STATS ${req.user.id.slice(0, 6)}] Conversas: ${conversationsToday} | Testes: ${testsToday} | Vendas: ${salesToday}`
    );

    res.json({
      conversations_today: conversationsToday,
      tests_today: testsToday,
      sales_today: salesToday,
      conversion_rate: conversionRate,
    });
  } catch (err) {
    console.error('❌ [ERRO /api/leads/stats]:', err.message);
    res.status(500).json({ error: 'Erro ao carregar estatísticas' });
  }
});

app.get('/api/leads/:leadId', auth, async (req, res) => {
  try {
    const leadRes = await pool.query(
      `SELECT id, phone, name, last_message, last_interaction, stage, chosen_app, natv_username, natv_password, needs_human, needs_human AS ai_paused, tab, test_created_at, created_at
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
    const leadCheck = await pool.query('SELECT id FROM leads WHERE id = $1 AND reseller_id = $2', [req.params.leadId, req.user.id]);
    if (!leadCheck.rows[0]) return res.status(404).json({ error: 'Conversa não encontrada' });

    const msgs = await pool.query(
      'SELECT id, sender, content, content AS text, media_url, created_at FROM messages WHERE lead_id = $1 ORDER BY created_at ASC',
      [req.params.leadId]
    );
    res.json(msgs.rows);
  } catch {
    res.status(500).json({ error: 'Erro ao carregar mensagens' });
  }
});

app.post('/api/leads/:leadId/messages', auth, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Digite uma mensagem' });

  try {
    const leadRes = await pool.query('SELECT * FROM leads WHERE id = $1 AND reseller_id = $2', [req.params.leadId, req.user.id]);
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: 'Conversa não encontrada' });

    let instanceName = lead.instance_name;
    if (!instanceName) {
      const instRes = await pool.query(`SELECT instance_name FROM whatsapp_instances WHERE reseller_id = $1 LIMIT 1`, [req.user.id]);
      instanceName = instRes.rows[0]?.instance_name;
    }
    if (!instanceName) return res.status(400).json({ error: 'WhatsApp não conectado' });

    await sendWhatsAppText(instanceName, lead.phone, text.trim());
    const saved = await pool.query(
      `INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'human', $2) RETURNING id, sender, content, content AS text, media_url, created_at`,
      [lead.id, text.trim()]
    );
    const isSupportInstance = String(instanceName || '').startsWith('jose_sup_');
    if (isSupportInstance) {
      await pool.query(
        `UPDATE leads SET last_message = $1, last_interaction = now(), needs_human = true WHERE id = $2`,
        [text.trim(), lead.id]
      );
    } else {
      await pool.query(
        `UPDATE leads SET last_message = $1, last_interaction = now() WHERE id = $2`,
        [text.trim(), lead.id]
      );
    }

    res.json(saved.rows[0]);
  } catch {
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

// Alternar IA (Pausar / Reativar / Assumir Conversa)
app.post('/api/leads/:leadId/toggle-ai', auth, async (req, res) => {
  const { pause_ai, needs_human, ai_paused } = req.body || {};
  const paused = Boolean(pause_ai ?? needs_human ?? ai_paused);
  try {
    await pool.query(
      'UPDATE leads SET needs_human = $1 WHERE id = $2 AND reseller_id = $3',
      [paused, req.params.leadId, req.user.id]
    );
    res.json({ success: true, needs_human: paused, ai_paused: paused });
  } catch (err) {
    console.error('❌ [ERRO /toggle-ai]:', err.message);
    res.status(500).json({ error: 'Erro ao alterar status da IA' });
  }
});

// Resetar Lead
app.post('/api/leads/:leadId/reset', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE leads
       SET stage = 'NOVO', natv_username = NULL, natv_password = NULL, chosen_app = NULL,
           followup_step = 0, needs_human = false
       WHERE id = $1 AND reseller_id = $2`,
      [req.params.leadId, req.user.id]
    );
    res.json({ success: true, message: 'Lead resetado com sucesso!' });
  } catch (err) {
    console.error('❌ [ERRO /reset]:', err.message);
    res.status(500).json({ error: 'Erro ao resetar lead' });
  }
});

// Deletar Lead (remove mensagens antes para evitar erro de chave estrangeira)
app.delete('/api/leads/:leadId', auth, async (req, res) => {
  try {
    const check = await pool.query('SELECT id FROM leads WHERE id = $1 AND reseller_id = $2', [req.params.leadId, req.user.id]);
    if (!check.rows[0]) return res.status(404).json({ error: 'Lead não encontrado' });

    await pool.query('DELETE FROM messages WHERE lead_id = $1', [req.params.leadId]);
    await pool.query('DELETE FROM leads WHERE id = $1 AND reseller_id = $2', [req.params.leadId, req.user.id]);
    res.json({ success: true, message: 'Lead deletado com sucesso!' });
  } catch (err) {
    console.error('❌ [ERRO DELETE /api/leads/:leadId]:', err.message);
    res.status(500).json({ error: 'Erro ao deletar lead' });
  }
});

// Gerar Teste pelo Painel (Gaveta do Lead)
app.post('/api/leads/:leadId/generate-test', auth, async (req, res) => {
  try {
    const leadRes = await pool.query('SELECT * FROM leads WHERE id = $1 AND reseller_id = $2', [req.params.leadId, req.user.id]);
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    const resRes = await pool.query('SELECT * FROM resellers WHERE id = $1', [req.user.id]);
    const reseller = resRes.rows[0];
    if (!reseller?.natv_api_key) return res.status(400).json({ error: 'Revendedor sem chave NATV configurada.' });

    const clientPhone = String(lead.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
    const natvRes = await fetch('https://revenda.pixbot.link/user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${reseller.natv_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: '60', ...(clientPhone ? { username: clientPhone } : {}) }),
    });
    const natvUser = await natvRes.json().catch(() => ({}));

    if (!natvRes.ok || !natvUser.username) {
      return res.status(400).json({ error: natvUser.message || 'Erro ao gerar teste na NATV.' });
    }

    await pool.query(
      `UPDATE leads SET stage = 'TESTE', natv_username = $1, natv_password = $2, followup_step = 0, test_created_at = now() WHERE id = $3`,
      [natvUser.username, natvUser.password || null, lead.id]
    );

    if (String(lead.chosen_app || '').toUpperCase().includes('MAXPLAYER') && reseller.maxplayer_token) {
      await syncUserToMaxPlayer(reseller, lead, natvUser);
    }

    res.json({
      success: true,
      usuario: natvUser.username,
      senha: natvUser.password || '',
      dominio: natvUser.domain || '',
    });
  } catch (err) {
    console.error('❌ [ERRO /generate-test]:', err.message);
    res.status(500).json({ error: 'Erro interno ao criar teste' });
  }
});

// Adicionar Tempo ao Teste (+1h, +3h, +6h)
app.post('/api/leads/:leadId/add-time', auth, async (req, res) => {
  const hours = Math.min(Math.max(Number(req.body?.hours) || 1, 1), 6);
  try {
    const leadRes = await pool.query('SELECT * FROM leads WHERE id = $1 AND reseller_id = $2', [req.params.leadId, req.user.id]);
    const lead = leadRes.rows[0];
    if (!lead || !lead.natv_username) {
      return res.status(400).json({ error: 'Lead ainda não possui usuário NATV gerado.' });
    }

    const resRes = await pool.query('SELECT natv_api_key FROM resellers WHERE id = $1', [req.user.id]);
    const reseller = resRes.rows[0];
    if (!reseller?.natv_api_key) {
      return res.status(400).json({ error: 'Chave NATV não configurada.' });
    }

    const natvRes = await fetch('https://revenda.pixbot.link/user/extension', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${reseller.natv_api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: lead.natv_username, hours }),
    });

    if (!natvRes.ok) {
      const errBody = await natvRes.text().catch(() => '');
      console.error('❌ [NATV EXTENSION]:', natvRes.status, errBody);
      return res.status(400).json({ error: 'A API NATV recusou a extensão de tempo para este usuário.' });
    }

    res.json({ success: true, message: `+${hours}h adicionadas com sucesso!` });
  } catch (err) {
    console.error('❌ [ERRO /add-time]:', err.message);
    res.status(500).json({ error: 'Erro interno ao adicionar tempo' });
  }
});

// ==========================================
// 8. CLIENTES NATV & TABELAS
// ==========================================
const natvClientsCache = new Map();

app.get('/api/natv/clients', auth, async (req, res) => {
  const userId = req.user.id;
  const cached = natvClientsCache.get(userId);
  if (cached && Date.now() - cached.ts < 65000) return res.json(cached.payload);

  try {
    const r = await pool.query('SELECT name, natv_api_key FROM resellers WHERE id = $1', [userId]);
    const natvKey = r.rows[0]?.natv_api_key;
    const resellerName = String(r.rows[0]?.name || '').trim().toLowerCase();
    if (!natvKey) return res.status(400).json({ error: 'Chave NATV não configurada' });

    const baseUrl = (process.env.NATV_API_URL || 'https://revenda.pixbot.link').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/report/allusers`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${natvKey}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) return res.status(400).json({ error: 'Erro ao consultar NATV' });

    const raw = await response.json();
    const list = Array.isArray(raw) ? raw : (raw.data || raw.users || raw.clients || []);

    const activeClients = list
      .filter((c) => {
        const isAtivo = String(c.t || '').trim().toLowerCase() === 'ativo';
        const dono = String(c.r || '').trim().toLowerCase();
        const isMeu = !resellerName || !dono || dono === resellerName;
        return isAtivo && isMeu;
      })
      .map((c, idx) => ({
        id: String(c.i ?? idx),
        username: String(c.u ?? 'Cliente'),
        name: String(c.n || c.u || 'Cliente'),
        exp_date: c.e ?? null,
      }));

    const payload = { total_active: activeClients.length, clients: activeClients };
    natvClientsCache.set(userId, { ts: Date.now(), payload });
    res.json(payload);
  } catch {
    res.status(500).json({ error: 'Erro interno' });
  }
});

async function initFollowupColumns() {
  try {
    await pool.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS followup_step INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS renewal_last_exp TEXT,
      ADD COLUMN IF NOT EXISTS renewal_stage TEXT,
      ADD COLUMN IF NOT EXISTS instance_name TEXT,
      ADD COLUMN IF NOT EXISTS test_created_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS natv_password TEXT;
    `);

    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS maxplayer_token TEXT;`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS support_whatsapp TEXT;`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS custom_apps JSONB;`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS bot_name TEXT DEFAULT 'José';`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS custom_prices JSONB;`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS gestor_provider TEXT;`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS gestor_webhook_url TEXT;`);
    await pool.query(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS gestor_token TEXT;`);
    await pool.query(`ALTER TABLE resellers ALTER COLUMN natv_credits TYPE NUMERIC(10,2) USING natv_credits::numeric;`);
    await pool.query(`ALTER TABLE resellers ALTER COLUMN cost_per_reply SET DEFAULT 0.09;`);
    await pool.query(`ALTER TABLE resellers ALTER COLUMN cost_per_test SET DEFAULT 0.18;`);
    await pool.query(`ALTER TABLE resellers ALTER COLUMN cost_per_activation SET DEFAULT 0.18;`);
    await pool.query(`UPDATE resellers SET cost_per_reply = 0.09, cost_per_test = 0.18, cost_per_activation = 0.18;`);
    await pool.query(`ALTER TABLE whatsapp_instances ADD COLUMN IF NOT EXISTS bot_type TEXT DEFAULT 'sales';`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS processed_payments (
        payment_id TEXT PRIMARY KEY,
        reseller_id UUID,
        lead_id UUID,
        created_at TIMESTAMP DEFAULT now()
      );
    `);
    console.log('Colunas e tabelas do banco verificadas com sucesso.');
  } catch (err) {
    console.error('Erro ao criar colunas/tabelas:', err.message);
  }
}

initFollowupColumns();

// ==========================================
// 9. NOVIDADES (VOD + TOP 10 + JOGOS COM CANAIS) E REMARKETING
// ==========================================
let vodCache = { ts: 0, data: null };
let gamesCache = { ts: 0, data: null };

async function fetchTodayGames() {
  if (gamesCache.data && Date.now() - gamesCache.ts < 15 * 60 * 1000) {
    return gamesCache.data;
  }

  const todayBr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).replace(/-/g, '');

  const leagues = [
    { slug: 'bra.1', name: 'Brasileirão Série A', defaultChannels: 'Premiere / SporTV / Globo' },
    { slug: 'bra.2', name: 'Brasileirão Série B', defaultChannels: 'Premiere / SporTV / Band' },
    { slug: 'bra.copa_do_brasil', name: 'Copa do Brasil', defaultChannels: 'Premiere / SporTV / Prime Video' },
    { slug: 'conmebol.libertadores', name: 'Libertadores', defaultChannels: 'ESPN / Disney+ / Paramount+' },
    { slug: 'conmebol.sudamericana', name: 'Sul-Americana', defaultChannels: 'ESPN / Disney+ / Paramount+' },
    { slug: 'uefa.champions', name: 'Champions League', defaultChannels: 'TNT / Space / Max' },
    { slug: 'eng.1', name: 'Premier League', defaultChannels: 'ESPN / Disney+' },
    { slug: 'esp.1', name: 'La Liga', defaultChannels: 'ESPN / Disney+' },
    { slug: 'ita.1', name: 'Serie A Itália', defaultChannels: 'ESPN / Disney+' },
  ];

  const results = await Promise.all(
    leagues.map(async (league) => {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.slug}/scoreboard?dates=${todayBr}`);
        if (!r.ok) return [];
        const json = await r.json();
        return (json.events || []).map((ev) => {
          const comp = ev.competitions?.[0];
          const home = comp?.competitors?.find((c) => c.homeAway === 'home');
          const away = comp?.competitors?.find((c) => c.homeAway === 'away');
          const dateObj = new Date(ev.date);
          const hora = new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            hour: '2-digit',
            minute: '2-digit',
          }).format(dateObj);

          const rawBroadcasts = [
            ...(comp?.broadcasts || []).flatMap((b) => b.names || []),
            ...(comp?.geoBroadcasts || []).map((b) => b.media?.shortName).filter(Boolean),
          ];
          const uniqueChannels = [...new Set(rawBroadcasts)].filter(Boolean);
          const channels = uniqueChannels.length
            ? uniqueChannels.slice(0, 3).join(' / ')
            : league.defaultChannels;

          return {
            id: ev.id,
            league: league.name,
            home: home?.team?.shortDisplayName || home?.team?.displayName || 'Casa',
            away: away?.team?.shortDisplayName || away?.team?.displayName || 'Visitante',
            time: hora,
            channels,
            timestamp: dateObj.getTime(),
            status: ev.status?.type?.shortDetail || '',
          };
        });
      } catch {
        return [];
      }
    })
  );

  const jogos = results.flat().sort((a, b) => a.timestamp - b.timestamp);
  const payload = { date: new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }), jogos };
  gamesCache = { ts: Date.now(), data: payload };
  return payload;
}

function getBrazilHour() {
  const hourStr = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return Number(hourStr);
}

function getBrDateKey(dateInput) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dateInput);
}

function parseNatvDateMs(rawDate) {
  if (!rawDate) return NaN;
  const str = String(rawDate).trim().replace(' ', 'T');
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(str);
  return Date.parse(hasTz ? str : `${str}-03:00`);
}

async function runSalesFollowup() {
  const hour = getBrazilHour();
  if (hour < 8 || hour >= 22) return;

  try {
    const { rows } = await pool.query(`
      SELECT
        l.*,
        r.id AS r_id,
        r.bot_active,
        r.wallet_balance,
        r.natv_api_key,
        r.custom_prices,
        wi.instance_name,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(l.last_interaction, l.created_at))) / 60 AS diff_min,
        EXTRACT(EPOCH FROM (NOW() - l.last_followup_at)) / 60 AS diff_followup_min
      FROM leads l
      JOIN resellers r ON r.id = l.reseller_id
      JOIN whatsapp_instances wi ON wi.reseller_id = r.id
      WHERE r.bot_active = true
        AND COALESCE(wi.bot_type, 'sales') = 'sales'
        AND l.needs_human = false
        AND COALESCE(l.stage, '') <> 'ATIVO'
        AND COALESCE(l.followup_step, 0) < 2
    `);

    const now = Date.now();
    let featuredGame = null;
    try {
      const gamesData = await fetchTodayGames();
      const upcomingGames = (gamesData.jogos || []).filter(
        (g) => g.timestamp > now + 30 * 60 * 1000
      );
      const priorityLeagues = [
        'Brasileirão Série A',
        'Copa do Brasil',
        'Libertadores',
        'Champions League',
      ];
      featuredGame =
        upcomingGames.find((g) => priorityLeagues.includes(g.league)) ||
        upcomingGames[0] ||
        null;
    } catch {}

    for (const lead of rows) {
      if (!isVipReseller(lead) && Number(lead.wallet_balance) <= 0) continue;

      const diffMin = Number(lead.diff_min || 0);
      const diffFollowupMin = lead.last_followup_at ? Number(lead.diff_followup_min || 0) : 999999;
      const step = Number(lead.followup_step || 0);
      const stage = String(lead.stage || '').toUpperCase();
      const chosenApp = String(lead.chosen_app || '').trim();
      const prices = getResellerPrices(lead);
      const mensalStr = formatBRL(prices[1][1]);

      let msg = null;
      let nextStep = step;

      if (step === 0) {
        if (stage === 'TESTE' && diffMin >= 65 && diffMin < 1440) {
          msg = `E aí, o que achou da qualidade dos canais e filmes no teste? Quer que eu já libere o plano mensal de R$ ${mensalStr} pra você continuar assistindo? 📺`;
          nextStep = 1;
        } else if (stage !== 'TESTE' && chosenApp && diffMin >= 45 && diffMin < 1440) {
          msg = `Opa! Conseguiu encontrar o *${chosenApp}* na loja da sua TV? Se não apareceu ou travou em alguma tela, me avisa aqui que te ajudo 👍`;
          nextStep = 1;
        } else if (stage !== 'TESTE' && !chosenApp && diffMin >= 45 && diffMin < 1440) {
          msg = `Opa! Ainda quer fazer o teste grátis de 1 hora sem compromisso? Me diz qual a marca da sua TV ou aparelho que já te ajudo a testar rapidinho 📺`;
          nextStep = 1;
        }
      } else if (step === 1 && diffMin >= 1440 && diffMin < 4320 && diffFollowupMin >= 1440) {
        if (stage === 'TESTE') {
          if (featuredGame) {
            msg = `Hoje tem *${featuredGame.home} x ${featuredGame.away}* às ${featuredGame.time} ⚽ Se quiser, já libero seu plano mensal de R$ ${mensalStr} em 1 minutinho pra você assistir tranquilo!`;
          } else {
            msg = `Passando só pra avisar que o seu acesso ainda está pronto por aqui! Se quiser ativar o plano mensal de R$ ${mensalStr} hoje, levo 1 minutinho pra liberar 😉`;
          }
          nextStep = 2;
        } else if (chosenApp) {
          msg = `Oi! Vi que você ainda não chegou a testar no *${chosenApp}*. Se quiser, te passo outro aplicativo bem fácil de instalar e já libero 1 hora grátis agora 👍`;
          nextStep = 2;
        } else {
          if (featuredGame) {
            msg = `Opa! Hoje tem *${featuredGame.home} x ${featuredGame.away}* às ${featuredGame.time} ⚽ Se quiser experimentar a qualidade dos canais com 1 hora de teste grátis antes do jogo, é só me chamar aqui!`;
          } else {
            msg = `Oi! Seu teste grátis de 1 hora ainda está disponível por aqui 😉 Quando estiver na frente da TV, me manda um oi que libero na hora pra você conhecer sem compromisso!`;
          }
          nextStep = 2;
        }
      }

      if (msg) {
        await sendWhatsAppText(lead.instance_name, lead.phone, msg);
        await pool.query(
          `INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'jose_ai', $2)`,
          [lead.id, msg]
        );
        await pool.query(
          `UPDATE leads SET followup_step = $1, last_followup_at = now(), last_message = $2, last_interaction = now() WHERE id = $3`,
          [nextStep, msg, lead.id]
        );
        console.log(`🔁 [REMARKETING STEP ${nextStep}] Enviado para ${lead.phone} (stage: ${stage || 'LEAD'}, app: ${chosenApp || 'nenhum'})`);
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  } catch (err) {
    console.error('Erro no follow-up de vendas:', err.message);
  }
}

async function runRenewalFollowup() {
  const hour = getBrazilHour();
  if (hour < 9 || hour >= 21) return;

  try {
    // Busca APENAS revendedores que possuem instância do José Suporte
    const resellersRes = await pool.query(`
      SELECT DISTINCT ON (r.id) r.*, wi.instance_name
      FROM resellers r
      JOIN whatsapp_instances wi ON wi.reseller_id = r.id
      WHERE r.bot_active = true
        AND r.natv_api_key IS NOT NULL
        AND wi.bot_type = 'support'
      ORDER BY r.id
    `);

    const baseUrl = (process.env.NATV_API_URL || 'https://revenda.pixbot.link').replace(/\/$/, '');
    const todayKey = getBrDateKey(new Date());
    const todayMidnightMs = Date.parse(`${todayKey}T00:00:00-03:00`);

    for (const reseller of resellersRes.rows) {
      if (!isVipReseller(reseller) && Number(reseller.wallet_balance) <= 0) continue;

      // Confirma na Evolution API se o WhatsApp do José Suporte está realmente conectado
      try {
        const stateRes = await fetch(`${EVOLUTION_URL}/instance/connectionState/${reseller.instance_name}`, {
          method: 'GET',
          headers: { apikey: EVOLUTION_KEY },
        });
        if (!stateRes.ok) continue;
        const stateData = await stateRes.json();
        const state = stateData?.instance?.state || stateData?.state || 'close';
        if (state !== 'open') continue;
      } catch {
        continue;
      }

      const response = await fetch(`${baseUrl}/report/allusers`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${reseller.natv_api_key}`, 'Content-Type': 'application/json' },
      });
      if (!response.ok) continue;

      const raw = await response.json();
      const list = Array.isArray(raw) ? raw : (raw.data || raw.users || raw.clients || []);
      const resellerName = String(reseller.name || '').trim().toLowerCase();

      const leadsRes = await pool.query(
        `SELECT * FROM leads WHERE reseller_id = $1 AND natv_username IS NOT NULL`,
        [reseller.id]
      );
      const leadByUser = new Map(leadsRes.rows.map((l) => [String(l.natv_username).trim().toLowerCase(), l]));

      for (const c of list) {
        const dono = String(c.r || '').trim().toLowerCase();
        if (resellerName && dono && dono !== resellerName) continue;
        if (!c.e || !c.u) continue;

        // 1. Bloqueia qualquer usuário de teste/trial vindo da NATV
        const statusNatv = String(c.t || '').trim().toLowerCase();
        if (
          statusNatv.includes('test') ||
          statusNatv.includes('trial') ||
          statusNatv.includes('demo') ||
          c.is_trial === true ||
          c.is_trial === 1 ||
          String(c.is_trial) === '1'
        ) {
          continue;
        }

        // 2. Calcula os dias restantes usando data exata no fuso de Brasília
        const expMs = parseNatvDateMs(c.e);
        if (Number.isNaN(expMs)) continue;

        // Bloqueia contas cuja duração total foi <= 48h (testes de 1h/6h que já expiraram na NATV)
        const createdRaw = c.d || c.created_at || c.criado_em;
        if (createdRaw) {
          const createdMs = parseNatvDateMs(createdRaw);
          if (!Number.isNaN(createdMs) && expMs - createdMs <= 48 * 60 * 60 * 1000) {
            continue;
          }
        }

        const expDateKey = getBrDateKey(new Date(expMs));
        const expMidnightMs = Date.parse(`${expDateKey}T00:00:00-03:00`);
        const daysLeft = Math.round((expMidnightMs - todayMidnightMs) / (1000 * 60 * 60 * 24));

        let stageToSend = null;
        let msg = null;

        if (daysLeft === 3) {
          stageToSend = '3d';
          msg = `Oi! Passando pra lembrar que o seu plano vence em 3 dias (${String(c.e).slice(0, 10)}). Se já quiser deixar renovado pra não ficar sem sinal, é só me chamar aqui que gero o Pix na hora! 📺`;
        } else if (daysLeft === 0) {
          stageToSend = '0d';
          msg = `Olá! Seu plano vence hoje. Quer que eu já envie o Pix para renovar automaticamente e manter seu acesso ativo?`;
        } else if (daysLeft === -1) {
          stageToSend = '-1d';
          msg = `Oi! Vi aqui que o seu acesso venceu ontem. Se quiser reativar agora, é só responder aqui que libero em 1 minutinho pra você 😉`;
        } else if (daysLeft === -3) {
          stageToSend = '-3d';
          msg = `Olá! Notei que seu plano venceu há 3 dias. Se quiser voltar a assistir hoje, seu usuário continua salvo aqui — só me avisar qual plano prefere que já mando o Pix!`;
        } else if (daysLeft === -7) {
          stageToSend = '-7d';
          msg = `Oi! Passando só pra avisar que seu login ainda está guardado por aqui. Quando quiser reativar sua TV, é só dar um oi que libero na hora 👍`;
        }

        if (!stageToSend) continue;

        const userKey = String(c.u).trim().toLowerCase();
        let lead = leadByUser.get(userKey);

        if (!lead) {
          const digits = String(c.u).replace(/\D/g, '');
          if (digits.length < 10 || digits.length > 13) continue;
          const phoneWithDdi = digits.length <= 11 ? `55${digits}` : digits;
          const remoteJid = `${phoneWithDdi}@s.whatsapp.net`;

          const existingByPhone = await pool.query(
            `SELECT * FROM leads WHERE reseller_id = $1 AND phone = $2 LIMIT 1`,
            [reseller.id, remoteJid]
          );

          if (existingByPhone.rows[0]) {
            lead = existingByPhone.rows[0];
            await pool.query(`UPDATE leads SET natv_username = $1 WHERE id = $2`, [String(c.u).trim(), lead.id]);
          } else {
            const created = await pool.query(
              `INSERT INTO leads (reseller_id, phone, name, stage, natv_username, instance_name)
               VALUES ($1, $2, $3, 'ATIVO', $4, $5) RETURNING *`,
              [reseller.id, remoteJid, String(c.n || c.u).trim(), String(c.u).trim(), reseller.instance_name]
            );
            lead = created.rows[0];
          }
          leadByUser.set(userKey, lead);
        }

        // 3. Só envia cobrança de renovação para leads com estágio estritamente ATIVO (bloqueia NOVO, TESTE, etc.)
        const leadStage = String(lead.stage || '').trim().toUpperCase();
        if (leadStage !== 'ATIVO') continue;

        if (lead.needs_human) continue;
        if (lead.renewal_last_exp === String(c.e) && lead.renewal_stage === stageToSend) continue;

        await sendWhatsAppText(reseller.instance_name, lead.phone, msg);
        await pool.query(`INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'jose_ai', $2)`, [lead.id, msg]);
        await pool.query(
          `UPDATE leads SET renewal_last_exp = $1, renewal_stage = $2, last_message = $3, last_interaction = now() WHERE id = $4`,
          [String(c.e), stageToSend, msg, lead.id]
        );
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } catch (err) {
    console.error('Erro no follow-up de renovação:', err.message);
  }
}

// Agendamento automático dos robôs de Remarketing (10 min) e Renovação (1h)
setInterval(runSalesFollowup, 10 * 60 * 1000);
setInterval(runRenewalFollowup, 60 * 60 * 1000);

app.get('/api/novidades/vod', auth, async (req, res) => {
  if (vodCache.data && Date.now() - vodCache.ts < 60 * 60 * 1000) return res.json(vodCache.data);

  let host = (process.env.XTREAM_HOST || '').trim().replace(/\/$/, '');
  const user = (process.env.XTREAM_USER || '').trim();
  const pass = (process.env.XTREAM_PASS || '').trim();
  if (!host || !user || !pass) return res.status(400).json({ error: 'Configure XTREAM_HOST, XTREAM_USER e XTREAM_PASS.' });
  if (!/^https?:\/\//i.test(host)) host = `http://${host}`;

  try {
    const base = `${host}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
    const headers = { 'User-Agent': 'IPTVSmartersPlayer', Accept: '*/*' };

    const [vodRes, seriesRes, vodCatRes, seriesCatRes] = await Promise.all([
      fetch(`${base}&action=get_vod_streams`, { headers }),
      fetch(`${base}&action=get_series`, { headers }),
      fetch(`${base}&action=get_vod_categories`, { headers }),
      fetch(`${base}&action=get_series_categories`, { headers }),
    ]);

    const parseSafe = async (r) => {
      try { return JSON.parse(await r.text()); } catch { return []; }
    };

    const vodRaw = await parseSafe(vodRes);
    const seriesRaw = await parseSafe(seriesRes);
    const vodCats = await parseSafe(vodCatRes);
    const seriesCats = await parseSafe(seriesCatRes);

    const vodList = Array.isArray(vodRaw) ? vodRaw : [];
    const seriesList = Array.isArray(seriesRaw) ? seriesRaw : [];

    const isTopCat = (name) => /top\s*10|mais\s*(vistos|assistidos)|em\s*alta|destaque/i.test(String(name || ''));
    const topVodCatIds = new Set(
      (Array.isArray(vodCats) ? vodCats : []).filter((c) => isTopCat(c.category_name)).map((c) => String(c.category_id))
    );
    const topSeriesCatIds = new Set(
      (Array.isArray(seriesCats) ? seriesCats : []).filter((c) => isTopCat(c.category_name)).map((c) => String(c.category_id))
    );

    const mapMovie = (item) => ({
      id: String(item.stream_id),
      title: item.name || 'Sem título',
      cover: item.stream_icon || '',
      rating: Number(item.rating_5based || item.rating || 0),
      added: item.added ? new Date(Number(item.added) * 1000).toLocaleDateString('pt-BR') : '',
    });

    const mapSeries = (item) => ({
      id: String(item.series_id),
      title: item.name || 'Sem título',
      cover: item.cover || '',
      rating: Number(item.rating_5based || item.rating || 0),
      added: (item.last_modified || item.added)
        ? new Date(Number(item.last_modified || item.added) * 1000).toLocaleDateString('pt-BR')
        : '',
    });

    const filmes = [...vodList]
      .sort((a, b) => Number(b.added || 0) - Number(a.added || 0))
      .slice(0, 20)
      .map(mapMovie);

    const series = [...seriesList]
      .sort((a, b) => Number(b.last_modified || b.added || 0) - Number(a.last_modified || a.added || 0))
      .slice(0, 20)
      .map(mapSeries);

    const topVodSource = topVodCatIds.size
      ? vodList.filter((i) => topVodCatIds.has(String(i.category_id)))
      : [...vodList].sort((a, b) => Number(b.rating_5based || 0) - Number(a.rating_5based || 0) || Number(b.added || 0) - Number(b.added || 0));

    const topSeriesSource = topSeriesCatIds.size
      ? seriesList.filter((i) => topSeriesCatIds.has(String(i.category_id)))
      : [...seriesList].sort((a, b) => Number(b.rating_5based || 0) - Number(a.rating_5based || 0) || Number(b.last_modified || 0) - Number(a.last_modified || 0));

    const top10_filmes = topVodSource.slice(0, 10).map(mapMovie);
    const top10_series = topSeriesSource.slice(0, 10).map(mapSeries);

    const payload = { filmes, series, top10_filmes, top10_series, updated_at: new Date().toISOString() };
    if (filmes.length || series.length) vodCache = { ts: Date.now(), data: payload };
    res.json(payload);
  } catch {
    res.status(500).json({ error: 'Erro ao consultar servidor NATV.' });
  }
});

app.get('/api/novidades/jogos', auth, async (req, res) => {
  try {
    const payload = await fetchTodayGames();
    res.json(payload);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar jogos do dia.' });
  }
});

// ==========================================
// 10. GESTOR INTELIGENTE DE CLIENTES
// ==========================================
async function initClientLinksTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_links (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        natv_username TEXT NOT NULL,
        whatsapp_jns TEXT,
        status TEXT DEFAULT 'PENDENTE',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, natv_username)
      );
    `);
    await pool.query(`ALTER TABLE client_links ALTER COLUMN user_id TYPE TEXT USING user_id::text;`);
  } catch (err) {
    console.error('Erro ao criar tabela client_links:', err);
  }
}
initClientLinksTable();

const gestorNatvCache = new Map();

app.post('/api/gestor/sincronizar', auth, async (req, res) => {
  const userId = req.user.id;
  try {
    const r = await pool.query('SELECT name, natv_api_key FROM resellers WHERE id = $1', [userId]);
    const natvKey = r.rows[0]?.natv_api_key;
    const resellerName = String(r.rows[0]?.name || '').trim().toLowerCase();
    if (!natvKey) return res.status(400).json({ error: 'Chave NATV não configurada' });

    const now = Date.now();
    const cached = gestorNatvCache.get(userId);
    let list = null;

    if (cached && now - cached.updatedAt < 5 * 60 * 1000) {
      list = cached.data;
    } else {
      const baseUrl = (process.env.NATV_API_URL || 'https://revenda.pixbot.link').replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/report/allusers`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${natvKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });
      if (response.status === 429) return res.status(429).json({ error: 'A NATV limitou as consultas. Aguarde 1 minuto.' });
      if (!response.ok) return res.status(400).json({ error: `Erro ao consultar NATV (${response.status})` });
      const raw = await response.json();
      list = Array.isArray(raw) ? raw : raw.data || raw.users || [];
      gestorNatvCache.set(userId, { data: list, updatedAt: now });
    }

    const activeClients = list.filter((c) => {
      const isAtivo = String(c.t || '').trim().toLowerCase() === 'ativo';
      const dono = String(c.r || '').trim().toLowerCase();
      const isMeu = !resellerName || !dono || dono === resellerName;
      return isAtivo && isMeu;
    });

    let vinculadosAuto = 0;
    let pendentes = 0;

    for (const client of activeClients) {
      const username = String(client.u || '').trim();
      if (!username) continue;
      const cleanNums = username.replace(/\D/g, '');
      const isPhoneUser = cleanNums.length >= 10 && cleanNums.length <= 13;
      let whatsappJid = null;
      let statusLink = 'PENDENTE';
      if (isPhoneUser) {
        const formattedPhone = cleanNums.startsWith('55') ? cleanNums : `55${cleanNums}`;
        whatsappJid = `${formattedPhone}@s.whatsapp.net`;
        statusLink = 'AUTOMATICO';
        vinculadosAuto++;
      } else {
        pendentes++;
      }

      await pool.query(
        `INSERT INTO client_links (user_id, natv_username, whatsapp_jns, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, natv_username)
         DO UPDATE SET whatsapp_jns = EXCLUDED.whatsapp_jns, status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP`,
        [userId, username, whatsappJid, statusLink]
      );
    }

    res.json({
      success: true,
      total_analisados: activeClients.length,
      vinculados_automaticamente: vinculadosAuto,
      pendentes_ajuste: pendentes,
      message: `Sincronização concluída! ${vinculadosAuto} clientes associados.`,
    });
  } catch {
    res.status(500).json({ error: 'Erro interno ao sincronizar gestor' });
  }
});

app.get('/api/gestor/clientes', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT natv_username, whatsapp_jns, status, updated_at FROM client_links WHERE user_id = $1 ORDER BY status DESC, updated_at DESC`,
      [req.user.id]
    );
    res.json({ clientes: result.rows });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar dados do gestor' });
  }
});

app.post('/api/gestor/vincular', auth, async (req, res) => {
  const { natv_username, whatsapp } = req.body;
  if (!natv_username || !whatsapp) return res.status(400).json({ error: 'Informe o usuário NATV e o WhatsApp' });
  const cleanPhone = whatsapp.replace(/\D/g, '');
  const whatsappJid = `${cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone}@s.whatsapp.net`;
  try {
    await pool.query(
      `INSERT INTO client_links (user_id, natv_username, whatsapp_jns, status)
       VALUES ($1, $2, $3, 'MANUAL')
       ON CONFLICT (user_id, natv_username)
       DO UPDATE SET whatsapp_jns = EXCLUDED.whatsapp_jns, status = 'MANUAL', updated_at = CURRENT_TIMESTAMP`,
      [req.user.id, natv_username, whatsappJid]
    );
    res.json({ success: true, message: 'WhatsApp vinculado com sucesso!' });
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar vínculo' });
  }
});

// ==========================================
// 11. PAINEL DE ATIVAÇÕES DE APPS (FILA + ALERTA WHATSAPP)
// ==========================================
const ACTIVATION_CATALOG = [
  { id: 'clouddy', name: 'Clouddy', price: 25.0, fields: ['email'] },
  { id: 'iboplayer', name: 'IBO Player', price: 17.0, fields: ['mac', 'device_key'] },
  { id: 'iboplayer_pro', name: 'IBO Player Pro', price: 20.0, fields: ['mac', 'device_key'] },
  { id: 'duplecast', name: 'Duplecast', price: 25.0, fields: ['mac', 'device_key'] },
  { id: 'quick_player', name: 'Quick Player', price: 20.0, fields: ['mac'] },
  { id: 'vu_player', name: 'VU Player', price: 25.0, fields: ['mac', 'device_key'] },
  { id: 'bob_player', name: 'Bob Player', price: 17.0, fields: ['mac', 'device_key'] },
];

async function initActivationsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_activations (
        id SERIAL PRIMARY KEY,
        reseller_id UUID NOT NULL,
        app_id TEXT NOT NULL,
        app_name TEXT NOT NULL,
        mac_address TEXT,
        device_key TEXT,
        account_email TEXT,
        price NUMERIC(10,2) NOT NULL,
        status TEXT DEFAULT 'PENDENTE',
        created_at TIMESTAMP DEFAULT now()
      );
    `);
  } catch (err) {
    console.error('Erro ao criar tabela app_activations:', err.message);
  }
}
initActivationsTable();

app.get('/api/activations/catalog', auth, (req, res) => {
  res.json({ catalog: ACTIVATION_CATALOG });
});

app.get('/api/activations', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM app_activations WHERE reseller_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ activations: result.rows });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar histórico de ativações' });
  }
});

app.post('/api/activations', auth, async (req, res) => {
  const { app_id, mac_address, device_key, account_email } = req.body || {};
  const appItem = ACTIVATION_CATALOG.find((a) => a.id === app_id);
  if (!appItem) return res.status(400).json({ error: 'Aplicativo inválido' });

  if (appItem.fields.includes('email') && !String(account_email || '').trim()) {
    return res.status(400).json({ error: 'Informe o e-mail da conta Clouddy' });
  }
  if (appItem.fields.includes('mac') && !String(mac_address || '').trim()) {
    return res.status(400).json({ error: 'Informe o MAC Address' });
  }
  if (appItem.fields.includes('device_key') && !String(device_key || '').trim()) {
    return res.status(400).json({ error: 'Informe a Device Key' });
  }

  try {
    const resQuery = await pool.query('SELECT * FROM resellers WHERE id = $1', [req.user.id]);
    const reseller = resQuery.rows[0];
    if (!reseller) return res.status(404).json({ error: 'Revendedor não encontrado' });

    const balance = Number(reseller.wallet_balance || 0);
    if (balance < appItem.price) {
      return res.status(400).json({
        error: `Saldo insuficiente na Carteira José (necessário R$ ${formatBRL(appItem.price)}).`,
      });
    }

    // Debita da Carteira José
    await debitWallet(
      reseller.id,
      appItem.price,
      'app_activation',
      `Ativação ${appItem.name} (${account_email || mac_address})`
    );

    // Salva na fila como PENDENTE
    const inserted = await pool.query(
      `INSERT INTO app_activations (reseller_id, app_id, app_name, mac_address, device_key, account_email, price, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDENTE') RETURNING *`,
      [
        reseller.id,
        appItem.id,
        appItem.name,
        mac_address ? String(mac_address).trim() : null,
        device_key ? String(device_key).trim() : null,
        account_email ? String(account_email).trim() : null,
        appItem.price,
      ]
    );
    const order = inserted.rows[0];

    // Dispara alerta no WhatsApp do administrador
    const adminPhone = String(process.env.ADMIN_ACTIVATION_WHATSAPP || '555198970564').replace(/\D/g, '');
    if (adminPhone) {
      const instRes = await pool.query(
        `SELECT instance_name FROM whatsapp_instances WHERE reseller_id = $1 LIMIT 1`,
        [reseller.id]
      );
      let instanceName = instRes.rows[0]?.instance_name;
      if (!instanceName) {
        const anyInst = await pool.query(`SELECT instance_name FROM whatsapp_instances LIMIT 1`);
        instanceName = anyInst.rows[0]?.instance_name;
      }

      if (instanceName) {
        const formatted = adminPhone.length <= 11 ? `55${adminPhone}` : adminPhone;
        const adminJid = `${formatted}@s.whatsapp.net`;
        const details = [
          order.account_email ? `E-mail: ${order.account_email}` : null,
          order.mac_address ? `MAC: ${order.mac_address}` : null,
          order.device_key ? `Device Key: ${order.device_key}` : null,
        ]
          .filter(Boolean)
          .join('\n');

        const alertMsg =
          `⚡ *Novo Pedido de Ativação #${order.id}*\n\n` +
          `Revendedor: ${reseller.name}\n` +
          `App: *${order.app_name}*\n` +
          `${details}\n` +
          `Valor debitado: R$ ${formatBRL(order.price)}\n\n` +
          `Status: PENDENTE`;

        await sendWhatsAppText(instanceName, adminJid, alertMsg);
      }
    }

    res.json({ success: true, activation: order });
  } catch (err) {
    console.error('❌ [ERRO /api/activations]:', err.message);
    res.status(500).json({ error: 'Erro ao solicitar ativação' });
  }
});

app.patch('/api/activations/:id/status', auth, async (req, res) => {
  const status = String(req.body?.status || '').toUpperCase();
  if (!['PENDENTE', 'CONCLUIDO', 'RECUSADO'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido' });
  }
  try {
    const updated = await pool.query(
      `UPDATE app_activations SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!updated.rows[0]) return res.status(404).json({ error: 'Pedido não encontrado' });
    res.json({ success: true, activation: updated.rows[0] });
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});


// ==========================================
// 12. META ADS (CAMPANHAS COM CRIATIVOS PRÉ-PROGRAMADOS + CARTEIRA JOSÉ)
// ==========================================
const ADS_CREATIVES_CATALOG = [
  {
    id: 'futebol_ao_vivo',
    name: 'Futebol ao Vivo + Todos os Canais',
    headline: 'Todos os Jogos ao Vivo na sua TV!',
    description: 'Teste grátis de 1 hora sem compromisso. Chama no WhatsApp!',
    cta: 'Enviar mensagem no WhatsApp',
    preview_url: `${BASE_URL}/logos/ad-futebol.jpg`,
    min_daily_budget: 20.0,
  },
  {
    id: 'filmes_series_4k',
    name: 'Filmes, Séries e Canais 4K',
    headline: 'Cinema em Casa por menos de R$ 1/dia',
    description: 'Lançamentos, séries e canais ao vivo. Peça seu teste grátis!',
    cta: 'Enviar mensagem no WhatsApp',
    preview_url: `${BASE_URL}/logos/ad-cinema.jpg`,
    min_daily_budget: 20.0,
  },
];

async function initAdsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ad_campaigns (
        id SERIAL PRIMARY KEY,
        reseller_id UUID NOT NULL,
        creative_id TEXT NOT NULL,
        creative_name TEXT NOT NULL,
        whatsapp_number TEXT NOT NULL,
        daily_budget NUMERIC(10,2) NOT NULL,
        days INTEGER NOT NULL,
        total_budget NUMERIC(10,2) NOT NULL,
        status TEXT DEFAULT 'PENDENTE',
        meta_campaign_id TEXT,
        created_at TIMESTAMP DEFAULT now()
      );
    `);
  } catch (err) {
    console.error('Erro ao criar tabela ad_campaigns:', err.message);
  }
}
initAdsTable();

app.get('/api/ads/creatives', auth, (req, res) => {
  res.json({ creatives: ADS_CREATIVES_CATALOG });
});

app.get('/api/ads/campaigns', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM ad_campaigns WHERE reseller_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ campaigns: result.rows });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar campanhas' });
  }
});

app.post('/api/ads/campaigns', auth, async (req, res) => {
  const { creative_id, whatsapp_number, daily_budget, days } = req.body || {};
  const creative = ADS_CREATIVES_CATALOG.find((c) => c.id === creative_id);
  if (!creative) return res.status(400).json({ error: 'Criativo inválido.' });

  const cleanPhone = String(whatsapp_number || '').replace(/\D/g, '');
  if (cleanPhone.length < 10) return res.status(400).json({ error: 'Informe um número de WhatsApp válido.' });

  const budgetDay = Number(daily_budget || 0);
  const totalDays = Math.max(1, Math.min(Number(days || 1), 30));
  if (budgetDay < creative.min_daily_budget) {
    return res.status(400).json({ error: `Orçamento diário mínimo é R$ ${formatBRL(creative.min_daily_budget)}.` });
  }

  const totalBudget = Number((budgetDay * totalDays).toFixed(2));

  try {
    const resQuery = await pool.query('SELECT * FROM resellers WHERE id = $1', [req.user.id]);
    const reseller = resQuery.rows[0];
    if (!reseller) return res.status(404).json({ error: 'Revendedor não encontrado' });

    const balance = Number(reseller.wallet_balance || 0);
    if (balance < totalBudget) {
      return res.status(400).json({
        error: `Saldo insuficiente na Carteira José (necessário R$ ${formatBRL(totalBudget)}).`,
      });
    }

    await debitWallet(
      reseller.id,
      totalBudget,
      'meta_ads',
      `Campanha Meta Ads: ${creative.name} (${totalDays}d x R$ ${formatBRL(budgetDay)})`
    );

    const inserted = await pool.query(
      `INSERT INTO ad_campaigns (reseller_id, creative_id, creative_name, whatsapp_number, daily_budget, days, total_budget, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDENTE') RETURNING *`,
      [reseller.id, creative.id, creative.name, cleanPhone, budgetDay, totalDays, totalBudget]
    );
    const campaign = inserted.rows[0];

    const adminPhone = String(process.env.ADMIN_ACTIVATION_WHATSAPP || '555198970564').replace(/\D/g, '');
    if (adminPhone) {
      const anyInst = await pool.query(
        `SELECT instance_name FROM whatsapp_instances WHERE reseller_id = $1 LIMIT 1`,
        [reseller.id]
      );
      let instanceName = anyInst.rows[0]?.instance_name;
      if (!instanceName) {
        const fallbackInst = await pool.query(`SELECT instance_name FROM whatsapp_instances LIMIT 1`);
        instanceName = fallbackInst.rows[0]?.instance_name;
      }
      if (instanceName) {
        const formatted = adminPhone.length <= 11 ? `55${adminPhone}` : adminPhone;
        const alertMsg =
          `📣 *Nova Campanha Meta Ads #${campaign.id}*\n\n` +
          `Revendedor: ${reseller.name}\n` +
          `Criativo: *${campaign.creative_name}*\n` +
          `WhatsApp destino: ${campaign.whatsapp_number}\n` +
          `Orçamento: R$ ${formatBRL(budgetDay)}/dia por ${totalDays} dia(s)\n` +
          `Total debitado da carteira: *R$ ${formatBRL(totalBudget)}*\n\n` +
          `Status: PENDENTE`;
        await sendWhatsAppText(instanceName, `${formatted}@s.whatsapp.net`, alertMsg);
      }
    }

    res.json({ success: true, campaign });
  } catch (err) {
    console.error('❌ [ERRO /api/ads/campaigns]:', err.message);
    res.status(500).json({ error: 'Erro ao criar campanha Meta Ads' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API do José rodando na porta ${PORT}`));
