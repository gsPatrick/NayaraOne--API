'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const { listOpportunityCarts } = require('./cartQueries.service');

// GET /opportunities/:id/carts — carrinhos da oportunidade com versões, link e rastreio (tela do carrinho, livro do Marco 3 §14).
const listCarts = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((transaction) => listOpportunityCarts(req.params.id, transaction));
  return success(res, { data });
});

module.exports = { listCarts };
