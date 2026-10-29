'use strict';

const { Op } = require('sequelize');
const { IntegrationWebhookInbox } = require('../../../models');
const { assertTransition } = require('./inbox.stateMachine');
const { auditarMudanca, visao } = require('./inbox.audit');
const { readInboxParams } = require('./inbox.params');
const { REASON_EXHAUSTED, REASON_INVALID } = require('./inbox.constants');
const { reportDeadLetter } = require('./inbox.dlqError');
const { settleRetryingErrors } = require('../errors/errors.settle');

/** Muda o estado (tabela de transições), grava e audita antes/depois. `row` precisa estar travada (FOR UPDATE). */
async function moveTo(ctx, row, to, patch, motivo, transaction) {
  assertTransition(row.status, to);
  const antes = visao(row);
  await row.update({ ...patch, status: to }, { transaction });
  await auditarMudanca(ctx, antes, row, motivo, transaction);
  // M9-D250: o erro que foi a RETRYING no retry humano fecha com o desfecho do evento (processou: resolve; voltou a falhar: reabre).
  if (to === 'PROCESSED') await settleRetryingErrors(ctx, row.id, 'RESOLVED', transaction, 'O evento repetido foi processado.');
  else if (to === 'DEAD_LETTER') await settleRetryingErrors(ctx, row.id, 'OPEN', transaction);
  return row;
}

/**
 * claimBatch — o worker pega até `limit` eventos RECEIVED/FAILED vencidos com FOR UPDATE SKIP LOCKED e os leva a
 * PROCESSING (attempts+1). Dois workers nunca pegam o mesmo evento. Deve rodar numa transação no contexto da empresa.
 */
async function claimBatch(ctx, limit, transaction) {
  const rows = await IntegrationWebhookInbox.findAll({
    where: { companyId: ctx.companyId, status: { [Op.in]: ['RECEIVED', 'FAILED'] }, nextAttemptAt: { [Op.lte]: new Date() } },
    order: [['next_attempt_at', 'ASC'], ['id', 'ASC']],
    limit: Math.max(1, Math.min(Number(limit) || 10, 500)),
    transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
  });
  const claimed = [];
  for (const row of rows) {
    claimed.push(await moveTo(ctx, row, 'PROCESSING', { attempts: row.attempts + 1 }, 'Evento pego pelo worker.', transaction));
  }
  return claimed;
}

const markProcessed = (ctx, row, transaction) => moveTo(ctx, row, 'PROCESSED', { processedAt: new Date() }, 'Evento processado.', transaction);

/** Falha no processamento: volta a FAILED com espera crescente, ou vai à fila morta ao esgotar as tentativas. */
async function markFailed(ctx, row, motivo, transaction) {
  const params = await readInboxParams(ctx, transaction);
  if (row.attempts >= params.maxAttempts) {
    const r = await moveTo(ctx, row, 'FAILED', {}, motivo, transaction);
    const morto = await moveTo(ctx, r, 'DEAD_LETTER', { deadLetterReason: REASON_EXHAUSTED }, 'Tentativas esgotadas.', transaction);
    await reportDeadLetter(ctx, morto, REASON_EXHAUSTED, transaction);
    return morto;
  }
  const lista = params.retryBackoffMs;
  const espera = lista[Math.min(row.attempts - 1, lista.length - 1)] ?? lista[lista.length - 1];
  return moveTo(ctx, row, 'FAILED', { nextAttemptAt: new Date(Date.now() + espera) }, motivo, transaction);
}

/** Schema inválido: RECEIVED -> DEAD_LETTER direto, sem retry e sem guardar o corpo. */
async function rejectInvalid(ctx, row, motivo, transaction) {
  const morto = await moveTo(
    ctx, row, 'DEAD_LETTER', { deadLetterReason: `${REASON_INVALID}: ${String(motivo || '').slice(0, 300)}`, payloadRaw: null, payload: null }, 'Evento com schema inválido.', transaction
  );
  await reportDeadLetter(ctx, morto, REASON_INVALID, transaction);
  return morto;
}

module.exports = { claimBatch, markProcessed, markFailed, rejectInvalid, moveTo };
