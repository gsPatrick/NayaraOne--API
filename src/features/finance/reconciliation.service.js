'use strict';

const { randomUUID } = require('node:crypto');
const { Op } = require('sequelize');

const { Reconciliation, FinancialEntry, BankTransaction } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishReconciliationMatched } = require('./financeEvents.service');

// Motor de conciliação — casa um finance.financial_entries (lançamento) com um
// finance.bank_transactions (linha real de extrato). Regras duras:
//   - valores devem bater (mesmo módulo, tolerância zero — nenhuma "reconciliação aproximada"
//     está prevista no schema/documento);
//   - nem o lançamento nem a transação podem já estar conciliados com outra coisa (1:1).

async function assertNotAlreadyReconciled(financialEntryId, bankTransactionId, transaction) {
  const existingForEntry = await Reconciliation.findOne({ where: { financialEntryId }, transaction });
  if (existingForEntry) {
    throw AppError.conflict('Este lançamento financeiro já está conciliado com outra transação.', 'FINANCE_RECONCILIATION_ENTRY_ALREADY_MATCHED');
  }
  const existingForTransaction = await Reconciliation.findOne({ where: { bankTransactionId }, transaction });
  if (existingForTransaction) {
    throw AppError.conflict('Esta transação de extrato já está conciliada com outro lançamento.', 'FINANCE_RECONCILIATION_TRANSACTION_ALREADY_MATCHED');
  }
}

async function matchReconciliation(payload, actorUserId, transaction) {
  const { groupId, companyId, financialEntryId, bankTransactionId } = payload;
  if (!groupId || !companyId || !financialEntryId || !bankTransactionId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "financialEntryId" e "bankTransactionId" são obrigatórios.',
      'FINANCE_RECONCILIATION_VALIDATION'
    );
  }

  // FIX (homologação 23/09/2026 — auditoria adversarial, corrida real de verdade validada):
  // não existe (e não dá pra existir sem redesenhar o schema — ver comentário em
  // matchReconciliationGroup sobre por que um financial_entry_id/bank_transaction_id pode
  // legitimamente se repetir em mais de uma linha dentro do MESMO grupo N:M) uma constraint
  // única simples que trave "entry/transaction só pode ser conciliado uma vez" no banco. Sem
  // isso, duas chamadas concorrentes de matchReconciliation para o MESMO entry/transaction
  // liam "ainda não conciliado" ao mesmo tempo (SELECT-then-INSERT clássico) e as duas
  // passavam. `FOR UPDATE` na leitura do entry/transaction serializa: a segunda transação
  // BLOQUEIA até a primeira commitar, e só então reavalia assertNotAlreadyReconciled — que
  // nesse ponto já enxerga a Reconciliation da primeira e barra corretamente.
  const entry = await FinancialEntry.findByPk(financialEntryId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  const bankTransaction = await BankTransaction.findByPk(bankTransactionId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!bankTransaction) throw AppError.notFound('Transação bancária não encontrada.', 'FINANCE_BANK_TRANSACTION_NOT_FOUND');

  if (Number(entry.amount) !== Math.abs(Number(bankTransaction.amount))) {
    throw AppError.conflict(
      `Valores não batem: lançamento ${entry.amount} vs. transação ${bankTransaction.amount}. Conciliação bloqueada.`,
      'FINANCE_RECONCILIATION_AMOUNT_MISMATCH'
    );
  }

  await assertNotAlreadyReconciled(financialEntryId, bankTransactionId, transaction);

  const reconciliation = await Reconciliation.create(
    {
      groupId,
      companyId,
      financialEntryId,
      bankTransactionId,
      matchedAt: new Date(),
      matchedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishReconciliationMatched(reconciliation, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.reconciliation.match',
      entityType: 'Reconciliation',
      entityId: reconciliation.id,
      afterJson: reconciliation.toJSON(),
      reason: `Lançamento financeiro conciliado com transação de extrato (valor ${entry.amount}).`,
    },
    transaction
  );

  return reconciliation;
}

// --- M4-13: conciliação N:N -----------------------------------------------------------------
//
// MODELAGEM (decisão documentada): não criamos tabela nova. Reaproveitamos `reconciliations`
// (1 linha = 1 par lançamento↔transação, com as FKs NOT NULL que já existem) e amarramos todas
// as linhas de um mesmo casamento por um `match_group_id` compartilhado (migration 000159).
// As linhas geradas formam uma ESTRELA, não o produto cartesiano: cada lançamento é ligado à
// PRIMEIRA transação, e cada transação extra é ligada ao PRIMEIRO lançamento. São
// N + M - 1 linhas, toda entidade do grupo aparece pelo menos uma vez (o que mantém
// `assertNotAlreadyReconciled` funcionando sem nenhuma adaptação de leitura) e não se inventa
// um vínculo par-a-par que financeiramente não existe — o vínculo real é o GRUPO.
//
// Tolerância ZERO no valor, igual ao 1:1: Σ(lançamentos) precisa bater exatamente com
// Σ(|transações|). A soma é feita em CENTAVOS inteiros — somar DECIMAL como float
// introduziria erro de arredondamento justamente onde a regra é "bater no centavo".

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function uniqueList(ids, label) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (list.length === 0) {
    throw AppError.badRequest(`O campo "${label}" deve conter pelo menos um id.`, 'FINANCE_RECONCILIATION_VALIDATION');
  }
  if (new Set(list).size !== list.length) {
    throw AppError.badRequest(`O campo "${label}" tem ids repetidos.`, 'FINANCE_RECONCILIATION_VALIDATION');
  }
  return list;
}

