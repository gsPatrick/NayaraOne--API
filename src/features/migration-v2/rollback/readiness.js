'use strict';

const { sequelize } = require('../../../models');
const { QueryTypes } = require('sequelize');
const { NEEDS_COMPENSATION, BLOCKER } = require('./rollback.constants');

/**
 * Pré-requisitos do corte (M9-D907 §3.4). A verificação própria: todo tipo do inventário com compensação e responsável (e procedimento quando o ato não se desfaz sozinho).
 * Outras demandas acrescentam as suas com `register(nome, fn)`, `fn(tenant, transaction) => [{ code, detail }]` (a M9-D908 registra a simulação de rollback no DRY3).
 */
const registered = new Map();
function register(name, fn) {
  if (typeof fn !== 'function') throw new Error('Verificação de prontidão deve ser uma função.');
  registered.set(name, fn);
  return () => registered.delete(name);
}

/** Tipos sem plano completo: { code, entity, missing[] }. Usado pelo GO e pelo blocker da Torre. */
async function typesWithoutPlan(tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT code, entity, reversibility, compensation, procedure, owner FROM governance.external_op_types WHERE company_id = :companyId ORDER BY code`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId } }
  );
  return rows.map((t) => ({
    code: t.code, entity: t.entity,
    missing: [!t.compensation.trim() && 'compensation', NEEDS_COMPENSATION.includes(t.reversibility) && !t.procedure.trim() && 'procedure', !t.owner.trim() && 'owner'].filter(Boolean),
  })).filter((t) => t.missing.length);
}

async function collect(tenant, transaction) {
  const gaps = (await typesWithoutPlan(tenant, transaction)).map((t) => ({ code: BLOCKER.COMPENSATION_REQUIRED, detail: { type: t.code, missing: t.missing } }));
  for (const fn of registered.values()) {
    gaps.push(...await fn(tenant, transaction));
  }
  return gaps;
}

module.exports = { register, typesWithoutPlan, collect };
