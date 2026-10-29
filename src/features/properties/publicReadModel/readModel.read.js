'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { PUBLIC_FIELDS } = require('./constants');
const { syncPublicPropertyReadModel, TABLE } = require('./readModel.sync');

/** 409: o imóvel não atende às condições para publicação (disponível, publicação autorizada e oferta ativa). */
const notPublishable = (reasons) => AppError.conflict('Este imóvel não atende às condições para publicação.', 'INTEGRATION_PROPERTY_NOT_PUBLISHABLE', { reasons });

/**
 * loadPublicPropertyReadModel — a ÚNICA fonte do que portais e site recebem (M9-D231): o registro do read model do imóvel,
 * com os campos públicos e nada mais. Antes de ler, confere o registro contra a origem (autocorreção se um evento se perdeu).
 * Imóvel que não atende às condições: 409 INTEGRATION_PROPERTY_NOT_PUBLISHABLE (e o registro, se existia, sai).
 */
async function loadPublicPropertyReadModel(propertyId, tenant, transaction) {
  const synced = await syncPublicPropertyReadModel(propertyId, tenant, transaction);
  if (synced.status === 'REMOVED' || synced.status === 'ABSENT') throw notPublishable(synced.reasons);
  const rows = await sequelize.query(`SELECT ${PUBLIC_FIELDS.join(', ')} FROM ${TABLE} WHERE property_id = :propertyId AND company_id = :companyId`, {
    replacements: { propertyId, companyId: tenant.companyId }, transaction, type: QueryTypes.SELECT,
  });
  if (rows.length === 0) throw notPublishable(['NOT_FOUND']);
  return rows[0];
}

module.exports = { loadPublicPropertyReadModel, notPublishable };
