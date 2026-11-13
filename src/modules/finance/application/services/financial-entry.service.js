'use strict';

/**
 * Lançamento financeiro (Guia M4 §2 financial-entry.service): criar, editar, listar, consultar e cancelar um
 * lançamento ainda não liquidado. A baixa, a baixa parcial e o estorno estão em receipt.service.js; o
 * comprovante da baixa manual em settlement-evidence.service.js; as pendências de classificação em
 * classification-pending.service.js; o dinheiro de terceiro em third-party-funds.service.js. A regra pura está
 * em domain/financial-entry.js e o acesso a dados em infrastructure/repositories/financial-entry.repository.js.
 */
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const ledger = require('../../infrastructure/repositories/ledger-movement.repository');
const intents = require('../../infrastructure/repositories/payment-intent.repository');
const { ENTRY_TYPES, NATURES, STATUSES, isPositiveAmount, isDueYearPlausible, DUE_DATE_MIN_YEAR, DUE_DATE_MAX_YEAR } = require('../../domain/financial-entry');
const { IN_FLIGHT_STATUSES } = require('../../domain/payment-intent');
const { toBRLDisplay } = require('../../domain/ledger-movement');
const { assertNoDuplicatePayment } = require('./finance-antifraud.service');
const { createAnomalyCase } = require('./anomaly-cases.service');
const { publishFinancialEntryCreated } = require('./finance-events.service');
const { resolveAccountVersionForEntry } = require('./chart-of-accounts.service');
const { markApprovalRequestsStale } = require('./approvals.service');
const { getBankAccount } = require('./bank-accounts.service');
const { assertCentersOfCompany } = require('./entry-reference-guards'); // FIN-002: centros só da própria empresa (pentest M4 PT4-0839)
const { evaluatePayableAnomaly } = require('./payment-anomaly-gate'); // §17 valor fora do padrão / fornecedor novo de alto valor
const { assertCompetenceOpen, assertPeriodOpenForEntry, resolveCompetenceMonth } = require('./competence-guard');
const { resolveThirdPartyLinks } = require('./third-party-funds.service');
const { invalidateStaleOpenPaymentIntents } = require('./payment-intent-invalidation');

function assertPositiveAmount(amount) {
  if (!isPositiveAmount(amount)) {
    // FIN-008: decimal simples de pelo menos R$ 0,01 ("1e-3" e 0.004 virariam 0,00 no banco).
    throw AppError.badRequest('Informe um valor maior que zero.', 'FINANCE_ENTRY_VALIDATION');
  }
}

// FIX AUD-2026-09-14 (reportado pela cliente: sistema aceitou vencimento no ano "92026"): nenhuma
// validação de faixa existia sobre `dueAt`. Fail closed: vencimento precisa estar num intervalo
// humano plausível (domain/financial-entry.js).
function assertReasonableDueDate(dueAt) {
  if (dueAt === undefined || dueAt === null || dueAt === '') return;
  const parsed = new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest('O vencimento informado não é uma data válida.', 'FINANCE_ENTRY_VALIDATION');
  }
  if (!isDueYearPlausible(parsed.getUTCFullYear())) {
    throw AppError.badRequest(
      `O campo "dueAt" tem um ano fora do intervalo plausível (${DUE_DATE_MIN_YEAR} a ${DUE_DATE_MAX_YEAR}) — verifique se não há um dígito a mais ou a menos na data.`,
      'FINANCE_ENTRY_VALIDATION'
    );
  }
}

// FIX FIN-TS-004 (Caderno §20: "Empresa errada — conta BB Construção em despesa Locação — Bloqueado"): a
// conta bancária de um lançamento é sempre da mesma empresa (FIN-002). A RLS de SELECT já esconde conta de
// outra empresa (getBankAccount devolve FINANCE_BANK_ACCOUNT_NOT_FOUND); o teste explícito é defesa em
// profundidade — erro de negócio claro, nunca mais um 500 cru da RLS no INSERT.
async function assertBankAccountOfCompany(bankAccountId, companyId, transaction) {
  const bankAccount = await getBankAccount(bankAccountId, transaction);
  if (bankAccount.companyId !== companyId) {
    throw AppError.badRequest(
      'A conta bancária informada pertence a outra empresa — um lançamento só pode usar uma conta bancária da mesma empresa (FIN-002, contas segregadas).',
      'FINANCE_ENTRY_BANK_ACCOUNT_COMPANY_MISMATCH'
    );
  }
}

