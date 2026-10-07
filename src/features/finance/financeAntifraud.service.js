'use strict';

const { Op } = require('sequelize');

const AppError = require('../../utils/AppError');
const { BankAccount, FinancialEntry, Notification, UserMembership } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const { getSetting } = require('../settings/settings.service');

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
// vêm do Motor de Regras; aprovação usa snapshot/hash."): os limiares abaixo eram lidos
// diretamente de env var (nem hard-code puro, nem Motor de Regras). Agora SEMPRE passam por
// `resolveAntifraudThresholds` (evaluateRule('FIN-005', ...) + getSetting), com os valores
// anteriores preservados como DEFAULT_* (usados quando a regra ainda não foi publicada para o
// tenant — nunca enfraquece a proteção por ausência de configuração, ao contrário do padrão
// "fail closed = 0" de REG-LOC-00x em collectionCase.service.js, que lá é seguro porque "0" é o
// valor mais protetivo para o credor; aqui "0" seria o valor MENOS protetivo contra fraude, por
// isso o fallback é o limiar histórico hardcoded, não zero).
const DEFAULT_BANK_ACCOUNT_COOLDOWN_HOURS = Number(process.env.FINANCE_BANK_ACCOUNT_COOLDOWN_HOURS) || 48;
const DEFAULT_ANOMALY_HISTORY_MULTIPLIER = Number(process.env.FINANCE_ANOMALY_MULTIPLIER) || 3;
const DEFAULT_ANOMALY_NEW_ACCOUNT_THRESHOLD = Number(process.env.FINANCE_ANOMALY_NEW_ACCOUNT_THRESHOLD) || 10000;

function hoursSince(date) {
  return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60);
}

/**
 * resolveAntifraudThresholds — FIN-005. `evaluateRule` decide SE a versão publicada da regra
 * está vigente para o tenant (fail-closed: RULE_CONFLICT/NOT_FOUND/erro => DENY). Quando APPLY,
 * o QUANTO vem de `getSetting` (ajustável pelo painel, sem publicar regra nova) com o
 * `action.*` da regra como default; quando DENY (regra ainda não publicada/seedada para o
 * tenant — ex.: ambiente de teste sem seedFinanceAntifraudRules), cai nos DEFAULT_* abaixo, que
 * são os MESMOS valores hardcoded usados antes desta migração (nunca enfraquece a proteção).
 */
