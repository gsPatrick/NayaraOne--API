'use strict';

const { sequelize } = require('../../../models');
const { QueryTypes } = require('sequelize');
const { NEEDS_COMPENSATION, BLOCKER } = require('./rollback.constants');

/**
 * Pré-requisitos do corte (M9-D907 §3.4). A verificação própria: todo tipo do inventário com compensação e responsável (e procedimento quando o ato não se desfaz sozinho).
 * Outras demandas acrescentam as suas com `register(nome, fn)`, `fn(tenant, transaction) => [{ code, detail }]` (a M9-D908 registra a simulação de rollback no DRY3).
 */
const registered = new Map();

/**
 * Verificações que o GO sempre exige (M9-D907 L6): carregadas pelo próprio `collect`, sem depender de quem importou o quê antes, e, se uma delas não estiver registrada,
 * o GO é recusado (falha fechada) em vez de aceitar sem checar. Cada entrada: nome registrado e módulo que o registra (carga tardia, evita ciclo).
 */
const REQUIRED = [{ name: 'dry3-rollback-simulation', load: () => require('../dryrun/dry.readiness').install() }];
const MISSING = 'GOV_CUTOVER_CHECK_MISSING';
function loadRequired() {
  for (const r of REQUIRED) if (!registered.has(r.name)) r.load();
}
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
  loadRequired();
  const gaps = (await typesWithoutPlan(tenant, transaction)).map((t) => ({ code: BLOCKER.COMPENSATION_REQUIRED, detail: { type: t.code, missing: t.missing } }));
  for (const r of REQUIRED) {
    if (!registered.has(r.name)) gaps.push({ code: MISSING, detail: { check: r.name } });
  }
  for (const fn of registered.values()) {
    gaps.push(...await fn(tenant, transaction));
  }
  return gaps;
}

/** Só para teste: tira uma verificação do registro e devolve a função, para recolocá-la depois. */
function unregister(name) {
  const fn = registered.get(name);
  registered.delete(name);
  return fn;
}

module.exports = { register, unregister, loadRequired, registeredNames: () => [...registered.keys()], typesWithoutPlan, collect, REQUIRED_CHECKS: REQUIRED.map((r) => r.name), MISSING };
