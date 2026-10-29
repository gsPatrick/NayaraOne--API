'use strict';

const { getSetting } = require('../../settings/settings.service');
const { RAG_KEYS: K, RAG_SETTING_DEFAULTS: D } = require('./retrieval.settings');

async function readInt(key, ctx, transaction, min = 1) {
  const n = Number(await getSetting(key, ctx, transaction, D[key]));
  return Number.isInteger(n) && n >= min ? n : D[key];
}

/** Domínios permitidos: lista separada por vírgula, minúsculos; entrada `*.exemplo.com` vale para os subdomínios. Vazia = nenhuma URL. */
function parseDomains(raw) {
  return String(raw || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/** Parâmetros do RAG da empresa; valor inválido volta ao padrão. A sobreposição nunca é maior que o chunk. */
async function readRagParams(ctx, transaction) {
  const [chunkTokens, chunkOverlap, secretsRejectPercent, embeddingBatch, restricted, domains] = await Promise.all([
    readInt(K.chunkTokens, ctx, transaction), readInt(K.chunkOverlap, ctx, transaction, 0), readInt(K.secretsRejectPercent, ctx, transaction),
    readInt(K.embeddingBatch, ctx, transaction), getSetting(K.indexRestricted, ctx, transaction, D[K.indexRestricted]),
    getSetting(K.allowedDomains, ctx, transaction, D[K.allowedDomains]),
  ]);
  return {
    chunkTokens,
    chunkOverlap: chunkOverlap >= chunkTokens ? Math.max(0, chunkTokens - 1) : chunkOverlap,
    secretsRejectPercent, embeddingBatch,
    indexRestricted: restricted === true || restricted === 'true',
    allowedDomains: parseDomains(domains),
  };
}

module.exports = { readRagParams, parseDomains };
