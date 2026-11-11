'use strict';

const AppError = require('../../utils/AppError');
const { BankAccount, FinancialEntry, Notification, UserMembership } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const { createAnomalyCase } = require('./anomalyCases.service');

// Regras de antifraude do Financeiro Base (01_ARQUITETURA_E_INVARIANTES.md — bloco Antifraude/
// 03_MOTORES_TRANSVERSAIS.md — gatilhos "mudança bancária + pagamento em janela curta" e
// "conta bancária nova exige período de resfriamento").
//
// IMPORTANTE (transparência de escopo): a migration de finance.bank_accounts NÃO tem uma
// coluna dedicada tipo `cooldown_until` — o cooldown é derivado do próprio `created_at`
// (padrão já usado no projeto para não precisar de coluna extra: ver radarMatchingJob.js).
// Da mesma forma, `finance.approval_requests` NÃO tem uma coluna `snapshot_hash` — a proteção
// "se alterar conta/valor a aprovação invalida" é implementada via lock otimista
// (`lock_version`, coluna que já existe em FinancialEntry/Commission/OwnerRepass/BankAccount)
// comparado no momento da decisão, não por um hash armazenado. Ver approvals.service.js.

// FIX (auditoria externa 2026-10-07 — contrato bruto, Centro Financeiro §2, FIN-005: "Limites
// vêm do Motor de Regras; aprovação usa snapshot/hash."): os limiares passam por
// `resolveAntifraudThresholds` (evaluateRule('FIN-005', ...) + getSetting). DEC-007 (DI-DEC007-1): os
// padrões são os do catálogo (finance.settings.js FINANCE_SETTINGS_DEFAULTS — conta nova R$ 5.000,00,
// múltiplo 3,0 revisa e 10,0 bloqueia, resfriamento 48 h, duplicidade 90 dias, fornecedor novo 30 dias e
// R$ 20.000,00), sem variável de ambiente que possa afrouxá-los. Falha segura: o `action.*` de uma versão
// publicada da regra só aperta o padrão (nunca o afrouxa), e sem a regra publicada o valor gravado pela
// empresa só vale quando é mais restritivo que o padrão.
const { KEYS, FINANCE_SETTINGS_DEFAULTS, readFinanceNumber } = require('./finance.settings');

const DEFAULT_BANK_ACCOUNT_COOLDOWN_HOURS = FINANCE_SETTINGS_DEFAULTS[KEYS.bankAccountCooldownHours];
const DEFAULT_ANOMALY_HISTORY_MULTIPLIER = FINANCE_SETTINGS_DEFAULTS[KEYS.historyMultiplier];
const DEFAULT_ANOMALY_NEW_ACCOUNT_THRESHOLD = FINANCE_SETTINGS_DEFAULTS[KEYS.newAccountThreshold];

function hoursSince(date) {
  return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60);
}

/** O mais restritivo entre o valor da regra publicada (se for número) e o padrão: `stricter` = Math.min para limiar de valor/múltiplo, Math.max para espera. */
function tighten(actionValue, fallback, stricter) {
  const n = Number(actionValue);
  return actionValue !== undefined && actionValue !== null && Number.isFinite(n) ? stricter(n, fallback) : fallback;
}

/**
 * resolveAntifraudThresholds — FIN-005. `evaluateRule` decide SE a versão publicada da regra
 * está vigente para o tenant (fail-closed: RULE_CONFLICT/NOT_FOUND/erro => DENY). Quando APPLY,
 * o QUANTO vem de `getSetting` (ajustável pelo painel, sem publicar regra nova), com o padrão do
 * catálogo apertado pelo `action.*` da regra; quando DENY (regra ainda não publicada para o tenant),
 * vale o padrão do catálogo ou o valor gravado, o que for mais restritivo. Os parâmetros novos da
 * DEC-007 (bloqueio, duplicidade, fornecedor novo) não dependem da regra.
 */
