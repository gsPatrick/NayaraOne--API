'use strict';

// Apoio dos testes M9-D832 (não é teste): preparo das empresas, importação como a rota faz e leituras de apoio. Rodar SEMPRE em banco descartável.
const env = require('./bcpEnv');
const { createBase } = require('./m9d832Base');
const { createReceivable, createLegalCase, createFinancingCase } = require('./m9d832More');
const { operationFor, PAYLOADS } = require('./m9d832Payloads');
const { importBatch } = require('../../../src/features/core-governance/bcp/import/import.batch');
const decideService = require('../../../src/features/core-governance/bcp/import/decide.service');
const { SPEC } = require('./m9d834Spec');

const ALL_SECTORS = Object.fromEntries(SPEC.map((item) => [item.sector, ['CI GESTOR', 'CI MAKER']]).filter((v, i, a) => a.findIndex((x) => x[0] === v[0]) === i));
const APPROVE = 'governance:bcp:approve';
let restorePermissions = null;
/** Pagamento emergencial (M9-D833): quem importa confere com governance:bcp:approve; o gestor recebe a permissão durante os testes (desfeita em cleanImports). */
const prepare = async (tenant) => {
  await env.cleanBcp();
  await env.setSectorRoles(tenant, ALL_SECTORS);
  if (!restorePermissions) restorePermissions = await env.withRolePermissions({ 'CI GESTOR': { [APPROVE]: true } });
};

/** Contexto completo de uma empresa: base, lançamento a receber de R$ 1.205,00, processo jurídico e processo de financiamento. */
async function context(tenant, receivableAmount = 1205) {
  const base = await createBase(tenant);
  return { base, receivableId: await createReceivable(tenant, base, receivableAmount), legalCaseId: await createLegalCase(tenant), financingCaseId: await createFinancingCase(tenant) };
}

/** Registra a operação da ação (como a rota) e devolve a operação gravada. */
async function recordAction(tenant, action, ctx, payloadOver, over = {}) {
  // Pagamento emergencial (M9-D833): quem registra (checker_1) não pode ser quem importa (checker_2); por padrão registra o usuário maker.
  if (action === 'EMERGENCY_PAYMENT' && !over.actorUserId) over = { ...over, actorUserId: await env.otherUserId() };
  const evidenceFileId = await env.evidence(tenant);
  const spec = operationFor(action, ctx, payloadOver, over.manualReference);
  return env.record(tenant, { ...spec, ...over, evidenceFileId, payload: spec.payload }, over.actorUserId);
}

const importIds = (tenant, ids, actorUserId) => env.inTx(tenant, (transaction) => importBatch({ tenant: env.tenantOf(tenant), actorUserId: actorUserId || tenant.userId, body: { ids }, transaction }), actorUserId);
const decide = (tenant, id, body, actorUserId) => env.inTx(tenant, (transaction) => decideService.decide({ tenant: env.tenantOf(tenant), actorUserId: actorUserId || tenant.userId, id, body, transaction }), actorUserId);
const reconciliationOf = async (operationId) => (await env.adminQuery('SELECT * FROM governance.reconciliations WHERE manual_operation_id = $1', [operationId])).rows[0] || null;
const importRow = async (operationId) => (await env.adminQuery('SELECT * FROM governance.manual_operation_imports WHERE manual_operation_id = $1', [operationId])).rows[0] || null;

/** Remove os dados de importação e de operação dos testes (a auditoria e as entidades de negócio ficam). */
const cleanImports = async () => { await env.cleanBcp(); if (restorePermissions) { const undo = restorePermissions; restorePermissions = null; await undo(); } };

module.exports = { ...env, prepare, context, recordAction, importIds, decide, reconciliationOf, importRow, cleanImports, PAYLOADS, operationFor };
