require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// Serve os logos hospedados na pasta /logos do repositório
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// Rota de saúde para o Easypanel não reiniciar o contêiner
app.get('/', (req, res) => res.json({ status: 'ok', app: 'API do José v2' }));

// Conexão com o PostgreSQL da sua VPS
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const JWT_SECRET = process.env.JWT_SECRET || 'jose_super_secret_key';
const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN; // Seu MP (recarga da carteira do José)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Chave do Google AI Studio (Gemini)

// Configure BASE_URL no Easypanel ou troque o link abaixo pelo domínio real da sua jose-api
const BASE_URL = process.env.BASE_URL || 'https://bot-streaming-jose-api.celuyv.easypanel.host';

// Chaves NATV VIP (não exigem saldo na carteira do José e não sofrem débito)
const VIP_NATV_KEYS = (process.env.VIP_NATV_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

function isVipReseller(reseller) {
  return Boolean(reseller?.natv_api_key && VIP_NATV_KEYS.includes(reseller.natv_api_key.trim()));
}

// Middleware de Autenticação
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
        is_vip: isVipReseller(user),
      },
    });
  } catch {
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// Login direto usando apenas a Chave de API NATV
app.post('/api/auth/natv-login', async (req, res) => {
  const { natv_api_key } = req.body;
  if (!natv_api_key) {
    return res.status(400).json({ error: 'Informe sua Chave de API NATV' });
  }

  try {
    const cleanKey = natv_api_key.trim();

    // 1. Valida a chave direto na NATV e puxa nome + créditos
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
    const credits = natvData.credits ?? 0;
    const natvName = natvData.username || natvData.name || `revenda_${natvData.id || Date.now()}`;
    const fakeEmail = `${natvName.toLowerCase().replace(/[^a-z0-9]/g, '')}@natv.jose`;

    // 2. Busca se já existe no banco; se não existir, cria automaticamente
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
        is_vip: isVipReseller(user),
      },
    });
   } catch (err) {
    console.error('Erro detalhado no natv-login:', err);
    res.status(500).json({ error: `Erro interno: ${err.message}` });
  }

});

// ==========================================
// 2. INTEGRAÇÕES DO REVENDEDOR (NATV, WATCH HUB, MAXPLAYER, MERCADO PAGO)
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

    if (!response.ok) {
      return res.status(400).json({ error: 'Chave de API NATV inválida' });
    }

    const natvData = await response.json();
    const credits = natvData.credits ?? 0;

    await pool.query(
  'UPDATE leads SET last_message = $1, last_interaction = now(), followup_step = 0 WHERE id = $2',
  [text, lead.id]
);


    res.json({ success: true, credits, natvData });
  } catch {
    res.status(500).json({ error: 'Erro ao conectar na API NATV' });
  }
});

app.post('/api/reseller/watch-hub', auth, async (req, res) => {
  const { watch_hub_code } = req.body;
  try {
    await pool.query(
      'UPDATE resellers SET watch_hub_code = $1 WHERE id = $2',
      [watch_hub_code, req.user.id]
    );
    res.json({ success: true, watch_hub_code });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar código do Watch Hub' });
  }
});

app.post('/api/reseller/maxplayer', auth, async (req, res) => {
  const { maxplayer_token } = req.body;
  try {
    await pool.query(
      'UPDATE resellers SET maxplayer_token = $1 WHERE id = $2',
      [maxplayer_token, req.user.id]
    );
    res.json({ success: true, maxplayer_token });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar Token do MaxPlayer' });
  }
});

app.post('/api/reseller/mercadopago', auth, async (req, res) => {
  const { mp_access_token } = req.body;
  try {
    await pool.query(
      'UPDATE resellers SET mp_access_token = $1 WHERE id = $2',
      [mp_access_token, req.user.id]
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar Token do Mercado Pago' });
  }
});

// ==========================================
// 3. CONECTAR WHATSAPP (GERAR QR CODE)
// ==========================================
app.post('/api/whatsapp/connect', auth, async (req, res) => {
  const instanceName = `jose_${req.user.id.slice(0, 8)}`;

  try {
    await fetch(`${EVOLUTION_URL}/instance/create`, {
      method: 'POST',
      headers: {
        apikey: EVOLUTION_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      }),
    });

    const qrRes = await fetch(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
      method: 'GET',
      headers: { apikey: EVOLUTION_KEY },
    });

    const qrData = await qrRes.json();
    const qrBase64 = qrData.base64 || qrData.qrcode?.base64 || null;

    await pool.query(
      `INSERT INTO whatsapp_instances (reseller_id, instance_name, status, qr_code_base64)
       VALUES ($1, $2, 'qr_pending', $3)
       ON CONFLICT (instance_name)
       DO UPDATE SET status = 'qr_pending', qr_code_base64 = $3, updated_at = now()`,
      [req.user.id, instanceName, qrBase64]
    );

    res.json({ instanceName, qr_code_base64: qrBase64 });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar QR Code na Evolution API' });
  }
});

