'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const errors = require('./calendar.errors');
const service = require('./calendar.service');

async function list(req, res) {
  const result = await req.withTenantTransaction((transaction) => service.listCalendar(
    tenantFromAuth(req),
    { permissions: req.auth.permissions || [], query: req.query },
    transaction
  ));
  return success(res, { data: result.items, pagination: result.pagination, meta: result.meta });
}

/** O calendário não aceita escrita em item: a rota existe só para responder 404 padronizado (o status muda pelo projetor). */
async function itemNotFound() {
  throw errors.notFound();
}

module.exports = { list, itemNotFound };