async function matchReconciliationGroup(payload, actorUserId, transaction) {
  const { groupId, companyId, financialEntryIds, bankTransactionIds } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCE_RECONCILIATION_VALIDATION');
  }
  const entryIds = uniqueList(financialEntryIds, 'financialEntryIds');
  const txIds = uniqueList(bankTransactionIds, 'bankTransactionIds');

  // FIX (homologação 23/09/2026 — mesma corrida de matchReconciliation acima, aplicada ao
  // caminho N:M): FOR UPDATE trava cada entry/transaction do grupo antes de checar se já foi
  // conciliado, serializando tentativas concorrentes sobre o mesmo item.
  const entries = [];
  for (const entryId of entryIds) {
    const entry = await FinancialEntry.findByPk(entryId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!entry) throw AppError.notFound(`Lançamento financeiro ${entryId} não encontrado.`, 'FINANCE_ENTRY_NOT_FOUND');
    entries.push(entry);
  }
  const bankTransactions = [];
  for (const txId of txIds) {
    const bankTransaction = await BankTransaction.findByPk(txId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!bankTransaction) throw AppError.notFound(`Transação bancária ${txId} não encontrada.`, 'FINANCE_BANK_TRANSACTION_NOT_FOUND');
    bankTransactions.push(bankTransaction);
  }

  const entriesCents = entries.reduce((acc, e) => acc + toCents(e.amount), 0);
  const txCents = bankTransactions.reduce((acc, t) => acc + Math.abs(toCents(t.amount)), 0);
  if (entriesCents !== txCents) {
    throw AppError.conflict(
      `Valores não batem: soma dos lançamentos ${(entriesCents / 100).toFixed(2)} vs. soma das transações ` +
        `${(txCents / 100).toFixed(2)}. Conciliação em grupo bloqueada (tolerância zero).`,
      'FINANCE_RECONCILIATION_AMOUNT_MISMATCH'
    );
  }

  // Cada entry/transaction do grupo precisa estar livre — mesma regra do 1:1, aplicada item a item.
  for (const entry of entries) {
    const existing = await Reconciliation.findOne({ where: { financialEntryId: entry.id }, transaction });
    if (existing) {
      throw AppError.conflict(
        `O lançamento ${entry.id} já está conciliado com outra transação.`,
        'FINANCE_RECONCILIATION_ENTRY_ALREADY_MATCHED'
      );
    }
  }
  for (const bankTransaction of bankTransactions) {
    const existing = await Reconciliation.findOne({ where: { bankTransactionId: bankTransaction.id }, transaction });
    if (existing) {
      throw AppError.conflict(
        `A transação de extrato ${bankTransaction.id} já está conciliada com outro lançamento.`,
        'FINANCE_RECONCILIATION_TRANSACTION_ALREADY_MATCHED'
      );
    }
  }

  const matchGroupId = randomUUID();
  const matchedAt = new Date();
  const pairs = [
    ...entries.map((entry) => ({ financialEntryId: entry.id, bankTransactionId: bankTransactions[0].id })),
    ...bankTransactions.slice(1).map((bankTransaction) => ({
      financialEntryId: entries[0].id,
      bankTransactionId: bankTransaction.id,
    })),
  ];

  const reconciliations = [];
  for (const pair of pairs) {
    const reconciliation = await Reconciliation.create(
      {
        groupId,
        companyId,
        financialEntryId: pair.financialEntryId,
        bankTransactionId: pair.bankTransactionId,
        matchGroupId,
        matchedAt,
        matchedByUserId: actorUserId || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
    await publishReconciliationMatched(reconciliation, transaction);
    reconciliations.push(reconciliation);
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.reconciliation.match_group',
      entityType: 'Reconciliation',
      entityId: matchGroupId,
      afterJson: {
        matchGroupId,
        financialEntryIds: entryIds,
        bankTransactionIds: txIds,
        totalAmount: (entriesCents / 100).toFixed(2),
        reconciliationIds: reconciliations.map((r) => r.id),
      },
      reason:
        `Conciliação em grupo (${entryIds.length} lançamento(s) x ${txIds.length} transação(ões)) ` +
        `no valor total de ${(entriesCents / 100).toFixed(2)}.`,
    },
    transaction
  );

  return { matchGroupId, reconciliations, totalAmount: (entriesCents / 100).toFixed(2) };
}

