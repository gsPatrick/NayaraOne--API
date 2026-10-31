'use strict';

// Apoio dos testes M9-D429 (WhatsApp e e-mail do Marketing): template publicado com referência oficial, pessoa com contatos e OPT_IN, janela de 24 h e
// o contexto de envio. Tudo roda na transação com rollback do teste (RLS real). Não é teste.
const env = require('./mktPolicyEnv');
const { suppressions } = require('./mktOptOut');
const adapters = require('../../../src/features/marketing/publications/adapters');
const messaging = require('../../../src/features/marketing/publications/messaging');

const { q, uid, sha, NOON_SP, HOUR } = env;
const ctxOf = (t, tenant, extra = {}) => ({ tenant, transaction: t, now: NOON_SP, mode: 'SANDBOX', ...extra });

/** Template PUBLICADO do canal; `official` = referência aprovada no provedor (obrigatória no WhatsApp fora da janela). */
async function makeTemplate(t, tenant, { channel = 'WHATSAPP', official = 'tpl_novidades_v1', status = 'PUBLISHED', body = 'Olá {{primeiroNome}}, temos novidades para você.', variables = [{ name: 'primeiroNome', type: 'text' }] } = {}) {
  const [row] = await q(t, `INSERT INTO marketing.templates (id, group_id, company_id, code, version_no, kind, channel, status, body, variables_json, official_template_ref, content_hash)
    VALUES (gen_random_uuid(), :g, :c, :code, 1, 'MESSAGE', :ch, :s, :body, CAST(:vars AS jsonb), :ref, :h) RETURNING id`,
  { g: tenant.groupId, c: tenant.companyId, code: `qa-m9-${uid().slice(0, 8)}`, ch: channel, s: status, body, vars: JSON.stringify(variables), ref: official, h: sha(uid()) });
  return row.id;
}

/** O cliente escreveu há `hoursAgo` horas: abre a janela de atendimento de 24 h do WhatsApp. */
const openWindow = (t, tenant, personId, hoursAgo = 2) => env.addMessage(t, tenant, { personId, channel: 'WHATSAPP', direction: 'INBOUND', at: new Date(NOON_SP.getTime() - hoursAgo * HOUR), status: 'RECEIVED' });

const messageOf = async (t, id) => (await q(t, 'SELECT id, status, delivery_status, purpose, action_key, external_message_id, failure_reason, body FROM crm.messages WHERE id = :id', { id }))[0];
const byKey = async (t, tenant, key) => (await q(t, 'SELECT id, status, delivery_status, purpose, action_key, external_message_id, failure_reason, body FROM crm.messages WHERE company_id = :c AND action_key = :k', { c: tenant.companyId, k: key }))[0];
const key = () => sha(uid());
const { allowTestUrls } = require('./mktUrlPolicy');
// M9-D433: portalUrl e unsubscribeUrl passam pela regra de URL externa; os endereços fictícios dos cenários entram na allowlist da empresa (parâmetro, na transação do teste).
const send = async (t, tenant, input, extra) => {
  await allowTestUrls(t, tenant);
  return messaging.sendMarketingMessage(ctxOf(t, tenant, extra), input);
};

module.exports = { ...env, suppressions, adapters, messaging, ctxOf, makeTemplate, openWindow, messageOf, byKey, key, send };
