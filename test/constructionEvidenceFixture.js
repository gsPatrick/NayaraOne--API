'use strict';

// Evidência real para os testes de Obras: desde a matriz de fechamento do Marco 6 (10/11/2026) os
// serviços só aceitam ID de arquivo que exista em core.files da empresa (evidenceFiles.js). Cada
// chamada envia um JPEG de conteúdo único pelo módulo de arquivos real, na transação do teste.
const crypto = require('node:crypto');
const filesService = require('../src/features/files/files.service');

async function uploadEvidence(tenant, transaction, label = 'evidencia') {
  const content = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(24)]);
  return filesService.uploadFile(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      fileName: `${label}-${crypto.randomBytes(4).toString('hex')}.jpg`,
      mimeType: 'image/jpeg',
      contentBase64: content.toString('base64'),
      category: 'CONSTRUCTION_EVIDENCE',
    },
    tenant.userId,
    transaction
  );
}

/** Lista com `n` IDs de evidências reais. */
async function evidenceIds(tenant, transaction, n = 1, label = 'evidencia') {
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push((await uploadEvidence(tenant, transaction, label)).id);
  return ids;
}

module.exports = { uploadEvidence, evidenceIds };