// ==========================================
// 4. RECARGA DA CARTEIRA DO JOSÉ (SEU MERCADO PAGO)
// ==========================================
app.post('/api/wallet/recharge', auth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 5) {
    return res.status(400).json({ error: 'Valor mínimo de recarga é R$ 5,00' });
  }

  try {
    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `${req.user.id}-${Date.now()}`,
      },
      body: JSON.stringify({
        transaction_amount: Number(amount),
        description: `Recarga Carteira José - ${req.user.email}`,
        payment_method_id: 'pix',
        payer: { email: req.user.email },
        external_reference: req.user.id,
      }),
    });

    const payment = await mpRes.json();
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

app.post('/api/webhooks/mercadopago', async (req, res) => {
  const paymentId = req.body?.data?.id;
  if (!paymentId) return res.sendStatus(200);

  try {
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const payment = await mpRes.json();

    if (payment.status === 'approved' && payment.external_reference) {
      const resellerId = payment.external_reference;
      const amount = Number(payment.transaction_amount);

      await pool.query(
        'UPDATE resellers SET wallet_balance = wallet_balance + $1 WHERE id = $2',
        [amount, resellerId]
      );

      await pool.query(
        `INSERT INTO wallet_transactions (reseller_id, type, category, amount, description)
         VALUES ($1, 'recharge', 'pix_recharge', $2, $3)`,
        [resellerId, amount, `Recarga Pix #${paymentId}`]
      );
    }
    res.sendStatus(200);
  } catch {
    res.sendStatus(500);
  }
});

