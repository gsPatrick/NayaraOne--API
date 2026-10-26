'use strict';

const crypto = require('crypto');

const {
  sequelize,
  FinancingCase,
  ProviderStatusHistory,
  WebhookInbox,
  ExternalCaseRouting,
} = require('../../models');
const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getDecryptedSetting, getSetting } = require('../settings/settings.service');
const { resolveFinancingProviderAdapterByCode } = require('./adapters/resolveFinancingProviderAdapter');
const { shouldApplyTransition, shouldApplyPolledTransition } = require('./statusMachine');
const { publishFinancingStatusChanged, publishIntegrationCorrespondentFailed } = require('./correspondentEvents.service');
const { syncOpportunityFromFinancingCase } = require('./correspondentCrmSync.service');
const { recordProposal, PROPOSAL_STATUSES, onCaseClosedByProvider } = require('./cases/caseWorkflow.service');
const { recordIntegrationError } = require('./integrationErrors.service');
const { peekEligibilityConfig } = require('./eligibility.service');
const { sanitizeProviderMessage } = require('./sanitizeProviderMessage');
const { storePendingWebhook } = require('./webhookPending.service');

const INVALID_SIGNATURE_MESSAGE = 'Assinatura do webhook de financiamento ausente ou inválida.';
// O payload bruto do evento fica no inbox para auditoria, mas com teto: corpo enorme guarda só o resumo e o hash.
const MAX_STORED_PAYLOAD_CHARS = 64 * 1024;

function invalidSignature(reason) {
  const err = AppError.unauthorized(INVALID_SIGNATURE_MESSAGE, 'CORRESPONDENT_WEBHOOK_HMAC_INVALID');
  // Motivo real só para a trilha de auditoria interna: a resposta ao chamador é sempre a mesma.
  err.rejectionReason = reason;
  return err;
}

/**
 * recordProviderProposalIfNew — a proposta devolvida pelo provider é gravada mesmo quando o STATUS não muda
 * (ex.: a consulta aplicou APPROVED sem proposta e o webhook chega depois com ela, ou o banco revisou as
 * condições no mesmo status). Proposta idêntica à vigente não é gravada de novo. Proposta recusada pelas
 * regras vira erro de integração visível (e evento), nunca some em silêncio.
 */
async function recordProviderProposalIfNew(financingCase, proposalInput, normalizedStatus, transaction, operation = 'webhook.proposal') {
  if (!proposalInput || !PROPOSAL_STATUSES.includes(normalizedStatus)) return false;
  const { FinancingProposal } = require('../../models');
  const active = await FinancingProposal.findOne({ where: { financingCaseId: financingCase.id, groupId: financingCase.groupId, companyId: financingCase.companyId, status: 'ACTIVE' }, transaction });
  if (active
    && Number(active.approvedAmount) === Number(proposalInput.approvedAmount)
    && Number(active.termMonths) === Number(proposalInput.termMonths)
    && Number(active.annualRatePct ?? 0) === Number(proposalInput.annualRatePct ?? 0)) {
    return false;
  }
  try {
    await sequelize.transaction({ transaction }, (savepoint) => recordProposal(financingCase, proposalInput, 'PROVIDER', null, savepoint));
    return true;
  } catch (err) {
    await reportProposalFailure(financingCase, err, operation, `proposal:${financingCase.id}:${crypto.randomUUID()}`, transaction);
    return false;
  }
}

async function reportProposalFailure(financingCase, err, operation, eventKey, transaction) {
  const message = String(err?.message || 'Proposta inválida').slice(0, 480);
  await recordIntegrationError(
    { groupId: financingCase.groupId, companyId: financingCase.companyId, financingCaseId: financingCase.id, providerCode: financingCase.providerCode, operation, errorCode: typeof err?.code === 'string' ? err.code : 'PROPOSAL_INVALID', message },
    transaction
  );
  // O evento do caderno também sai para a proposta recusada (mensagem de negócio, sem o corpo do provider).
  await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: message, submissionId: eventKey }, transaction);
}

