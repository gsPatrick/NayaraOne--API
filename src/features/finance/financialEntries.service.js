'use strict';

const { FinancialEntry } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { assertBankAccountEligibleForPayment, assertNoDuplicatePayment } = require('./financeAntifraud.service');
const { publishFinancialEntryCreated, publishFinancialEntrySettled, publishFinancialEntryReversed } = require('./financeEvents.service');
const { assertAccountUsableForEntry } = require('./chartOfAccounts.service');
const { assertPeriodOpenForEntry } = require('./periodClosures.service');

// finance.financial_entries É o ledger (não existe uma tabela "finance.ledger" separada — ver
// nota em financeAntifraud.service.js e o relatório de schema real). Regras duras
// (01_ARQUITETURA_E_INVARIANTES.md, FIN-003/FIN-010): "Ledger imutável... correção é sempre
// por estorno/lançamento compensatório" — por isso este service NUNCA dá UPDATE em `amount`
// de um lançamento já SETTLED, e `reverseEntry` cria um novo registro em vez de apagar/alterar
// o original.

const ENTRY_TYPES = ['DEBIT', 'CREDIT'];
const NATURES = ['PAYABLE', 'RECEIVABLE', 'TRANSFER', 'ADJUSTMENT'];
// PARTIALLY_SETTLED (M4-06): lançamento que já recebeu uma ou mais baixas parciais mas ainda
// tem saldo em aberto. Continua "vivo" (aceita novas baixas) até a soma fechar o total.
const STATUSES = ['PENDING', 'PARTIALLY_SETTLED', 'SETTLED', 'REVERSED', 'CANCELLED'];

// M4-03 — COMPETÊNCIA x VENCIMENTO.
// `competenceMonth` ("YYYY-MM") é o mês contábil a que o lançamento pertence e pode ser
// diferente do mês de vencimento (ex.: energia consumida em setembro que vence em outubro).
// REGRA DE DERIVAÇÃO (quando o campo não é informado):
//   1. se houver `dueAt`, usa o ano-mês do vencimento (em UTC);
//   2. senão, usa o ano-mês de "agora" (momento da criação do lançamento = created_at).
// Nunca derivamos de settledAt: competência é definida na origem da obrigação, não na baixa.
const COMPETENCE_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function toCompetenceMonth(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function resolveCompetenceMonth(competenceMonth, dueAt) {
  if (competenceMonth !== undefined && competenceMonth !== null && competenceMonth !== '') {
    const normalized = String(competenceMonth).trim();
    if (!COMPETENCE_MONTH_REGEX.test(normalized)) {
      throw AppError.badRequest(
        'O campo "competenceMonth" deve estar no formato "YYYY-MM" (ex.: "2026-09").',
        'FINANCE_ENTRY_VALIDATION'
      );
    }
    return normalized;
  }
  if (dueAt) return toCompetenceMonth(dueAt);
  return toCompetenceMonth(new Date());
}

function assertPositiveAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw AppError.badRequest('O campo "amount" deve ser um número positivo (moeda em numeric/decimal — FIN-008).', 'FINANCE_ENTRY_VALIDATION');
  }
}

/**
 * assertNotUnderManualReview (M4-21) — fail closed: um lançamento flagado como anômalo pelo
 * antifraude não pode ser liquidado (total nem parcialmente) enquanto um humano não liberar
 * via `clearManualReview` (financeAntifraud.service.js).
 */
function assertNotUnderManualReview(entry) {
  if (entry.requiresManualReview) {
    throw AppError.conflict(
      'Este lançamento está retido para revisão manual (antifraude) e não pode ser liquidado até ser liberado por um revisor.',
      'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW'
    );
  }
}

