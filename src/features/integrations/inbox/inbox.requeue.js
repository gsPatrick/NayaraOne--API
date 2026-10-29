'use strict';

const { auditarMudanca, visao } = require('./inbox.audit');

/**
 * requeueDeadLetter — a ÚNICA saída da fila morta da caixa de entrada (M9-D250): o retry humano devolve o evento a RECEIVED para o worker processar de novo.
 * Fica fora da tabela de transições de propósito (DEAD_LETTER continua final para o worker e para o código): só o retry autorizado chama, com a linha
 * travada (FOR UPDATE). `attempts` volta ao limite menos as tentativas extras concedidas, para o evento ter exatamente essas tentativas a mais.
 */
async function requeueDeadLetter(ctx, row, { maxAttempts, extraAttempts, reason }, transaction) {
  const antes = visao(row);
  await row.update({
    status: 'RECEIVED', attempts: Math.max(0, maxAttempts - extraAttempts), nextAttemptAt: new Date(), deadLetterReason: null,
  }, { transaction });
  await auditarMudanca(ctx, antes, row, `Retry humano autorizado (fila morta -> recebido): ${String(reason).slice(0, 300)}`, transaction);
  return row;
}

module.exports = { requeueDeadLetter };
