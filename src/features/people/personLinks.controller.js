'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const linksService = require('./personLinks.service');
const personService = require('./person.service');

/**
 * POST /people/links — vincula a esta empresa a pessoa do grupo pelo CPF/CNPJ e o nome (permissão people:link, DI-M9I-4).
 * 201 com a pessoa como esta empresa a vê (só a base, vinculo.origem VINCULADA) e o resultado (VINCULADA ou REATIVADA);
 * 200 com JA_NESTA_EMPRESA quando a pessoa já é desta empresa. Não conferiu: 422 PERSON_LINK_NOT_MATCHED, sem id nem nome.
 */
const link = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const { resultado, person } = await req.withTenantTransaction(async (transaction) => {
    const r = await linksService.linkPersonByTaxId(payload, req.auth.userId, transaction);
    return { resultado: r.resultado, person: await personService.getPerson(r.personId, transaction) };
  });
  return success(res, { statusCode: resultado === 'JA_NESTA_EMPRESA' ? 200 : 201, data: person, meta: { resultado } });
});

/** POST /people/:id/unlink — desfaz o vínculo desta empresa com a pessoa (motivo obrigatório; auditado no banco). */
const unlink = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    linksService.unlinkPerson(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

module.exports = { link, unlink };