async function resolveAntifraudThresholds(tenant, transaction) {
  const evaluation = await evaluateRule('FIN-005', { financeAntifraudRuleActive: true }, tenant, { transaction });
  const active = evaluation.decision === 'APPLY';
  const action = (active && evaluation.action) || {};
  const read = (key, fallback) => readFinanceNumber(key, tenant, transaction, fallback);

  const [historyMultiplier, newAccountThreshold, cooldownHours, outlierBlockMultiplier, duplicateWindowDays, newSupplierDays, newSupplierMinAmount] = await Promise.all([
    read(KEYS.historyMultiplier, tighten(action.historyMultiplier, DEFAULT_ANOMALY_HISTORY_MULTIPLIER, Math.min)),
    read(KEYS.newAccountThreshold, tighten(action.newAccountThreshold, DEFAULT_ANOMALY_NEW_ACCOUNT_THRESHOLD, Math.min)),
    read(KEYS.bankAccountCooldownHours, tighten(action.bankAccountCooldownHours, DEFAULT_BANK_ACCOUNT_COOLDOWN_HOURS, Math.max)),
    read(KEYS.outlierBlockMultiplier),
    read(KEYS.duplicateWindowDays),
    read(KEYS.newSupplierDays),
    read(KEYS.newSupplierMinAmount),
  ]);

  return {
    historyMultiplier: active ? historyMultiplier : Math.min(historyMultiplier, DEFAULT_ANOMALY_HISTORY_MULTIPLIER),
    newAccountThreshold: active ? newAccountThreshold : Math.min(newAccountThreshold, DEFAULT_ANOMALY_NEW_ACCOUNT_THRESHOLD),
    cooldownHours: active ? cooldownHours : Math.max(cooldownHours, DEFAULT_BANK_ACCOUNT_COOLDOWN_HOURS),
    outlierBlockMultiplier,
    duplicateWindowDays,
    newSupplierDays,
    newSupplierMinAmount,
    ruleVersionId: active ? evaluation.ruleVersionId : null,
  };
}

/**
 * assertBankAccountEligibleForPayment — bloqueia pagamento/repasse para uma conta bancária:
 *   - com status BLOCKED (bloqueio manual/antifraude);
 *   - ainda em PENDING_COOLDOWN e dentro da janela de resfriamento (conta nova OU dado
 *     sensível alterado recentemente — ver bankAccounts.service.js, que reabre o cooldown
 *     sempre que bank_code/agency/account_number/pix_key mudam).
 * Promove automaticamente PENDING_COOLDOWN → ACTIVE quando o prazo já passou (mesma técnica
 * "lazy transition" do resto do projeto, sem job dedicado).
 */
async function assertBankAccountEligibleForPayment(bankAccountId, transaction) {
  if (!bankAccountId) return null;

  const bankAccount = await BankAccount.findByPk(bankAccountId, { transaction });
  if (!bankAccount) throw AppError.notFound('Conta bancária não encontrada.', 'FINANCE_BANK_ACCOUNT_NOT_FOUND');

  if (bankAccount.status === 'BLOCKED') {
    throw AppError.conflict(
      'Esta conta bancária está bloqueada para pagamentos (antifraude). Desbloqueie antes de prosseguir.',
      'FINANCE_BANK_ACCOUNT_BLOCKED'
    );
  }

  if (bankAccount.status === 'PENDING_COOLDOWN') {
    const { cooldownHours } = await resolveAntifraudThresholds(
      { groupId: bankAccount.groupId, companyId: bankAccount.companyId },
      transaction
    );
    const elapsed = hoursSince(bankAccount.updated_at || bankAccount.created_at);
    if (elapsed < cooldownHours) {
      const remaining = Math.ceil(cooldownHours - elapsed);
      throw AppError.conflict(
        `Conta bancária em período de resfriamento (antifraude) — faltam ${remaining}h para ficar elegível a pagamentos. ` +
          'Isso protege contra troca fraudulenta de dados bancários seguida de pagamento imediato.',
        'FINANCE_BANK_ACCOUNT_COOLDOWN'
      );
    }
    bankAccount.status = 'ACTIVE';
    await bankAccount.save({ transaction });
  }

  return bankAccount;
}

/**
 * assertNoDuplicatePayment — checagem explícita de idempotência antes de liquidar/pagar (a
 * unicidade de `idempotency_key` no banco já impede o INSERT duplicado, mas aqui damos um erro
 * de negócio claro e antecipado em vez de deixar estourar como erro de constraint de banco).
 */
