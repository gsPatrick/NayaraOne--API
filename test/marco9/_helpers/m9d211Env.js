'use strict';

// Apoio dos testes do framework de webhooks (M9-D211): HTTP real contra o app de teste, cofre de arquivo temporário, connection com canal e segredo,
// corpo assinado (hmacWithTimestamp) e leitura direta da caixa de entrada e dos erros. Roda em banco descartável (os testes COMMITAM).
// Quem usa define process.env.PORT ANTES de requerer este arquivo (ele sobe o app de teste).
require('../../../app');
const crypto = require('node:crypto');
const { sequelize, carregarTenants, ctxDe, comTenant, uniqueSuffix } = require('../../integrations/dispatch/dispatchHelpers');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { getSecretStore, webhookRefOf } = require('../../../src/features/integrations/secrets');
const { useTempSecretStore } = require('./mktSecretStore');

const base = () => `http://127.0.0.1:${process.env.PORT}/api`;

/** Cabeçalho x-signature: t=<segundos>,v1=<HMAC-SHA256 de "<t>." + corpo>. */
function assinar(segredo, corpo, { t = Math.floor(Date.now() / 1000) } = {}) {
  const bruto = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8');
  const v1 = crypto.createHmac('sha256', segredo).update(`${t}.`).update(bruto).digest('hex');
  return { 'x-signature': `t=${t},v1=${v1}` };
}

/** POST com o corpo exato (string ou Buffer). Devolve { status, json, headers }. */
async function postar(caminho, corpo, headers = {}) {
  const res = await fetch(`${base()}${caminho}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: corpo });
  const texto = await res.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { json = texto; }
  return { status: res.status, json, headers: res.headers };
}

/** Connection (qualquer status, menos DISABLED) com o canal gerado pelo servidor e o segredo do webhook no cofre. */
async function criarCanal(tenant, { provider = 'messaging-sandbox', segredo = `wh-${crypto.randomBytes(12).toString('hex')}`, comSegredo = true } = {}) {
  const secretRef = `company/${tenant.companyId}/webhook/${uniqueSuffix()}`.toLowerCase();
  const conn = await comTenant(tenant, (t) => registry.createConnection({ providerCode: provider, environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}`, secretRef }, ctxDe(tenant), t));
  if (comSegredo) await getSecretStore().put(webhookRefOf(secretRef), segredo, {});
  return { conn, canal: conn.webhookChannel, segredo, secretRef, provider };
}

const sql = (tenant, consulta, replacements = {}) => comTenant(tenant, async (t) => (await sequelize.query(consulta, { replacements, transaction: t }))[0]);
const inbox = (tenant, provider, eventId) => sql(tenant, 'SELECT * FROM integration.webhook_inbox WHERE provider_code = :p AND external_event_id = :e', { p: provider, e: eventId });
const erros = (tenant, provider, code) => sql(tenant, 'SELECT * FROM integration.integration_errors WHERE company_id = :c AND provider_code = :p AND error_code = :k ORDER BY created_at DESC', { c: tenant.companyId, p: provider, k: code });
/** Total do contador de webhook desconhecido do fornecedor (tabela de plataforma: só com a marca de administração). */
const desconhecidos = (provider) => sequelize.transaction(async (t) => {
  await sequelize.query("SET LOCAL app.integration_platform_admin = 'on'", { transaction: t });
  const [[linha]] = await sequelize.query('SELECT COALESCE(sum(hits), 0)::int AS n FROM integration.platform_unknown_webhooks WHERE provider_code = :p', { replacements: { p: provider }, transaction: t });
  return linha.n;
});

module.exports = { sequelize, carregarTenants, ctxDe, comTenant, uniqueSuffix, assinar, postar, criarCanal, sql, inbox, erros, desconhecidos, useTempSecretStore, base };