// ==========================================
// 5. WEBHOOK DE VENDA DE PLANOS (MERCADO PAGO DO REVENDEDOR -> ATIVAÇÃO NATV)
// ==========================================
app.post('/api/webhooks/mp-reseller/:resellerId', async (req, res) => {
  res.sendStatus(200);
  const paymentId = req.body?.data?.id;
  const { resellerId } = req.params;
  if (!paymentId || !resellerId) return;

  try {
    const resRes = await pool.query('SELECT * FROM resellers WHERE id = $1', [resellerId]);
    const reseller = resRes.rows[0];
    if (!reseller?.mp_access_token || !reseller?.natv_api_key) return;

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${reseller.mp_access_token}` },
    });
    const payment = await mpRes.json();

    if (payment.status === 'approved' && payment.external_reference) {
      const [leadId, monthsStr] = payment.external_reference.split('|');
      const months = Number(monthsStr) || 1;

      const leadRes = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
      const lead = leadRes.rows[0];
      if (!lead?.natv_username || lead.stage === 'ATIVO') return;

      // Ativa/renova o usuário na NATV (desconta os créditos do revendedor)
      const actRes = await fetch('https://revenda.pixbot.link/user/activation', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${reseller.natv_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: lead.natv_username,
          months,
        }),
      });
      const actData = await actRes.json();

      if (actRes.ok) {
        await pool.query(`UPDATE leads SET stage = 'ATIVO' WHERE id = $1`, [lead.id]);

        if (!isVipReseller(reseller)) {
          await debitWallet(
            reseller.id,
            Number(reseller.cost_per_activation ?? 0.50),
            'activation',
            `Ativação (${months}m): ${lead.natv_username}`
          );
        }

        if (actData.owner?.credits !== undefined) {
          await pool.query('UPDATE resellers SET natv_credits = $1 WHERE id = $2', [
            actData.owner.credits,
            reseller.id,
          ]);
        }

        const instRes = await pool.query(
          'SELECT instance_name FROM whatsapp_instances WHERE reseller_id = $1 LIMIT 1',
          [reseller.id]
        );
        const instanceName = instRes.rows[0]?.instance_name;
        if (instanceName) {
          await sendWhatsAppText(
            instanceName,
            lead.phone,
            `Pagamento confirmado! 🎉 Seu plano de ${months} ${months === 1 ? 'mês' : 'meses'} já foi ativado automaticamente. Bom entretenimento!`
          );
        }
      }
    }
  } catch (err) {
    console.error('Erro no webhook mp-reseller:', err);
  }
});

// ==========================================
// 6. MOTOR DO JOSÉ (GEMINI AI + LOGOS + CARTEIRA + NATV + MAXPLAYER + PIX)
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

const JOSE_SYSTEM_PROMPT = `Você é o José, atendente comercial de streaming no WhatsApp.
Estilo: leve, direto, simpático e natural. Mensagens CURTAS (máx. 2 a 3 linhas) e APENAS UMA pergunta por vez.

PLANOS: Mensal R$ 29,90 | Trimestral R$ 74,90 | Semestral R$ 149,90 | Anual R$ 279,90 | Teste grátis: 1 hora.
Regra: nunca jogue a tabela completa antes de oferecer o teste grátis (se perguntar preço, diga "a partir de R$ 29,90/mês" e puxe para o teste).

APPS POR APARELHO (indique sempre a 1ª opção primeiro):
- Samsung: 1º WATCH HUB | 2º HD PLAYER | 3º MAXPLAYER
- Roku: 1º PLAYER MASTER | 2º WATCH HUB | 3º HD PLAYER
- LG: 1º HD PLAYER | 2º MAXPLAYER | 3º TOPTV
- Android/Google TV / TV Box / Fire Stick: 1º WATCH HUB | 2º LOBO PLAYER | 3º MEGATV PLAYER

FERRAMENTAS:
- Ao indicar um app pela primeira vez, chame \`enviar_logo_app\` com o nome exato do app.
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
  - Se o app escolhido for MAXPLAYER, entregue EXATAMENTE neste formato:
    Seu teste está pronto! Já cadastrei o seu acesso no MaxPlayer.
    Para assistir, basta abrir o app no seu aparelho e usar estes dados:

    Usuário: [usuario]
    Senha: [senha]
  - Para os demais apps, entregue usuário, senha e domínio normalmente.
- Quando o cliente quiser fechar/comprar um plano (Mensal=1, Trimestral=3, Semestral=6, Anual=12), chame \`gerar_pix_plano\` passando a quantidade de meses e envie o código Pix Copia e Cola retornado avisando que a ativação é automática após o pagamento.
- Se for cliente relatando travamento, problema de pagamento ou pedir humano, chame \`chamar_humano\`.`;

async function sendWhatsAppText(instanceName, remoteJid, text) {
  await fetch(`${EVOLUTION_URL}/message/sendText/${instanceName}`, {
    method: 'POST',
    headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: remoteJid, delay: 1200, text }),
  });
}

async function sendWhatsAppImage(instanceName, remoteJid, imageUrl, caption) {
  if (!imageUrl || imageUrl.includes('SEU_LINK_DO_JOSE_API')) return;
  await fetch(`${EVOLUTION_URL}/message/sendMedia/${instanceName}`, {
    method: 'POST',
    headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number: remoteJid,
      mediatype: 'image',
      media: imageUrl,
      caption,
    }),
  });
}

async function debitWallet(resellerId, amount, category, description) {
  await pool.query(
    'UPDATE resellers SET wallet_balance = GREATEST(wallet_balance - $1, 0) WHERE id = $2',
    [amount, resellerId]
  );
  await pool.query(
    `INSERT INTO wallet_transactions (reseller_id, type, category, amount, description)
     VALUES ($1, 'debit', $2, $3, $4)`,
    [resellerId, category, amount, description]
  );
}