// FIX AUD-2026-09-14 (reportado pela cliente: sistema aceitou vencimento no ano "92026"):
// nenhuma validação de faixa existia sobre `dueAt` — o campo DATE do Postgres aceita qualquer
// ano dentro do range do tipo, e nada no backend rejeitava um valor absurdo digitado por engano
// (typo de dígito extra) no front. Fail closed: vencimento precisa estar num intervalo humano
// plausível (100 anos atrás a 50 anos à frente), nunca um valor literalmente impossível.
const DUE_DATE_MIN_YEAR = new Date().getUTCFullYear() - 100;
const DUE_DATE_MAX_YEAR = new Date().getUTCFullYear() + 50;

function assertReasonableDueDate(dueAt) {
  if (dueAt === undefined || dueAt === null || dueAt === '') return;
  const parsed = new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest('O campo "dueAt" não é uma data válida.', 'FINANCE_ENTRY_VALIDATION');
  }
  const year = parsed.getUTCFullYear();
  if (year < DUE_DATE_MIN_YEAR || year > DUE_DATE_MAX_YEAR) {
    throw AppError.badRequest(
      `O campo "dueAt" tem um ano fora do intervalo plausível (${DUE_DATE_MIN_YEAR} a ${DUE_DATE_MAX_YEAR}) — verifique se não há um dígito a mais ou a menos na data.`,
      'FINANCE_ENTRY_VALIDATION'
    );
  }
}

/**
 * createFinancialEntry — cria uma obrigação/direito (conta a pagar/receber) em status PENDING.
 * `idempotencyKey`, quando informada, impede duplicidade (ex.: reprocessar o mesmo import não
 * cria dois lançamentos — FIN-004).
 */
async function createFinancialEntry(payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    bankAccountId,
    costCenterId,
    resultCenterId,
    contractId,
    entryType,
    nature,
    amount,
    description,
    dueAt,
    competenceMonth,
    idempotencyKey,
    chartOfAccountId,
    isThirdPartyFunds,
    thirdPartyReference,
  } = payload;

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

  // M4-16 — dinheiro de terceiro (caução, depósito de garantia, valores que só transitam pela
  // imobiliária) só pode ser marcado como tal se vier com a referência de a QUEM pertence.
  // Sem isso, a marcação seria uma flag solta: dá pra tirar o valor da receita própria, mas não
  // dá pra prestar contas de quem é o dinheiro — que é justamente a razão de segregar.
  const normalizedThirdParty = isThirdPartyFunds === true || isThirdPartyFunds === 'true';
  const normalizedThirdPartyReference =
    thirdPartyReference === undefined || thirdPartyReference === null ? null : String(thirdPartyReference).trim();
  if (normalizedThirdParty && !normalizedThirdPartyReference) {
    throw AppError.badRequest(
      'Lançamento marcado como dinheiro de terceiro exige "thirdPartyReference" não vazio (ex.: "Caução contrato X") — é o que identifica de quem é o dinheiro.',
      'FINANCE_THIRD_PARTY_REFERENCE_REQUIRED'
    );
  }

  await assertAccountUsableForEntry(chartOfAccountId, companyId, transaction);

  // M4-19 — período fechado bloqueia lançamento novo naquele mês (competência do vencimento e
  // da própria criação).
  await assertPeriodOpenForEntry(companyId, [dueAt, new Date()], transaction);

  await assertNoDuplicatePayment(FinancialEntry, idempotencyKey, transaction);

  const entry = await FinancialEntry.create(
    {
      groupId,
      companyId,
      bankAccountId: bankAccountId || null,
      costCenterId: costCenterId || null,
      resultCenterId: resultCenterId || null,
      contractId: contractId || null,
      entryType: normalizedType,
      nature: normalizedNature,
      amount,
      description: description || null,
      dueAt: dueAt || null,
      competenceMonth: resolvedCompetenceMonth,
      settledAt: null,
      status: 'PENDING',
      idempotencyKey: idempotencyKey || null,
      reversalOfEntryId: null,
      chartOfAccountId: chartOfAccountId || null,
      isThirdPartyFunds: normalizedThirdParty,
      thirdPartyReference: normalizedThirdPartyReference,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

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
      reason: `Lançamento ${normalizedNature === 'PAYABLE' ? 'a pagar' : normalizedNature === 'RECEIVABLE' ? 'a receber' : normalizedNature.toLowerCase()} de ${amount} criado.`,
    },
    transaction
  );

  return entry;
}

