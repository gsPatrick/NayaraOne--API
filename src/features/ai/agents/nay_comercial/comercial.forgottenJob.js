'use strict';

// Livro do Marco 3 §16 "Detecta lead esquecido", de forma PROATIVA: numa empresa com a NAY ligada (`ia.habilitada`), a NAY Comercial ativa
// e a detecção ligada (`ia.comercial.lead_esquecido.ativo`), cada oportunidade aberta sem contato há mais de
// `ia.comercial.lead_esquecido.dias_sem_contato` dias vira UMA recomendação LEAD_ESQUECIDO dirigida ao responsável da oportunidade, sem
// ninguém perguntar. Idempotente: a mesma ausência de contato não gera outra (comercial.forgotten.js alreadyRecommended). Recomendação sem
// ação proposta: aceitar só marca como vista; retomar o contato é da pessoa. Roda dentro da transação da empresa (RLS).
const recommendations = require('../../recommendations');
const agentsRepo = require('../agents.repository');
const { getSetting } = require('../../../settings/settings.service');
const { readForgottenParams } = require('./comercial.capParams');
const { findForgottenLeads, forgottenRecommendation, alreadyRecommended } = require('./comercial.forgotten');
const { CODE } = require('./comercial.policy');

/** A empresa está com tudo ligado para a detecção automática? { ready, reason, params }. */
async function forgottenReadiness(ctx, transaction) {
  const tenant = { groupId: ctx.groupId, companyId: ctx.companyId };
  const params = await readForgottenParams(tenant, transaction);
  if (!params.enabled) return { ready: false, reason: 'DESLIGADA', params };
  if ((await getSetting('ia.habilitada', tenant, transaction, false)) !== true) return { ready: false, reason: 'NAY_DESLIGADA', params };
  const agent = await agentsRepo.findActiveFor(ctx, CODE, transaction);
  if (!agent || !agent.enabled) return { ready: false, reason: 'AGENTE_INATIVO', params };
  return { ready: true, reason: null, params };
}

/**
 * Uma passada na empresa (o contexto já está na transação). Devolve { ready, reason, detected, created, skipped }.
 * `now` é o relógio da detecção (teste e execução manual).
 */
async function detectForgottenLeadsForCompany(ctx, transaction, { now = new Date() } = {}) {
  const readiness = await forgottenReadiness(ctx, transaction);
  if (!readiness.ready) return { ready: false, reason: readiness.reason, detected: 0, created: 0, skipped: 0 };
  const list = await findForgottenLeads(transaction, { now, days: readiness.params.days });
  const svc = { groupId: ctx.groupId, companyId: ctx.companyId, userId: null };
  let created = 0;
  let skipped = 0;
  for (const { facts, ownerUserId } of list) {
    if (await alreadyRecommended(ctx.companyId, facts, transaction)) { skipped += 1; continue; }
    const rec = forgottenRecommendation(facts);
    const out = await recommendations.createRecommendation(svc, {
      agentCode: CODE, aiRunId: null, relatedEntityType: rec.entityType, relatedEntityId: rec.entityId, recommendationType: rec.type,
      title: rec.title, rationale: rec.rationale, riskLevel: rec.riskLevel, targetUserId: ownerUserId, payload: rec.payload,
    }, transaction);
    if (out.replayed) skipped += 1; else created += 1;
  }
  return { ready: true, reason: null, detected: list.length, created, skipped };
}

module.exports = { detectForgottenLeadsForCompany, forgottenReadiness };
