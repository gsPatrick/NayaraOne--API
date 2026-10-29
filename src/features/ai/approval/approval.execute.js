'use strict';

/**
 * Execução da ação já aprovada (M9-D019): o ApprovalService chama a função `execute` da tool registrada, que por sua vez chama o
 * serviço de aplicação normal (mesmas regras, RLS, eventos e auditoria dessa ação), com a pessoa que aprovou como autora. Roda
 * dentro de um SAVEPOINT: se o serviço falhar, tudo o que ele gravou é desfeito (nunca meia execução) e a transação segue para
 * registrar EXECUTION_FAILED. A chave de idempotência é o id da recomendação.
 */
const { sequelize } = require('../../../models');
const { buildToolServices } = require('../toolServices');
const { buildToolContext, guardContext } = require('../orchestrator/toolContext');
const { pruneOutput } = require('../tools/outputSchema');

const MESSAGE_MAX = 300;

/** Falha do serviço de aplicação -> { code, message } sem detalhe técnico nem pilha. */
function describeFailure(err) {
  const code = err && err.code && /^[A-Z0-9_]{3,80}$/.test(String(err.code)) ? String(err.code) : 'EXECUTION_ERROR';
  const message = err && err.isOperational && err.message ? String(err.message).slice(0, MESSAGE_MAX) : 'A ação não pôde ser concluída pelo serviço.';
  return { code, message };
}

async function executeApprovedAction({ ctx, recommendation, def, transaction }) {
  const action = recommendation.proposedAction;
  const scope = { groupId: ctx.groupId, companyId: ctx.companyId, userId: ctx.userId, permissions: ctx.permissions };
  const { services, readModels } = buildToolServices(transaction, scope, { includeWrite: true });
  const toolCtx = buildToolContext({
    auth: { userId: ctx.userId, permissions: ctx.permissions }, companyId: ctx.companyId, groupId: ctx.groupId, services, readModels,
    correlationId: recommendation.id, // idempotencyKey = recommendation_id
  });
  const savepoint = await sequelize.transaction({ transaction });
  try {
    const output = pruneOutput(def, await def.execute(guardContext(toolCtx, () => {}), action.args));
    await savepoint.commit();
    return { ok: true, output };
  } catch (err) {
    await savepoint.rollback();
    return { ok: false, failure: describeFailure(err) };
  }
}

module.exports = { executeApprovedAction, describeFailure };