/**
 * listFinancialEntries — filtros disponíveis: status, nature, bankAccountId, costCenterId,
 * chartOfAccountId (M4-01) e isThirdPartyFunds (M4-16).
 *
 * `isThirdPartyFunds` é um filtro de três estados de propósito: `true` devolve SÓ dinheiro de
 * terceiro, `false` devolve SÓ receita/despesa própria, e omitir devolve tudo. É isso que
 * permite somar "receita própria" sem nunca incluir caução — sem precisar que o chamador
 * lembre de filtrar em memória.
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
  return FinancialEntry.findAll({ where, order: [['due_at', 'ASC']], transaction });
}

async function getFinancialEntry(id, transaction) {
  const entry = await FinancialEntry.findByPk(id, { transaction });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  return entry;
}

/**
 * updateFinancialEntry — só permite editar campos "de agenda" (vencimento, centro de custo/
 * resultado, conta bancária) enquanto o lançamento estiver PENDING. Uma vez SETTLED/REVERSED,
 * o registro é histórico — qualquer correção de valor precisa passar por `reverseEntry`.
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

  // M4-19 — não se edita lançamento cuja competência (vencimento atual, vencimento novo ou
  // criação) caia num mês já fechado.
  await assertPeriodOpenForEntry(
    entry.companyId,
    [entry.dueAt, dueAt !== undefined ? dueAt : null, entry.createdAt],
    transaction
  );

  if (chartOfAccountId !== undefined) {
    if (chartOfAccountId === null) {
      entry.chartOfAccountId = null;
    } else {
      await assertAccountUsableForEntry(chartOfAccountId, entry.companyId, transaction);
      entry.chartOfAccountId = chartOfAccountId;
    }
  }
  if (competenceMonth !== undefined) {
    entry.competenceMonth = resolveCompetenceMonth(competenceMonth, dueAt !== undefined ? dueAt : entry.dueAt);
  }
  if (bankAccountId !== undefined) entry.bankAccountId = bankAccountId;
  if (costCenterId !== undefined) entry.costCenterId = costCenterId;
  if (resultCenterId !== undefined) entry.resultCenterId = resultCenterId;
  if (dueAt !== undefined) entry.dueAt = dueAt;
  if (description !== undefined) entry.description = description;
  entry.updatedBy = actorUserId || null;
  await entry.save({ transaction });

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
 * settleFinancialEntry — baixa/liquida o lançamento (marca como pago/recebido). Se houver
 * `bankAccountId`, valida elegibilidade antifraude (cooldown/bloqueio) antes de liquidar.
 */
async function settleFinancialEntry(id, actorUserId, transaction) {
  const entry = await getFinancialEntry(id, transaction);
  if (entry.status === 'PARTIALLY_SETTLED') {
    throw AppError.conflict(
      'Este lançamento já tem baixas parciais — use a liquidação parcial do saldo restante (settleFinancialEntryPartial) para fechá-lo.',
      'FINANCE_ENTRY_INVALID_STATUS'
    );
  }
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(`Só é possível liquidar um lançamento PENDING (atual: "${entry.status}").`, 'FINANCE_ENTRY_INVALID_STATUS');
  }
  assertNotUnderManualReview(entry);
  const beforeJson = entry.toJSON();

  if (entry.bankAccountId) {
    await assertBankAccountEligibleForPayment(entry.bankAccountId, transaction);
  }

  entry.status = 'SETTLED';
  entry.settledAt = new Date();
  entry.updatedBy = actorUserId || null;
  await entry.save({ transaction });

  await publishFinancialEntrySettled(entry, transaction);

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settle',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: `Lançamento de ${entry.amount} liquidado.`,
    },
    transaction
  );

  return entry;
}

