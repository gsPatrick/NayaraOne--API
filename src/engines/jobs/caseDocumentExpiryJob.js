'use strict';

const { sanitizeProviderMessage } = require('../../features/correspondent/sanitizeProviderMessage');

const { Op } = require('sequelize');
const { sequelize, Group, Company, CaseDocument, CaseRequirement, FinancingCase } = require('../../models');
const { syncCaseChecklistStatus } = require('../../features/correspondent/cases/caseDocuments.service');
const { registrarAuditoria } = require('../audit/auditLog.service');

/**
 * caseDocumentExpiryJob (Marco 8 — Caderno, bloco "Documentos/OCR": "Documento substituído
 * preserva versão anterior; expiração gera requirement.").
 *
 * Varre `correspondent.case_documents` com `expires_at` no passado, cuja versão é a VIGENTE
 * (`superseded_at IS NULL`) e cujo requirement está `SUBMITTED` ou `VALIDATED`. Marca
 * o requirement como `EXPIRED` e cria um NOVO `CaseRequirement` do MESMO `documentType`,
 * `PENDING`, pra reabrir o checklist — sem apagar nada, sem UPDATE em `CaseDocument` (a versão
 * expirada continua intacta no histórico).
 *
 * Mesmo padrão de `insurancePolicyExpiryJob.js`: varredura por empresa com RLS via SET LOCAL,
 * re-busca com lock pessimista dentro de uma transação aninhada e reconfirma o estado antes de
 * escrever (evita duplicidade em deploy multi-réplica).
 *
 * Idempotência: um requirement já `EXPIRED` não é mais candidato (não está mais `SUBMITTED`), e
 * a condição de busca usa o documento vigente do requirement original — rodar o job duas vezes
 * não gera dois requirements novos para o mesmo documento vencido.
 */
async function expireDueDocuments(transaction, now = new Date()) {
  const candidates = await CaseDocument.findAll({
    where: { supersededAt: null, expiresAt: { [Op.lt]: now } },
    include: [{ model: CaseRequirement, as: 'requirement', where: { status: { [Op.in]: ['SUBMITTED', 'VALIDATED'] } }, required: true }],
    transaction,
  });

  let expired = 0;
  for (const candidate of candidates) {
    try {
      const didExpire = await sequelize.transaction({ transaction }, async (nested) => {
        const requirement = await CaseRequirement.findByPk(candidate.requirementId, { transaction: nested, lock: nested.LOCK.UPDATE });
        if (!requirement || !['SUBMITTED', 'VALIDATED'].includes(requirement.status)) return false;
        const document = await CaseDocument.findByPk(candidate.id, { transaction: nested });
        if (!document || document.supersededAt || !document.expiresAt || document.expiresAt >= now) return false;

        // Caso que já tem decisão final (recusado, concluído ou cancelado) não reabre checklist.
        const financingCase = await FinancingCase.findByPk(requirement.financingCaseId, { transaction: nested });
        if (!financingCase || ['CANCELED', 'REJECTED', 'COMPLETED'].includes(financingCase.status)) return false;

        const beforeJson = requirement.toJSON();
        requirement.status = 'EXPIRED';
        requirement.updatedBy = null;
        await requirement.save({ transaction: nested });

        const newRequirement = await CaseRequirement.create(
          {
            groupId: requirement.groupId,
            companyId: requirement.companyId,
            financingCaseId: requirement.financingCaseId,
            documentType: requirement.documentType,
            required: requirement.required,
            status: 'PENDING',
            notes: `Reaberto automaticamente — documento anterior venceu em ${document.expiresAt.toISOString().slice(0, 10)}.`,
          },
          { transaction: nested }
        );

        await registrarAuditoria(
          {
            groupId: requirement.groupId,
            companyId: requirement.companyId,
            actorUserId: null,
            action: 'correspondent.case_requirement.expired',
            entityType: 'CaseRequirement',
            entityId: requirement.id,
            beforeJson,
            afterJson: requirement.toJSON(),
            reason: `Documento do tipo "${requirement.documentType}" venceu em ${document.expiresAt.toISOString().slice(0, 10)} — requirement marcado EXPIRED e novo requirement ${newRequirement.id} criado automaticamente para reenvio.`,
          },
          nested
        );
        await syncCaseChecklistStatus(requirement.financingCaseId, requirement.groupId, requirement.companyId, null, nested);
        return true;
      });
      if (didExpire) expired += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[CaseDocumentExpiryJob] Falha ao expirar documento ${candidate.id}: ${sanitizeProviderMessage(err.message)}`);
    }
  }

  return { documentsChecked: candidates.length, expired };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return expireDueDocuments(transaction);
  });
}

async function runCaseDocumentExpiryJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, documentsChecked: 0, expired: 0, errors: 0 };

  for (const group of groups) {
    summary.groupsChecked += 1;
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });

    for (const company of companies) {
      summary.companiesChecked += 1;
      try {
        const result = await processCompany(group, company);
        summary.documentsChecked += result.documentsChecked;
        summary.expired += result.expired;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[CaseDocumentExpiryJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${sanitizeProviderMessage(err.message)}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[CaseDocumentExpiryJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.documentsChecked} documento(s) verificado(s), ${summary.expired} expirado(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hora — mesmo intervalo do job de apólice vencida.

function startCaseDocumentExpiryJob(intervalMs = DEFAULT_INTERVAL_MS) {
  runCaseDocumentExpiryJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[CaseDocumentExpiryJob] Falha na execução inicial: ${sanitizeProviderMessage(err.message)}`);
  });
  return setInterval(() => {
    runCaseDocumentExpiryJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[CaseDocumentExpiryJob] Falha na execução agendada: ${sanitizeProviderMessage(err.message)}`);
    });
  }, intervalMs);
}

module.exports = { expireDueDocuments, runCaseDocumentExpiryJob, startCaseDocumentExpiryJob };
