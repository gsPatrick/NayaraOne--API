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
const { publishFinancingStatusChanged, publishIntegrationCorrespondentFailed } = require('./correspondentEvents.service');
const { syncOpportunityFromFinancingCase } = require('./correspondentCrmSync.service');
const { recordProposal, PROPOSAL_STATUSES } = require('./cases/caseWorkflow.service');
const { recordIntegrationError } = require('./integrationErrors.service');

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

    // ACHADO REAL (auditoria pós-DoD, Frente Idempotência/Concorrência): o findOne acima só
    // decide a resposta de forma otimista — duas entregas de webhook verdadeiramente
    // concorrentes (cenário real: o provider reentrega por timeout de rede do lado dele, duas
    // conexões distintas processando ao mesmo tempo) podem passar pelo findOne antes de
    // qualquer uma commitar, e a 2ª `create()` bate no índice único
    // `webhook_inbox_provider_event_idx` e estoura um erro cru em vez de responder
    // graciosamente "evento duplicado" (resposta esperada e inofensiva pra um webhook). Captura
    // a violação e trata como duplicata — nunca propaga erro técnico de banco pro provider.
    try {
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
    } catch (err) {
      if (err?.name === 'SequelizeUniqueConstraintError') {
        return { received: true, processed: false, reason: 'duplicate_event' };
      }
      throw err;
    }

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
      if (normalizedStatus === 'CANCELED') {
        financingCase.canceledReason = `Cancelado pelo provider "${providerCode}" (status original "${rawProviderStatus}")`;
        financingCase.canceledAt = new Date();
      }
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
      if (body.proposal && PROPOSAL_STATUSES.includes(normalizedStatus)) {
        try {
          await recordProposal(financingCase, body.proposal, 'PROVIDER', null, transaction);
        } catch (err) {
          // Proposta malformada não derruba o webhook (o status já foi aplicado): fica registrada como erro
          // de integração, com mensagem de negócio, sem o corpo do provider.
          await recordIntegrationError(
            { groupId, companyId, financingCaseId: financingCase.id, providerCode, operation: 'webhook.proposal', errorCode: err?.code || 'PROPOSAL_INVALID', message: String(err?.message || 'Proposta inválida').slice(0, 480) },
            transaction
          );
          // O evento do caderno também sai para a proposta recusada do webhook (mensagem de negócio, sem o corpo do provider).
          await publishIntegrationCorrespondentFailed(
            financingCase,
            { providerCode, reason: String(err?.message || 'Proposta inválida').slice(0, 480), submissionId: `webhook:${externalEventId}` },
            transaction
          );
        }
      }
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