async function assertNoDuplicatePayment(Model, idempotencyKey, transaction) {
  if (!idempotencyKey) return;
  const existing = await Model.findOne({ where: { idempotencyKey }, transaction });
  if (existing) {
    throw AppError.conflict(
      'Já existe um lançamento com esta mesma chave de idempotência — pagamento/recebimento duplicado bloqueado.',
      'FINANCE_DUPLICATE_PAYMENT',
      { existingId: existing.id }
    );
  }
}

// --- M4-21: detecção de anomalia + revisão manual de beneficiário ---------------------------
//
// Os critérios (§17 "Pagamento duplicado", "Valor fora do padrão", "Conta nova + pagamento
// imediato", "Fornecedor novo de alto valor") e os números da DEC-007 estão em
// payableAntifraudFindings.js. Ao detectar, o LANÇAMENTO é marcado com requires_manual_review =
// true (fica retido: o financialEntries.service recusa liquidar, total ou parcialmente, enquanto o
// flag estiver ligado), cada achado abre o seu caso e o time financeiro é notificado (Notification
// IN_APP, mesmo padrão do legalDeadlineAlertJob). A liberação é sempre humana e auditada —
// `clearManualReview`. Achado BLOQUEANTE (duplicidade, múltiplo de bloqueio) também impede
// preparar a intenção e pedir aprovação até a liberação (paymentAnomalyGate.assertNotBlocked).

/**
 * flagAnomalousPayment — avalia o lançamento. Limiares vêm de `resolveAntifraudThresholds`
 * (FIN-005 + parâmetros da DEC-007). Retorna `{ flagged: false }` quando nada foi detectado (e
 * NÃO altera nada), ou `{ flagged: true, reason, findings, blocking, notifiedUserIds }` quando
 * marcou o lançamento para revisão manual.
 */
async function flagAnomalousPayment(financialEntry, transaction) {
  if (!financialEntry || !financialEntry.bankAccountId) return { flagged: false, reason: null };
  if (financialEntry.requiresManualReview) return { flagged: false, reason: null, alreadyFlagged: true };

  const thresholds = await resolveAntifraudThresholds({ groupId: financialEntry.groupId, companyId: financialEntry.companyId }, transaction);
  const { collectPayableFindings } = require('./payableAntifraudFindings');
  const findings = await collectPayableFindings(financialEntry, thresholds, transaction);
  if (findings.length === 0) return { flagged: false, reason: null };
  const reason = findings.map((f) => f.reason).join(' ');
  const blocking = findings.some((f) => f.blocking);

  const beforeJson = financialEntry.toJSON();
  financialEntry.requiresManualReview = true;
  financialEntry.manualReviewReason = reason;
  financialEntry.manualReviewClearedAt = null;
  financialEntry.manualReviewClearedBy = null;
  await financialEntry.save({ transaction });

  // Notifica o time financeiro do tenant. Sem um "grupo/papel financeiro" modelado no schema,
  // usamos os usuários com membership ativa na empresa — quem opera o financeiro do tenant.
  const memberships = await UserMembership.findAll({ where: { companyId: financialEntry.companyId }, transaction });
  const notifiedUserIds = [...new Set(memberships.map((m) => m.userId).filter(Boolean))];
  for (const userId of notifiedUserIds) {
    await Notification.create(
      {
        groupId: financialEntry.groupId,
        companyId: financialEntry.companyId,
        userId,
        channel: 'IN_APP',
        title: blocking ? 'Pagamento bloqueado pelo antifraude até a revisão' : 'Pagamento anômalo retido para revisão manual',
        body: `Lançamento ${financialEntry.id} (${Number(financialEntry.amount).toFixed(2)}) foi retido pelo antifraude. Motivo: ${reason}`,
        createdBy: null,
        updatedBy: null,
      },
      { transaction }
    );
  }

  await registrarAuditoria(
    {
      groupId: financialEntry.groupId,
      companyId: financialEntry.companyId,
      actorUserId: null,
      action: 'finance.antifraud.manual_review_required',
      entityType: 'FinancialEntry',
      entityId: financialEntry.id,
      beforeJson,
      afterJson: financialEntry.toJSON(),
      reason: `Antifraude reteve o pagamento para revisão manual: ${reason}`,
    },
    transaction
  );

  // GAP REAL CORRIGIDO (Caderno §17, "Valor fora do padrão → Anomaly score + revisão"): cada achado
  // tem caso próprio — "openHighRiskAnomalies" do relatório semanal (§19) vem daqui.
  for (const finding of findings) {
    await createAnomalyCase(
      {
        groupId: financialEntry.groupId,
        companyId: financialEntry.companyId,
        caseType: finding.caseType,
        riskLevel: finding.riskLevel,
        relatedEntityType: 'FinancialEntry',
        relatedEntityId: financialEntry.id,
        reason: finding.reason,
      },
      null,
      transaction
    );
  }

  return { flagged: true, reason, findings, blocking, notifiedUserIds };
}

