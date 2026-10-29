'use strict';

const logger = require('../../../utils/logger');
const { success } = require('../../../utils/httpResponse');
const runs = require('../orchestrator/runs');
const { executeRequest, authOf } = require('./runApi.service');
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
 * Executa o pedido. O run abre numa transação própria, confirmada na hora (`openTransaction`), e o restante roda na transação do pedido.
 * Passando de `ia.run.sincrono_max_ms` sem terminar, responde 202 `{ runId, status: 'RUNNING' }` e o run segue; o cliente consulta
 * GET /ai/runs/:id. Falha do orquestrador (`ok: false`): a transação é CONFIRMADA (run FAILED ou BLOCKED gravado) e a resposta é o erro.
 */
async function handleExecution(req, res, { kind, agentCode, body }) {
  const auth = authOf(req.auth);
  const tenant = { groupId: auth.groupId, companyId: auth.companyId };
  const params = await req.withTenantTransaction((t) => readRunApiParams(auth, t));
  let openedRunId = null;
  let announce;
  const known = new Promise((resolve) => { announce = resolve; });
  const onSpan = ({ runId }) => { if (runId && !openedRunId) { openedRunId = runId; announce(runId); } };
  const job = req.withTenantTransaction(async (transaction) => {
    if (kind === 'RUN' && body && typeof body.agentCode === 'string' && body.agentCode.trim() && !(await isAgentEnabled(body.agentCode, tenant, transaction))) {
      throw aiAgentDisabled(body.agentCode);
    }
    const result = await executeRequest({ kind, agentCode, body }, auth, transaction, { openTransaction: (fn) => req.withTenantTransaction(fn), onSpan });
    return { result, data: result.outcome.ok ? await toResponseData(result, auth, transaction) : null };
  });
  const settled = job.then((value) => ({ value }), (error) => ({ error }));
  const wait = waiter(params.syncMaxMs);
  let first = await Promise.race([settled, wait.promise]);
  wait.cancel();
  if (first.late) {
    const id = await Promise.race([known, settled.then(() => null)]);
    if (id) {
      settled.then((after) => { if (after.error) abortOpenRun(req, id); });
      return success(res, { statusCode: 202, data: { runId: id, status: 'RUNNING' } });
    }
    first = await settled;
  }
  if (first.error) {
    if (openedRunId) await abortOpenRun(req, openedRunId);
    throw first.error;
  }
  const { result, data } = first.value;
  if (!result.outcome.ok) throw failureToError(result.outcome);
  return success(res, { data });
}

module.exports = { handleExecution };
