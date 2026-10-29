'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { PUBLIC_FIELDS } = require('../../../properties/publicReadModel');
const { parsePagination, pageResult } = require('../standards/pagination.helper');
const { inTenantTx } = require('../consumers/tenantTx');

/**
 * GET /api-external/properties (scope properties:read): os imóveis publicados da empresa, SÓ com os campos públicos do read model (M9-D231): nada de proprietário, documento, valor
 * interno nem identificador interno. A empresa é a da credencial; a RLS isola o resto.
 */
async function listProperties(client, query) {
  return inTenantTx(client, async (transaction) => {
    const paging = await parsePagination(query, client, transaction);
    const where = 'WHERE company_id = :companyId';
    const items = await sequelize.query(
      `SELECT ${PUBLIC_FIELDS.join(', ')} FROM "real_estate"."public_property_read_model" ${where} ORDER BY published_at DESC NULLS LAST, public_code LIMIT :limit OFFSET :offset`,
      { replacements: { companyId: client.companyId, limit: paging.limit, offset: paging.offset }, transaction, type: QueryTypes.SELECT }
    );
    const [{ total }] = await sequelize.query(`SELECT count(*)::int AS total FROM "real_estate"."public_property_read_model" ${where}`, { replacements: { companyId: client.companyId }, transaction, type: QueryTypes.SELECT });
    return pageResult(items, paging, total);
  });
}

module.exports = { listProperties };