/**
 * resolveTenantByExternalId — o webhook só traz `externalCaseId` (do provider), nunca o
 * financing_case_id interno nem o tenant. Consulta `ExternalCaseRouting` (tabela SEM RLS por
 * design, ver migration 20260101000345 — mesmo padrão de `insurance_provider_submissions`,
 * `bank_payment_provider_routing`, etc.) pra descobrir o tenant ANTES de abrir qualquer
 * transação com `SET LOCAL` — nenhuma tabela protegida por RLS é consultada neste passo.
 */
async function resolveTenantByExternalId(providerCode, externalCaseId) {
  const routing = await ExternalCaseRouting.findOne({ where: { providerCode, externalCaseId } });
  if (!routing) return null;
  return {
    financingCaseId: routing.financingCaseId,
    groupId: routing.groupId,
    companyId: routing.companyId,
  };
}

/** Webhook recusado deixa rastro na auditoria da empresa (fora da transação que volta). Melhor esforço. */
async function auditRejectedWebhook(routing, providerCode, reason) {
  try {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true)', {
        replacements: { groupId: routing.groupId, companyId: routing.companyId },
        transaction,
      });
      await registrarAuditoria(
        {
          groupId: routing.groupId,
          companyId: routing.companyId,
          actorUserId: null,
          action: 'correspondent.webhook.rejected',
          entityType: 'FinancingCase',
          entityId: routing.financingCaseId,
          reason: `Webhook do provider "${providerCode}" recusado e não processado: ${reason}.`,
        },
        transaction
      );
    });
  } catch (err) {
    logger.warn({ providerCode, err: sanitizeProviderMessage(err?.message) }, 'Não foi possível registrar na auditoria o webhook recusado.');
  }
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
 *
 * Provider desconhecido e id de caso desconhecido respondem como assinatura inválida (401): quem não prova a
 * assinatura não descobre quais providers e quais ids existem. O evento de um id ainda desconhecido (o provider
 * respondeu antes de o roteamento ser gravado) fica guardado e é reprocessado quando o roteamento existir.
 */
