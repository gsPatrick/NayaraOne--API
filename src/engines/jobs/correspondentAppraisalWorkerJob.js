'use strict';

const { sequelize, Group, Company, Appraisal, FinancingCase } = require('../../models');
const { processPendingAppraisal } = require('../../features/correspondent/cases/appraisals.service');

/**
 * correspondentAppraisalWorkerJob (Marco 8, Fase 7 — worker assíncrono, pedido explícito do
 * usuário após o DoD do Marco 8). Mesmo padrão de `correspondentSubmissionWorkerJob.js`: nenhuma
 * fila real existe no projeto, varredura periódica por empresa com RLS via `SET LOCAL`, lock
 * pessimista + reconfirmação de status dentro de transação aninhada.
 */
async function processOnePendingAppraisal(candidateId, transaction) {
  const appraisal = await Appraisal.findByPk(candidateId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!appraisal || appraisal.status !== 'REQUESTED' || appraisal.responseSnapshot) return false;

  const financingCase = await FinancingCase.findOne({
    where: { id: appraisal.financingCaseId, groupId: appraisal.groupId, companyId: appraisal.companyId },
    transaction,
  });
  if (!financingCase) return false;

  await processPendingAppraisal(appraisal, financingCase, appraisal.createdBy, transaction);
  return true;
}

async function processCompanyPendingAppraisals(group, company) {
  const candidates = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    // responseSnapshot nulo é o sinal de "ainda não processado pelo worker" (REQUESTED sem
    // resposta nenhuma ainda) — diferente de um REQUESTED que o adapter devolveu assim de
    // propósito (teoricamente possível se o provider responder "ainda em análise").
    const rows = await Appraisal.findAll({
      where: { status: 'REQUESTED', responseSnapshot: null },
      attributes: ['id'],
      transaction,
    });
    return rows.map((r) => r.id);
  });

  let processed = 0;
  for (const candidateId of candidates) {
    try {
      const didProcess = await sequelize.transaction(async (transaction) => {
        await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
        await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
        return processOnePendingAppraisal(candidateId, transaction);
      });
      if (didProcess) processed += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[CorrespondentAppraisalWorkerJob] Falha ao processar avaliação ${candidateId}: ${err.message}`);
    }
  }

  return { candidatesFound: candidates.length, processed };
}

async function runCorrespondentAppraisalWorkerJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, candidatesFound: 0, processed: 0, errors: 0 };

  for (const group of groups) {
    summary.groupsChecked += 1;
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });

    for (const company of companies) {
      summary.companiesChecked += 1;
      try {
        const result = await processCompanyPendingAppraisals(group, company);
        summary.candidatesFound += result.candidatesFound;
        summary.processed += result.processed;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[CorrespondentAppraisalWorkerJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[CorrespondentAppraisalWorkerJob] Execução concluída — ${summary.groupsChecked} grupo(s), ` +
      `${summary.companiesChecked} empresa(s), ${summary.candidatesFound} avaliação(ões) pendente(s), ` +
      `${summary.processed} processada(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = Number(process.env.CORRESPONDENT_APPRAISAL_WORKER_INTERVAL_MS || 7000);

function startCorrespondentAppraisalWorkerJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runCorrespondentAppraisalWorkerJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[CorrespondentAppraisalWorkerJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runCorrespondentAppraisalWorkerJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[CorrespondentAppraisalWorkerJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runCorrespondentAppraisalWorkerJob,
  startCorrespondentAppraisalWorkerJob,
  processCompanyPendingAppraisalsForTest: processCompanyPendingAppraisals,
};
