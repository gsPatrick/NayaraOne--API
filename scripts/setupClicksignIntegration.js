'use strict';

require('dotenv').config();

/**
 * setupClicksignIntegration — configura o provedor de assinatura eletrônica real (Clicksign)
 * para o tenant real da Nayara: grava o token de API e o provider selecionado via settings.
 * service (mesmo caminho usado pelo painel admin), registra o webhook público desta API na
 * conta do Clicksign via POST /webhooks, e grava o segredo HMAC retornado.
 *
 * Rodar uma única vez (idempotente: se já existir webhook cadastrado com o mesmo endpoint,
 * apenas reaproveita/atualiza o segredo local). Precisa de DATABASE_URL com privilégio de
 * escrita normal (nayara_runtime já basta — não precisa de superuser, é INSERT/UPDATE comum).
 *
 * Uso: CLICKSIGN_API_TOKEN=... CLICKSIGN_WEBHOOK_URL=... node scripts/setupClicksignIntegration.js
 */

const { sequelize, Company } = require('../src/models');
const { upsertSetting } = require('../src/features/settings/settings.service');

const CLICKSIGN_BASE_URL = process.env.CLICKSIGN_BASE_URL || 'https://sandbox.clicksign.com/api/v3';
const CLICKSIGN_API_TOKEN = process.env.CLICKSIGN_API_TOKEN;
const CLICKSIGN_WEBHOOK_URL = process.env.CLICKSIGN_WEBHOOK_URL;

async function clicksignRequest(method, path, body) {
  const response = await fetch(`${CLICKSIGN_BASE_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: CLICKSIGN_API_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    json = null;
  }
  if (!response.ok) {
    throw new Error(`Clicksign respondeu ${response.status} em ${method} ${path}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  if (!CLICKSIGN_API_TOKEN) throw new Error('CLICKSIGN_API_TOKEN é obrigatório.');
  if (!CLICKSIGN_WEBHOOK_URL) throw new Error('CLICKSIGN_WEBHOOK_URL é obrigatório.');

  const company = await Company.findOne({ raw: true });
  if (!company) throw new Error('Nenhuma empresa encontrada no banco.');
  const tenant = { groupId: company.group_id, companyId: company.id };
  console.log(`Tenant: group=${tenant.groupId} company=${tenant.companyId}`);

  // 1) Tenta listar webhooks já cadastrados nessa conta pra não duplicar em reruns.
  let webhookSecret = null;
  const existing = await clicksignRequest('GET', '/webhooks');
  const already = existing && existing.data && existing.data.find((w) => w.attributes && w.attributes.endpoint === CLICKSIGN_WEBHOOK_URL);

  if (already) {
    console.log(`Webhook já cadastrado (id=${already.id}) — reaproveitando; Clicksign não devolve o secret de novo em GET, então o script assume que o secret já foi gravado numa rodada anterior.`);
    webhookSecret = already.attributes.secret || null;
  } else {
    console.log('Registrando novo webhook no Clicksign...');
    const created = await clicksignRequest('POST', '/webhooks', {
      data: {
        type: 'webhooks',
        attributes: {
          endpoint: CLICKSIGN_WEBHOOK_URL,
          events: ['sign', 'refusal', 'auto_close', 'close', 'cancel', 'deadline'],
          status: 'active',
        },
      },
    });
    webhookSecret = created && created.data && created.data.attributes && created.data.attributes.secret;
    console.log(`Webhook criado (id=${created.data.id}).`);
  }

  if (!webhookSecret) {
    throw new Error('Não foi possível obter o secret do webhook (nem no registro novo, nem num já existente) — cadastre manualmente no painel do Clicksign e rode com CLICKSIGN_WEBHOOK_SECRET=... setado à mão.');
  }

  await sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });

    await upsertSetting('legal.signature_provider', 'clicksign', tenant, null, t);
    await upsertSetting('legal.clicksign_api_token', CLICKSIGN_API_TOKEN, tenant, null, t);
    await upsertSetting('legal.clicksign_webhook_secret', webhookSecret, tenant, null, t);
  });

  console.log('Configuração gravada: legal.signature_provider=clicksign, token e webhook secret salvos (criptografados).');
  await sequelize.close();
}

main().catch(async (err) => {
  console.error(err);
  await sequelize.close();
  process.exit(1);
});
