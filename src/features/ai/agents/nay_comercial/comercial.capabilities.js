'use strict';

// Resolvedores RULE das capacidades do livro do Marco 3 §16 e §12 que o piloto M9-D034 não tinha: classificar a qualidade do cadastro e os
// documentos faltantes, detectar leads esquecidos (sob demanda; a detecção automática é a rotina nayComercialForgottenLeadsJob), resumir
// mensagem recebida como apoio (com redação por modelo opcional) e propor envio de mensagem conferindo regras e consentimento. Toda
// leitura respeita a permissão de quem pede (403) e o escopo de carteira (404 sem revelar existência).
const { loadOpportunityFacts } = require('./comercial.data');
const { isMine, assertCan, nowOf } = require('./comercial.access');
const { withOpportunity } = require('./comercial.resolvers');
const { registrationQuality } = require('./comercial.quality');
const { findForgottenLeads, forgottenListResult } = require('./comercial.forgotten');
const { messageFacts, messageSummaryResult } = require('./comercial.messageSummary');
const { sendProposalResult } = require('./comercial.contact');
const { readForgottenParams, draftByModel } = require('./comercial.capParams');
const { scopeOfActor } = require('./comercial.scope');
const { subjectId } = require('./comercial.sources');
const { TASKS } = require('./comercial.policy');

const CRM = 'crm:opportunities:read';
const PERSON_TYPES = ['person', 'pessoa', 'people'];
const MESSAGE_TYPES = ['crmmessage', 'crm.message', 'message', 'mensagem'];

/** Cadastro da pessoa do assunto (`context.entityType: 'person'`) ou da pessoa da oportunidade (com os documentos pendentes do financiamento). */
const classificar = async (ruleInput, env) => {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput, 'people:read');
  const now = nowOf(ruleInput);
  const personId = subjectId({ subject: ruleInput.subject, input: '' }, PERSON_TYPES);
  if (personId) return registrationQuality(personId, { tenant: env.tenant, transaction: env.transaction, now });
  assertCan(ruleInput, CRM);
  return withOpportunity(ruleInput, env, async ({ id, ownerScope }) => {
    const facts = await loadOpportunityFacts(id, env.transaction, { now, ownerScope });
    return registrationQuality(facts.personId, { tenant: env.tenant, transaction: env.transaction, now, pendingFinancing: facts.pendingDocuments });
  });
};

/** Leads esquecidos da carteira de quem pede (OWN: só os dele; ALL: os da empresa). */
const detectar = async (ruleInput, env) => {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput, CRM);
  const now = nowOf(ruleInput);
  const params = await readForgottenParams(env.tenant, env.transaction);
  const list = await findForgottenLeads(env.transaction, { now, days: params.days, ownerScope: scopeOfActor(ruleInput) });
  return forgottenListResult(list, { days: params.days, listMax: params.listMax, now });
};

/** Resumo de mensagem recebida (apoio). Com a redação por modelo ligada, sai daqui e o modelo redige com a mensagem que o servidor entrega. */
const resumirMensagem = async (ruleInput, env) => {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput, CRM, 'people:read');
  const id = subjectId({ subject: ruleInput.subject, input: ruleInput.input }, MESSAGE_TYPES);
  if (!id) return null;
  if (await draftByModel(env.tenant, env.transaction)) return null;
  const facts = await messageFacts(id, { tenant: env.tenant, transaction: env.transaction, ownerScope: scopeOfActor(ruleInput), now: nowOf(ruleInput) });
  return messageSummaryResult(facts);
};

/** Proposta de envio de mensagem ao cliente da oportunidade: regras e consentimento conferidos; nada é enviado. */
const proporEnvio = async (ruleInput, env) => {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput, CRM, 'people:read');
  return withOpportunity(ruleInput, env, async ({ id, now, ownerScope }) => sendProposalResult(
    await loadOpportunityFacts(id, env.transaction, { now, ownerScope }), { input: ruleInput.input, tenant: env.tenant, transaction: env.transaction }
  ));
};

const CAPABILITY_RESOLVERS = Object.freeze({
  [TASKS.QUALITY]: classificar, [TASKS.FORGOTTEN]: detectar, [TASKS.MESSAGE_SUMMARY]: resumirMensagem, [TASKS.SEND_PROPOSAL]: proporEnvio,
});

module.exports = { CAPABILITY_RESOLVERS };
