'use strict';

// Apoio dos testes do pedido de avaliação (M9-D424): automação instalada, parâmetros, satisfação registrada no outbox e leitura dos pedidos. Não é teste.
const env = require('./mktRunner');
const { installSeed } = require('../../../src/features/marketing/automations/seeds');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { publishDomainEvent } = require('../../../src/engines/events/outbox');
const { createFeedbackCase } = require('../../../src/features/crm/feedbackCases.service');
const { useTempSecretStore } = require('./mktSecretStore');

const { allowTestUrls } = require('./mktUrlPolicy');
const { q, uid } = env;
const REVIEW_URL = 'https://g.page/r/imobiliaria-exemplo/review';
const LINK_BASE = 'https://api.exemplo.test';

/** Parâmetros do pedido de avaliação e o descadastro do e-mail; `over` troca ou remove (null) um deles. */
async function configure(t, tenant, over = {}) {
  await allowTestUrls(t, tenant); // M9-D433: a allowlist de URL externa vem do parâmetro da empresa
  const values = { 'marketing.review.url_avaliacao': REVIEW_URL, 'marketing.review.url_base_rastreio': LINK_BASE, 'marketing.email.url_descadastro': 'https://www.exemplo.test/descadastro?t={token}', ...over };
  for (const [key, value] of Object.entries(values)) if (value !== null) await upsertSetting(key, value, tenant, tenant.userId, t);
}

/** Pessoa só com e-mail e OPT_IN em AVALIACAO (ou sem consentimento), automação instalada e parâmetros prontos. */
async function ready(t, tenant, { optIn = true, params = {} } = {}) {
  await configure(t, tenant, params);
  await installSeed({ code: 'REVIEW-REQUEST', tenant, actor: tenant.userId }, t);
  return env.readyPerson(t, tenant, { phone: null, optIn: optIn ? ['AVALIACAO'] : [] });
}

/** Satisfação registrada pelo CRM: evento no outbox (a run lembra o id dele) e a entrada do runner com o mesmo id. */
async function satisfaction(t, tenant, personId, score, over = {}) {
  const id = over.id || uid();
  const payload = { id, personId, score, ...(over.payload || {}) };
  const outbox = await publishDomainEvent({ groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: 'SatisfactionResponse', aggregateId: id, eventType: 'crm.satisfaction.recorded', payload, idempotencyKey: `crm.satisfaction.recorded:${id}` }, t);
  return { id, outboxId: outbox.id, input: env.eventFor(tenant, personId, { eventId: outbox.id, eventType: 'crm.satisfaction.recorded', payload }) };
}

const record = (t, tenant, personId, score, options = {}, over = {}) => satisfaction(t, tenant, personId, score, over).then((s) => env.run(t, tenant, s.input, options).then((out) => ({ ...s, out })));
const requestOf = async (t, personId) => (await q(t, 'SELECT * FROM marketing.review_requests WHERE person_id = :p ORDER BY created_at, id', { p: personId }));
const openCase = (t, tenant, personId) => createFeedbackCase({ groupId: tenant.groupId, companyId: tenant.companyId, personId, type: 'COMPLAINT', description: 'Reclamação QA-M9 antiga ainda aberta.', severity: 'LOW', assignedToUserId: tenant.userId }, tenant.userId, t);
const reviewEvents = (t, reviewRequestId) => q(t, "SELECT payload_json FROM integration.outbox_events WHERE event_type = 'review.requested' AND aggregate_id = :id", { id: reviewRequestId });

module.exports = { ...env, useTempSecretStore, configure, ready, satisfaction, record, requestOf, openCase, reviewEvents, REVIEW_URL, LINK_BASE };