/**
 * createFinancialEntry — cria uma obrigação/direito (conta a pagar/receber) em status PENDING.
 * `idempotencyKey`, quando informada, impede duplicidade (ex.: reprocessar o mesmo import não
 * cria dois lançamentos — FIN-004).
 */
async function createFinancialEntry(payload, actorUserId, transaction, options = {}) {
  const { groupId, companyId, bankAccountId, costCenterId, resultCenterId, constructionProjectId, originRef } = payload;
  const { entryType, nature, amount, description, dueAt, competenceMonth, idempotencyKey, chartOfAccountId, sourceEventId } = payload;

  if (!groupId || !companyId || !entryType || !nature || amount === undefined || amount === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "entryType", "nature" e "amount" são obrigatórios.',
      'FINANCE_ENTRY_VALIDATION'
    );
  }
  const normalizedType = String(entryType).toUpperCase();
  const normalizedNature = String(nature).toUpperCase();
  if (!ENTRY_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`O campo "entryType" deve ser um de: ${ENTRY_TYPES.join(', ')}.`, 'FINANCE_ENTRY_VALIDATION');
  }
  if (!NATURES.includes(normalizedNature)) {
    throw AppError.badRequest(`O campo "nature" deve ser um de: ${NATURES.join(', ')}.`, 'FINANCE_ENTRY_VALIDATION');
  }
  assertPositiveAmount(amount);
  assertReasonableDueDate(dueAt);
  const resolvedCompetenceMonth = resolveCompetenceMonth(competenceMonth, dueAt);

  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; Centro Financeiro BLINDADO v1, §4 "Plano de
  // contas e dimensões"): "Centro de custo obrigatório para despesa. Centro de resultado obrigatório para
  // receita e análise de margem." TRANSFER/ADJUSTMENT/PENDING_CLASSIFICATION não são despesa nem receita própria.
  if (normalizedNature === 'PAYABLE' && !costCenterId) {
    throw AppError.badRequest('Lançamento de despesa exige o centro de custo.', 'FINANCE_ENTRY_COST_CENTER_REQUIRED');
  }
  if (normalizedNature === 'RECEIVABLE' && !resultCenterId) {
    throw AppError.badRequest('Lançamento de receita exige o centro de resultado.', 'FINANCE_ENTRY_RESULT_CENTER_REQUIRED');
  }

  // M4-16 / F04 / D2 / D3 — dinheiro de terceiro: referência, origem, contrato, titular e dívida compensada.
  const links = await resolveThirdPartyLinks(payload, normalizedNature, options, transaction);
  const { thirdPartyRelease, resolvedReleaseType, compensatedDebt } = links;

  // §4 (Frente 3): a classificação gravada é a VERSÃO da conta vigente na data do fato
  // (`factDate` informado, senão o vencimento, senão agora) — não a conta "como está hoje".
  const chartVersion = await resolveAccountVersionForEntry(chartOfAccountId, companyId, payload.factDate || dueAt || new Date(), transaction);

  if (bankAccountId) await assertBankAccountOfCompany(bankAccountId, companyId, transaction);
  await assertCentersOfCompany({ costCenterId, resultCenterId }, companyId, transaction);
  if (constructionProjectId) await entries.assertConstructionProjectInCompany(constructionProjectId, companyId, transaction); // M6 verificação: FK ignora RLS

  // M4-19 — período fechado bloqueia lançamento novo naquele mês (competência do vencimento e
  // da própria criação). C1 (revisão independente): a COMPETÊNCIA informada também é conferida.
  await assertPeriodOpenForEntry(companyId, [dueAt, new Date()], transaction);
  await assertCompetenceOpen(companyId, resolvedCompetenceMonth, transaction);

  await assertNoDuplicatePayment(entries.model, idempotencyKey, transaction);

  const entry = await entries.create(
    {
      groupId,
      companyId,
      bankAccountId: bankAccountId || null,
      costCenterId: costCenterId || null,
      resultCenterId: resultCenterId || null,
      contractId: links.resolvedContractId,
      // M6-97 — dimensão de origem Obras: só preenchida quando o lançamento nasce de uma
      // medição/obra (ver stageMeasurements.service.js), permite relatório de margem por obra.
      constructionProjectId: constructionProjectId || null,
      // M9-D432: referência de origem (`campaign:{id}`) lida pelo Marketing para o custo real da campanha.
      originRef: originRef ? String(originRef).trim().slice(0, 120) : null,
      entryType: normalizedType,
      nature: normalizedNature,
      amount,
      description: description || null,
      dueAt: dueAt || null,
      competenceMonth: resolvedCompetenceMonth,
      settledAt: null,
      status: 'PENDING',
      idempotencyKey: idempotencyKey || null,
      sourceEventId: sourceEventId || null, // Caderno Obras §7: evento do outbox de origem (único)
      reversalOfEntryId: null,
      chartOfAccountId: chartOfAccountId || null,
      chartOfAccountVersionId: chartVersion ? chartVersion.id : null,
      isThirdPartyFunds: links.normalizedThirdParty,
      thirdPartyReference: links.normalizedThirdPartyReference,
      thirdPartyOriginEntryId: thirdPartyRelease ? thirdPartyRelease.origin.id : null,
      thirdPartyHolderPersonId: links.resolvedHolderPersonId,
      thirdPartyReleaseType: resolvedReleaseType,
      thirdPartyCompensatedEntryId: compensatedDebt ? compensatedDebt.id : null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    transaction
  );

  await evaluatePayableAnomaly(entry, transaction, 'create'); // D3: o evento de terceiros sai na liquidação, não aqui
  await publishFinancialEntryCreated(entry, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.entry.create',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      afterJson: entry.toJSON(),
      reason: thirdPartyRelease
        ? `${resolvedReleaseType === 'COMPENSATION' ? `Compensação (abate da dívida ${compensatedDebt.id})` : 'Devolução'} de dinheiro de terceiro de ${amount} vinculada ao recebimento ${thirdPartyRelease.origin.id} (contrato ${thirdPartyRelease.contractId}, titular ${thirdPartyRelease.holderPersonId}).`
        : `Lançamento ${normalizedNature === 'PAYABLE' ? 'a pagar' : normalizedNature === 'RECEIVABLE' ? 'a receber' : normalizedNature.toLowerCase()} de ${amount} criado.`,
    },
    transaction
  );

  return entry;
}

