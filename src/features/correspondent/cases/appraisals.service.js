'use strict';

const { sanitizeProviderMessage } = require('../sanitizeProviderMessage');

const { FinancingCase, Appraisal } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveFinancingProviderAdapterByCode } = require('../adapters/resolveFinancingProviderAdapter');
const { publishAppraisalRequested, publishAppraisalCompleted } = require('../correspondentEvents.service');
const { assertCaseAcceptsAction } = require('./caseActionGate');
const MAX_VALUE = 99999999999;
const { assertEligible } = require('../eligibility.service');
const { recordIntegrationError } = require('../integrationErrors.service');
const { publishIntegrationCorrespondentFailed } = require('../correspondentEvents.service');

const APPRAISAL_TIMEOUT_MS = (() => {
  const value = Number(process.env.CORRESPONDENT_APPRAISAL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 8000;
})();

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Tempo esgotado aguardando resposta do provider de avaliação.'), { uncertain: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
  // Trava o caso: dois cliques simultâneos esperam um pelo outro e o segundo vê o pedido aberto do primeiro.
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  await assertCaseAcceptsAction(financingCase, 'appraisal', transaction);

  const hasReference = payload?.referenceValue !== undefined && payload?.referenceValue !== null && payload?.referenceValue !== '';
  const referenceValue = hasReference ? Number(payload.referenceValue) : undefined;
  if (hasReference && (!Number.isFinite(referenceValue) || referenceValue <= 0 || referenceValue > MAX_VALUE)) {
    throw AppError.badRequest('O valor de referência do imóvel, quando informado, deve ser maior que zero e menor que R$ 100 bilhões.', 'APPRAISAL_VALIDATION');
  }

  // A avaliação é do imóvel: sem imóvel vinculado ao caso, não há o que avaliar (regra ajustável em Parâmetros).
  const { peekEligibilityConfig } = require('../eligibility.service');
  const parameters = await peekEligibilityConfig(groupId, companyId, transaction);
  if (parameters.requirePropertyForAppraisal !== false && !financingCase.propertyId) {
    throw AppError.unprocessable('Este caso não tem imóvel vinculado. Vincule o imóvel ao caso antes de pedir a avaliação.', 'APPRAISAL_PROPERTY_REQUIRED');
  }

  // Provider que deixou de ser elegível não recebe dado nenhum (nem para avaliar o imóvel).
  await assertEligible(financingCase, { skipAmount: true }, groupId, companyId, actorUserId, transaction);

  // Um pedido de avaliação por vez: duplo clique não gera duas chamadas (e dois custos) ao provider.
  const open = await Appraisal.findOne({ where: { financingCaseId, groupId, companyId, status: 'REQUESTED' }, transaction });
  if (open) {
    throw AppError.conflict('Já existe uma avaliação deste imóvel em andamento. Aguarde o resultado antes de pedir outra.', 'APPRAISAL_ALREADY_REQUESTED');
  }

  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter) {
    throw AppError.unprocessable('O provider deste caso não está disponível neste ambiente. Ajuste o provider padrão da empresa e crie o caso de novo.', 'APPRAISAL_PROVIDER_UNKNOWN');
  }
  if (!adapter.capabilities().requestAppraisal) {
    if (financingCase.providerCode !== 'manual') {
      throw AppError.badRequest(
        'O provider configurado para este caso não realiza avaliação automática do imóvel — a avaliação precisa ser levantada diretamente com o banco.',
        'APPRAISAL_NOT_SUPPORTED'
      );
    }
    // Provider manual (sem API): a pessoa registra o valor que o banco informou, no mesmo modelo de avaliação.
    // Só informativo: nunca altera o preço do imóvel nem a oferta.
    const appraisedValue = Number(payload?.appraisedValue);
    if (!Number.isFinite(appraisedValue) || appraisedValue <= 0 || appraisedValue > 99999999999) {
      throw AppError.badRequest('Informe o valor avaliado pelo banco (maior que zero): este provider não avalia sozinho.', 'APPRAISAL_VALIDATION');
    }
    const manualAppraisal = await Appraisal.create(
      {
        groupId, companyId, financingCaseId,
        providerCode: financingCase.providerCode,
        status: 'COMPLETED',
        requestedValue: Math.round(appraisedValue * 100) / 100,
        requestSnapshot: { financingCaseId, manual: true },
        responseSnapshot: { manual: true, registeredBy: actorUserId || null },
        createdBy: actorUserId || null,
      },
      { transaction }
    );
    await publishAppraisalRequested(manualAppraisal, transaction);
    await publishAppraisalCompleted(manualAppraisal, transaction);
    await registrarAuditoria(
      { groupId, companyId, actorUserId, action: 'correspondent.appraisal.completed', entityType: 'FinancingCase', entityId: financingCaseId, reason: `Avaliação do imóvel registrada por uma pessoa (informada pelo banco): valor informativo R$ ${Number(manualAppraisal.requestedValue).toFixed(2)}. Nenhum preço de imóvel/oferta foi alterado.` },
      transaction
    );
    return manualAppraisal;
  }

  // Se o último pedido ficou sem resposta (tempo esgotado), o novo pedido reaproveita o mesmo identificador:
  // o provider reconhece e não cobra duas vezes pela mesma avaliação.
  const lastAttempt = await Appraisal.findOne({ where: { financingCaseId, groupId, companyId }, order: [['created_at', 'DESC']], transaction });
  const reusableKey = lastAttempt && lastAttempt.status === 'FAILED' && lastAttempt.responseSnapshot && lastAttempt.responseSnapshot.uncertain === true
    ? (lastAttempt.requestSnapshot && lastAttempt.requestSnapshot.idempotencyKey) || `appraisal:${lastAttempt.id}`
    : null;
  const requestSnapshot = { financingCaseId, referenceValue: referenceValue ?? null };
  if (reusableKey) requestSnapshot.idempotencyKey = reusableKey;

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
/** preflightAppraisal — confere caso cancelado, elegibilidade e provider ANTES de chamar. Devolve o adapter ou marca FAILED. */
async function preflightAppraisal(appraisal, financingCase, actorUserId, transaction) {
  const fail = async (message, extra = {}) => {
    appraisal.status = 'FAILED';
    appraisal.responseSnapshot = { error: message, ...extra };
    await appraisal.save({ transaction });
    await recordIntegrationError(
      { groupId: appraisal.groupId, companyId: appraisal.companyId, financingCaseId: appraisal.financingCaseId, providerCode: financingCase.providerCode, operation: 'appraisal', errorCode: 'APPRAISAL_NOT_SENT', message: String(message).slice(0, 400) },
      transaction
    );
    await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: message, submissionId: `appraisal:${appraisal.id}` }, transaction);
    await registrarAuditoria(
      { groupId: appraisal.groupId, companyId: appraisal.companyId, actorUserId, action: 'correspondent.appraisal.failed', entityType: 'FinancingCase', entityId: appraisal.financingCaseId, reason: `Avaliação do imóvel não foi enviada ao provider: ${String(message).slice(0, 300)}` },
      transaction
    );
    return null;
  };
  if (financingCase.status === 'CANCELED') return fail('Caso cancelado antes de a avaliação ser enviada ao provider.');
  try {
    await assertEligible(financingCase, { skipAmount: true }, financingCase.groupId, financingCase.companyId, actorUserId, transaction);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return fail(sanitizeProviderMessage(err.message, 'Provider inelegível.'));
  }
  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter) return fail(`O provider "${financingCase.providerCode}" não está disponível neste ambiente.`);
  return adapter;
}

