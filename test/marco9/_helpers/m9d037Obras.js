'use strict';

// Fábricas de obras para os testes da NAY Obras (M9-D037): tudo pelos serviços de aplicação do Marco 6, na transação do teste (rollback).
const projectsService = require('../../../src/features/construction/projects.service');
const dailyReportsService = require('../../../src/features/construction/dailyReports.service');
const nonconformitiesService = require('../../../src/features/construction/nonconformities.service');
const maintenanceCasesService = require('../../../src/features/construction/maintenanceCases.service');
const { FinancialEntry, Property } = require('../../../src/models');
const { uniqueSuffix } = require('../../testHelpers');

const DAY = 86400000;
const dia = (offsetDias) => new Date(Date.now() + offsetDias * DAY).toISOString().slice(0, 10);

/** Obra com prazo planejado `atrasoDias` atrás (atrasada) ou à frente (negativo), orçamento base e custo já pago. */
async function criarObra(tenant, tx, { name = `QA-M9 Obra ${uniqueSuffix()}`, atrasoDias = 0, orcado = '100000.00', realizado = null } = {}) {
  // meio dia a menos: o serviço arredonda o atraso para cima (ceil), então 10 dias de atraso são 9,5 dias corridos desde o prazo
  const prazo = new Date(Date.now() - (atrasoDias > 0 ? atrasoDias - 0.5 : atrasoDias) * DAY).toISOString();
  const project = await projectsService.createProject({
    groupId: tenant.groupId, companyId: tenant.companyId, name, managerUserId: tenant.userId, endsAtPlanned: prazo, budgetAmount: orcado,
  }, tenant.userId, tx);
  if (realizado !== null) {
    await FinancialEntry.create({
      groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', status: 'SETTLED', amount: realizado, constructionProjectId: project.id,
      description: 'Custo pago da obra (teste)', dueAt: new Date(), settledAt: new Date(), createdBy: tenant.userId, updatedBy: tenant.userId,
    }, { transaction: tx });
  }
  return project;
}

const diario = (tenant, tx, projectId, extra = {}) => dailyReportsService.createDailyReport(
  projectId, { groupId: tenant.groupId, companyId: tenant.companyId, reportDate: dia(0), shiftCode: 'UNICO', workforceCount: 4, servicesPerformed: 'Alvenaria do térreo.', ...extra }, tenant.userId, tx,
);

const naoConformidade = (tenant, tx, projectId, extra = {}) => nonconformitiesService.createNonconformity(
  projectId, { groupId: tenant.groupId, companyId: tenant.companyId, severity: 'HIGH', description: 'Infiltração na laje do segundo pavimento.', responsibleUserId: tenant.userId, beforeEvidenceFileIds: ['11111111-1111-1111-1111-111111111111'], ...extra }, tenant.userId, tx,
);

async function garantia(tenant, tx, projectId, extra = {}) {
  const suffix = uniqueSuffix();
  const property = await Property.create({
    groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel QA-M9 ${suffix}`, internalCode: `QAM9-${suffix}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction: tx });
  return maintenanceCasesService.createMaintenanceCase({
    groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, projectId, description: 'Infiltração no teto da sala.', category: 'WATERPROOFING', severity: 'HIGH', ...extra,
  }, tenant.userId, tx);
}

module.exports = { criarObra, diario, naoConformidade, garantia, dia };
