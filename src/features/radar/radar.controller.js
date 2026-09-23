'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const radarService = require('./radar.service');

const create = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const { radar, matches } = await req.withTenantTransaction((transaction) =>
    radarService.createRadar(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: { ...radar.toJSON(), matches } });
});

const list = catchAsync(async (req, res) => {
  const radars = await req.withTenantTransaction((transaction) =>
    radarService.listRadars(transaction, { personId: req.query.personId, status: req.query.status })
  );
  return success(res, { data: radars });
});

// GET /radar/:id precisa devolver "matches" igual à criação/atualização: a tela de detalhe do
// radar (app/painel/radar/[id]) lê apiRadar.matches direto da resposta deste endpoint sempre
// que a página é aberta/recarregada — não só logo após criar/editar. Sem isso, reabrir um radar
// já existente sempre mostrava "0 imóveis compatíveis", mesmo com imóvel ativo batendo 100% dos
// critérios (bug real, confirmado comparando a resposta de criação com a de um GET subsequente).
const getOne = catchAsync(async (req, res) => {
  const { radar, matches } = await req.withTenantTransaction(async (transaction) => {
    const radar = await radarService.getRadar(req.params.id, transaction);
    const matches = await radarService.matchRadarToProperties(radar, transaction);
    return { radar, matches };
  });
  return success(res, { data: { ...radar.toJSON(), matches } });
});

const update = catchAsync(async (req, res) => {
  const { radar, matches } = await req.withTenantTransaction((transaction) =>
    radarService.updateRadar(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: { ...radar.toJSON(), matches } });
});

const remove = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    radarService.deleteRadar(req.params.id, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

const matches = catchAsync(async (req, res) => {
  const results = await req.withTenantTransaction((transaction) => radarService.getRadarMatches(req.params.id, transaction));
  return success(res, { data: results });
});

// M3-15: explica, critério a critério, por que um imóvel específico bate (ou não) num radar.
const explainMatch = catchAsync(async (req, res) => {
  const explanation = await req.withTenantTransaction((transaction) =>
    radarService.explainRadarMatch(req.params.id, req.params.propertyId, transaction)
  );
  return success(res, { data: explanation });
});

module.exports = { create, list, getOne, update, remove, matches, explainMatch };
