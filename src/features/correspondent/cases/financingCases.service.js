'use strict';

const { FinancingCase, CaseApplicant, Person, Property, Opportunity } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveFinancingProviderAdapterByCode } = require('../adapters/resolveFinancingProviderAdapter');
const { publishFinancingCaseCreated } = require('../correspondentEvents.service');
const { flagPossibleDuplicate } = require('../correspondentDuplicate.service');
const { PRODUCTS } = require('../eligibility.service');

const APPLICANT_ROLES = ['PRINCIPAL', 'CO_APPLICANT'];
const FINANCING_PURPOSES = ['RESIDENCIAL', 'COMERCIAL'];

/**
 * createFinancingCase — Marco 8 Fase 1. Cria um financing_case em DRAFT com seus proponentes
 * (case_applicants). Cada proponente precisa ser um cadastro real de Person já existente no
 * tenant (nunca texto livre — ver PADRAO_COMPONENTES_E_REGRAS.md). Exatamente um proponente
 * precisa ser PRINCIPAL.
 */
async function createFinancingCase(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, providerCode, purpose, applicants, opportunityId, product } = payload;

  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCING_CASE_VALIDATION');
  }
  if (!Array.isArray(applicants) || applicants.length === 0) {
    throw AppError.badRequest('Informe ao menos um proponente ("applicants").', 'FINANCING_CASE_VALIDATION');
  }
  for (const line of applicants) {
    if (!line || !line.personId) {
      throw AppError.badRequest('Cada proponente precisa de "personId" — selecione um contato já cadastrado.', 'FINANCING_CASE_VALIDATION');
    }
    if (line.role && !APPLICANT_ROLES.includes(line.role)) {
      throw AppError.badRequest(`"role" do proponente precisa ser um de: ${APPLICANT_ROLES.join(', ')}.`, 'FINANCING_CASE_VALIDATION');
    }
  }
  const principals = applicants.filter((a) => (a.role || 'PRINCIPAL') === 'PRINCIPAL');
  if (principals.length !== 1) {
    throw AppError.badRequest('O financiamento precisa de exatamente um proponente principal ("role": "PRINCIPAL").', 'FINANCING_CASE_VALIDATION');
  }
  const personIds = applicants.map((a) => a.personId);
  if (new Set(personIds).size !== personIds.length) {
    throw AppError.badRequest('O mesmo contato não pode ser proponente duas vezes no mesmo caso.', 'FINANCING_CASE_VALIDATION');
  }

  const people = await Person.findAll({ where: { id: personIds, groupId, companyId }, transaction });
  if (people.length !== personIds.length) {
    throw AppError.badRequest('Um ou mais proponentes não correspondem a contatos cadastrados nesta empresa.', 'FINANCING_CASE_APPLICANT_NOT_FOUND');
  }

  if (propertyId) {
    const property = await Property.findOne({ where: { id: propertyId, groupId, companyId }, transaction });
    if (!property) {
      throw AppError.badRequest('O imóvel informado não foi encontrado nesta empresa.', 'FINANCING_CASE_PROPERTY_NOT_FOUND');
    }
  }

  // Achado real — auditoria Fase 14+ (Frente Conformidade Caderno, ciclo 3): `opportunityId` era
  // aceito do payload sem nenhuma validação de existência/propriedade, permitindo vincular (e
  // depois auditar via correspondentCrmSync.service.js) uma oportunidade de OUTRA empresa. Mesmo
  // padrão de validação já usado acima para `propertyId`.
  if (opportunityId) {
    const opportunity = await Opportunity.findOne({ where: { id: opportunityId, groupId, companyId }, transaction });
    if (!opportunity) {
      throw AppError.badRequest('A oportunidade informada não foi encontrada nesta empresa.', 'FINANCING_CASE_OPPORTUNITY_NOT_FOUND');
    }
  }

  // Sem provider informado, vale o padrão da empresa (Configurações); sem configuração, sandbox.
  const { getSetting } = require('../../settings/settings.service');
  const resolvedProviderCode = (providerCode ? String(providerCode).trim().toLowerCase() : '') || await getSetting('correspondent.financing_provider', { groupId, companyId }, transaction, 'sandbox') || 'sandbox';
  // Mesmo adapter registry da Fase 0 — provider desconhecido nunca é aceito silenciosamente.
  if (!resolveFinancingProviderAdapterByCode(resolvedProviderCode)) {
    throw AppError.badRequest(`Provider "${resolvedProviderCode}" não é suportado.`, 'FINANCING_CASE_PROVIDER_UNKNOWN');
  }

  const resolvedPurpose = purpose || 'RESIDENCIAL';
  if (!FINANCING_PURPOSES.includes(resolvedPurpose)) {
    throw AppError.badRequest(`"purpose" precisa ser um de: ${FINANCING_PURPOSES.join(', ')}.`, 'FINANCING_CASE_VALIDATION');
  }

  const resolvedProduct = product || 'FINANCIAMENTO_IMOBILIARIO';
  if (!PRODUCTS.includes(resolvedProduct)) {
    throw AppError.badRequest(`"product" precisa ser um de: ${PRODUCTS.join(', ')}.`, 'FINANCING_CASE_VALIDATION');
  }

  const financingCase = await FinancingCase.create(
    {
      groupId,
      companyId,
      product: resolvedProduct,
      propertyId: propertyId || null,
      opportunityId: opportunityId || null,
      providerCode: resolvedProviderCode,
      purpose: resolvedPurpose,
      status: 'DRAFT',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  for (const line of applicants) {
    // eslint-disable-next-line no-await-in-loop
    await CaseApplicant.create(
      { groupId, companyId, financingCaseId: financingCase.id, personId: line.personId, role: line.role || 'PRINCIPAL' },
      { transaction }
    );
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.financing_case.created',
      entityType: 'FinancingCase',
      entityId: financingCase.id,
      beforeJson: { registro: 'Não existia (registro criado nesta ação)' },
      afterJson: {
        id: financingCase.id,
        status: financingCase.status,
        providerCode: financingCase.providerCode,
        purpose: financingCase.purpose,
        product: financingCase.product,
      },
      reason: `Caso de financiamento criado com ${applicants.length} proponente(s), provider "${resolvedProviderCode}".`,
    },
    transaction
  );

  await publishFinancingCaseCreated(financingCase, transaction);

  // Marco 8 Fase 11 — sinaliza possível duplicata (fingerprint), nunca bloqueia a criação.
  const principal = applicants.find((a) => (a.role || 'PRINCIPAL') === 'PRINCIPAL');
  await flagPossibleDuplicate(financingCase, principal.personId, actorUserId, transaction);

  return getFinancingCase(financingCase.id, groupId, companyId, transaction);
}

async function getFinancingCase(id, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({
    where: { id, groupId, companyId },
    include: [
      { model: CaseApplicant, as: 'applicants', include: [{ model: Person, as: 'person', attributes: ['id', 'legalName', 'personType'] }] },
      { model: Property, as: 'property', attributes: ['id', 'internalCode', 'title'], required: false },
    ],
    transaction,
  });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  return financingCase;
}

async function listFinancingCases(groupId, companyId, transaction, { status } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  const cases = await FinancingCase.findAll({
    where,
    include: [
      { model: CaseApplicant, as: 'applicants', include: [{ model: Person, as: 'person', attributes: ['id', 'legalName', 'personType'] }] },
      { model: Property, as: 'property', attributes: ['id', 'internalCode', 'title'], required: false },
    ],
    order: [['created_at', 'DESC']],
    limit: 1500,
    transaction,
  });
  return cases;
}

module.exports = { createFinancingCase, getFinancingCase, listFinancingCases };
