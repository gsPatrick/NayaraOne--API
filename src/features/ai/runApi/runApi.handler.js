'use strict';

const { safeLogger: logger } = require('../audit/safeLogger');
const { success } = require('../../../utils/httpResponse');
const runs = require('../orchestrator/runs');
const { prepareRequest, authOf } = require('./runApi.service');
const { initToolRegistry } = require('../tools');
const { readRunApiParams } = require('./runApi.params');
const { toResponseData, failureToError } = require('./runApi.response');
const { isAgentEnabled } = require('../aiGate.middleware');
const { aiAgentDisabled } = require('../ai.errors');

const ABORT_CODE = 'AI_RUN_ABORTED';

/** Espera `ms` sem segurar o processo; `cancel` solta o relógio quando o run termina antes. */
function waiter(ms) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(() => resolve({ late: true }), ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** O run foi aberto (e confirmado) mas a execução caiu por erro inesperado: ele não fica RUNNING para sempre. */
async function abortOpenRun(req, runId) {
  try {
    await req.withTenantTransaction((t) => runs.finishRun(authOf(req.auth), runId, { status: 'FAILED', errorCode: ABORT_CODE }, t));
  } catch (err) {
    logger.warn({ runId, code: err && err.code }, 'ai.run.abort_failed');
  }
}

/**
 * Executa o pedido em DUAS transações em sequência, nunca ao mesmo tempo (cada pedido segura uma conexão por vez): 1) prepara e abre o run
 * (corpo, conversa, agente, taxa por pessoa sob trava) e CONFIRMA, para o run já ser visível a quem o consulta; 2) executa o restante.
 * Passando de `ia.run.sincrono_max_ms` sem terminar, responde 202 `{ runId, status: 'RUNNING' }` e o run segue; o cliente consulta
 * GET /ai/runs/:id. Falha do orquestrador (`ok: false`): a transação é CONFIRMADA (run FAILED ou BLOCKED gravado) e a resposta é o erro.
 */
async function handleExecution(req, res, { kind, agentCode, body }) {
  const auth = authOf(req.auth);
  const tenant = { groupId: auth.groupId, companyId: auth.companyId };
  // O registro de tools lê o banco ao ser montado (só no primeiro uso do processo): monta antes de segurar a conexão da transação do pedido.
  await initToolRegistry();
  const params = await req.withTenantTransaction((t) => readRunApiParams(auth, t));
  const prepared = await req.withTenantTransaction(async (transaction) => {
    if (kind === 'RUN' && body && typeof body.agentCode === 'string' && body.agentCode.trim() && !(await isAgentEnabled(body.agentCode, tenant, transaction))) {
      throw aiAgentDisabled(body.agentCode);
    }
    return prepareRequest({ kind, agentCode, body }, auth, transaction);
  });
  const openedRunId = prepared.opened.opened.run.id;
  const job = req.withTenantTransaction(async (transaction) => {
    const result = await prepared.execute(transaction);
    return { result, data: result.outcome.ok ? await toResponseData(result, auth, transaction) : null };
  });
  const settled = job.then((value) => ({ value }), (error) => ({ error }));
  const wait = waiter(params.syncMaxMs);
  let first = await Promise.race([settled, wait.promise]);
  wait.cancel();
  if (first.late) {
    settled.then((after) => { if (after.error) abortOpenRun(req, openedRunId); });
    return success(res, { statusCode: 202, data: { runId: openedRunId, status: 'RUNNING' } });
  }
  if (first.error) {
    await abortOpenRun(req, openedRunId);
    throw first.error;
  }
  const { result, data } = first.value;
  if (!result.outcome.ok) throw failureToError(result.outcome);
  return success(res, { data });
}

module.exports = { handleExecution };
