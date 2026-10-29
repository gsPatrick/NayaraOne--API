'use strict';

// M9-D017 — a chamada de tool da NAY de ponta a ponta: conexão restrita, as cinco verificações (toolAuthorizer) e, só então,
// o executor (D002/D018) com o contexto congelado. A tool recebe como permissão a EFETIVA (interseção), nunca a do ator inteira.
// O orquestrador (M9-D020) chama `runToolCall` para cada tool que o modelo pede.

const { executeTool } = require('../tools/toolExecutor');
const { buildToolServices } = require('../toolServices');
const { assertRuntimeConnection } = require('./runtimeConnection');
const { loadSecuritySettings } = require('./securitySettings');
const { createSecurityRecorder } = require('./securityRecorder');
const { createToolCallStore } = require('../tools/toolCallStore');
const { authorizeToolCall } = require('./toolAuthorizer');
const { createWritePolicy } = require('../approval/writePolicy');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {object} p execCtx (executionContext), agent (resolveActiveAgent), registry (ToolRegistry), toolName, args (do modelo),
 *   requestText (pedido do usuário), source ('USER' | 'RETRIEVED'), transaction (do tenant), recorder (opcional), toolCallStore
 *   (porta de ai.tool_calls), proposeAction (M9-D019, opcional: sem ele e com `execCtx.runId` uuid, a política de escrita monta o da NAY), execution
 *   (teto do agente na busca do RAG, M9-D023: { allowsConfidential, allowsRestricted, sourceTypes }), argsLimits e
 *   executorOptions (repassados ao executor).
 */
async function runToolCall({ execCtx, agent, registry, toolName, args, requestText, source = 'USER', transaction, recorder, toolCallStore, proposeAction, argsLimits, services, executorOptions, execution }) {
  await assertRuntimeConnection(transaction);
  const settings = await loadSecuritySettings(execCtx, transaction);
  // M9-D006: com um run real (uuid) a porta é ai.tool_calls; o orquestrador (M9-D020) pode passar a sua.
  const store = toolCallStore || (UUID.test(String(execCtx.runId)) ? createToolCallStore({ execCtx, registry }) : undefined);
  const gravador = recorder || createSecurityRecorder({ execCtx, agentCode: agent && agent.code, requestText, transaction, toolCallStore: store, args });
  const autorizada = await authorizeToolCall({ execCtx, agent, registry, toolName, args, requestText, source, transaction, recorder: gravador, argsLimits, settings });

  const userId = execCtx.actor.type === 'USER' ? execCtx.actor.userId : null;
  // M9-D695: `userPermissions` são as do ator inteiro; o BI confere nelas a permissão do domínio da métrica (a efetiva só traz os códigos das tools).
  const escopo = { groupId: execCtx.groupId, companyId: execCtx.companyId, userId, permissions: autorizada.effective, userPermissions: [...execCtx.permissions], execution, dataScopes: (agent && agent.dataScopes) || [],
    runId: UUID.test(String(execCtx.runId)) ? execCtx.runId : null, actorType: execCtx.actor.type, externalContactId: execCtx.externalContactId || null };
  const politica = await createWritePolicy({ registry, execCtx, agent, runId: UUID.test(String(execCtx.runId)) ? execCtx.runId : null, transaction });
  const montados = services || buildToolServices(transaction, escopo, { includeWrite: politica.directWriteEnabled });
  return executeTool({
    registry: registry.executorMap({ allowDirectWrite: politica.allowDirectWrite }),
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
    proposeAction: proposeAction || politica.proposeAction,
    argsLimits,
    transaction,
    ...(executorOptions || {}),
  });
}

module.exports = { runToolCall };
