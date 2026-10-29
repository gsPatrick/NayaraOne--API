'use strict';

// M9-D034 — liberar as propostas do agente comercial (`ia.comercial.permitir_propostas` Ligado) exige a versão ATIVA de NAY_COMERCIAL com
// avaliação PASSED, homologada por uma pessoa e do `config_hash` e do `global_hash` de agora. Verificado no serviço de parâmetros ao
// gravar o valor Ligado: 409 AI_AGENT_NOT_HOMOLOGATED. Desligar nunca é recusado.
const E = require('../agents.errors');
const agentsRepo = require('../agents.repository');
const { evaluationsTableExists, homologatedEvaluationSuites } = require('../../readmodels/agentSupport.readmodel');
const { assertRegressionPassed, isGreen } = require('../../regression/regression.gate');
const { registerSettingGuard } = require('../../../settings/settingGuards');
const { COMERCIAL_KEYS } = require('./comercial.settings');
const { CODE } = require('./comercial.policy');

async function assertPilotHomologated(value, tenant, actorUserId, transaction) {
  if (value !== true) return;
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: actorUserId };
  const agent = await agentsRepo.findActiveFor(ctx, CODE, transaction);
  if (!agent || !agent.enabled || !agent.companyId) throw E.notHomologated();
  if (!(await evaluationsTableExists(transaction))) throw E.notHomologated();
  if (!isGreen(await homologatedEvaluationSuites(ctx.companyId, CODE, agent.version, transaction))) throw E.notHomologated();
  await assertRegressionPassed(ctx, agent, { homologated: true }, transaction);
}

function registerComercialSettingGuard() {
  registerSettingGuard(COMERCIAL_KEYS.allowProposals, assertPilotHomologated);
}

module.exports = { registerComercialSettingGuard, assertPilotHomologated };
