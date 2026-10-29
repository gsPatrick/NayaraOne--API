'use strict';

const { recordError } = require('../../errors');
const { moveTo } = require('../../inbox/inbox.worker');
const { allowlistOf } = require('../../registry/webhookSchemaPick');
const { CODES, MENSAGENS } = require('./worker.errors');

/**
 * Fila morta por dado inválido (M9-D212 3.3): sem nova tentativa (a tentativa atual é a única), o corpo bruto e o JSON lido são ANULADOS e o erro de integração guarda só o
 * conteúdo sanitizado (campos do esquema do adapter, textos até 200 caracteres, CPF, e-mail, telefone e segredos trocados por [REDACTED]) mais o hash e o tamanho.
 * O caminho da máquina de estados é PROCESSING -> FAILED -> DEAD_LETTER (a tabela de transições da D203 não muda).
 */
async function deadLetterInvalid(ctx, row, failure, transaction) {
  const hash = row.payloadHash;
  const payload = failure.payload || (row.payload && typeof row.payload === 'object' ? row.payload : undefined);
  const tamanho = row.payloadRaw ? Buffer.from(row.payloadRaw).length : Buffer.byteLength(JSON.stringify(payload || {}));
  const emFalha = await moveTo(ctx, row, 'FAILED', {}, failure.detail, transaction);
  const morto = await moveTo(ctx, emFalha, 'DEAD_LETTER', { deadLetterReason: failure.reason, payloadRaw: null, payload: null }, `Evento inválido (${failure.reason}): ${failure.detail} Corpo de ${tamanho} bytes, hash ${String(hash).slice(0, 12)}.`.slice(0, 480), transaction);
  await recordError(ctx, {
    providerCode: row.providerCode, connectionId: row.connectionId || null, source: 'WEBHOOK', sourceRefId: row.id, operation: 'webhook.process', errorClass: 'VALIDATION',
    errorCode: CODES[failure.reason] || 'INTEGRATION_WEBHOOK_PAYLOAD_INVALID', message: MENSAGENS[failure.reason] || MENSAGENS.SCHEMA_INVALID,
    payload, allowlist: allowlistOf(failure.schema), payloadHash: hash, attempts: Math.max(1, row.attempts || 1),
  }, transaction);
  return morto;
}

module.exports = { deadLetterInvalid };