app.post('/api/webhooks/evolution', async (req, res) => {
  res.sendStatus(200);

  try {
    const { event, instance, data } = req.body;
    if (event !== 'messages.upsert' || !data || data.key?.fromMe) return;

    const remoteJid = data.key?.remoteJid;
    if (!remoteJid || remoteJid.includes('@g.us')) return;

    const text =
      data.message?.conversation ||
      data.message?.extendedTextMessage?.text;
    if (!text) return;

    const pushName = data.pushName || 'Cliente';

    // 1. Busca o revendedor dono da instância
    const instRes = await pool.query(
      `SELECT r.* FROM whatsapp_instances wi
       JOIN resellers r ON r.id = wi.reseller_id
       WHERE wi.instance_name = $1`,
      [instance]
    );
    const reseller = instRes.rows[0];
    const isVip = isVipReseller(reseller);

    if (!reseller || !reseller.bot_active || (!isVip && Number(reseller.wallet_balance) <= 0)) {
      return;
    }

    // 2. Busca ou cria o Lead
    let leadRes = await pool.query(
      'SELECT * FROM leads WHERE reseller_id = $1 AND phone = $2',
      [reseller.id, remoteJid]
    );
    let lead = leadRes.rows[0];

    if (!lead) {
      const insertLead = await pool.query(
        `INSERT INTO leads (reseller_id, phone, name, last_message)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [reseller.id, remoteJid, pushName, text]
      );
      lead = insertLead.rows[0];
    } else {
      await pool.query(
        'UPDATE leads SET last_message = $1, last_interaction = now() WHERE id = $2',
        [text, lead.id]
      );
    }

    await pool.query(
      `INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'client', $2)`,
      [lead.id, text]
    );

    if (lead.needs_human) return;

    // 3. Carrega histórico recente
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
            properties: {
              app_name: {
                type: 'string',
                enum: Object.keys(APP_LOGOS),
              },
            },
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
          name: 'gerar_pix_plano',
          description: 'Gera o Pix Copia e Cola na conta Mercado Pago do revendedor para ativar o plano do cliente.',
          parameters: {
            type: 'object',
            properties: {
              months: { type: 'number', enum: [1, 3, 6, 12] },
            },
            required: ['months'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'chamar_humano',
          description: 'Pausa a IA e alerta o revendedor para assumir o atendimento.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];

    const messagesPayload = [
      { role: 'system', content: JOSE_SYSTEM_PROMPT },
      ...history,
    ];

    // 4. Primeira chamada ao Google Gemini
    let aiRes = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gemini-2.5-flash',
        temperature: 0.3,
        messages: messagesPayload,
        tools,
      }),
    });
    let aiData = await aiRes.json();
    let msg = aiData.choices?.[0]?.message;

    // 5. Executa ferramentas se a IA solicitou
    if (msg?.tool_calls?.length) {
      messagesPayload.push(msg);

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');
        let toolResult = 'ok';

        if (fnName === 'enviar_logo_app') {
          const appName = args.app_name;
          lead.chosen_app = appName;
          await pool.query('UPDATE leads SET chosen_app = $1 WHERE id = $2', [appName, lead.id]);
          await sendWhatsAppImage(
            instance,
            remoteJid,
            APP_LOGOS[appName],
            `Procura por esse ícone na loja: ${appName} 📺`
          );
          toolResult = `Logo do ${appName} enviado com sucesso.`;
        }

        if (fnName === 'gerar_teste') {
          if (!reseller.natv_api_key) {
            toolResult = 'Erro: revendedor sem chave NATV configurada.';
          } else {
            const natvRes = await fetch('https://revenda.pixbot.link/user', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${reseller.natv_api_key}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ minutes: '60' }),
            });
            const natvUser = await natvRes.json();

            if (natvRes.ok) {
              lead.natv_username = natvUser.username;
              await pool.query(
                `UPDATE leads SET stage = 'TESTE', natv_username = $1 WHERE id = $2`,
                [natvUser.username, lead.id]
              );
              if (!isVip) {
                await debitWallet(
                  reseller.id,
                  Number(reseller.cost_per_test ?? 0.25),
                  'test_created',
                  `Teste gerado: ${natvUser.username}`
                );
              }

              let maxplayerStatus = 'Não configurado';

              if (lead.chosen_app === 'MAXPLAYER' && reseller.maxplayer_token) {
                try {
                  const maxUserRes = await fetch('https://api.maxplayer.tv/v3/users', {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${reseller.maxplayer_token}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      username: natvUser.username,
                      password: natvUser.password,
                      email: `${natvUser.username}@josebot.com`,
                      reseller_id: reseller.id.slice(0, 8),
                    }),
                  });

                  if (maxUserRes.ok) {
                    const m3uUrl = `https://dns.pixbot.link/get.php?auth=${natvUser.username}&pass=${natvUser.password}&output=ts`;
                    await fetch('https://api.maxplayer.tv/v3/users/list', {
                      method: 'POST',
                      headers: {
                        Authorization: `Bearer ${reseller.maxplayer_token}`,
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify({
                        username: natvUser.username,
                        list_url: m3uUrl,
                        name: 'Lista José',
                      }),
                    });
                    maxplayerStatus = 'Criado com sucesso';
                  } else {
                    maxplayerStatus = 'Erro ao cadastrar usuário no MaxPlayer';
                  }
                } catch {
                  maxplayerStatus = 'Falha na comunicação com a API MaxPlayer';
                }
              }

              toolResult = JSON.stringify({
                app_escolhido: lead.chosen_app || '',
                codigo_watch_hub: reseller.watch_hub_code || '',
                usuario: natvUser.username,
                senha: natvUser.password,
                dominio: natvUser.domain,
                maxplayer_status: maxplayerStatus,
              });
            } else {
              toolResult = 'Erro ao gerar teste na API NATV.';
            }
          }
        }

        if (fnName === 'gerar_pix_plano') {
          const prices = { 1: 29.9, 3: 74.9, 6: 149.9, 12: 279.9 };
          const months = Number(args.months) || 1;
          const amount = prices[months] || 29.9;

          if (!reseller.mp_access_token) {
            toolResult = 'Erro: revendedor sem Mercado Pago configurado. Chame um humano.';
          } else if (!lead.natv_username) {
            toolResult = 'Erro: cliente ainda não possui usuário de teste gerado.';
          } else {
            const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${reseller.mp_access_token}`,
                'Content-Type': 'application/json',
                'X-Idempotency-Key': `plan-${lead.id}-${Date.now()}`,
              },
              body: JSON.stringify({
                transaction_amount: amount,
                description: `Plano ${months} mês(es) - ${lead.natv_username}`,
                payment_method_id: 'pix',
                payer: { email: `${lead.natv_username}@cliente.com` },
                external_reference: `${lead.id}|${months}`,
                notification_url: `${BASE_URL}/api/webhooks/mp-reseller/${reseller.id}`,
              }),
            });
            const payment = await mpRes.json();
            const pixCode = payment.point_of_interaction?.transaction_data?.qr_code;

            toolResult = pixCode
              ? JSON.stringify({ valor: amount, meses: months, pix_copia_e_cola: pixCode })
              : 'Erro ao gerar Pix no Mercado Pago do revendedor.';
          }
        }

        if (fnName === 'chamar_humano') {
          await pool.query(
            `UPDATE leads SET needs_human = true, tab = 'suporte' WHERE id = $1`,
            [lead.id]
          );
          toolResult = 'Atendimento transferido para humano.';
        }

        messagesPayload.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      // Segunda chamada para a IA montar a resposta final ao cliente
      aiRes = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gemini-2.5-flash',
          temperature: 0.3,
          messages: messagesPayload,
        }),
      });
      aiData = await aiRes.json();
      msg = aiData.choices?.[0]?.message;
    }

    const replyText = msg?.content;
    if (replyText) {
      await sendWhatsAppText(instance, remoteJid, replyText);
      if (!isVip) {
        await debitWallet(
          reseller.id,
          Number(reseller.cost_per_reply ?? 0.10),
          'reply',
          `Resposta IA: ${lead.name || lead.phone}`
        );
      }
      await pool.query(
        `INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'jose_ai', $2)`,
        [lead.id, replyText]
      );
      await pool.query(
        'UPDATE leads SET last_message = $1, last_interaction = now() WHERE id = $2',
        [replyText, lead.id]
      );
    }
  } catch (err) {
    console.error('Erro no webhook do José:', err);
  }
});

// ==========================================
// 7. CHAT AO VIVO NO PAINEL (VER E RESPONDER WHATSAPP)
// ==========================================

// 1. Lista todas as conversas (leads) do revendedor
app.get('/api/leads', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, phone, name, last_message, last_interaction, stage, chosen_app, natv_username, needs_human, tab
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

// 2. Carrega o histórico de mensagens de um cliente específico
app.get('/api/leads/:leadId/messages', auth, async (req, res) => {
  try {
    const leadCheck = await pool.query(
      'SELECT id FROM leads WHERE id = $1 AND reseller_id = $2',
      [req.params.leadId, req.user.id]
    );
    if (!leadCheck.rows[0]) return res.status(404).json({ error: 'Conversa não encontrada' });

    const msgs = await pool.query(
      `SELECT id, sender, content, created_at
       FROM messages
       WHERE lead_id = $1
       ORDER BY created_at ASC`,
      [req.params.leadId]
    );
    res.json(msgs.rows);
  } catch {
    res.status(500).json({ error: 'Erro ao carregar mensagens' });
  }
});

// 3. Envia uma resposta manual do revendedor direto pro WhatsApp do cliente
app.post('/api/leads/:leadId/messages', auth, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Digite uma mensagem' });

  try {
    const leadRes = await pool.query(
      'SELECT * FROM leads WHERE id = $1 AND reseller_id = $2',
      [req.params.leadId, req.user.id]
    );
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: 'Conversa não encontrada' });

    const instRes = await pool.query(
      'SELECT instance_name FROM whatsapp_instances WHERE reseller_id = $1 LIMIT 1',
      [req.user.id]
    );
    const instanceName = instRes.rows[0]?.instance_name;
    if (!instanceName) return res.status(400).json({ error: 'WhatsApp não conectado' });

    // Envia no WhatsApp via Evolution API
    await sendWhatsAppText(instanceName, lead.phone, text.trim());

    // Salva no banco como mensagem humana e pausa a IA nessa conversa para não atravessar
    const saved = await pool.query(
      `INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'human', $2) RETURNING *`,
      [lead.id, text.trim()]
    );
    await pool.query(
      `UPDATE leads SET last_message = $1, last_interaction = now(), needs_human = true WHERE id = $2`,
      [text.trim(), lead.id]
    );

    res.json(saved.rows[0]);
  } catch {
    res.status(500).json({ error: 'Erro ao enviar mensagem no WhatsApp' });
  }
});

// 4. Pausar ou reativar a IA do José em uma conversa específica
app.post('/api/leads/:leadId/toggle-ai', auth, async (req, res) => {
  const { pause_ai } = req.body;
  try {
    await pool.query(
      'UPDATE leads SET needs_human = $1 WHERE id = $2 AND reseller_id = $3',
      [Boolean(pause_ai), req.params.leadId, req.user.id]
    );
    res.json({ success: true, needs_human: Boolean(pause_ai) });
  } catch {
    res.status(500).json({ error: 'Erro ao alterar status da IA' });
  }
});

// ==========================================
// 8. LISTAR CLIENTES ATIVOS DO PAINEL NATV
// ==========================================
const natvClientsCache = new Map();

app.get('/api/natv/clients', auth, async (req, res) => {
  try {
    const cached = natvClientsCache.get(req.user.id);
    if (cached && Date.now() - cached.ts < 65000) {
      return res.json(cached.payload);
    }

    const r = await pool.query(
      'SELECT name, natv_api_key FROM resellers WHERE id = $1',
      [req.user.id]
    );
    const natvKey = r.rows[0]?.natv_api_key;
    const resellerName = String(r.rows[0]?.name || '').trim().toLowerCase();

    if (!natvKey) {
      return res.status(400).json({ error: 'Chave NATV não configurada' });
    }

    const baseUrl = (process.env.NATV_API_URL || 'https://revenda.pixbot.link').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/report/allusers`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${natvKey}`,
        'Content-Type': 'application/json',
      },
    });

    const rawText = await response.text();
    if (!response.ok) {
      console.log('NATV /report/allusers erro:', response.status, rawText.slice(0, 300));
      return res.status(response.status).json({ error: 'Não foi possível consultar os clientes na NATV' });
    }

    const raw = JSON.parse(rawText);
    const list = Array.isArray(raw) ? raw : (raw.data || raw.users || raw.clients || []);

    const now = Date.now();
    const activeClients = list
      .filter((c) => {
        const tipo = String(c.t || '').trim().toLowerCase();
        const bloqueado = String(c.b || '').trim().toLowerCase();
        const dono = String(c.r || '').trim().toLowerCase();

        if (tipo !== 'ativo') return false;
        if (bloqueado !== 'no' && bloqueado !== '0' && bloqueado !== 'false' && bloqueado !== '') return false;
        if (resellerName && dono && dono !== resellerName) return false;

        if (c.e) {
          const expMs = Date.parse(String(c.e).replace(' ', 'T'));
          if (!Number.isNaN(expMs) && expMs < now) return false;
        }
        return true;
      })
      .map((c, idx) => ({
        id: String(c.i ?? idx),
        username: String(c.u ?? 'Cliente NATV'),
        name: String(c.n || c.u || 'Cliente NATV'),
        exp_date: c.e ?? null,
        plan: c.c ? `${c.c} tela(s)` : 'NATV',
      }));

    const payload = {
      total_active: activeClients.length,
      clients: activeClients,
    };

    natvClientsCache.set(req.user.id, { ts: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    console.error('Erro /api/natv/clients:', err);
    res.status(500).json({ error: 'Erro interno ao buscar clientes NATV' });
  }
});


// ==========================================
// 9. MOTOR DE FOLLOW-UP AUTOMÁTICO (VENDAS + RENOVAÇÃO NATV)
// ==========================================
async function initFollowupColumns() {
  try {
    await pool.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS followup_step INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS renewal_last_exp TEXT,
      ADD COLUMN IF NOT EXISTS renewal_stage TEXT;
    `);
    console.log('Colunas de follow-up verificadas com sucesso.');
  } catch (err) {
    console.error('Erro ao criar colunas de follow-up:', err.message);
  }
}

