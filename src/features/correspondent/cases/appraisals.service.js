'use strict';

const { FinancingCase, Appraisal } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveFinancingProviderAdapterByCode } = require('../adapters/resolveFinancingProviderAdapter');
const { publishAppraisalRequested, publishAppraisalCompleted } = require('../correspondentEvents.service');

/**
 * createAppraisal — Marco 8 Fase 7. Chama `adapter.requestAppraisal()` do provider configurado
 * no case e persiste o resultado.
 *
 * INVARIANTE CRÍTICO DO CADERNO (citação literal): "Avaliação do provider nunca altera o preço
 * do imóvel automaticamente (é só informativo/consultivo)." — esta função NUNCA escreve em
 * `properties`/`property_offers`. `requestedValue` fica só nesta tabela, pra consulta manual por
 * quem decide o preço (um humano, fora deste módulo). Testado adversarialmente em
 * test/correspondent.appraisals.test.js (cria appraisal com valor diferente do preço atual,
 * confirma que o preço não mudou).
 */
async function createAppraisal(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }

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
  const result = await adapter.requestAppraisal(requestSnapshot);

  const appraisal = await Appraisal.create(
    {
      groupId,
      companyId,
      financingCaseId,
      providerCode: financingCase.providerCode,
      externalId: result.externalId || null,
      status: result.status === 'COMPLETED' ? 'COMPLETED' : 'REQUESTED',
      requestedValue: result.status === 'COMPLETED' ? result.value : null,
      requestSnapshot,
      responseSnapshot: result,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  await publishAppraisalRequested(appraisal, transaction);
  if (appraisal.status === 'COMPLETED') {
    await publishAppraisalCompleted(appraisal, transaction);
  }
  // (já estava com await — mantido explícito para deixar claro que ambos os eventos são
  // publicados dentro da MESMA transação da criação da appraisal, nunca depois do commit)

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.appraisal.requested',
      entityType: 'FinancingCase',
      entityId: financingCaseId,
      reason:
        `Avaliação do imóvel solicitada ao provider "${financingCase.providerCode}"` +
        (appraisal.requestedValue != null ? ` — valor informativo retornado: R$ ${Number(appraisal.requestedValue).toFixed(2)}.` : '.') +
        ' Nenhum preço de imóvel/oferta foi alterado por esta ação.',
    },
    transaction
  );

  return appraisal;
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

module.exports = { createAppraisal, listAppraisals };