// --- M4-06: liquidação PARCIAL (recebimento/pagamento parcial no LEDGER) -------------------
//
// MODELAGEM (decisão documentada): o ledger é append-only e imutável — o `amount` do
// lançamento original NUNCA é alterado por uma baixa parcial. Cada baixa vira um NOVO
// lançamento SETTLED (mesmo entryType/nature/conta do pai) com o valor parcial, ligado ao
// original por `parentEntryId`. O ORIGINAL só muda de STATUS:
//   PENDING -> PARTIALLY_SETTLED (ainda há saldo) -> SETTLED (soma das baixas = amount).
// O saldo restante é CALCULADO (`computeRemainingAmount`), nunca armazenado — assim não existe
// a possibilidade de um "saldo materializado" divergir do que o ledger realmente diz.
//
// Toda a aritmética é feita em CENTAVOS inteiros: DECIMAL(18,2) em ponto flutuante daria
// erro de arredondamento (0.1 + 0.2 !== 0.3) e a exigência aqui é precisão até o centavo.

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

/**
 * computeRemainingAmount — saldo em aberto do lançamento = amount - Σ(baixas parciais filhas
 * que estão SETTLED). Retorna string com 2 casas (mesma precisão do DECIMAL(18,2)).
 */
async function computeRemainingAmount(entryOrId, transaction) {
  const entry = typeof entryOrId === 'string' ? await getFinancialEntry(entryOrId, transaction) : entryOrId;
  const children = await FinancialEntry.findAll({
    where: { parentEntryId: entry.id, status: 'SETTLED' },
    transaction,
  });
  const settledCents = children.reduce((acc, child) => acc + toCents(child.amount), 0);
  return fromCents(toCents(entry.amount) - settledCents);
}

/**
 * settleFinancialEntryPartial — baixa parcial de `partialAmount` sobre o lançamento `id`.
 * Valida 0 < partialAmount <= saldo restante (tolerância zero, em centavos).
 */
async function settleFinancialEntryPartial(id, partialAmount, actorUserId, transaction) {
  // Lock pessimista no pai: sem ele, duas baixas parciais concorrentes poderiam ler o mesmo
  // saldo restante e, somadas, ultrapassar o total do lançamento.
  const entry = await FinancialEntry.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');

  if (!['PENDING', 'PARTIALLY_SETTLED'].includes(entry.status)) {
    throw AppError.conflict(
      `Só é possível liquidar parcialmente um lançamento PENDING ou PARTIALLY_SETTLED (atual: "${entry.status}").`,
      'FINANCE_ENTRY_INVALID_STATUS'
    );
  }
  assertNotUnderManualReview(entry);
  assertPositiveAmount(partialAmount);

  const partialCents = toCents(partialAmount);
  const remainingCents = toCents(await computeRemainingAmount(entry, transaction));
  if (partialCents > remainingCents) {
    throw AppError.badRequest(
      `Valor da baixa parcial (${fromCents(partialCents)}) é maior que o saldo restante do lançamento (${fromCents(remainingCents)}).`,
      'FINANCE_ENTRY_PARTIAL_EXCEEDS_REMAINING'
    );
  }

  if (entry.bankAccountId) {
    await assertBankAccountEligibleForPayment(entry.bankAccountId, transaction);
  }

  const beforeJson = entry.toJSON();

  const settlement = await FinancialEntry.create(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      bankAccountId: entry.bankAccountId,
      costCenterId: entry.costCenterId,
      resultCenterId: entry.resultCenterId,
      contractId: entry.contractId,
      entryType: entry.entryType,
      nature: entry.nature,
      amount: fromCents(partialCents),
      description: `Baixa parcial de ${fromCents(partialCents)} do lançamento ${entry.id}.`,
      dueAt: entry.dueAt,
      // A baixa parcial pertence à MESMA competência do lançamento original (a obrigação é a
      // mesma; o que mudou foi só o momento do caixa).
      competenceMonth: entry.competenceMonth,
      settledAt: new Date(),
      status: 'SETTLED',
      idempotencyKey: null,
      reversalOfEntryId: null,
      parentEntryId: entry.id,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  const newRemainingCents = remainingCents - partialCents;
  entry.status = newRemainingCents === 0 ? 'SETTLED' : 'PARTIALLY_SETTLED';
  if (newRemainingCents === 0) entry.settledAt = new Date();
  entry.updatedBy = actorUserId || null;
  await entry.save({ transaction });

  await publishFinancialEntrySettled(settlement, transaction);

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settle_partial',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: {
        original: entry.toJSON(),
        settlementEntryId: settlement.id,
        partialAmount: fromCents(partialCents),
        remainingAmount: fromCents(newRemainingCents),
      },
      reason:
        `Baixa parcial de ${fromCents(partialCents)} registrada no lançamento de ${entry.amount} ` +
        `(saldo restante ${fromCents(newRemainingCents)}).`,
    },
    transaction
  );

  return { original: entry, settlement, remainingAmount: fromCents(newRemainingCents) };
}

