'use strict';

// M9-D017 — a chamada de tool da NAY de ponta a ponta: conexão restrita, as cinco verificações (toolAuthorizer) e, só então,
// o executor (D002/D018) com o contexto congelado. A tool recebe como permissão a EFETIVA (interseção), nunca a do ator inteira.
// O orquestrador (M9-D020) chama `runToolCall` para cada tool que o modelo pede.

const { executeTool } = require('../tools/toolExecutor');
const { buildToolServices } = require('../toolServices');
const { assertRuntimeConnection } = require('./runtimeConnection');
const { loadSecuritySettings } = require('./securitySettings');
const { createSecurityRecorder } = require('./securityRecorder');
const { authorizeToolCall } = require('./toolAuthorizer');

/**
 * @param {object} p execCtx (executionContext), agent (resolveActiveAgent), registry (ToolRegistry), toolName, args (do modelo),
 *   requestText (pedido do usuário), source ('USER' | 'RETRIEVED'), transaction (do tenant), recorder (opcional), toolCallStore
 *   (porta de ai.tool_calls), proposeAction (M9-D019), argsLimits e executorOptions (repassados ao executor).
 */
async function runToolCall({ execCtx, agent, registry, toolName, args, requestText, source = 'USER', transaction, recorder, toolCallStore, proposeAction, argsLimits, services, executorOptions }) {
  await assertRuntimeConnection(transaction);
  const settings = await loadSecuritySettings(execCtx, transaction);
  const gravador = recorder || createSecurityRecorder({ execCtx, agentCode: agent && agent.code, requestText, transaction, toolCallStore });
  const autorizada = await authorizeToolCall({ execCtx, agent, registry, toolName, args, requestText, source, transaction, recorder: gravador, argsLimits, settings });

  const userId = execCtx.actor.type === 'USER' ? execCtx.actor.userId : null;
  const escopo = { groupId: execCtx.groupId, companyId: execCtx.companyId, userId, permissions: autorizada.effective };
  const montados = services || buildToolServices(transaction, escopo);
  return executeTool({
    registry: registry.executorMap(),
    toolName,
    input: autorizada.args,
    contextParts: {
      auth: { userId, serviceIdentityId: execCtx.actor.serviceIdentityId || null, permissions: autorizada.effective, roles: [...execCtx.roles] },
      companyId: execCtx.companyId,
      groupId: execCtx.groupId,
      services: montados.services,
      readModels: montados.readModels,
      correlationId: execCtx.correlationId,
    },
    recorder: gravador,
    proposeAction,
    argsLimits,
    transaction,
    ...(executorOptions || {}),
  });
}

module.exports = { runToolCall };