async function listReconciliations(transaction, filters = {}) {
  const where = {};
  if (filters.financialEntryId) where.financialEntryId = filters.financialEntryId;
  if (filters.bankTransactionId) where.bankTransactionId = filters.bankTransactionId;
  if (filters.matchGroupId) where.matchGroupId = filters.matchGroupId;
  return Reconciliation.findAll({ where, order: [['matched_at', 'DESC']], transaction });
}

// --- M4-contrato §11 "Conciliação bancária" — motor de SUGESTÃO de conciliação --------------
//
// Até esta rodada (auditoria externa 2026-10-07), matchReconciliation/matchReconciliationGroup
// são 100% MANUAIS — o usuário sempre informa explicitamente o par. O contrato bruto (Centro
// Financeiro §11, e o pseudocódigo do Guia Marcelo, seção 9 "Conciliação") define 5 classes e a
// função `scoreMatch` com pesos EXATOS:
//
//   Exato                ID externo/fingerprint + valor + data        Auto confirmado se fonte confiável.
//   Forte                 Valor, contraparte, referência e janela temporal  Auto ou revisão conforme regra.
//   Provável               Valor/data/texto similares                  Sugestão; humano confirma.
//   Ambíguo                Várias possibilidades                       Nunca auto conciliar.
//   Sem correspondência    Nenhuma                                     Fila de pendência.
//
//   function scoreMatch(bankTx, candidate) {
//       let score = 0;
//       if (bankTx.amount.equals(candidate.amount)) score += 0.45;
//       if (sameReference(bankTx, candidate)) score += 0.30;
//       if (sameCounterparty(bankTx, candidate)) score += 0.15;
//       if (withinDateWindow(bankTx, candidate)) score += 0.10;
//       return score;
//   }
//
// DECISÃO DE ENGENHARIA (critérios sameReference/sameCounterparty/withinDateWindow não têm uma
// definição literal de campo-a-campo no documento — só o nome e o peso): o schema atual de
// finance.bank_transactions/financial_entries não tem um campo de "contraparte" dedicado nem um
// "id externo do lançamento" comparável ao bankTransaction.externalTransactionId. Usamos os
// campos que de fato existem e carregam esse significado:
//   - sameReference: bankTransaction.externalTransactionId (quando presente) bate com
//     financialEntry.idempotencyKey, OU a descrição do extrato contém o id do lançamento
//     (referência textual que o próprio banco ecoa em PIX/boleto).
//   - sameCounterparty: mesma bankAccountId do extrato e do lançamento (nem bank_transactions
//     nem financial_entries têm um campo dedicado de "contraparte"/contrato — a conta bancária
//     é o sinal mais próximo disponível no schema atual de "mesmo lado da relação comercial").
//   - withinDateWindow: data do extrato dentro de +-5 dias da data de vencimento (ou, na
//     ausência de vencimento, da criação) do lançamento — mesma folga usada pelo antifraude
//     (M4-21) para não tratar "pagamento com atraso de alguns dias" como anomalia de data.
// EXATO exige, além do score máximo (1.00 — todos os 4 critérios bateram), que a correspondência
// de referência tenha vindo do id externo (não só da heurística textual) — é a única forma de
// "ID externo/fingerprint" que o schema atual suporta sem campo dedicado. Sem id externo, o
// score máximo possível é FORTE (0.90 — reference textual + counterparty + dateWindow), nunca
// EXATO — fail-closed em relação à classe mais permissiva de auto-conciliação.
const MATCH_CLASSES = { EXACT: 'EXACT', STRONG: 'STRONG', PROBABLE: 'PROBABLE', AMBIGUOUS: 'AMBIGUOUS', NO_MATCH: 'NO_MATCH' };
const STRONG_THRESHOLD = 0.75;
const PROBABLE_THRESHOLD = 0.45;
const DATE_WINDOW_DAYS = 5;
const AMBIGUITY_SCORE_GAP = 0.05;

