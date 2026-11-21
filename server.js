require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());
const path = require('path');
app.use('/logos', express.static(path.join(__dirname, 'logos')));

app.get('/', (req, res) => res.json({ status: 'ok', app: 'API do José' }));


// Conexão com o PostgreSQL da sua VPS
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const JWT_SECRET = process.env.JWT_SECRET || 'jose_super_secret_key';
const EVOLUTION_URL = process.env.EVOLUTION_API_URL; // ex: https://bot-streaming-evolution.celuyv.easypanel.host
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;

// Middleware de Autenticação (verifica o token do revendedor)
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
  } catch (err) {
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
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// ==========================================
// 2. VALIDAR CHAVE NATV E PUXAR CRÉDITOS
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
      'UPDATE resellers SET natv_api_key = $1, natv_credits = $2 WHERE id = $3',
      [natv_api_key, credits, req.user.id]
    );

    res.json({ success: true, credits, natvData });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao conectar na API NATV' });
  }
});
// Salvar código do Watch Hub do revendedor
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

// ==========================================
// 3. CONECTAR WHATSAPP (GERAR QR CODE)
// ==========================================
app.post('/api/whatsapp/connect', auth, async (req, res) => {
  const instanceName = `jose_${req.user.id.slice(0, 8)}`;

  try {
    // Tenta criar a instância na Evolution API (ignora se já existir)
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

    // Busca o QR Code em Base64
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
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar QR Code na Evolution API' });
  }
});

// ==========================================
// 4. RECARGA DA CARTEIRA VIA PIX (MERCADO PAGO)
// ==========================================
app.post('/api/wallet/recharge', auth, async (req, res) => {
  const { amount } = req.body; // Ex: 50.00
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
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar cobrança Pix' });
  }
});

// Webhook do Mercado Pago (adiciona saldo automático quando o Pix cair)
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
// FASE 2: MOTOR DO JOSÉ (IA + LOGOS + CARTEIRA + NATV)
// ==========================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Coloque aqui os links públicos das imagens dos logos dos apps
const BASE_URL = 'https://bot-streaming-jose-api.celuyv.easypanel.host/';

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
  - Para os demais apps, entregue usuário, senha e domínio normalmente.

- Se for cliente relatando travamento, problema de pagamento ou pedir humano, chame \`chamar_humano\`.`;

async function sendWhatsAppText(instanceName, remoteJid, text) {
  await fetch(`${EVOLUTION_URL}/message/sendText/${instanceName}`, {
    method: 'POST',
    headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: remoteJid, delay: 1200, text }),
  });
}

async function sendWhatsAppImage(instanceName, remoteJid, imageUrl, caption) {
  if (!imageUrl || imageUrl.includes('COLE_AQUI')) return;
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

// Webhook que recebe as mensagens da Evolution API
app.post('/api/webhooks/evolution', async (req, res) => {
  res.sendStatus(200); // Responde rápido para a Evolution não reenviar

  try {
    const { event, instance, data } = req.body;
    if (event !== 'messages.upsert' || !data || data.key?.fromMe) return;

    const remoteJid = data.key?.remoteJid;
    if (!remoteJid || remoteJid.includes('@g.us')) return; // Ignora grupos

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
    if (!reseller || !reseller.bot_active || Number(reseller.wallet_balance) <= 0) {
      return; // Bot pausado ou sem saldo na carteira
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
      // Cobra por nova conversa iniciada
      await debitWallet(
        reseller.id,
        Number(reseller.cost_per_conversation),
        'conversation',
        `Nova conversa: ${pushName}`
      );
    } else {
      await pool.query(
        'UPDATE leads SET last_message = $1, last_interaction = now() WHERE id = $2',
        [text, lead.id]
      );
    }

    // Salva mensagem do cliente no banco
    await pool.query(
      `INSERT INTO messages (lead_id, sender, content) VALUES ($1, 'client', $2)`,
      [lead.id, text]
    );

    // Se o revendedor assumiu o atendimento, o José fica em silêncio
    if (lead.needs_human) return;

    // 3. Carrega histórico recente (últimas 12 mensagens)
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

    // 4. Chama a OpenAI
    let aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
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
              await pool.query(
                `UPDATE leads SET stage = 'TESTE', natv_username = $1 WHERE id = $2`,
                [natvUser.username, lead.id]
              );
              await debitWallet(
                reseller.id,
                Number(reseller.cost_per_test),
                'test_created',
                `Teste gerado: ${natvUser.username}`
              );
                            toolResult = JSON.stringify({
                app_escolhido: lead.chosen_app || '',
                codigo_watch_hub: reseller.watch_hub_code || '',
                usuario: natvUser.username,
                senha: natvUser.password,
                dominio: natvUser.domain,
              });

            } else {
              toolResult = 'Erro ao gerar teste na API NATV.';
            }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API do José rodando na porta ${PORT}`));