async function resolveAntifraudThresholds(tenant, transaction) {
  const evaluation = await evaluateRule('FIN-005', { financeAntifraudRuleActive: true }, tenant, { transaction });

  if (evaluation.decision !== 'APPLY') {
    return {
      historyMultiplier: DEFAULT_ANOMALY_HISTORY_MULTIPLIER,
      newAccountThreshold: DEFAULT_ANOMALY_NEW_ACCOUNT_THRESHOLD,
      cooldownHours: DEFAULT_BANK_ACCOUNT_COOLDOWN_HOURS,
      ruleVersionId: null,
    };
  }

  const [historyMultiplier, newAccountThreshold, cooldownHours] = await Promise.all([
    getSetting('finance.antifraud_history_multiplier', tenant, transaction, evaluation.action.historyMultiplier ?? DEFAULT_ANOMALY_HISTORY_MULTIPLIER),
    getSetting(
      'finance.antifraud_new_account_threshold',
      tenant,
      transaction,
      evaluation.action.newAccountThreshold ?? DEFAULT_ANOMALY_NEW_ACCOUNT_THRESHOLD
    ),
    getSetting('finance.bank_account_cooldown_hours', tenant, transaction, evaluation.action.bankAccountCooldownHours ?? DEFAULT_BANK_ACCOUNT_COOLDOWN_HOURS),
  ]);

  return {
    historyMultiplier: Number(historyMultiplier),
    newAccountThreshold: Number(newAccountThreshold),
    cooldownHours: Number(cooldownHours),
    ruleVersionId: evaluation.ruleVersionId,
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
// CRITÉRIOS (decisão de engenharia documentada — não há limiar definido no schema/documento;
// ambos são configuráveis por env pra poder calibrar sem deploy de código):
//   (A) DESVIO DO HISTÓRICO: o valor do pagamento é >= 3x a MÉDIA dos pagamentos já liquidados
//       para a MESMA bankAccountId (beneficiário). Só vale a partir de um mínimo de histórico
//       (2 pagamentos) — com 1 só pagamento a "média" não significa nada e geraria ruído.
//   (B) PRIMEIRO PAGAMENTO GRANDE: conta bancária sem nenhum pagamento liquidado no histórico
//       recebendo de cara um valor >= R$ 10.000 — o padrão clássico de fraude de beneficiário
//       (cadastra conta nova e manda o valor cheio).
// Ao detectar, o LANÇAMENTO é marcado com requires_manual_review = true (fica retido: o
// financialEntries.service recusa liquidar, total ou parcialmente, enquanto o flag estiver
// ligado) e o time financeiro é notificado (Notification IN_APP, mesmo padrão do
// legalDeadlineAlertJob). A liberação é sempre humana e auditada — `clearManualReview`.

const ANOMALY_MIN_HISTORY = 2;

/**
 * flagAnomalousPayment — avalia o lançamento contra os critérios acima. Limiares vêm de
 * `resolveAntifraudThresholds` (FIN-005, Motor de Regras). Retorna `{ flagged: false }` quando
 * nada foi detectado (e NÃO altera nada), ou `{ flagged: true, reason, notifiedUserIds }`
 * quando marcou o lançamento para revisão manual.
 */
async function flagAnomalousPayment(financialEntry, transaction) {
  if (!financialEntry || !financialEntry.bankAccountId) return { flagged: false, reason: null };
  if (financialEntry.requiresManualReview) return { flagged: false, reason: null, alreadyFlagged: true };

  const { historyMultiplier, newAccountThreshold } = await resolveAntifraudThresholds(
    { groupId: financialEntry.groupId, companyId: financialEntry.companyId },
    transaction
  );

  const amount = Number(financialEntry.amount);

  // Histórico = pagamentos JÁ liquidados da mesma conta bancária, excluindo o próprio
  // lançamento e qualquer baixa parcial dele (parent_entry_id), pra não se comparar consigo mesmo.
  const history = await FinancialEntry.findAll({
    where: {
      bankAccountId: financialEntry.bankAccountId,
      status: 'SETTLED',
      parentEntryId: null,
      id: { [Op.ne]: financialEntry.id },
    },
    transaction,
  });

  let reason = null;
  if (history.length >= ANOMALY_MIN_HISTORY) {
    const average = history.reduce((acc, e) => acc + Number(e.amount), 0) / history.length;
    if (average > 0 && amount >= average * historyMultiplier) {
      reason =
        `Valor ${amount.toFixed(2)} é ${(amount / average).toFixed(1)}x a média histórica ` +
        `(${average.toFixed(2)}) dos ${history.length} pagamentos já liquidados desta conta bancária ` +
        `(limiar FIN-005: ${historyMultiplier}x).`;
    }
  } else if (history.length === 0 && amount >= newAccountThreshold) {
    reason =
      `Primeiro pagamento desta conta bancária já no valor de ${amount.toFixed(2)} ` +
      `(limite FIN-005 para conta sem histórico: ${newAccountThreshold.toFixed(2)}).`;
  }

  if (!reason) return { flagged: false, reason: null };

  const beforeJson = financialEntry.toJSON();
  financialEntry.requiresManualReview = true;
  financialEntry.manualReviewReason = reason;
  financialEntry.manualReviewClearedAt = null;
  financialEntry.manualReviewClearedBy = null;
  await financialEntry.save({ transaction });

  // Notifica o time financeiro do tenant. Sem um "grupo/papel financeiro" modelado no schema,
  // usamos os usuários com membership ativa na empresa — quem opera o financeiro do tenant.
  const memberships = await UserMembership.findAll({
    where: { companyId: financialEntry.companyId },
    transaction,
  });
  const notifiedUserIds = [...new Set(memberships.map((m) => m.userId).filter(Boolean))];
  for (const userId of notifiedUserIds) {
    await Notification.create(
      {
        groupId: financialEntry.groupId,
        companyId: financialEntry.companyId,
        userId,
        channel: 'IN_APP',
        title: 'Pagamento anômalo retido para revisão manual',
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

  return { flagged: true, reason, notifiedUserIds };
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

// --- FIN-013/FIN-005 complementar: sinalizador de estorno frequente e conciliação manual
// recorrente ---------------------------------------------------------------------------------
//
// Auditoria externa (contrato bruto, 2026-10-07): item 6 pede, além da migração dos limiares
// para o Motor de Regras, "um sinalizador/alerta pra estorno frequente e conciliação manual
// recorrente (mesmo que seja um relatório/contador simples, não precisa ser elaborado)". Não há
// um código de teste/seção específica no Anexo I para isso além da menção direta no pedido do
// auditor — implementado como contador simples com limiar configurável via Motor de Regras
// (mesmo FIN-005), sem nenhuma ação automática (é um ALERTA/relatório, não um bloqueio).

const FREQUENT_REVERSAL_WINDOW_DAYS = 30;
const FREQUENT_REVERSAL_MIN_COUNT = 3;
const RECURRING_MANUAL_RECONCILIATION_MIN_COUNT = 3;

/**
 * checkFrequentReversalAlert — conta quantos FinancialEntry foram REVERSED (reverseFinancialEntry)
 * para a empresa nos últimos `FREQUENT_REVERSAL_WINDOW_DAYS` dias. `flagged: true` quando o
 * total atinge o limiar — só um sinalizador de leitura, nunca bloqueia nada.
 */
async function checkFrequentReversalAlert(companyId, transaction) {
  const since = new Date(Date.now() - FREQUENT_REVERSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const count = await FinancialEntry.count({
    // NOTA: o atributo de timestamp deste model está registrado como 'updated_at' (snake_case
    // literal), não 'updatedAt' — ver FinancialEntry.js (underscored:true com updatedAt:
    // 'updated_at' explícito gera o atributo já com esse nome, não um alias camelCase).
    where: { companyId, status: 'REVERSED', updated_at: { [Op.gte]: since } },
    transaction,
  });
  return {
    count,
    windowDays: FREQUENT_REVERSAL_WINDOW_DAYS,
    flagged: count >= FREQUENT_REVERSAL_MIN_COUNT,
  };
}

/**
 * checkRecurringManualReconciliationAlert — conta quantas conciliações da empresa foram
 * confirmadas manualmente (via matchReconciliation/matchReconciliationGroup — todo o fluxo
 * atual é manual) nos últimos `FREQUENT_REVERSAL_WINDOW_DAYS` dias. Um volume alto de
 * conciliação manual recorrente é sinal de que o motor de sugestão (reconciliation.service.js)
 * não está encontrando candidatos automáticos — vale investigar qualidade dos dados de origem.
 */
async function checkRecurringManualReconciliationAlert(companyId, transaction) {
  const { Reconciliation } = require('../../models');
  const since = new Date(Date.now() - FREQUENT_REVERSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const count = await Reconciliation.count({
    where: { companyId, matchedAt: { [Op.gte]: since } },
    transaction,
  });
  return {
    count,
    windowDays: FREQUENT_REVERSAL_WINDOW_DAYS,
    flagged: count >= RECURRING_MANUAL_RECONCILIATION_MIN_COUNT,
  };
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