function sameAmount(bankTx, candidate) {
  return toCents(Math.abs(Number(bankTx.amount))) === toCents(Number(candidate.amount));
}

function sameReference(bankTx, candidate) {
  if (bankTx.externalTransactionId && candidate.idempotencyKey && bankTx.externalTransactionId === candidate.idempotencyKey) {
    return { matched: true, byExternalId: true };
  }
  const description = String(bankTx.description || '').toLowerCase();
  if (description && candidate.id && description.includes(String(candidate.id).toLowerCase())) {
    return { matched: true, byExternalId: false };
  }
  return { matched: false, byExternalId: false };
}

function sameCounterparty(bankTx, candidate) {
  // Nem finance.bank_transactions nem finance.financial_entries têm um campo dedicado de
  // "contraparte" — o sinal disponível mais próximo de "é o mesmo lado da relação comercial" é
  // a MESMA bankAccountId (quem recebe/paga é a mesma conta bancária nos dois lados).
  return Boolean(bankTx.bankAccountId && candidate.bankAccountId) && bankTx.bankAccountId === candidate.bankAccountId;
}

function withinDateWindow(bankTx, candidate) {
  const reference = candidate.dueAt || candidate.createdAt;
  if (!bankTx.transactionDate || !reference) return false;
  const diffMs = Math.abs(new Date(bankTx.transactionDate).getTime() - new Date(reference).getTime());
  return diffMs <= DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * scoreMatch — pesos EXATOS do contrato bruto (0.45/0.30/0.15/0.10). Retorna o score numérico
 * (0 a 1) e o detalhe de quais critérios bateram (usado por `classifyMatch` para decidir EXATO
 * vs. FORTE sem recalcular tudo).
 */
function scoreMatch(bankTx, candidate) {
  const amountMatch = sameAmount(bankTx, candidate);
  const referenceMatch = sameReference(bankTx, candidate);
  const counterpartyMatch = sameCounterparty(bankTx, candidate);
  const dateMatch = withinDateWindow(bankTx, candidate);

  let score = 0;
  if (amountMatch) score += 0.45;
  if (referenceMatch.matched) score += 0.3;
  if (counterpartyMatch) score += 0.15;
  if (dateMatch) score += 0.1;

  return {
    score: Math.round(score * 100) / 100,
    criteria: { amountMatch, referenceMatch: referenceMatch.matched, byExternalId: referenceMatch.byExternalId, counterpartyMatch, dateMatch },
  };
}

/**
 * classifyMatch — aplica as 5 classes do contrato a um score+critérios já calculados por
 * `scoreMatch`. EXATO é a única classe fail-closed por campo específico (precisa do id externo
 * batendo, não só o score numérico) — as demais usam só o limiar de score.
 */
function classifyMatch({ score, criteria }) {
  if (score >= 1 && criteria.amountMatch && criteria.byExternalId && criteria.counterpartyMatch && criteria.dateMatch) {
    return MATCH_CLASSES.EXACT;
  }
  if (score >= STRONG_THRESHOLD) return MATCH_CLASSES.STRONG;
  if (score >= PROBABLE_THRESHOLD) return MATCH_CLASSES.PROBABLE;
  return MATCH_CLASSES.NO_MATCH;
}

/**
 * suggestReconciliationMatches — motor de SUGESTÃO (M4-contrato §11). Para uma transação
 * bancária ainda não conciliada, calcula `scoreMatch` contra todos os FinancialEntry em aberto
 * (PENDING/PARTIALLY_SETTLED) da mesma empresa ainda sem Reconciliation, classifica cada
 * candidato, e resolve a classe final do TOPO:
 *   - só 1 candidato com classe EXATO/FORTE -> mantém essa classe;
 *   - 2+ candidatos empatados (gap de score < 0.05) na faixa FORTE/EXATO -> AMBÍGUO, "nunca
 *     auto conciliar" (contrato, literal);
 *   - nenhum candidato com score >= 0.45 -> SEM CORRESPONDÊNCIA (fila de pendência).
 * NUNCA executa a conciliação — só sugere. `autoReconcileSuggestion` (abaixo) é quem decide se
 * executa, e só para EXATO/FORTE sem ambiguidade.
 */
async function suggestReconciliationMatches(bankTransactionId, transaction) {
  const bankTx = await BankTransaction.findByPk(bankTransactionId, { transaction });
  if (!bankTx) throw AppError.notFound('Transação bancária não encontrada.', 'FINANCE_BANK_TRANSACTION_NOT_FOUND');

  const alreadyReconciled = await Reconciliation.findOne({ where: { bankTransactionId }, transaction });
  if (alreadyReconciled) {
    return { bankTransactionId, finalClass: null, candidates: [], alreadyReconciled: true };
  }

  const candidates = await FinancialEntry.findAll({
    where: { companyId: bankTx.companyId, status: { [Op.in]: ['PENDING', 'PARTIALLY_SETTLED'] } },
    transaction,
  });

  const reconciledEntryIds = new Set(
    (await Reconciliation.findAll({ where: { companyId: bankTx.companyId }, transaction })).map((r) => r.financialEntryId)
  );

  const scored = candidates
    .filter((c) => !reconciledEntryIds.has(c.id))
    .map((candidate) => {
      const { score, criteria } = scoreMatch(bankTx, candidate);
      return { financialEntryId: candidate.id, score, criteria, class: classifyMatch({ score, criteria }) };
    })
    .filter((c) => c.score >= PROBABLE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { bankTransactionId, finalClass: MATCH_CLASSES.NO_MATCH, candidates: [] };
  }

  const top = scored[0];
  const strongOrBetter = scored.filter((c) => c.class === MATCH_CLASSES.EXACT || c.class === MATCH_CLASSES.STRONG);
  const tiedAtTop = strongOrBetter.filter((c) => top.score - c.score < AMBIGUITY_SCORE_GAP);

  let finalClass = top.class;
  if ((top.class === MATCH_CLASSES.EXACT || top.class === MATCH_CLASSES.STRONG) && tiedAtTop.length > 1) {
    // "múltiplos candidatos fortes: AMBIGUOUS, nunca auto" (contrato, literal).
    finalClass = MATCH_CLASSES.AMBIGUOUS;
  }

  return { bankTransactionId, finalClass, candidates: scored };
}

/**
 * autoReconcileSuggestion — só EXECUTA a conciliação (via matchReconciliation) quando a classe
 * final resolvida por `suggestReconciliationMatches` é EXATO ou FORTE SEM ambiguidade. Para
 * PROVÁVEL (sugestão — humano confirma), AMBÍGUO (nunca auto) e SEM CORRESPONDÊNCIA (fila), só
 * retorna a sugestão sem tocar em nada — fail closed em relação à auto-conciliação.
 */
async function autoReconcileSuggestion(payload, actorUserId, transaction) {
  const { groupId, companyId, bankTransactionId } = payload;
  const suggestion = await suggestReconciliationMatches(bankTransactionId, transaction);

  if (suggestion.finalClass !== MATCH_CLASSES.EXACT && suggestion.finalClass !== MATCH_CLASSES.STRONG) {
    return { ...suggestion, autoReconciled: false };
  }

  const top = suggestion.candidates[0];
  const reconciliation = await matchReconciliation(
    { groupId, companyId, financialEntryId: top.financialEntryId, bankTransactionId },
    actorUserId,
    transaction
  );

  return { ...suggestion, autoReconciled: true, reconciliation };
}

module.exports = {
  matchReconciliation,
  matchReconciliationGroup,
  listReconciliations,
  scoreMatch,
  classifyMatch,
  suggestReconciliationMatches,
  autoReconcileSuggestion,
  MATCH_CLASSES,
};
