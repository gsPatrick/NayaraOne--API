'use strict';

const { sequelize, Group, Company, ProviderSubmission, FinancingCase } = require('../../models');
const { processPendingSubmission } = require('../../features/correspondent/cases/submissions.service');

/**
 * correspondentSubmissionWorkerJob (Marco 8, Fase 5 — "Worker chama provider", citação literal
 * do Caderno/Guia do Marcelo). Pedido explícito do usuário após o DoD do Marco 8: trocar a
 * simplificação síncrona documentada nas Fases 5/7/8 por um worker de verdade.
 *
 * Mesmo padrão arquitetural de `insurancePolicyExpiryJob.js`/`billingScheduleAutoGenerateJob.js`
 * (nenhuma fila de mensageria real existe no projeto — `REDIS_URL` não é consumido por nada):
 * varredura periódica por empresa com RLS via `SET LOCAL`, lock pessimista dentro de uma
 * transação aninhada, reconfirma o status PENDING antes de processar (evita duplo processamento
 * em deploy multi-réplica ou execuções sobrepostas).
 *
 * Idempotência do PROCESSAMENTO do job em si: `findByPk` com `lock: LOCK.UPDATE` dentro da
 * transação aninhada + reconfirmação de `status === 'PENDING'` depois do lock — se duas execuções
 * do job disputarem a mesma submission, só uma consegue o lock e processa; a outra reconfirma
 * status != PENDING depois e pula, sem chamar o adapter duas vezes.
 */
async function processOnePendingSubmission(candidateId, transaction) {
  const submission = await ProviderSubmission.findByPk(candidateId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!submission || submission.status !== 'PENDING') return false;

  const financingCase = await FinancingCase.findOne({
    where: { id: submission.financingCaseId, groupId: submission.groupId, companyId: submission.companyId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!financingCase) return false;

  await processPendingSubmission(submission, financingCase, submission.createdBy, transaction);
  return true;
}

async function processCompanyPendingSubmissions(group, company) {
  const candidates = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    const rows = await ProviderSubmission.findAll({ where: { status: 'PENDING' }, attributes: ['id'], transaction });
    return rows.map((r) => r.id);
  });

  let processed = 0;
  for (const candidateId of candidates) {
    try {
      const didProcess = await sequelize.transaction(async (transaction) => {
        await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
        await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
        return processOnePendingSubmission(candidateId, transaction);
      });
      if (didProcess) processed += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[CorrespondentSubmissionWorkerJob] Falha ao processar submissão ${candidateId}: ${err.message}`);
    }
  }

  return { candidatesFound: candidates.length, processed };
}

async function runCorrespondentSubmissionWorkerJob() {
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
        const result = await processCompanyPendingSubmissions(group, company);
        summary.candidatesFound += result.candidatesFound;
        summary.processed += result.processed;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[CorrespondentSubmissionWorkerJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[CorrespondentSubmissionWorkerJob] Execução concluída — ${summary.groupsChecked} grupo(s), ` +
      `${summary.companiesChecked} empresa(s), ${summary.candidatesFound} submissão(ões) pendente(s), ` +
      `${summary.processed} processada(s), ${summary.errors} erro(s).`
  );

  return summary;
}

// DECISÃO DE ENGENHARIA — não especificado no Caderno com um número exato: intervalo de
// varredura. 7s é curto o suficiente pra não deixar o usuário esperando muito na tela
// "processando" em dev/teste, e ajustável via env var se o cliente pedir outro valor em produção.
const DEFAULT_INTERVAL_MS = Number(process.env.CORRESPONDENT_SUBMISSION_WORKER_INTERVAL_MS || 7000);

function startCorrespondentSubmissionWorkerJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runCorrespondentSubmissionWorkerJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[CorrespondentSubmissionWorkerJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runCorrespondentSubmissionWorkerJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[CorrespondentSubmissionWorkerJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runCorrespondentSubmissionWorkerJob,
  startCorrespondentSubmissionWorkerJob,
  processCompanyPendingSubmissionsForTest: processCompanyPendingSubmissions,
};
