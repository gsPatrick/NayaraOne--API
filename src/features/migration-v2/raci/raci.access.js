'use strict';

const { RACI } = require('./raci.constants');
const repo = require('./raci.repository');
const { ensureActivities } = require('./raci.seed');

/**
 * Papel do ator numa atividade (M9-D902 e M9-D901 §3.1.1): é R/A/C/I quando há linha para o seu usuário OU para algum dos seus perfis (comparação sem diferença de maiúsculas).
 * Devolve { R, A, C, I } booleanos.
 */
async function rolesOf(tenant, actor, activityCode, transaction) {
  await ensureActivities(tenant, transaction);
  const entries = await repo.listEntries(tenant, transaction, activityCode);
  const myRoles = new Set(((actor && actor.roles) || []).map((name) => String(name).toUpperCase()));
  const result = { R: false, A: false, C: false, I: false };
  for (const entry of entries) {
    if ((entry.userId && actor && entry.userId === actor.userId) || (entry.role && myRoles.has(String(entry.role).toUpperCase()))) result[entry.raci] = true;
  }
  return result;
}

const isResponsibleOrAccountable = (roles) => roles[RACI.R] || roles[RACI.A];

module.exports = { rolesOf, isResponsibleOrAccountable };
