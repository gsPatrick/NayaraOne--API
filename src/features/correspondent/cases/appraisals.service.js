'use strict';

const { FinancingCase, Appraisal } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveFinancingProviderAdapterByCode } = require('../adapters/resolveFinancingProviderAdapter');
const { publishAppraisalRequested, publishAppraisalCompleted } = require('../correspondentEvents.service');
const { assertCaseNotCanceled } = require('../statusMachine');

/**
 * requestAppraisalRecord — Marco 8 Fase 7 (worker assíncrono, pedido explícito do usuário após o
 * DoD do Marco 8). Só valida e persiste a `Appraisal` com status `REQUESTED`, devolvendo
 * imediatamente — quem chama `adapter.requestAppraisal()` de verdade é o job
 * `correspondentAppraisalWorkerJob` (`processPendingAppraisal`, abaixo).
 *
 * INVARIANTE CRÍTICO DO CADERNO (citação literal): "Avaliação do provider nunca altera o preço
 * do imóvel automaticamente (é só informativo/consultivo)." — nem esta função nem
 * `processPendingAppraisal` jamais escrevem em `properties`/`property_offers`.
 */
async function requestAppraisalRecord(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  assertCaseNotCanceled(financingCase);

  const referenceValue = payload?.referenceValue !== undefined ? Number(payload.referenceValue) : undefined;
  if (referenceValue !== undefined && (!Number.isFinite(referenceValue) || referenceValue < 0)) {
    throw AppError.badRequest('O campo "referenceValue", quando informado, deve ser um número maior ou igual a zero.', 'APPRAISAL_VALIDATION');
  }

  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter) {
    throw AppError.internal(`Provider "${financingCase.providerCode}" configurado no caso não é suportado.`, 'APPRAISAL_PROVIDER_UNKNOWN');
  }
  if (!adapter.capabilities().requestAppraisal) {
    throw AppError.badRequest(
      'O provider configurado para este caso não realiza avaliação automática do imóvel — a avaliação precisa ser levantada diretamente com o banco.',
      'APPRAISAL_NOT_SUPPORTED'
    );
  }

  const requestSnapshot = { financingCaseId, referenceValue: referenceValue ?? null };

  const appraisal = await Appraisal.create(
    {
      groupId,
      companyId,
      financingCaseId,
      providerCode: financingCase.providerCode,
      status: 'REQUESTED',
      requestSnapshot,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  await publishAppraisalRequested(appraisal, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.appraisal.requested',
      entityType: 'FinancingCase',
      entityId: financingCaseId,
      reason: `Avaliação do imóvel solicitada ao provider "${financingCase.providerCode}" — processamento assíncrono pelo worker. Nenhum preço de imóvel/oferta foi alterado por esta ação.`,
    },
    transaction
  );

  return appraisal;
}

/**
 * processPendingAppraisal — chamada pelo job `correspondentAppraisalWorkerJob`. Chama
 * `adapter.requestAppraisal()` de verdade e atualiza a `Appraisal` já criada (status REQUESTED)
 * para COMPLETED/FAILED. Mesma invariante: nunca escreve preço de imóvel.
 */
async function processPendingAppraisal(appraisal, financingCase, actorUserId, transaction) {
  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter) {
    throw AppError.internal(`Provider "${financingCase.providerCode}" configurado no caso não é suportado.`, 'APPRAISAL_PROVIDER_UNKNOWN');
  }

  try {
    const result = await adapter.requestAppraisal(appraisal.requestSnapshot);
    appraisal.status = result.status === 'COMPLETED' ? 'COMPLETED' : 'REQUESTED';
    appraisal.externalId = result.externalId || null;
    appraisal.requestedValue = result.status === 'COMPLETED' ? result.value : null;
    appraisal.responseSnapshot = result;
    await appraisal.save({ transaction });

    if (appraisal.status === 'COMPLETED') {
      await publishAppraisalCompleted(appraisal, transaction);
      await registrarAuditoria(
        {
          groupId: appraisal.groupId,
          companyId: appraisal.companyId,
          actorUserId,
          action: 'correspondent.appraisal.completed',
          entityType: 'FinancingCase',
          entityId: appraisal.financingCaseId,
          reason: `Avaliação do imóvel concluída pelo worker — valor informativo: R$ ${Number(appraisal.requestedValue).toFixed(2)}. Nenhum preço de imóvel/oferta foi alterado.`,
        },
        transaction
      );
    }
  } catch (err) {
    appraisal.status = 'FAILED';
    appraisal.responseSnapshot = { error: err?.message || 'Falha desconhecida ao avaliar o imóvel.' };
    await appraisal.save({ transaction });
  }

  return appraisal;
}

/**
 * createAppraisal — wrapper de compatibilidade (mesmo espírito de `submitFinancingCase` em
 * `submissions.service.js`): `requestAppraisalRecord` + `processPendingAppraisal` na mesma
 * transação, reproduzindo o comportamento síncrono anterior para não forçar reescrita de testes
 * fora desta frente. O fluxo HTTP real usa só `requestAppraisalRecord`.
 */
async function createAppraisal(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  const appraisal = await requestAppraisalRecord(financingCaseId, payload, actorUserId, groupId, companyId, transaction);
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  return processPendingAppraisal(appraisal, financingCase, actorUserId, transaction);
}

async function listAppraisals(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  return Appraisal.findAll({
    where: { financingCaseId, groupId, companyId },
    order: [['created_at', 'DESC']],
    transaction,
  });
}

module.exports = { createAppraisal, requestAppraisalRecord, processPendingAppraisal, listAppraisals };
