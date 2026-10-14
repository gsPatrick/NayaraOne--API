'use strict';

const {
  sequelize,
  FinancingCase,
  ProviderStatusHistory,
  WebhookInbox,
  ExternalCaseRouting,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getDecryptedSetting } = require('../settings/settings.service');
const { resolveFinancingProviderAdapterByCode } = require('./adapters/resolveFinancingProviderAdapter');
const { shouldApplyTransition } = require('./statusMachine');
const { publishFinancingStatusChanged } = require('./correspondentEvents.service');
const { syncOpportunityFromFinancingCase } = require('./correspondentCrmSync.service');

/**
 * resolveTenantByExternalId — o webhook só traz `externalCaseId` (do provider), nunca o
 * financing_case_id interno nem o tenant. Consulta `ExternalCaseRouting` (tabela SEM RLS por
 * design, ver migration 20260101000345 — mesmo padrão de `insurance_provider_submissions`,
 * `bank_payment_provider_routing`, etc.) pra descobrir o tenant ANTES de abrir qualquer
 * transação com `SET LOCAL` — nenhuma tabela protegida por RLS é consultada neste passo.
 */
async function resolveTenantByExternalId(externalCaseId) {
  const routing = await ExternalCaseRouting.findByPk(externalCaseId);
  if (!routing) return null;
  return {
    financingCaseId: routing.financingCaseId,
    groupId: routing.groupId,
    companyId: routing.companyId,
  };
}

/**
 * processFinancingWebhook — Marco 8 Fase 6. Ordem exata do Caderno: (1) registry resolve o
 * adapter pelo provider da URL, (2) resolve o case/tenant pelo externalCaseId, (3)
 * `verifyWebhook()` autentica a origem (webhook sem assinatura válida é rejeitado, NUNCA
 * processado — nenhuma exceção "sandbox confia" como em outros módulos legados: Marco 8 exige
 * HMAC sempre, mesmo em sandbox, porque o próprio SandboxFinancingProviderAdapter já implementa
 * verificação real), (4) dedup por `UNIQUE(providerCode, externalEventId)` via WebhookInbox —
 * duplicado nunca aplica o efeito duas vezes, (5) normaliza o status bruto, decide se avança
 * (shouldApplyTransition) e SEMPRE grava o histórico raw+normalized, aplicado ou não.
 */
async function processFinancingWebhook(providerCode, rawBody, headers, body) {
  const adapter = resolveFinancingProviderAdapterByCode(providerCode);
  if (!adapter) {
    return { received: true, processed: false, reason: 'unknown_provider' };
  }

  const { externalCaseId, externalEventId, status: rawProviderStatus } = body || {};
  if (!externalCaseId || !externalEventId || !rawProviderStatus) {
    return { received: true, processed: false, reason: 'invalid_payload' };
  }

  const routing = await resolveTenantByExternalId(externalCaseId);
  if (!routing) {
    return { received: true, processed: false, reason: 'unknown_routing' };
  }
  const { financingCaseId, groupId, companyId } = routing;

  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true)', {
      replacements: { groupId, companyId },
      transaction,
    });

    // Com o contexto de tenant já setado, agora sim é seguro consultar tabelas com RLS — e
    // revalida o case de verdade (ExternalCaseRouting é só roteamento, nunca fonte de verdade).
    const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
    if (!financingCase) {
      return { received: true, processed: false, reason: 'unknown_routing' };
    }

    const tenant = { groupId, companyId };
    const webhookSecret = await getDecryptedSetting('correspondent.sandbox_webhook_secret', tenant, transaction, null);
    const isValid = adapter.verifyWebhook(rawBody, headers, webhookSecret);
    if (!isValid) {
      throw AppError.unauthorized(
        'Assinatura do webhook de financiamento ausente ou inválida.',
        'CORRESPONDENT_WEBHOOK_HMAC_INVALID'
      );
    }

    // Dedup: UNIQUE(provider_code, external_event_id) é a garantia de verdade (nível de banco);
    // o findOne aqui é só pra decidir a resposta antes de tentar o INSERT (evita depender de
    // capturar a exceção de violação de unique constraint em todo caminho).
    const alreadyProcessed = await WebhookInbox.findOne({
      where: { providerCode, externalEventId },
      transaction,
    });
    if (alreadyProcessed) {
      return { received: true, processed: false, reason: 'duplicate_event' };
    }

    await WebhookInbox.create(
      {
        groupId,
        companyId,
        financingCaseId: financingCase.id,
        providerCode,
        externalEventId,
        payload: body,
        receivedAt: new Date(),
      },
      { transaction }
    );

    const normalizedStatus = adapter.normalizeProviderStatus(rawProviderStatus);
    const applied = normalizedStatus ? shouldApplyTransition(financingCase.status, normalizedStatus) : false;
    const previousStatus = financingCase.status;

    const historyEntry = await ProviderStatusHistory.create(
      {
        groupId,
        companyId,
        financingCaseId: financingCase.id,
        rawProviderStatus,
        normalizedStatus,
        source: 'webhook',
        applied,
        occurredAt: new Date(),
      },
      { transaction }
    );

    if (applied) {
      financingCase.status = normalizedStatus;
      await financingCase.save({ transaction });

      // Caderno, Fase 9: "financing.status.changed" (+ approved/rejected/completed quando
      // aplicável) e atualização da oportunidade de CRM via evento/audit log — só quando a
      // transição é REALMENTE aplicada (nunca para status fora de ordem, que só ficam no
      // histórico raw+normalized acima).
      await publishFinancingStatusChanged(
        financingCase,
        { previousStatus, normalizedStatus, historyId: historyEntry.id },
        transaction
      );
      await syncOpportunityFromFinancingCase(financingCase, normalizedStatus, transaction);
    }

    await registrarAuditoria(
      {
        groupId,
        companyId,
        actorUserId: null,
        action: applied ? 'correspondent.webhook.status_applied' : 'correspondent.webhook.status_ignored',
        entityType: 'FinancingCase',
        entityId: financingCase.id,
        reason: applied
          ? `Status do provider "${providerCode}" atualizado via webhook: ${rawProviderStatus} → ${normalizedStatus}.`
          : `Evento de webhook do provider "${providerCode}" registrado mas NÃO aplicado (status bruto "${rawProviderStatus}"${normalizedStatus ? `, normalizado "${normalizedStatus}"` : ', não reconhecido'} — fora de ordem ou não reconhecido).`,
      },
      transaction
    );

    return { received: true, processed: true, applied, normalizedStatus };
  });
}

async function getCaseStatus(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  const history = await ProviderStatusHistory.findAll({
    where: { financingCaseId, groupId, companyId },
    order: [['occurred_at', 'DESC']],
    transaction,
  });
  return { status: financingCase.status, history };
}

module.exports = { processFinancingWebhook, getCaseStatus, resolveTenantByExternalId };
