'use strict';

const { sanitizeProviderMessage } = require('../../features/correspondent/sanitizeProviderMessage');

const { Op } = require('sequelize');
const { recordIntegrationError } = require('../../features/correspondent/integrationErrors.service');
const { publishIntegrationCorrespondentFailed } = require('../../features/correspondent/correspondentEvents.service');
const { getProviderTimeoutMs } = require('../../features/correspondent/eligibility.service');
const logger = require('../../utils/logger');
const { sequelize, Group, Company, ProviderSubmission, FinancingCase } = require('../../models');
const { preflightSubmission, callProviderSubmit, applyProviderOutcome, retryPendingFinalization, sendNeededDocumentsDetached, commitExternalRouting } = require('../../features/correspondent/cases/submissions.service');
const { resolveFinancingProviderAdapterByCode } = require('../../features/correspondent/adapters/resolveFinancingProviderAdapter');

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
async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

// Mesma ordem de trava do cancelamento (primeiro o caso, depois a submissão): sem deadlock entre os dois.
async function lockCaseThenSubmission(candidateId, transaction) {
  const peek = await ProviderSubmission.findByPk(candidateId, { transaction });
  if (!peek) return {};
  const financingCase = await FinancingCase.findOne({ where: { id: peek.financingCaseId, groupId: peek.groupId, companyId: peek.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  const submission = await ProviderSubmission.findByPk(candidateId, { transaction, lock: transaction.LOCK.UPDATE });
  return { financingCase, submission };
}

/**
 * Envio em três tempos (sem reenvio cego se o processo cair no meio):
 *  1) transação curta: confere tudo e marca a submissão como UNKNOWN "envio em andamento" — CONFIRMADO no banco;
 *  2) chama o provider FORA de qualquer transação;
 *  3) transação curta: grava o resultado (aceito, ou UNKNOWN por falha/timeout).
 * Se o processo morrer entre 1 e 3, a submissão fica UNKNOWN e só é resolvida por consulta ao provider.
 */
async function processOnePendingSubmission(candidateId, group, company) {
  const prepared = await tenantTx(group, company, async (transaction) => {
    const { financingCase, submission } = await lockCaseThenSubmission(candidateId, transaction);
    if (!submission || !financingCase) return { done: false };
    if (submission.status === 'SUBMITTED' && submission.failureReason === 'FINALIZACAO_LOCAL_PENDENTE') {
      const done = await retryPendingFinalization(submission, financingCase, submission.createdBy, transaction);
      // Registro local retomado: os documentos validados seguem depois, fora da trava (passo 4).
      return { done: true, retried: done, caseId: financingCase.id, submissionId: submission.id };
    }
    if (submission.status !== 'PENDING') return { done: false };
    const adapter = await preflightSubmission(submission, financingCase, submission.createdBy, transaction);
    if (!adapter) return { done: true };
    submission.status = 'UNKNOWN';
    submission.failureReason = 'ENVIO_EM_ANDAMENTO';
    await submission.save({ transaction });
    // Tempo máximo de espera do provider: parâmetro da empresa (Parâmetros do correspondente).
    const timeoutMs = await getProviderTimeoutMs(group.id, company.id, transaction);
    return { providerCode: financingCase.providerCode, requestSnapshot: submission.requestSnapshot, timeoutMs };
  });
  if (prepared.retried) {
    await sendNeededDocumentsDetached((fn) => tenantTx(group, company, fn), prepared.caseId, prepared.submissionId);
    return true;
  }
  if (!prepared.providerCode) return prepared.done;

  const adapter = resolveFinancingProviderAdapterByCode(prepared.providerCode);
  const outcome = await callProviderSubmit(adapter, { requestSnapshot: prepared.requestSnapshot }, prepared.timeoutMs);

  const stored = await tenantTx(group, company, async (transaction) => {
    const { financingCase, submission } = await lockCaseThenSubmission(candidateId, transaction);
    if (!submission || !financingCase) return { orphan: true };
    if (submission.status === 'SUBMITTED' && outcome.result && submission.externalCaseId === outcome.result.externalId) {
      // Já recuperado por consulta (mesmo id externo): não há órfão nem o que gravar de novo.
      return { orphan: false, accepted: false };
    }
    if (submission.status !== 'UNKNOWN' || submission.failureReason !== 'ENVIO_EM_ANDAMENTO') {
      // O estado mudou durante a chamada (cancelamento, liberação manual...). Se o provider aceitou o caso,
      // ele existe lá mesmo assim: precisa de rastro e, se o caso foi cancelado, de aviso de cancelamento.
      return { orphan: true, caseCanceled: financingCase.status === 'CANCELED', caseId: financingCase.id, providerCode: financingCase.providerCode };
    }
    // Documentos seguem DEPOIS, fora desta trava (passo 4).
    await applyProviderOutcome(adapter, submission, financingCase, outcome, submission.createdBy, transaction, { sendDocuments: false });
    return { accepted: submission.status === 'SUBMITTED', caseId: financingCase.id, submissionId: submission.id };
  });

  if (!stored.orphan && !stored.accepted) return true;
  if (stored.orphan) {
    if (outcome.result) {
      // Provider aceitou um caso que o sistema já não espera: grava o roteamento (os webhooks dele precisam achar o
      // caso), avisa o cancelamento (se for o caso) e deixa erro visível, com o evento do caderno.
      const externalId = outcome.result.externalId;
      await tenantTx(group, company, async (transaction) => {
        const peek = await ProviderSubmission.findByPk(candidateId, { transaction });
        if (!peek) return;
        const financingCase = await FinancingCase.findByPk(peek.financingCaseId, { transaction });
        if (!financingCase) return;
        await recordIntegrationError(
          { groupId: group.id, companyId: company.id, financingCaseId: financingCase.id, providerCode: financingCase.providerCode, operation: 'submit', errorCode: 'PROVIDER_CASE_ORPHAN', message: `O provider aceitou o caso (referência "${externalId}") depois de o envio ter sido cancelado ou liberado aqui. Confira no provider e cancele lá se for preciso.` },
          transaction
        );
        await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: 'O provider aceitou um envio que já tinha sido cancelado ou liberado aqui.', submissionId: `orphan:${candidateId}` }, transaction);
      });
      if (stored.caseId && typeof externalId === 'string' && externalId.length > 0 && externalId.length <= 160) {
        try {
          await commitExternalRouting({ id: stored.caseId, providerCode: stored.providerCode, groupId: group.id, companyId: company.id }, externalId);
        } catch (err) {
          // Id que já é de outro caso: o alerta acima já pede conferência com o provider.
          logger.warn({ caseId: stored.caseId, err: sanitizeProviderMessage(err?.message) }, 'Roteamento do caso órfão não gravado.');
        }
      }
      if (stored.caseCanceled && typeof adapter.cancelCase === 'function' && adapter.capabilities().cancelCase) {
        try { await adapter.cancelCase(externalId); } catch (err) {
          logger.warn({ caseId: stored.caseId, err: sanitizeProviderMessage(err?.message) }, 'Não foi possível cancelar no provider o caso órfão; o alerta de integração segue aberto.');
        }
      }
    }
    return true;
  }
  // Passo 4: documentos validados, chamada a chamada, sem segurar trava nenhuma.
  if (stored.accepted) {
    await sendNeededDocumentsDetached((fn) => tenantTx(group, company, fn), stored.caseId, stored.submissionId);
  }
  return true;
}

async function processCompanyPendingSubmissions(group, company) {
  const candidates = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    const rows = await ProviderSubmission.findAll({ where: { [Op.or]: [{ status: 'PENDING' }, { status: 'SUBMITTED', failureReason: 'FINALIZACAO_LOCAL_PENDENTE' }] }, attributes: ['id'], transaction });
    return rows.map((r) => r.id);
  });

  let processed = 0;
  for (const candidateId of candidates) {
    try {
      const didProcess = await processOnePendingSubmission(candidateId, group, company);
      if (didProcess) processed += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[CorrespondentSubmissionWorkerJob] Falha ao processar submissão ${candidateId}: ${sanitizeProviderMessage(err.message)}`);
    }
  }

  return { candidatesFound: candidates.length, processed };
}

// Quantas empresas são varridas ao mesmo tempo: um provider lento de uma empresa não segura as demais.
const COMPANY_CONCURRENCY = 4;

async function runCorrespondentSubmissionWorkerJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, candidatesFound: 0, processed: 0, errors: 0 };

  for (const group of groups) {
    summary.groupsChecked += 1;
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });

    for (let i = 0; i < companies.length; i += COMPANY_CONCURRENCY) {
      const batch = companies.slice(i, i + COMPANY_CONCURRENCY);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(batch.map(async (company) => {
        summary.companiesChecked += 1;
        try {
          const result = await processCompanyPendingSubmissions(group, company);
          summary.candidatesFound += result.candidatesFound;
          summary.processed += result.processed;
        } catch (err) {
          summary.errors += 1;
          // eslint-disable-next-line no-console
          console.error(
            `[CorrespondentSubmissionWorkerJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${sanitizeProviderMessage(err.message)}`
          );
        }
      }));
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
// Valor inválido na variável de ambiente (texto, zero, negativo) cai no padrão: setInterval(NaN) rodaria sem parar.
const DEFAULT_INTERVAL_MS = (() => {
  const n = Number(process.env.CORRESPONDENT_SUBMISSION_WORKER_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 7000;
})();

function startCorrespondentSubmissionWorkerJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  // A execução inicial e as agendadas dividem a mesma trava: nunca duas rodadas ao mesmo tempo.
  let running = false;
  const tick = (label) => {
    if (running) return; // rodada anterior ainda em andamento: não sobrepõe
    running = true;
    runCorrespondentSubmissionWorkerJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[CorrespondentSubmissionWorkerJob] Falha na execução ${label}:`, err.message);
    }).finally(() => { running = false; });
  };
  tick('inicial');
  return setInterval(() => tick('agendada'), intervalMs);
}

module.exports = {
  runCorrespondentSubmissionWorkerJob,
  startCorrespondentSubmissionWorkerJob,
  processCompanyPendingSubmissionsForTest: processCompanyPendingSubmissions,
};