async function processFinancingWebhook(providerCodeRaw, rawBody, headers, body, options = {}) {
  const providerCode = String(providerCodeRaw || '').trim().toLowerCase();
  const adapter = resolveFinancingProviderAdapterByCode(providerCode);
  if (!adapter) {
    logger.info({ providerCode: providerCode.slice(0, 32) }, 'Webhook de financiamento para provider desconhecido recusado.');
    throw invalidSignature('provider desconhecido na URL');
  }

  const { externalCaseId, externalEventId, status: rawProviderStatus } = body || {};
  if (
    typeof externalCaseId !== 'string' || typeof externalEventId !== 'string' || typeof rawProviderStatus !== 'string'
    || !externalCaseId || !externalEventId || !rawProviderStatus
    || externalCaseId.length > 160 || externalEventId.length > 160
  ) {
    return { received: true, processed: false, reason: 'invalid_payload' };
  }

  // Checagem barata antes de qualquer consulta ao banco: webhook sem assinatura nunca é processado.
  const hasSignature = headers && typeof headers['x-webhook-signature'] === 'string' && headers['x-webhook-signature'].length > 0;
  if (!hasSignature) {
    throw invalidSignature('assinatura ausente');
  }

  const routing = await resolveTenantByExternalId(providerCode, externalCaseId);
  if (!routing) {
    // Mesma resposta de uma assinatura inválida. O evento fica guardado para ser reprocessado quando o roteamento existir.
    if (!options.fromPending) await storePendingWebhook(providerCode, rawBody, headers, body);
    throw invalidSignature('caso ainda desconhecido');
  }
  const { financingCaseId, groupId, companyId } = routing;

  try {
    return await sequelize.transaction(async (transaction) => {
      await sequelize.query('SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true)', {
        replacements: { groupId, companyId },
        transaction,
      });

      // Com o contexto de tenant já setado, agora sim é seguro consultar tabelas com RLS — e
      // revalida o case de verdade (ExternalCaseRouting é só roteamento, nunca fonte de verdade).
      const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
      if (!financingCase || financingCase.providerCode !== providerCode) {
        // Webhook de outro provider (rota da URL diferente do provider do caso) nunca muda o caso.
        throw invalidSignature('o provider da URL é diferente do provider do caso');
      }

      const tenant = { groupId, companyId };
      // Um segredo por provider (correspondent.<provider>_webhook_secret): um provider novo nunca herda o segredo do sandbox.
      const secretKey = `correspondent.${providerCode}_webhook_secret`;
      const webhookSecret = await getDecryptedSetting(secretKey, tenant, transaction, null);
      const isValid = adapter.verifyWebhook(rawBody, headers, webhookSecret);
      if (!isValid) {
        let reason = 'assinatura inválida';
        if (!webhookSecret) {
          const stored = await getSetting(secretKey, tenant, transaction, null);
          reason = stored ? 'o segredo do webhook desta empresa está ilegível (refaça o cadastro do segredo)' : 'o segredo do webhook não está configurado para esta empresa';
        }
        throw invalidSignature(reason);
      }

      // Só agora, com a assinatura conferida, trava o caso: quem não prova a assinatura não segura
      // o lock da linha. Dois webhooks simultâneos válidos são aplicados em fila.
      await financingCase.reload({ transaction, lock: transaction.LOCK.UPDATE });

      // Dedup: UNIQUE(company_id, provider_code, external_event_id) é a garantia de verdade (nível de banco);
      // o findOne aqui é só pra decidir a resposta antes de tentar o INSERT.
      const alreadyProcessed = await WebhookInbox.findOne({
        where: { providerCode, externalEventId },
        transaction,
      });
      if (alreadyProcessed) {
        return { received: true, processed: false, reason: 'duplicate_event' };
      }

      // O findOne acima só decide a resposta de forma otimista — duas entregas concorrentes podem passar por ele e a
      // 2ª `create()` bate no índice único. Captura a violação num savepoint e trata como duplicata.
      const payloadText = JSON.stringify(body);
      const storedPayload = payloadText.length > MAX_STORED_PAYLOAD_CHARS
        ? { truncated: true, size: payloadText.length, sha256: crypto.createHash('sha256').update(payloadText).digest('hex'), externalCaseId, externalEventId, status: rawProviderStatus }
        : body;
      try {
        await sequelize.transaction({ transaction }, (savepoint) => WebhookInbox.create(
          {
            groupId,
            companyId,
            financingCaseId: financingCase.id,
            providerCode,
            externalEventId,
            payload: storedPayload,
            receivedAt: new Date(),
          },
          { transaction: savepoint }
        ));
      } catch (err) {
        if (err?.name === 'SequelizeUniqueConstraintError') {
          return { received: true, processed: false, reason: 'duplicate_event' };
        }
        throw err;
      }

      const normalizedStatus = adapter.normalizeProviderStatus(rawProviderStatus);
      // Ordem pelo relógio do provider: se o evento traz a hora em que aconteceu (`occurredAt`) e já
      // existe um evento aplicado com hora do provider mais nova, este é antigo e atrasado: fica no histórico, mas não vale.
      // Só se comparam horas DO PROVIDER entre si (a hora local nunca entra na comparação).
      const config = await peekEligibilityConfig(groupId, companyId, transaction);
      const toleranceMinutes = Number.isInteger(config.providerClockToleranceMinutes) && config.providerClockToleranceMinutes >= 0 ? config.providerClockToleranceMinutes : 5;
      const providerTime = body.occurredAt ? new Date(body.occurredAt) : null;
      // Hora do provider no futuro (relógio errado) não vale: usa a hora local, para não congelar o caso.
      const providerTimeValid = Boolean(providerTime) && !Number.isNaN(providerTime.getTime()) && providerTime.getTime() <= Date.now() + toleranceMinutes * 60 * 1000;
      const eventAt = providerTimeValid ? providerTime : new Date();
      let staleByProviderClock = false;
      if (providerTimeValid) {
        const lastApplied = await ProviderStatusHistory.findOne({
          where: { financingCaseId: financingCase.id, groupId, companyId, applied: true, source: 'webhook', providerOccurredAt: { [require('sequelize').Op.ne]: null } },
          order: [['provider_occurred_at', 'DESC']],
          transaction,
        });
        staleByProviderClock = Boolean(lastApplied && lastApplied.providerOccurredAt && lastApplied.providerOccurredAt > providerTime);
      }
      const applied = normalizedStatus && !staleByProviderClock ? shouldApplyTransition(financingCase.status, normalizedStatus) : false;
      const previousStatus = financingCase.status;

      const historyEntry = await ProviderStatusHistory.create(
        {
          groupId,
          companyId,
          financingCaseId: financingCase.id,
          rawProviderStatus: String(rawProviderStatus).slice(0, 255),
          normalizedStatus,
          source: 'webhook',
          applied,
          occurredAt: eventAt,
          providerOccurredAt: providerTimeValid ? providerTime : null,
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
        if (['CANCELED', 'REJECTED'].includes(normalizedStatus)) await onCaseClosedByProvider(financingCase, normalizedStatus, transaction);
        if (body.proposal && PROPOSAL_STATUSES.includes(normalizedStatus)) {
          try {
            await sequelize.transaction({ transaction }, (savepoint) => recordProposal(financingCase, body.proposal, 'PROVIDER', null, savepoint));
          } catch (err) {
            // Proposta malformada não derruba o webhook (o status já foi aplicado): fica registrada como erro
            // de integração, com mensagem de negócio, sem o corpo do provider.
            await reportProposalFailure(financingCase, err, 'webhook.proposal', `webhook:${crypto.createHash('sha1').update(String(externalEventId)).digest('hex').slice(0, 20)}`, transaction);
          }
        }
      }

      if (!applied && normalizedStatus && normalizedStatus === financingCase.status) {
        await recordProviderProposalIfNew(financingCase, body.proposal, normalizedStatus, transaction);
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
  } catch (err) {
    if (err?.code === 'CORRESPONDENT_WEBHOOK_HMAC_INVALID' && err.rejectionReason) {
      await auditRejectedWebhook(routing, providerCode, err.rejectionReason);
    }
    throw err;
  }
}

/**
 * applyPolledStatus — aplica o status que o provider devolveu numa CONSULTA (`getCaseStatus`), pelo
 * mesmo caminho de regras do webhook: normaliza, respeita a ordem (nunca regride), grava o histórico
 * (bruto + normalizado, `source: 'poll'`), emite os eventos e atualiza o CRM. Se o status normalizado
 * é o mesmo em que o caso já está, não faz nada (a consulta repetida não enche o histórico). A consulta só
 * avança o caso: sem hora do evento no provider, não decide movimento lateral entre estados irmãos.
 */
async function applyPolledStatus(financingCase, adapter, result, transaction) {
  const rawProviderStatus = result?.rawProviderStatus || result?.status;
  if (!rawProviderStatus) return { applied: false, reason: 'empty' };
  const rawText = String(rawProviderStatus).slice(0, 255);
  const normalizedStatus = adapter.normalizeProviderStatus(rawProviderStatus);
  const { groupId, companyId } = financingCase;
  // Nunca perde o status bruto: status que o mapa não reconhece fica no histórico (uma vez, não a cada consulta).
  const lastPoll = await ProviderStatusHistory.findOne({ where: { financingCaseId: financingCase.id, groupId, companyId, source: 'poll' }, order: [['occurred_at', 'DESC']], transaction });
  if (!normalizedStatus) {
    if (!lastPoll || lastPoll.rawProviderStatus !== rawText) {
      await ProviderStatusHistory.create(
        { groupId, companyId, financingCaseId: financingCase.id, rawProviderStatus: rawText, normalizedStatus: null, source: 'poll', applied: false, occurredAt: new Date() },
        { transaction }
      );
    }
    return { applied: false, reason: 'unrecognized' };
  }
  if (normalizedStatus === financingCase.status) {
    await recordProviderProposalIfNew(financingCase, result?.proposal, normalizedStatus, transaction, 'status');
    return { applied: false, reason: 'no_change' };
  }
  const applied = shouldApplyPolledTransition(financingCase.status, normalizedStatus);
  const previousStatus = financingCase.status;
  // Consulta repetida que devolve o mesmo status antigo não enche o histórico a cada minuto.
  if (!applied && lastPoll && lastPoll.rawProviderStatus === rawText) {
    return { applied: false, reason: 'no_change' };
  }
  const historyEntry = await ProviderStatusHistory.create(
    {
      groupId, companyId,
      financingCaseId: financingCase.id,
      rawProviderStatus: rawText,
      normalizedStatus,
      source: 'poll',
      applied,
      occurredAt: new Date(),
    },
    { transaction }
  );
  if (applied) {
    financingCase.status = normalizedStatus;
    if (normalizedStatus === 'CANCELED') {
      financingCase.canceledReason = `Cancelado pelo provider "${financingCase.providerCode}" (status original "${rawProviderStatus}")`;
      financingCase.canceledAt = new Date();
    }
    await financingCase.save({ transaction });
    await publishFinancingStatusChanged(financingCase, { previousStatus, normalizedStatus, historyId: historyEntry.id }, transaction);
    await syncOpportunityFromFinancingCase(financingCase, normalizedStatus, transaction);
    if (['CANCELED', 'REJECTED'].includes(normalizedStatus)) await onCaseClosedByProvider(financingCase, normalizedStatus, transaction);
    if (result.proposal && PROPOSAL_STATUSES.includes(normalizedStatus)) {
      try {
        await sequelize.transaction({ transaction }, (savepoint) => recordProposal(financingCase, result.proposal, 'PROVIDER', null, savepoint));
      } catch (err) {
        await reportProposalFailure(financingCase, err, 'status', `poll:${historyEntry.id}`, transaction);
      }
    }
    await registrarAuditoria(
      {
        groupId, companyId, actorUserId: null,
        action: 'correspondent.status.polled_applied',
        entityType: 'FinancingCase',
        entityId: financingCase.id,
        reason: `Status consultado no provider "${financingCase.providerCode}" e aplicado: ${rawProviderStatus} → ${normalizedStatus}.`,
      },
      transaction
    );
  }
  return { applied, normalizedStatus };
}

/**
 * getCaseStatus — status atual e histórico (mais recentes primeiro, com limite e deslocamento). O histórico
 * volta sem identificadores de grupo e empresa: quem consulta já está no seu contexto.
 */
async function getCaseStatus(financingCaseId, groupId, companyId, transaction, { limit, offset } = {}) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);
  const rowLimit = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.min(Math.floor(parsedLimit), 500) : 200;
  const rowOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;
  const history = await ProviderStatusHistory.findAll({
    where: { financingCaseId, groupId, companyId },
    order: [['occurred_at', 'DESC']],
    limit: rowLimit,
    offset: rowOffset,
    transaction,
  });
  return {
    status: financingCase.status,
    history: history.map((row) => {
      const { groupId: _g, companyId: _c, ...rest } = row.get({ plain: true });
      return rest;
    }),
  };
}

module.exports = { processFinancingWebhook, getCaseStatus, resolveTenantByExternalId, applyPolledStatus };
