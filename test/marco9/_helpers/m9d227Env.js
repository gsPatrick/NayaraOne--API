'use strict';

// Apoio dos testes da contingência do WhatsApp, do portal e da assinatura (M9-D227): WhatsApp ativo com política, e-mail alternativo, pessoa com e-mail e consentimento, queda do
// canal (circuito aberto), rodada da contingência e leitura de mensagens, e-mails e tarefas. Roda em banco descartável (os testes COMMITAM). Quem usa define process.env.PORT ANTES.
const e226 = require('./m9d226Env');
const e230 = require('./m9d230Env');
const e234 = require('./m9d234Env');
const peopleService = require('../../../src/features/people/people.service');
const personConsents = require('../../../src/features/people/personConsents.service');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const { runDispatchCycle } = require('../../../src/features/integrations/dispatch/worker');

const { comTenant, ctxDe, uniqueSuffix, sequelize } = e226;
const { sql } = e230;

/** Só uma connection de mensageria ATIVA por vez: cria a do fornecedor com a política de contingência dada e a ativa. */
async function whatsapp(tenant, { provider = 'messaging-sandbox', contingencia, config, manter = false } = {}) {
  if (!manter) await sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND status = 'ACTIVE' AND provider_code LIKE 'messaging-%'", { c: tenant.companyId });
  const policyJson = contingencia ? { contingency: contingencia } : {};
  const c = await comTenant(tenant, (t) => registry.createConnection({
    providerCode: provider, environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}`, policyJson, configJson: { templates: [...e230.MODELOS_PADRAO, ...((config && config.templates) || [])], ...(config || {}) },
  }, ctxDe(tenant), t));
  await comTenant(tenant, (t) => transitionConnection(c.id, 'ACTIVE', ctxDe(tenant), t));
  return c;
}

const derrubar = (tenant, id) => e226.forcarCircuito(tenant, id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 3600 });
/** O canal voltou: circuito fechado e três testes de saúde seguidos OK (o padrão de `recovery_checks`). */
async function recuperar(tenant, id) { await e226.fecharCircuito(tenant, id); await e226.checks(tenant, id, 3, true); }

/** Pessoa com WhatsApp e, opcionalmente, e-mail e consentimento de e-mail (OPT_IN) na finalidade dada. */
async function pessoa(tenant, { email, optIn = 'TRANSACTIONAL', optOut } = {}) {
  const phone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const contacts = [{ contactType: 'WHATSAPP', value: phone, isPrimary: true }, ...(email ? [{ contactType: 'EMAIL', value: email, isPrimary: true }] : [])];
  const p = await comTenant(tenant, (t) => peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `QA-M9 Cliente ${uniqueSuffix()}`, contacts }, tenant.userId, t));
  if (email && optIn) await comTenant(tenant, (t) => personConsents.recordConsent(p.id, { channel: 'EMAIL', purpose: optIn, status: 'OPT_IN' }, tenant.userId, t));
  if (optOut) await comTenant(tenant, (t) => personConsents.recordConsent(p.id, { channel: 'EMAIL', purpose: optOut, status: 'OPT_OUT' }, tenant.userId, t));
  return { id: p.id, phone, email };
}

/** Texto enviado pelo serviço do CRM com a janela aberta (padrão), na finalidade dada. */
const enviar = (tenant, p, text, extra = {}) => e230.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text, ...extra });

const emails = (tenant, messageId) => sql(tenant, "SELECT * FROM integration.email_messages WHERE company_id = :c AND origin_type = 'Message' AND origin_id = :m ORDER BY created_at", { c: tenant.companyId, m: String(messageId) });
const tarefasDe = (tenant, dispatchId) => e226.tarefasDoEnvio(tenant, dispatchId);
const rodarEnvios = (tenant) => runDispatchCycle(ctxDe(tenant));
const cancelarTudo = (tenant) => e226.limparPendentes(tenant);

module.exports = {
  ...e226, whatsapp, derrubar, recuperar, pessoa, enviar, emails, tarefasDe, rodarEnvios, cancelarTudo, e230, e234, abrirJanela: e230.abrirJanela, mensagem: e230.mensagem, envioDe: e230.envioDe, parametro: e230.parametro, restaurar: e230.restaurar,
  consentir: e230.consentir, modelo: e230.modelo, sequelize, sql, comTenant, ctxDe, uniqueSuffix, registry,
};
