'use strict';

// Apoio dos testes da migração do Correspondente para o registro de integração (M9-D240): caso pronto para enviar, envio, leitura dos envios e do cofre temporário.
const { sequelize, getSeedTenant, withRollbackTenantTransaction, withTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const financingCases = require('../../../src/features/correspondent/cases/financingCases.service');
const simulationsService = require('../../../src/features/correspondent/cases/simulations.service');
const documentsService = require('../../../src/features/correspondent/cases/caseDocuments.service');
const submissionsService = require('../../../src/features/correspondent/cases/submissions.service');
const { Person, File, FinancingCase, Property } = require('../../../src/models');

let tenant;
const carregar = async () => { tenant = await getSeedTenant(); return tenant; };
const a = () => [tenant.userId, tenant.groupId, tenant.companyId];
const ctxDe = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });

async function novoCaso(t, providerCode = 'sandbox', { comImovel = false } = {}) {
  const principal = await Person.create({
    groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proponente D240 ${uniqueSuffix()}`, taxIdNormalized: String(Math.floor(Math.random() * 1e11)).padStart(11, '0'), createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction: t });
  const imovel = comImovel ? await Property.create({ groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel D240 ${uniqueSuffix()}`, internalCode: `D240-${uniqueSuffix()}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t }) : null;
  return financingCases.createFinancingCase({ groupId: tenant.groupId, companyId: tenant.companyId, providerCode, propertyId: imovel ? imovel.id : undefined, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] }, tenant.userId, t);
}

async function checklistValidado(caso, t) {
  const tn = { groupId: tenant.groupId, companyId: tenant.companyId };
  const req = await documentsService.createRequirement(caso.id, { documentType: 'RG_CPF', required: true }, tenant.userId, tn, t);
  const file = await File.create({
    groupId: tenant.groupId, companyId: tenant.companyId, fileName: `rg-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 1024, storageKey: `test/${uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId,
  }, { transaction: t });
  await documentsService.uploadDocument(caso.id, req.id, { fileId: file.id }, tenant.userId, tn, t);
  await documentsService.validateRequirement(caso.id, req.id, tenant.userId, tn, t, { manualFields: { taxId: '52998224725', name: 'Fulano de Tal', income: 5000, accountNumber: '12345-6' } });
}

/** Caso com checklist validado e simulação (valor 150000), pronto para `requestSubmission`. */
async function casoPronto(t, providerCode = 'sandbox', opcoes = {}) {
  const caso = await novoCaso(t, providerCode, opcoes);
  await checklistValidado(caso, t);
  if (providerCode === 'sandbox') await simulationsService.createSimulation(caso.id, { amount: 150000, termMonths: 240 }, ...a(), t);
  return caso;
}

const pedir = (caso, t) => submissionsService.requestSubmission(caso.id, { consent: true }, ...a(), t);
const processar = async (submission, caso, t) => submissionsService.processPendingSubmission(submission, await FinancingCase.findByPk(caso.id, { transaction: t }), tenant.userId, t);

const envios = async (t, submissionId) => (await sequelize.query(
  "SELECT * FROM integration.dispatches WHERE aggregate_type = 'ProviderSubmission' AND aggregate_id = :id ORDER BY created_at", { replacements: { id: submissionId }, transaction: t },
))[0];

module.exports = {
  sequelize, withRollbackTenantTransaction, withTenantTransaction, uniqueSuffix, carregar, a, ctxDe, novoCaso, checklistValidado, casoPronto, pedir, processar, envios, submissionsService, financingCases,
  get tenant() { return tenant; },
};
