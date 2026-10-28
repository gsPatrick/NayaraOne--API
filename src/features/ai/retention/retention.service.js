'use strict';

const { purgeAiContentInDb } = require('../readmodels/retentionSupport.readmodel');
const { readRetentionParams } = require('./retention.params');
const { providerRetentionCaps } = require('./retention.providerCaps');

/**
 * Expurga o CONTEÚDO vencido da empresa da sessão (resumos, argumentos e resultado de ferramentas, trecho de fontes) em
 * ai.ai_runs e ai.ai_sources, mantendo metadados, custo e hashes. Prazo do run = menor entre o da maior classificação das
 * fontes e a retenção contratada do provider. Devolve { runs, sources }. `now` só existe para o teste do relógio.
 */
async function purgeExpiredAiContent(ctx, transaction, { now = new Date() } = {}) {
  const p = await readRetentionParams(ctx, transaction);
  const caps = await providerRetentionCaps(transaction);
  return purgeAiContentInDb({ ...p, caps, now }, transaction);
}

module.exports = { purgeExpiredAiContent };
