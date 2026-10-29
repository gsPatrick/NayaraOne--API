'use strict';

const { CaseApplicant, Person } = require('../../../models');

/**
 * Objeto de domínio do envio do caso ao provider (M9-D240): o que o outputMapper `financing.submitCase` (M9-D219) aceita. Só o proponente principal (nome e documento
 * pelo consentimento já registrado no envio), a referência do caso e o valor da operação. Documentos, consentimento e demais proponentes NÃO saem aqui.
 */
async function buildSubmitDomainObject(financingCase, requestSnapshot, transaction) {
  const proponentes = await CaseApplicant.findAll({ where: { financingCaseId: financingCase.id, groupId: financingCase.groupId, companyId: financingCase.companyId }, order: [['role', 'ASC'], ['id', 'ASC']], transaction });
  const principal = proponentes.find((p) => p.role === 'PRINCIPAL') || proponentes[0] || null;
  const pessoa = principal ? await Person.findByPk(principal.personId, { transaction }) : null;
  const objeto = { caseRef: financingCase.id };
  if (pessoa && pessoa.legalName) objeto.proponentName = pessoa.legalName;
  if (pessoa && pessoa.taxIdNormalized) objeto.proponentDocument = pessoa.taxIdNormalized;
  if (requestSnapshot && requestSnapshot.amount !== null && requestSnapshot.amount !== undefined) objeto.amount = requestSnapshot.amount;
  return objeto;
}

module.exports = { buildSubmitDomainObject };