/**
 * clearManualReview — liberação HUMANA do lançamento retido. Registra quem liberou e quando
 * (manual_review_cleared_by/at) e audita — a trilha de "quem revisou" nunca se perde.
 */
async function clearManualReview(entityId, actorUserId, transaction, reviewNote) {
  if (!actorUserId) {
    throw AppError.forbidden(
      'A liberação de um pagamento retido por antifraude exige um revisor humano identificado.',
      'FINANCE_MANUAL_REVIEW_ACTOR_REQUIRED'
    );
  }
  const entry = await FinancialEntry.findByPk(entityId, { transaction });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  if (!entry.requiresManualReview) {
    throw AppError.conflict('Este lançamento não está retido para revisão manual.', 'FINANCE_MANUAL_REVIEW_NOT_PENDING');
  }
  // Revisão Marco 7 (19/10/2026, B2): o payable de um recebimento de Compras com divergência
  // (excedente/preço) em aberto nasce retido. Só a decisão da divergência, em Compras, libera —
  // a liberação manual do Financeiro não pode furar a retenção enquanto a divergência existir.
  const [openProcurementDiscrepancy] = await FinancialEntry.sequelize.query(
    `SELECT 1 FROM procurement.goods_receipts gr
       JOIN procurement.goods_receipt_items gi ON gi.goods_receipt_id = gr.id
       JOIN procurement.receipt_discrepancies d ON d.goods_receipt_item_id = gi.id
      WHERE gr.financial_entry_id = :entryId
        AND d.status = 'OPEN'
        AND d.discrepancy_type IN ('OVER_RECEIPT', 'PRICE_MISMATCH')
      LIMIT 1`,
    { replacements: { entryId: entry.id }, transaction, type: FinancialEntry.sequelize.QueryTypes.SELECT }
  );
  if (openProcurementDiscrepancy) {
    throw AppError.conflict(
      'Este pagamento está retido por uma divergência de recebimento em aberto em Compras — a liberação acontece quando a divergência for decidida.',
      'PROCUREMENT_RECEIPT_DISCREPANCY_OPEN'
    );
  }

  const beforeJson = entry.toJSON();
  entry.requiresManualReview = false;
  entry.manualReviewClearedAt = new Date();
  entry.manualReviewClearedBy = actorUserId;
  entry.updatedBy = actorUserId;
  await entry.save({ transaction });

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.antifraud.manual_review_cleared',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: reviewNote
        ? `Revisão manual concluída e pagamento liberado: ${reviewNote}`
        : 'Revisão manual concluída — pagamento liberado pelo revisor.',
    },
    transaction
  );

  return entry;
}

// --- FIN-013/FIN-005 complementar: estorno frequente (frequentReversalAlert.js) e conciliação
// manual recorrente (manualReconciliationAlert.js), com os números da DEC-007. As duas funções
// continuam exportadas daqui (mesma assinatura) para quem já as chamava.
const { checkFrequentReversalAlert } = require('./frequentReversalAlert');

/** Leitura (sem abrir caso) da conciliação manual recorrente da empresa, com os mesmos parâmetros do alerta. */
async function checkRecurringManualReconciliationAlert(companyId, transaction) {
  return require('./manualReconciliationAlert').readManualReconciliationAlert(companyId, transaction);
}

module.exports = {
  DEFAULT_BANK_ACCOUNT_COOLDOWN_HOURS,
  DEFAULT_ANOMALY_HISTORY_MULTIPLIER,
  DEFAULT_ANOMALY_NEW_ACCOUNT_THRESHOLD,
  resolveAntifraudThresholds,
  assertBankAccountEligibleForPayment,
  assertNoDuplicatePayment,
  flagAnomalousPayment,
  clearManualReview,
  checkFrequentReversalAlert,
  checkRecurringManualReconciliationAlert,
};
