'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { mktContentVersionImmutable } = require('../marketing.errors');

/**
 * M9-D405 regra 3 — depois de publicar (ou durante a publicação, ou arquivada por ter sido publicada), a versão não muda. O banco já
 * recusa o UPDATE do corpo e dos fatos (MK001); aqui o serviço responde 409 em português antes de chegar lá. Todo caminho que altera
 * uma versão chama assertVersionMutable primeiro.
 */
const FROZEN_STATUSES = Object.freeze(['PUBLISHING', 'PUBLISHED', 'ARCHIVED']);

async function assertVersionMutable(versionId, tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT i.id AS item_id, i.status FROM marketing.content_versions v
       JOIN marketing.content_items i ON i.id = v.content_item_id AND i.company_id = v.company_id
      WHERE v.id = :versionId AND v.company_id = :companyId`,
    { replacements: { versionId, companyId: tenant.companyId }, transaction, type: QueryTypes.SELECT }
  );
  if (!rows[0]) throw AppError.notFound('Versão de conteúdo não encontrada.', 'MKT_CONTENT_VERSION_NOT_FOUND');
  if (FROZEN_STATUSES.includes(rows[0].status)) {
    throw mktContentVersionImmutable({ contentItemId: rows[0].item_id, status: rows[0].status });
  }
  return rows[0];
}

module.exports = { FROZEN_STATUSES, assertVersionMutable };
