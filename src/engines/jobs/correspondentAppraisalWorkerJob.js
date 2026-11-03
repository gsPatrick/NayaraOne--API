'use strict';

const { sanitizeProviderMessage } = require('../../features/correspondent/sanitizeProviderMessage');

const { Op } = require('sequelize');
const { sequelize, Group, Company, Appraisal, FinancingCase } = require('../../models');
const { peekEligibilityConfig } = require('../../features/correspondent/eligibility.service');
const { preflightAppraisal, callAppraisal, applyAppraisalOutcome } = require('../../features/correspondent/cases/appraisals.service');
const { recordIntegrationError } = require('../../features/correspondent/integrationErrors.service');
const { publishIntegrationCorrespondentFailed } = require('../../features/correspondent/correspondentEvents.service');
const { resolveFinancingProviderAdapterByCode } = require('../../features/correspondent/adapters/resolveFinancingProviderAdapter');

/**
 * correspondentAppraisalWorkerJob (Marco 8, Fase 7 — worker assíncrono, pedido explícito do
 * usuário após o DoD do Marco 8). Mesmo padrão de `correspondentSubmissionWorkerJob.js`: nenhuma
 * fila real existe no projeto, varredura periódica por empresa com RLS via `SET LOCAL`, lock
 * pessimista + reconfirmação de status dentro de transação aninhada.
 */
async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

/**
 * Avaliação em três tempos (nenhuma trava segurada durante a chamada ao provider):
 * 1) transação curta: confere e marca "em andamento" (confirmado); 2) chama o provider fora da transação;
 * 3) transação curta: grava o resultado. Se o processo morrer no meio, a marca "em andamento" velha vira falha.
 */
async function processOnePendingAppraisal(candidateId, group, company) {
  const prepared = await tenantTx(group, company, async (transaction) => {
    const appraisal = await Appraisal.findByPk(candidateId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!appraisal || appraisal.status !== 'REQUESTED') return null;
    const stale = appraisal.responseSnapshot && appraisal.responseSnapshot.inProgress === true;
    if (appraisal.responseSnapshot && !stale) return null;
    if (stale) {
      // Só vira falha se passou do tempo de espera da empresa (Parâmetros); o resultado tardio ainda é aceito.
      const waitMinutes = Number((await peekEligibilityConfig(appraisal.groupId, appraisal.companyId, transaction)).appraisalInProgressMinutes) || 10;
      const startedAt = Math.min(new Date(appraisal.responseSnapshot.startedAt || appraisal.updatedAt).getTime(), new Date(appraisal.updatedAt).getTime());
      if (Date.now() - startedAt < waitMinutes * 60000) return null;
      appraisal.status = 'FAILED';
      appraisal.responseSnapshot = { error: 'A avaliação não terminou (o processo foi interrompido). Peça de novo.', staleTimeout: true };
      await appraisal.save({ transaction });
      const staleCase = await FinancingCase.findByPk(appraisal.financingCaseId, { transaction });
      if (staleCase) {
        await recordIntegrationError(
          { groupId: appraisal.groupId, companyId: appraisal.companyId, financingCaseId: appraisal.financingCaseId, providerCode: staleCase.providerCode, operation: 'appraisal', errorCode: 'APPRAISAL_INTERRUPTED', message: 'A avaliação do imóvel não terminou (o processo foi interrompido). Peça de novo.' },
          transaction
        );
        await publishIntegrationCorrespondentFailed(staleCase, { providerCode: staleCase.providerCode, reason: 'A avaliação do imóvel não terminou.', submissionId: `appraisal:${appraisal.id}` }, transaction);
      }
      return null;
    }
    const financingCase = await FinancingCase.findOne({ where: { id: appraisal.financingCaseId, groupId: appraisal.groupId, companyId: appraisal.companyId }, transaction });
    if (!financingCase) return null;
    const adapter = await preflightAppraisal(appraisal, financingCase, appraisal.createdBy, transaction);
    if (!adapter) return null;
    appraisal.responseSnapshot = { inProgress: true, startedAt: new Date().toISOString() };
    await appraisal.save({ transaction });
    return { providerCode: financingCase.providerCode, requestSnapshot: appraisal.requestSnapshot, id: appraisal.id };
  });
  if (!prepared) return true;
  const adapter = resolveFinancingProviderAdapterByCode(prepared.providerCode);
  const outcome = await callAppraisal(adapter, { id: prepared.id, requestSnapshot: prepared.requestSnapshot });
  await tenantTx(group, company, async (transaction) => {
    const appraisal = await Appraisal.findByPk(candidateId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!appraisal) return;
    // Resposta tardia: a avaliação já tinha sido marcada como interrompida, mas o provider respondeu. Vale o resultado.
    const lateAnswer = appraisal.status === 'FAILED' && appraisal.responseSnapshot && appraisal.responseSnapshot.staleTimeout === true;
    if (!lateAnswer && (appraisal.status !== 'REQUESTED' || !(appraisal.responseSnapshot && appraisal.responseSnapshot.inProgress === true))) {
      // eslint-disable-next-line no-console
      console.warn(`[CorrespondentAppraisalWorkerJob] Resposta da avaliação ${candidateId} descartada: o registro já estava em "${appraisal.status}".`);
      return;
    }
    const financingCase = await FinancingCase.findByPk(appraisal.financingCaseId, { transaction });
    if (!financingCase) return;
    await applyAppraisalOutcome(appraisal, financingCase, outcome, appraisal.createdBy, transaction);
  });
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
      where: {
        status: 'REQUESTED',
        [Op.or]: [
          { responseSnapshot: null },
          sequelize.literal("(response_snapshot->>'inProgress') = 'true' AND updated_at < now() - interval '1 minute'"),
        ],
      },
      attributes: ['id'],
      transaction,
    });
    return rows.map((r) => r.id);
  });

  let processed = 0;
  for (const candidateId of candidates) {
    try {
      const didProcess = await processOnePendingAppraisal(candidateId, group, company);
      if (didProcess) processed += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[CorrespondentAppraisalWorkerJob] Falha ao processar avaliação ${candidateId}: ${sanitizeProviderMessage(err.message)}`);
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
          `[CorrespondentAppraisalWorkerJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${sanitizeProviderMessage(err.message)}`
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

  let running = false;
  return setInterval(() => {
    if (running) return; // rodada anterior ainda em andamento: não sobrepõe
    running = true;
    runCorrespondentAppraisalWorkerJob().finally(() => { running = false; }).catch((err) => {
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
