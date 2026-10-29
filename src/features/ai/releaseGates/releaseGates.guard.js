'use strict';

const E = require('./releaseGates.errors');
const { computeMissing } = require('./releaseGates.requirements');
const { realProvidersInUse } = require('./releaseGates.providers');
const { registerSettingGuard } = require('../../settings/settingGuards');
const { PROVIDER_KEYS } = require('../providers/providers.settings');
const { readProviderParams } = require('../providers/providers.params');

/** Trava de gravação de `ia.ambiente`: ir a PRODUCAO exige o portão completo (409 AI_PRODUCTION_GATE_INCOMPLETE). Voltar a LAB nunca é recusado. */
async function assertProductionGate(value, tenant, actorUserId, transaction) {
  if (value !== 'PRODUCAO') return;
  const { missing } = await computeMissing({ groupId: tenant.groupId, companyId: tenant.companyId, userId: actorUserId }, transaction);
  if (missing.length) throw E.incomplete(missing);
}

/**
 * Habilitar um agente (ativar a versão) com provedor real quando `ia.ambiente` é PRODUCAO exige o mesmo portão, com a avaliação do próprio agente.
 * Em LAB, ou só com o provedor de testes, nada muda aqui.
 */
async function assertAgentEnableAllowed(ctx, agentCode, transaction) {
  if (!(await readProviderParams(ctx, transaction)).production) return;
  if (!(await realProvidersInUse(ctx, transaction)).length) return;
  const { missing } = await computeMissing(ctx, transaction, { extraAgents: [agentCode] });
  if (missing.length) throw E.incomplete(missing);
}

function registerReleaseGateGuard() {
  registerSettingGuard(PROVIDER_KEYS.environment, assertProductionGate);
}

module.exports = { registerReleaseGateGuard, assertProductionGate, assertAgentEnableAllowed };
