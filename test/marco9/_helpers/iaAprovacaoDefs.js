'use strict';

// Tools sintéticas da M9-D019: uma por categoria sensível do AI-007, com contador de execuções, para provar que a tool só cria a
// proposta. Não passam pelo registro de produção (que recusa a definição insegura); vão num mapa de executor e num registro falso.

const { partes } = require('./iaToolCalls');
const { createToolCallRecorder } = require('../../../src/features/ai/tools/toolCallRecorder');
const { createProposeAction } = require('../../../src/features/ai/tools/proposals');
const { executeTool } = require('../../../src/features/ai/tools/toolExecutor');
const { buildUserContext } = require('../../../src/features/ai/orchestrator/executionContext');
const { LIMITES } = require('./iaAprovacao');

function toolSensivel({ name, domain, riskLevel = 'HIGH', requiresHumanApproval = true, permissionCode = 'legal:create' }) {
  const execucoes = [];
  const def = {
    name, version: 1, description: `Tool sintética ${name}.`, permissionCode, riskLevel, category: 'WRITE', domain, requiresHumanApproval, idempotent: false,
    entityRefs: [], inputSchema: { type: 'object', properties: { alvo: { type: 'string' } }, additionalProperties: false },
    execute: async (_ctx, input) => { execucoes.push(input); return { feito: true }; },
  };
  return { def, execucoes };
}

/** Pede a tool sintética pelo executor (D002) com o recorder real e o `proposeAction` da D019. */
async function pedirSintetica(tenant, tx, { def, runId, userId, args = { alvo: 'x' } }) {
  const execCtx = buildUserContext({ userId, groupId: tenant.groupId, companyId: tenant.companyId, roles: ['TESTE'], permissions: [def.permissionCode] }, { correlationId: 'corr-d019', runId });
  const registroFalso = { get: (nome) => (nome === def.name ? def : undefined) };
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId };
  const recorder = createToolCallRecorder({ ctx, transaction: tx, runId });
  const proposeAction = createProposeAction({ registry: registroFalso, execCtx, agent: { code: 'NAY_SINTETICA' }, runId, transaction: tx });
  const mapa = { [def.name]: { ...def } };
  return executeTool({
    registry: mapa, toolName: def.name, input: args, contextParts: partes(tenant, { auth: { userId, permissions: [def.permissionCode] } }),
    recorder, proposeAction, argsLimits: LIMITES, transaction: tx, seq: 1,
  }).then((res) => ({ res, err: null, recorder }), (err) => ({ res: null, err, recorder }));
}

module.exports = { toolSensivel, pedirSintetica };
