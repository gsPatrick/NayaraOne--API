'use strict';

// Semente de chunks para os testes da busca (M9-D023): grava uma ingestão e um chunk com os metadados escolhidos, com o vetor real do
// provedor sandbox (o mesmo que a busca usa), sem passar pelo pipeline. `comoEmpresa` troca a empresa da sessão dentro da mesma transação.

const { AiIngestion, AiChunk } = require('../../../src/models');
const { embedTexts } = require('../../../src/features/ai/retrieval/embedder');
const { sequelize, uid } = require('./ragEnv');

async function semear(tenant, tx, { texto, requiredPermission = 'ai:use', classification = 'INTERNAL', ownerScope = 'COMPANY', ownerUserId = null, sourceType = 'URL', sourceId = uid(),
  version = 1, effectiveFrom = new Date('2026-01-01T00:00:00Z'), effectiveUntil = null, status = 'ACTIVE', chunkIndex = 0 } = {}) {
  const ingestion = await AiIngestion.create({
    groupId: tenant.groupId, companyId: tenant.companyId, sourceKind: sourceType, sourceRef: sourceId, sourceId, status: 'INDEXED', step: 'DONE',
    contentHash: 'a'.repeat(64), classification, sourceVersion: version, chunksCount: 1, finishedAt: new Date(),
  }, { transaction: tx });
  const { vectors, model } = await embedTexts({ groupId: tenant.groupId, companyId: tenant.companyId }, [texto], { classification: 'INTERNAL', batch: 1 }, tx);
  const chunk = await AiChunk.create({
    groupId: tenant.groupId, companyId: tenant.companyId, ingestionId: ingestion.id, sourceId, sourceType, sourceVersion: version, chunkIndex, contentRedacted: texto,
    contentHash: require('node:crypto').createHash('sha256').update(texto).digest('hex'), tokensCount: texto.split(/\s+/).length, classification, effectiveFrom, effectiveUntil,
    requiredPermission, ownerScope, ownerUserId, embedding: vectors[0].embedding, embeddingNorm: vectors[0].norm, embeddingModel: model, status,
  }, { transaction: tx });
  return { id: chunk.id, sourceId, ingestionId: ingestion.id };
}

/** Executa `fn` com a sessão na empresa `tenant` e devolve a sessão para a empresa anterior. */
async function comoEmpresa(tenant, tx, fn) {
  const [[atual]] = await sequelize.query("SELECT current_setting('app.group_id', true) AS g, current_setting('app.company_id', true) AS c", { transaction: tx });
  await sequelize.query('SELECT set_config(\'app.group_id\', :g, true), set_config(\'app.company_id\', :c, true)', { replacements: { g: tenant.groupId, c: tenant.companyId }, transaction: tx });
  try { return await fn(); } finally {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true), set_config(\'app.company_id\', :c, true)', { replacements: { g: atual.g || '', c: atual.c || '' }, transaction: tx });
  }
}

module.exports = { semear, comoEmpresa };