/** callAppraisal — só a chamada ao provider (ambígua). Nunca lança. */
async function callAppraisal(adapter, appraisal) {
  try {
    const result = await withTimeout(adapter.requestAppraisal({ ...appraisal.requestSnapshot, idempotencyKey: (appraisal.requestSnapshot && appraisal.requestSnapshot.idempotencyKey) || `appraisal:${appraisal.id}` }), APPRAISAL_TIMEOUT_MS);
    return { result };
  } catch (error) {
    return { error };
  }
}

/** applyAppraisalOutcome — grava o resultado (concluída, ou falha visível). */
async function applyAppraisalOutcome(appraisal, financingCase, outcome, actorUserId, transaction) {
  if (!outcome.error) {
    const { result } = outcome;
    // O valor devolvido pelo provider é conferido antes de gravar: número positivo, dentro do limite do banco.
    if (result && result.status === 'COMPLETED') {
      const value = Number(result.value);
      if (!Number.isFinite(value) || value <= 0 || value > MAX_VALUE) {
        return applyAppraisalOutcome(appraisal, financingCase, { error: new Error('O provider devolveu uma avaliação com valor inválido.') }, actorUserId, transaction);
      }
      result.value = Math.round(value * 100) / 100;
    }
    // Não existe consulta nem webhook de avaliação: resposta diferente de COMPLETED não terá segundo ato.
    // Em vez de ficar "em andamento" para sempre (bloqueando novos pedidos), vira falha visível.
    appraisal.status = result.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
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
    return appraisal;
  }
  appraisal.status = 'FAILED';
  const reason = sanitizeProviderMessage(outcome.error?.message, 'Falha desconhecida ao avaliar o imóvel.');
  appraisal.responseSnapshot = { error: reason, ...(outcome.error?.uncertain ? { uncertain: true } : {}) };
  await appraisal.save({ transaction });
  await recordIntegrationError(
    { groupId: appraisal.groupId, companyId: appraisal.companyId, financingCaseId: appraisal.financingCaseId, providerCode: financingCase.providerCode, operation: 'appraisal', errorCode: 'APPRAISAL_FAILED', message: 'Falha ao pedir a avaliação do imóvel ao provider.' },
    transaction
  );
  await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason, submissionId: `appraisal:${appraisal.id}` }, transaction);
  return appraisal;
}

/** processPendingAppraisal — numa transação só (testes e chamadas diretas); o worker usa os mesmos passos em três tempos. */
async function processPendingAppraisal(appraisal, financingCase, actorUserId, transaction) {
  const adapter = await preflightAppraisal(appraisal, financingCase, actorUserId, transaction);
  if (!adapter) return appraisal;
  const outcome = await callAppraisal(adapter, appraisal);
  return applyAppraisalOutcome(appraisal, financingCase, outcome, actorUserId, transaction);
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

async function listAppraisals(financingCaseId, groupId, companyId, transaction, { limit } = {}) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  return Appraisal.findAll({
    where: { financingCaseId, groupId, companyId },
    order: [['created_at', 'DESC']],
    limit: Math.min(Math.max(Number(limit) || 200, 1), 500),
    transaction,
  });
}

module.exports = {
  preflightAppraisal,
  callAppraisal,
  applyAppraisalOutcome, createAppraisal, requestAppraisalRecord, processPendingAppraisal, listAppraisals };
