'use strict';

const { Op } = require('sequelize');
const { sequelize, IntegrationDispatch, IntegrationConnection } = require('../../../../models');
const { applyTransition } = require('../dispatch.transition');
const { readDispatchParams } = require('../dispatch.params');
const { resolveEffectivePolicy } = require('../retry/retry.policy');
const { readRetryParams } = require('../retry/retry.params');
const { backoffMs } = require('../retry/retry.delay');
const { sendToDeadLetter } = require('../retry/retry.deadLetter');
const { reportDispatchError, MENSAGENS } = require('../retry/retry.report');

const CODE = 'SENDING_STALE';

/** A tentativa que ficou aberta quando o processo morreu: fecha como erro, sem conteúdo, para a saúde e o histórico não ficarem com ponta solta. */
const closeOpenAttempts = (id, transaction) => sequelize.query(
  `UPDATE "integration"."dispatch_attempts" SET finished_at = now(), outcome = 'ERROR', error_class = 'UNKNOWN', error_code = :code WHERE dispatch_id = :id AND finished_at IS NULL`,
  { replacements: { id, code: CODE }, transaction },
);

/**
 * recoverStaleSending — o processo morreu no meio (M9-D215 3.4): envio em SENDING há mais de `integration.dispatch.sending_stale_s` (padrão 120 s).
 * Operação PERIGOSA vai a UNKNOWN (pode ter saído antes de morrer; a reconciliação consulta o fornecedor e só repete se ele disser que não
 * há registro) e abre o erro CRITICAL; operação SEGURA vai a RETRY_WAIT como falha transitória, com backoff (ou à fila morta se acabaram as
 * tentativas). Devolve os envios recuperados.
 */
async function recoverStaleSending(ctx, transaction, { now = new Date() } = {}) {
  const params = await readDispatchParams(ctx, transaction);
  const velhos = await IntegrationDispatch.findAll({
    where: { companyId: ctx.companyId, status: 'SENDING', updated_at: { [Op.lt]: sequelize.literal(`now() - make_interval(secs => ${Number(params.sendingStaleS)})`) } },
    transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
  });
  const out = [];
  for (const row of velhos) {
    await closeOpenAttempts(row.id, transaction);
    if (row.criticalityOp === 'DANGEROUS') {
      await applyTransition(ctx, row, 'UNKNOWN', { lastErrorClass: 'UNKNOWN', lastErrorCode: CODE }, { motivo: 'Envio perigoso em SENDING sem resposta: estado desconhecido até a reconciliação.' }, transaction);
      await reportDispatchError(ctx, row, { errorClass: 'UNKNOWN', errorCode: CODE, severity: 'CRITICAL', message: MENSAGENS.UNKNOWN }, transaction);
    } else if (row.attempts >= row.maxAttempts) {
      await sendToDeadLetter(ctx, row, { class: 'TRANSIENT', code: CODE }, undefined, transaction);
    } else {
      const connection = await IntegrationConnection.findOne({ where: { id: row.connectionId, companyId: ctx.companyId }, transaction });
      const retry = connection ? (await resolveEffectivePolicy(ctx, connection, transaction)).retry : await readRetryParams(ctx, transaction);
      await applyTransition(ctx, row, 'RETRY_WAIT', { lastErrorClass: 'TRANSIENT', lastErrorCode: CODE, nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts, retry)) }, { motivo: 'Envio seguro em SENDING sem resposta: nova tentativa com backoff.' }, transaction);
    }
    out.push(row);
  }
  return out;
}

module.exports = { recoverStaleSending, STALE_CODE: CODE };