/**
 * listFinancialEntries — filtros disponíveis: status, nature, bankAccountId, costCenterId,
 * chartOfAccountId (M4-01), isThirdPartyFunds (M4-16) e competenceMonth.
 *
 * `isThirdPartyFunds` é um filtro de três estados de propósito: `true` devolve SÓ dinheiro de
 * terceiro, `false` devolve SÓ receita/despesa própria, e omitir devolve tudo.
 */
async function listFinancialEntries(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.nature) where.nature = String(filters.nature).toUpperCase();
  if (filters.bankAccountId) where.bankAccountId = filters.bankAccountId;
  if (filters.costCenterId) where.costCenterId = filters.costCenterId;
  if (filters.chartOfAccountId) where.chartOfAccountId = filters.chartOfAccountId;
  if (filters.isThirdPartyFunds !== undefined && filters.isThirdPartyFunds !== null && filters.isThirdPartyFunds !== '') {
    where.isThirdPartyFunds = filters.isThirdPartyFunds === true || filters.isThirdPartyFunds === 'true';
  }
  if (filters.competenceMonth) where.competenceMonth = String(filters.competenceMonth).trim();
  return entries.list(where, transaction);
}

async function getFinancialEntry(id, transaction) {
  const entry = await entries.findById(id, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  return entry;
}

/**
 * updateFinancialEntry — só permite editar campos "de agenda" (vencimento, centro de custo/
 * resultado, conta bancária) enquanto o lançamento estiver PENDING. Uma vez SETTLED/REVERSED,
 * o registro é histórico — qualquer correção de valor precisa passar por estorno.
 */
async function updateFinancialEntry(id, payload, actorUserId, transaction) {
  const entry = await getFinancialEntry(id, transaction);
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(
      `Lançamento com status "${entry.status}" não pode mais ser editado — ledger imutável (FIN-003). Use estorno.`,
      'FINANCE_ENTRY_IMMUTABLE'
    );
  }
  const beforeJson = entry.toJSON();
  const { bankAccountId, costCenterId, resultCenterId, dueAt, description, chartOfAccountId, competenceMonth } = payload;
  if (dueAt !== undefined) assertReasonableDueDate(dueAt);

  // A1 (revisão independente, provado): a conta de um pagamento pode ser trocada
  // (redirecionamento, com revisão manual), nunca removida.
  if (entry.nature === 'PAYABLE' && entry.bankAccountId && bankAccountId === null) {
    throw AppError.conflict(
      'A conta bancária de um pagamento não pode ser removida — troque por outra conta (com revisão) ou cancele o lançamento.',
      'FINANCE_ENTRY_BANK_ACCOUNT_REMOVAL_FORBIDDEN'
    );
  }

  // M4-19 / C1 — não se edita lançamento cuja competência (vencimento atual, vencimento novo ou
  // criação) caia num mês já fechado, nem se move um lançamento PARA ou DE um mês fechado.
  const nextCompetenceMonth =
    competenceMonth !== undefined ? resolveCompetenceMonth(competenceMonth, dueAt !== undefined ? dueAt : entry.dueAt) : null;
  await assertPeriodOpenForEntry(
    entry.companyId,
    [entry.dueAt, dueAt !== undefined ? dueAt : null, entry.createdAt, entry.competenceMonth],
    transaction
  );
  if (nextCompetenceMonth && nextCompetenceMonth !== entry.competenceMonth) {
    await assertCompetenceOpen(entry.companyId, [entry.competenceMonth, nextCompetenceMonth], transaction);
  }

  if (chartOfAccountId !== undefined) {
    if (chartOfAccountId === null) {
      entry.chartOfAccountId = null;
      entry.chartOfAccountVersionId = null;
    } else {
      const chartVersion = await resolveAccountVersionForEntry(
        chartOfAccountId, entry.companyId, payload.factDate || payload.dueAt || entry.dueAt || entry.createdAt, transaction
      );
      entry.chartOfAccountId = chartOfAccountId;
      entry.chartOfAccountVersionId = chartVersion.id;
    }
  }
  if (competenceMonth !== undefined) {
    entry.competenceMonth = nextCompetenceMonth;
  }
  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07): trocar o beneficiário (bankAccountId) de um
  // PENDING não passava por nenhuma checagem extra. Troca de conta é o padrão de fraude que o módulo defende:
  // precisa de revisão humana antes de poder ser liquidado (e nunca para conta de outra empresa, FIN-TS-004).
  if (bankAccountId) await assertBankAccountOfCompany(bankAccountId, entry.companyId, transaction);
  await assertCentersOfCompany({ costCenterId, resultCenterId }, entry.companyId, transaction);

  if (bankAccountId !== undefined && bankAccountId !== entry.bankAccountId) {
    const inFlight = await intents.countForEntry(entry.id, IN_FLIGHT_STATUSES, transaction);
    if (inFlight > 0) {
      throw AppError.conflict(
        'Há um pagamento em andamento no banco para este lançamento — não é possível trocar a conta do favorecido até o banco responder.',
        'FINANCE_ENTRY_HAS_OPEN_PAYMENT_INTENT'
      );
    }
  }

  const isBankAccountRedirect = bankAccountId !== undefined && entry.bankAccountId && bankAccountId && bankAccountId !== entry.bankAccountId;
  if (bankAccountId !== undefined) entry.bankAccountId = bankAccountId;
  if (costCenterId !== undefined) entry.costCenterId = costCenterId;
  if (resultCenterId !== undefined) entry.resultCenterId = resultCenterId;
  if (dueAt !== undefined) entry.dueAt = dueAt;
  if (description !== undefined) entry.description = description;
  entry.updatedBy = actorUserId || null;
  if (isBankAccountRedirect) {
    entry.requiresManualReview = true;
    entry.manualReviewReason = `Beneficiário alterado após a criação do lançamento (conta bancária redirecionada) — revisão manual obrigatória antes de liquidar.`;
    entry.manualReviewClearedAt = null;
    entry.manualReviewClearedBy = null;
  }
  await entries.save(entry, transaction);

  // F-05 (conferência ao vivo 20/10/2026, Caderno §9 e §17): a edição invalida a intenção que ainda não foi
  // ao banco e a troca de conta abre um caso de revisão (alerta) além da marca de revisão manual.
  await invalidateStaleOpenPaymentIntents(entry, actorUserId, transaction);
  if (bankAccountId && !isBankAccountRedirect) await evaluatePayableAnomaly(entry, transaction, 'update');
  if (isBankAccountRedirect) {
    await createAnomalyCase(
      {
        groupId: entry.groupId,
        companyId: entry.companyId,
        caseType: 'BENEFICIARY_CHANGED',
        riskLevel: 'HIGH',
        relatedEntityType: 'FinancialEntry',
        relatedEntityId: entry.id,
        reason: 'A conta bancária do favorecido foi trocada depois da criação do lançamento. As aprovações anteriores foram invalidadas e o pagamento exige revisão manual antes de ser liquidado.',
      },
      actorUserId,
      transaction
    );
  }

  // A10 (18/10/2026): edição depois da aprovação invalida a aprovação (FIN-005): APPROVED vira STALE.
  await markApprovalRequestsStale(
    'FinancialEntry',
    entry.id,
    'Lançamento editado após a aprovação — decisão anterior invalidada (FIN-005, versão revisada obsoleta).',
    actorUserId,
    transaction
  );

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.update',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: 'Lançamento financeiro atualizado (agenda).',
    },
    transaction
  );

  return entry;
}

