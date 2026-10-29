'use strict';

const { FinancingCase, CaseRequirement } = require('../../models');
const AppError = require('../../utils/AppError');
const { docLabel } = require('./correspondentNay.service');

/**
 * Leituras da NAY Correspondente que a camada de IA usa como ferramenta (M9-D039). SOMENTE LEITURA: nenhuma função grava, muda status
 * ou chama o provider. Os rótulos dos documentos são os mesmos da NAY determinística (correspondentNay.service.js).
 */
const CLOSED_STATUSES = ['VALIDATED', 'EXPIRED', 'DISPENSED'];
const STATUS_LABEL = { PENDING: 'pendente', SUBMITTED: 'aguardando conferência', REJECTED: 'recusado' };
const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * Exigências abertas do caso: itens do checklist que ainda não foram validados, vencidos ou dispensados. Cada item diz o documento
 * (nome legível), se é obrigatório, o estado e a data da última mudança (a fonte do dado é `correspondent.case_requirements`).
 */
async function getPendingRequirements(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  const rows = await CaseRequirement.findAll({ where: { financingCaseId, groupId, companyId }, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction });
  const open = rows.filter((r) => !CLOSED_STATUSES.includes(r.status));
  return {
    financingCaseId,
    caseStatus: financingCase.status,
    source: 'correspondent.case_requirements',
    asOf: iso(new Date()),
    total: open.length,
    requiredOpen: open.filter((r) => r.required).length,
    items: open.map((r) => ({
      requirementId: r.id,
      documentType: r.documentType,
      documentLabel: docLabel(r.documentType),
      required: r.required === true,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] || r.status,
      updatedAt: iso(r.updatedAt ?? r.get('updated_at')),
    })),
  };
}

module.exports = { getPendingRequirements };
