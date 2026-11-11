'use strict';

/**
 * Origem verificável de prazo jurídico para os testes (Guia do Marcelo §12: `if (!input.sourceFileId &&
 * !input.sourceEventId) throw DEADLINE_SOURCE_REQUIRED`). Cria, uma vez por empresa, um arquivo fictício com SHA-256
 * (a "intimação" de origem) e devolve o id. Chame `prepararOrigem(tenant)` no before() e use `origem(tenant)` no
 * payload do prazo: `{ ..., sourceFileId: origem(tenant) }`. Não é teste.
 */
const crypto = require('node:crypto');
const { sequelize, File } = require('../../src/models');

const cache = new Map();

/** Mesmo arquivo de origem, criado DENTRO da transação do teste (some no rollback). */
async function origemNaTransacao(tenant, transaction) {
  const sfx = crypto.randomUUID();
  const file = await File.create(
    {
      groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `test/prazo-origem/${sfx}.pdf`, fileName: `intimacao-ficticia-${sfx.slice(0, 8)}.pdf`,
      mimeType: 'application/pdf', checksumSha256: crypto.createHash('sha256').update(sfx).digest('hex'), uploadedByUserId: tenant.userId || null,
      createdBy: tenant.userId || null, updatedBy: tenant.userId || null,
    },
    { transaction }
  );
  return file.id;
}

async function prepararOrigem(tenant) {
  if (cache.has(tenant.companyId)) return cache.get(tenant.companyId);
  const id = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    const sfx = crypto.randomUUID();
    const file = await File.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        storageKey: `test/prazo-origem/${sfx}.pdf`,
        fileName: `intimacao-ficticia-${sfx.slice(0, 8)}.pdf`,
        mimeType: 'application/pdf',
        checksumSha256: crypto.createHash('sha256').update(sfx).digest('hex'),
        uploadedByUserId: tenant.userId || null,
        createdBy: tenant.userId || null,
        updatedBy: tenant.userId || null,
      },
      { transaction }
    );
    return file.id;
  });
  cache.set(tenant.companyId, id);
  return id;
}

function origem(tenant) {
  const id = cache.get(tenant.companyId);
  if (!id) throw new Error('prazoOrigem: chame prepararOrigem(tenant) no before() do teste.');
  return id;
}

module.exports = { prepararOrigem, origem, origemNaTransacao };