/**
 * cancelPendingFinancialEntry — cancela um lançamento que NUNCA foi liquidado (PENDING). Não há
 * movimento de caixa a desfazer, então não se cria lançamento compensatório (ao contrário do
 * estorno de um lançamento liquidado): o original só passa a CANCELLED, com motivo e auditoria.
 */
async function cancelPendingFinancialEntry(id, reasonText, actorUserId, transaction, options = {}) {
  const entry = await entries.findByIdForUpdate(id, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  const statusOk = entry.status === 'PENDING' || (options.allowPartiallySettled && entry.status === 'PARTIALLY_SETTLED');
  if (!statusOk) {
    throw AppError.conflict(`Só um lançamento PENDING (nunca liquidado) pode ser cancelado (atual: "${entry.status}").`, 'FINANCE_ENTRY_INVALID_STATUS');
  }
  if (!reasonText || !String(reasonText).trim()) {
    throw AppError.badRequest('Cancelar um lançamento exige um motivo documentado.', 'FINANCE_ENTRY_CANCEL_REASON_REQUIRED');
  }
  if (entry.status === 'PARTIALLY_SETTLED' && !options.balanceWrittenOff) {
    // Só se cancela o saldo depois de estornar as baixas parciais (nada liquidado pode ficar de pé).
    const standing = await ledger.countSettledChildren(entry.id, transaction);
    if (standing > 0) {
      throw AppError.conflict('Estorne as baixas parciais antes de cancelar o saldo deste lançamento.', 'FINANCE_ENTRY_INVALID_STATUS');
    }
  }
  // Cancelar muda o resultado do mês: período fechado ou em revisão não aceita (exceto baixa de diferença de
  // recebimento, que é consequência de um fato externo já ocorrido).
  if (!options.skipPeriodGuard) {
    await assertPeriodOpenForEntry(entry.companyId, [entry.competenceMonth], transaction);
    await assertCompetenceOpen(entry.companyId, entry.competenceMonth, transaction);
  }
  const beforeJson = entry.toJSON();
  entry.status = 'CANCELLED';
  entry.updatedBy = actorUserId || null;
  await entries.save(entry, transaction);
  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.cancel_pending',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: `Lançamento pendente de ${toBRLDisplay(entry.amount)} cancelado (nunca liquidado, sem movimento de caixa): ${String(reasonText).trim()}.`,
    },
    transaction
  );
  return entry;
}

module.exports = {
  createFinancialEntry,
  listFinancialEntries,
  getFinancialEntry,
  updateFinancialEntry,
  cancelPendingFinancialEntry,
  resolveCompetenceMonth,
  ENTRY_TYPES,
  NATURES,
  STATUSES,
};