function getBrazilHour() {
  const hourStr = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return Number(hourStr);
}

// 9.1 FOLLOW-UP DE VENDAS (Pré-teste 45m | Pós-teste 65m | Recuperação 24h)
async function runSalesFollowup() {
  const hour = getBrazilHour();
  if (hour < 8 || hour >= 22) return; // Só envia entre 08h e 22h (horário de Brasília)

  try {
    const { rows } = await pool.query(`
      SELECT l.*, r.id AS r_id, r.bot_active, r.wallet_balance, r.natv_api_key, wi.instance_name
      FROM leads l
      JOIN resellers r ON r.id = l.reseller_id
      JOIN whatsapp_instances wi ON wi.reseller_id = r.id
      WHERE r.bot_active = true
        AND l.needs_human = false
        AND COALESCE(l.stage, '') <> 'ATIVO'
        AND COALESCE(l.followup_step, 0) < 2
    `);

    const now = Date.now();

    for (const lead of rows) {
      if (!isVipReseller(lead) && Number(lead.wallet_balance) <= 0) continue;

      const lastTime = new Date(lead.last_interaction || lead.created_at).getTime();
      const diffMin = (now - lastTime) / 60000;
      const step = Number(lead.followup_step || 0);
      const stage = String(lead.stage || '').toUpperCase();

      let msg = null;
      let nextStep = step;

      // Caso 1: Abandonou antes de gerar o teste (45 min sem resposta)
      if (stage !== 'TESTE' && step === 0 && diffMin >= 45 && diffMin < 1440) {
        msg = 'Opa! Conseguiu encontrar o aplicativo na loja da sua TV? Se precisar de ajuda pra achar, me avisa aqui que te auxilio 👍';
        nextStep = 1;
      }
      // Caso 2: Acabou o teste grátis de 1h (65 min após o teste)
      else if (stage === 'TESTE' && step === 0 && diffMin >= 65 && diffMin < 1440) {
        msg = 'E aí, o que achou da qualidade dos canais e filmes no teste? Quer que eu já libere o plano mensal de R$ 29,90 pra você continuar assistindo? 📺';
        nextStep = 1;
      }
      // Caso 3: Recuperação 24h depois do teste
      else if (stage === 'TESTE' && step === 1 && diffMin >= 1440 && diffMin < 4320) {
        msg = 'Passando só pra avisar que o seu usuário ainda está salvo por aqui! Se quiser ativar hoje, levo 1 minutinho pra liberar o acesso 😉';
        nextStep = 2;
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
        // Pequena pausa entre envios para evitar bloqueio no WhatsApp
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  } catch (err) {
    console.error('Erro no follow-up de vendas:', err.message);
  }
}

// 9.2 FOLLOW-UP DE RENOVAÇÃO (3 dias antes | No dia | 1 dia após vencer)
async function runRenewalFollowup() {
  const hour = getBrazilHour();
  if (hour < 9 || hour >= 21) return; // Só envia entre 09h e 21h

  try {
    const resellersRes = await pool.query(`
      SELECT r.*, wi.instance_name
      FROM resellers r
      JOIN whatsapp_instances wi ON wi.reseller_id = r.id
      WHERE r.bot_active = true AND r.natv_api_key IS NOT NULL
    `);

    const baseUrl = (process.env.NATV_API_URL || 'https://revenda.pixbot.link').replace(/\/$/, '');

    for (const reseller of resellersRes.rows) {
      if (!isVipReseller(reseller) && Number(reseller.wallet_balance) <= 0) continue;

      const response = await fetch(`${baseUrl}/report/allusers`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${reseller.natv_api_key}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) continue;

      const raw = await response.json();
      const list = Array.isArray(raw) ? raw : (raw.data || raw.users || raw.clients || []);
      const resellerName = String(reseller.name || '').trim().toLowerCase();

      // Busca leads com natv_username vinculado a este revendedor
      const leadsRes = await pool.query(
        `SELECT * FROM leads WHERE reseller_id = $1 AND natv_username IS NOT NULL AND needs_human = false`,
        [reseller.id]
      );
      const leadByUser = new Map(
        leadsRes.rows.map((l) => [String(l.natv_username).trim().toLowerCase(), l])
      );

      const now = Date.now();

      for (const c of list) {
        const dono = String(c.r || '').trim().toLowerCase();
        if (resellerName && dono && dono !== resellerName) continue;
        if (!c.e || !c.u) continue;

        const lead = leadByUser.get(String(c.u).trim().toLowerCase());
        if (!lead) continue;

        const expMs = Date.parse(String(c.e).replace(' ', 'T'));
        if (Number.isNaN(expMs)) continue;

        const daysLeft = Math.ceil((expMs - now) / (1000 * 60 * 60 * 24));
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
        }

        if (!stageToSend) continue;

        // Evita reenviar o mesmo aviso para a mesma data de vencimento
        if (lead.renewal_last_exp === String(c.e) && lead.renewal_stage === stageToSend) {
          continue;
        }

        await sendWhatsAppText(reseller.instance_name, lead.phone, msg);
        await pool.query(
          `INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'jose_ai', $2)`,
          [lead.id, msg]
        );
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

// Inicia as colunas e agenda os disparos automáticos
initFollowupColumns();
setInterval(runSalesFollowup, 5 * 60 * 1000);     // Vendas: checa a cada 5 minutos
setInterval(runRenewalFollowup, 60 * 60 * 1000);  // Renovação: checa a cada 1 hora



// ==========================================
// 10. DISPARO MANUAL: TENTATIVA DE RECUPERAÇÃO (ANTI-BLOQUEIO)
// ==========================================
const runningRecoveryJobs = new Set();

const RECOVERY_MESSAGES = [
  'Oi! Tudo bem? Passando só pra saber se você ainda tem interesse em liberar o acesso aos canais, filmes e séries. Se quiser testar de novo ou ativar hoje, é só me chamar por aqui! 📺',
  'Olá! Vi que a gente conversou outro dia sobre o streaming e acabou não fechando. Ainda está procurando um aplicativo bom e estável pra sua TV? Posso te ajudar agora mesmo 😉',
  'Opa, tudo certo? Passando rapidinho pra avisar que nossos planos continuam disponíveis a partir de R$ 29,90/mês com ativação imediata. Se quiser voltar a assistir hoje, só dar um oi aqui!',
  'Oi! Tudo bem por aí? Caso ainda tenha interesse em ativar o streaming na sua TV ou celular, continuo à disposição por aqui pra liberar rapidinho pra você 👍',
];

app.post('/api/followup/recovery', auth, async (req, res) => {
  try {
    const customMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';

    if (runningRecoveryJobs.has(req.user.id)) {
      return res.status(409).json({ error: 'Já existe uma tentativa de recuperação em andamento.' });
    }

    const instRes = await pool.query(
      'SELECT instance_name FROM whatsapp_instances WHERE reseller_id = $1 LIMIT 1',
      [req.user.id]
    );
    const instanceName = instRes.rows[0]?.instance_name;
    if (!instanceName) {
      return res.status(400).json({ error: 'WhatsApp não conectado.' });
    }

    // Busca até 40 leads que não assinaram, sem resposta há +24h e sem recuperação nos últimos 7 dias
    const leadsRes = await pool.query(
      `SELECT id, phone, name
       FROM leads
       WHERE reseller_id = $1
         AND needs_human = false
         AND COALESCE(stage, '') <> 'ATIVO'
         AND last_interaction < NOW() - INTERVAL '24 hours'
         AND (last_followup_at IS NULL OR last_followup_at < NOW() - INTERVAL '7 days')
       ORDER BY last_interaction DESC
       LIMIT 40`,
      [req.user.id]
    );

    const targets = leadsRes.rows;
    if (targets.length === 0) {
      return res.json({
        started: false,
        total_targets: 0,
        message: 'Nenhum lead elegível para recuperação no momento.',
      });
    }

    // Responde imediatamente pro painel não travar e dispara em segundo plano
    runningRecoveryJobs.add(req.user.id);
    res.json({
      started: true,
      total_targets: targets.length,
      message: `Recuperação iniciada para ${targets.length} contato(s) com intervalo seguro de 45s a 90s.`,
    });

    (async () => {
      try {
        for (let i = 0; i < targets.length; i++) {
          const lead = targets[i];
          const text = customMessage || RECOVERY_MESSAGES[i % RECOVERY_MESSAGES.length];


          try {
            await sendWhatsAppText(instanceName, lead.phone, text);
            await pool.query(
              `INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'jose_ai', $2)`,
              [lead.id, text]
            );
            await pool.query(
              `UPDATE leads SET last_followup_at = now(), last_message = $1, last_interaction = now() WHERE id = $2`,
              [text, lead.id]
            );
          } catch (sendErr) {
            console.error(`Erro ao enviar recuperação para ${lead.phone}:`, sendErr.message);
          }

          // Pausa aleatória entre 45 e 90 segundos antes do próximo número
          if (i < targets.length - 1) {
            const delayMs = (45 + Math.floor(Math.random() * 46)) * 1000;
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
        console.log(`Recuperação finalizada para revendedor ${req.user.id} (${targets.length} envios).`);
      } finally {
        runningRecoveryJobs.delete(req.user.id);
      }
    })();
  } catch (err) {
    console.error('Erro /api/followup/recovery:', err);
    res.status(500).json({ error: 'Erro ao iniciar tentativa de recuperação.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API do José rodando na porta ${PORT}`));
