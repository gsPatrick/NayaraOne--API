'use strict';

const chunks = require('./chunks.repository');
const V = require('./ingestion.input');
const knowledgeExpiry = require('../knowledge/knowledgeExpiry.service');

/**
 * Marca como vencido o que passou do prazo (M9-D024, job diário): primeiro o conhecimento homologado (EXPIRED, com os chunks dele), depois
 * qualquer chunk ACTIVE cuja vigência terminou (arquivos e links com `effective_until`). Idempotente. Devolve { knowledge, chunks }.
 */
async function expireSources(ctx, transaction, { now = new Date() } = {}) {
  V.ctxOk(ctx);
  const knowledge = await knowledgeExpiry.expireEnded(ctx, transaction, { now });
  const rest = await chunks.expireEnded(ctx, now, transaction);
  return { knowledge, chunks: rest };
}

module.exports = { expireSources };