/**
 * reverseEntry — ESTORNO. Nunca apaga nem edita o valor do lançamento original (FIN-010):
 * marca o original como REVERSED e cria um novo lançamento compensatório (`entryType`
 * invertido, mesmo `amount`) apontando de volta via `reversalOfEntryId`.
 */
async function reverseFinancialEntry(id, reasonText, actorUserId, transaction) {
  const original = await getFinancialEntry(id, transaction);
  if (original.status === 'REVERSED') {
    throw AppError.conflict('Este lançamento já foi estornado.', 'FINANCE_ENTRY_ALREADY_REVERSED');
  }
  if (original.status === 'CANCELLED') {
    throw AppError.conflict('Lançamento cancelado não pode ser estornado.', 'FINANCE_ENTRY_INVALID_STATUS');
  }
  const beforeJson = original.toJSON();

  const compensatingType = original.entryType === 'DEBIT' ? 'CREDIT' : 'DEBIT';
  const reversal = await FinancialEntry.create(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      bankAccountId: original.bankAccountId,
      costCenterId: original.costCenterId,
      resultCenterId: original.resultCenterId,
      contractId: original.contractId,
      entryType: compensatingType,
      nature: 'ADJUSTMENT',
      amount: original.amount,
      dueAt: null,
      // O estorno pertence à mesma competência do lançamento estornado.
      competenceMonth: original.competenceMonth,
      settledAt: new Date(),
      status: 'SETTLED',
      idempotencyKey: null,
      reversalOfEntryId: original.id,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  original.status = 'REVERSED';
  original.updatedBy = actorUserId || null;
  await original.save({ transaction });

  await publishFinancialEntryReversed(original, reversal, transaction);

  await registrarAuditoria(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      actorUserId,
      action: 'finance.entry.reverse',
      entityType: 'FinancialEntry',
      entityId: original.id,
      beforeJson,
      afterJson: { original: original.toJSON(), reversalEntryId: reversal.id },
      reason: reasonText ? `Lançamento estornado: ${reasonText}` : 'Lançamento estornado.',
    },
    transaction
  );

  return { original, reversal };
}

module.exports = {
  createFinancialEntry,
  listFinancialEntries,
  getFinancialEntry,
  updateFinancialEntry,
  settleFinancialEntry,
  settleFinancialEntryPartial,
  computeRemainingAmount,
  resolveCompetenceMonth,
  reverseFinancialEntry,
  ENTRY_TYPES,
  NATURES,
  STATUSES,
};
