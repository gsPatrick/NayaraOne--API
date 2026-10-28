'use strict';

const { Op } = require('sequelize');
const { IntegrationWebhookInbox } = require('../../../models');
const { assertTransition } = require('./inbox.stateMachine');
const { auditarMudanca, visao } = require('./inbox.audit');
const { readInboxParams } = require('./inbox.params');
const { REASON_EXHAUSTED, REASON_INVALID } = require('./inbox.constants');

/** Muda o estado (tabela de transições), grava e audita antes/depois. `row` precisa estar travada (FOR UPDATE). */
async function moveTo(ctx, row, to, patch, motivo, transaction) {
  assertTransition(row.status, to);
  const antes = visao(row);
  await row.update({ ...patch, status: to }, { transaction });
  await auditarMudanca(ctx, antes, row, motivo, transaction);
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
    return moveTo(ctx, row, 'FAILED', {}, motivo, transaction).then((r) => moveTo(ctx, r, 'DEAD_LETTER', { deadLetterReason: REASON_EXHAUSTED }, 'Tentativas esgotadas.', transaction));
  }
  const lista = params.retryBackoffMs;
  const espera = lista[Math.min(row.attempts - 1, lista.length - 1)] ?? lista[lista.length - 1];
  return moveTo(ctx, row, 'FAILED', { nextAttemptAt: new Date(Date.now() + espera) }, motivo, transaction);
}

/** Schema inválido: RECEIVED -> DEAD_LETTER direto, sem retry e sem guardar o corpo. */
const rejectInvalid = (ctx, row, motivo, transaction) => moveTo(
  ctx, row, 'DEAD_LETTER', { deadLetterReason: `${REASON_INVALID}: ${String(motivo || '').slice(0, 300)}`, payloadRaw: null, payload: null }, 'Evento com schema inválido.', transaction
);

module.exports = { claimBatch, markProcessed, markFailed, rejectInvalid, moveTo };
