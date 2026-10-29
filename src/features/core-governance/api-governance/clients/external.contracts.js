'use strict';

const { Contract } = require('../../../../models');
const { parsePagination, pageResult } = require('../standards/pagination.helper');
const { inTenantTx } = require('../consumers/tenantTx');

// Dados resumidos (M9-D844 scope contracts:read): sem partes, sem valor total e sem usuário que criou.
const ATTRIBUTES = ['id', 'contractNumber', 'contractType', 'status', 'propertyId', 'startsAt', 'endsAt'];

/** GET /api-external/contracts (scope contracts:read): contratos da empresa da credencial, mais novos primeiro. */
async function listContracts(client, query) {
  return inTenantTx(client, async (transaction) => {
    const paging = await parsePagination(query, client, transaction);
    const where = { companyId: client.companyId };
    if (query.status) where.status = String(query.status).toUpperCase();
    const { rows, count } = await Contract.findAndCountAll({ where, attributes: ATTRIBUTES, order: [['created_at', 'DESC'], ['id', 'ASC']], limit: paging.limit, offset: paging.offset, transaction });
    return pageResult(rows.map((row) => row.toJSON()), paging, count);
  });
}

module.exports = { listContracts };
