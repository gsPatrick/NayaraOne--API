'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getLegalCaseForUpdate, getLegalCase } = require('./legalCases.service');
const { normalizeOptionalText } = require('./legalText');
const { parseDueAt } = require('./legalDeadlineDates');
const { optionalUuid } = require('./legalInput');

/**
 * Recebível do processo (Caderno M5 §14 "Valores a receber ficam estimados e vinculados ao Financeiro somente quando
 * juridicamente cabível" e "Não confundir estimativa processual com recebível confirmado").
 *  - A ESTIMATIVA (estimated_amount) nunca vira lançamento: não há caminho que a leve ao Financeiro.
 *  - Só o valor CONFIRMADO (confirmed_amount) vira recebível, e só com a base jurídica que o torna exigível.
 * DECISÃO (o livro não lista o que é "juridicamente cabível"): o mais conservador — acordo homologado (SETTLEMENT) ou
 * sentença transitada em julgado (FINAL_JUDGMENT), com a referência (nº do acordo/decisão) obrigatória; um recebível
 * por processo; quem vincula precisa de legal:approve E finance:create (rota). O lançamento RECEIVABLE nasce pelo
 * serviço normal do Financeiro (centro de resultado, período aberto, auditoria do Financeiro) na mesma transação, e o
 * vínculo fica em legal.case_receivables (append-only, migration 9998).
 */
const BASES = ['SETTLEMENT', 'FINAL_JUDGMENT'];
const BASIS_LABEL = { SETTLEMENT: 'acordo homologado', FINAL_JUDGMENT: 'sentença transitada em julgado' };

const listQuery = `SELECT id, legal_case_id AS "legalCaseId", financial_entry_id AS "financialEntryId", basis, basis_reference AS "basisReference",
  amount, created_by AS "createdBy", created_at AS "createdAt" FROM legal.case_receivables WHERE legal_case_id = :id ORDER BY created_at`;

async function linkCaseReceivable(legalCaseId, payload, actorUserId, transaction) {
  const legalCase = await getLegalCaseForUpdate(legalCaseId, transaction);
  const body = payload || {};
  const confirmed = legalCase.confirmedAmount !== null && legalCase.confirmedAmount !== undefined ? Number(legalCase.confirmedAmount) : 0;
  if (!(confirmed > 0)) {
    throw AppError.conflict('O processo não tem valor CONFIRMADO: estimativa processual não vira recebível.', 'LEGAL_CASE_RECEIVABLE_NOT_CONFIRMED');
  }
  const basis = typeof body.basis === 'string' ? body.basis.trim().toUpperCase() : '';
  if (!BASES.includes(basis)) {
    throw AppError.badRequest(`"basis" deve ser um de: ${BASES.join(', ')} (base jurídica que torna o valor exigível).`, 'LEGAL_CASE_RECEIVABLE_BASIS_INVALID');
  }
  const basisReference = normalizeOptionalText(body.basisReference, 'basisReference');
  if (!basisReference) throw AppError.badRequest('Informe a referência do acordo ou da decisão ("basisReference").', 'LEGAL_CASE_RECEIVABLE_BASIS_INVALID');
  if (body.dueAt === undefined || body.dueAt === null || body.dueAt === '') throw AppError.badRequest('Informe o vencimento do recebível ("dueAt").', 'LEGAL_CASE_RECEIVABLE_VALIDATION');
  const dueAt = parseDueAt(body.dueAt, 'dueAt');
  const resultCenterId = optionalUuid(body.resultCenterId, 'resultCenterId', 'LEGAL_CASE_RECEIVABLE_VALIDATION');
  const existing = await sequelize.query(listQuery, { type: QueryTypes.SELECT, transaction, replacements: { id: legalCase.id } });
  if (existing.length) throw AppError.conflict('Este processo já tem recebível vinculado ao Financeiro.', 'LEGAL_CASE_RECEIVABLE_DUPLICATE');

  const financialEntries = require('../finance/financialEntries.service');
  const entry = await financialEntries.createFinancialEntry(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount: confirmed,
      dueAt,
      resultCenterId,
      contractId: legalCase.contractId || null,
      description: `Recebível do processo ${legalCase.caseNumber || legalCase.id} (${BASIS_LABEL[basis]}: ${basisReference})`.slice(0, 255),
      originRef: `legal.legal_cases:${legalCase.id}`,
    },
    actorUserId,
    transaction
  );
  const [link] = await sequelize.query(
    `INSERT INTO legal.case_receivables (group_id, company_id, legal_case_id, financial_entry_id, basis, basis_reference, amount, created_by)
     VALUES (:groupId, :companyId, :caseId, :entryId, :basis, :basisReference, :amount, :createdBy)
     RETURNING id, legal_case_id AS "legalCaseId", financial_entry_id AS "financialEntryId", basis, basis_reference AS "basisReference", amount, created_at AS "createdAt"`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: legalCase.groupId, companyId: legalCase.companyId, caseId: legalCase.id, entryId: entry.id, basis, basisReference, amount: confirmed.toFixed(2), createdBy: actorUserId || null } }
  );
  await registrarAuditoria(
    {
      groupId: legalCase.groupId, companyId: legalCase.companyId, actorUserId, action: 'legal.case.receivable_link', entityType: 'LegalCase', entityId: legalCase.id,
      beforeJson: { recebivelVinculado: false, confirmedAmount: legalCase.confirmedAmount, estimatedAmount: legalCase.estimatedAmount },
      afterJson: { recebivelVinculado: true, ...link, financialEntryId: entry.id },
      reason: `Valor confirmado ${confirmed.toFixed(2)} do processo vinculado ao Financeiro (${BASIS_LABEL[basis]}: ${basisReference}).`,
    },
    transaction
  );
  return { ...link, financialEntry: { id: entry.id, nature: entry.nature, amount: entry.amount, status: entry.status, dueAt: entry.dueAt } };
}

async function listCaseReceivables(legalCaseId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  return sequelize.query(listQuery, { type: QueryTypes.SELECT, transaction, replacements: { id: legalCase.id } });
}

module.exports = { linkCaseReceivable, listCaseReceivables, BASES };
