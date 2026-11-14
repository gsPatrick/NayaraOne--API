'use strict';

const { formatMoneyBR } = require('../../../../utils/formatBR');
const { checkAfterManualReconciliation } = require('./manual-reconciliation-alert'); // §17 conciliação manual recorrente
const { randomUUID } = require('node:crypto');

const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { publishReconciliationMatched } = require('./finance-events.service');
const reconciliationRepository = require('../../infrastructure/repositories/reconciliation.repository');
const {
  MATCH_CLASSES,
  directionAndAccountMismatch,
  amountsMatchExactly,
  sumEntriesCents,
  sumBankTransactionsCents,
  buildGroupPairs,
  scoreMatch,
  classifyMatch,
  filterEligibleCandidates,
  scoreCandidates,
  resolveFinalClass,
  autoMatchMethod,
} = require('../../domain/reconciliation');
const { DEFAULT_POLICY, readPolicy, autoConfirmDecision } = require('./reconciliation-policy');

// Motor de conciliação — casa um finance.financial_entries (lançamento) com um
// finance.bank_transactions (linha real de extrato). Regras duras:
//   - valores devem bater (mesmo módulo, tolerância zero — nenhuma "reconciliação aproximada"
//     está prevista no schema/documento);
//   - nem o lançamento nem a transação podem já estar conciliados com outra coisa (1:1).
// A regra pura (sentido, centavos, pontuação e classes) fica em domain/reconciliation.js e o
// acesso a dados em infrastructure/repositories/reconciliation.repository.js.

async function assertNotAlreadyReconciled(financialEntryId, bankTransactionId, transaction) {
  const existingForEntry = await reconciliationRepository.findReconciliationByFinancialEntry(financialEntryId, transaction);
  if (existingForEntry) {
    throw AppError.conflict('Este lançamento financeiro já está conciliado com outra transação.', 'FINANCE_RECONCILIATION_ENTRY_ALREADY_MATCHED');
  }
  const existingForTransaction = await reconciliationRepository.findReconciliationByBankTransaction(bankTransactionId, transaction);
  if (existingForTransaction) {
    throw AppError.conflict('Esta transação de extrato já está conciliada com outro lançamento.', 'FINANCE_RECONCILIATION_TRANSACTION_ALREADY_MATCHED');
  }
}

// Sentido do extrato (R6 / M4-D019 A7) e conta bancária: a regra está no domínio; aqui só
// traduz a incompatibilidade no erro HTTP.
function assertDirectionAndAccountCompatible(entry, bankTransaction) {
  const mismatch = directionAndAccountMismatch(entry, bankTransaction);
  if (mismatch === 'DIRECTION') {
    throw AppError.conflict(
      'Entrada do extrato não pode conciliar com pagamento (ou vice-versa).',
      'FINANCE_RECONCILIATION_DIRECTION_MISMATCH'
    );
  }
  if (mismatch === 'ACCOUNT') {
    throw AppError.conflict(
      'A linha do extrato e o lançamento são de contas bancárias diferentes.',
      'FINANCE_RECONCILIATION_ACCOUNT_MISMATCH'
    );
  }
}

async function matchReconciliation(payload, actorUserId, transaction) {
  const { groupId, companyId, financialEntryId, bankTransactionId, matchMethod = 'MANUAL' } = payload;
  if (!groupId || !companyId || !financialEntryId || !bankTransactionId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "financialEntryId" e "bankTransactionId" são obrigatórios.',
      'FINANCE_RECONCILIATION_VALIDATION'
    );
  }

  // Homologação 23/09/2026 (corrida real): sem UNIQUE simples possível (o grupo N:M repete ids), o
  // FOR UPDATE no lançamento e na transação serializa duas conciliações concorrentes; a segunda
  // só reavalia assertNotAlreadyReconciled depois que a primeira commita e é barrada.
  const entry = await reconciliationRepository.findFinancialEntryForUpdate(financialEntryId, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  const bankTransaction = await reconciliationRepository.findBankTransactionForUpdate(bankTransactionId, transaction);
  if (!bankTransaction) throw AppError.notFound('Transação bancária não encontrada.', 'FINANCE_BANK_TRANSACTION_NOT_FOUND');

  if (!amountsMatchExactly(entry, bankTransaction)) {
    throw AppError.conflict(
      `Valores não batem: lançamento ${entry.amount} vs. transação ${bankTransaction.amount}. Conciliação bloqueada.`,
      'FINANCE_RECONCILIATION_AMOUNT_MISMATCH'
    );
  }

  assertDirectionAndAccountCompatible(entry, bankTransaction);

  await assertNotAlreadyReconciled(financialEntryId, bankTransactionId, transaction);

  const reconciliation = await reconciliationRepository.createReconciliation(
    {
      groupId,
      companyId,
      financialEntryId,
      bankTransactionId,
      matchedAt: new Date(),
      matchedByUserId: actorUserId || null,
      matchMethod,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    transaction
  );

  await publishReconciliationMatched(reconciliation, transaction);
  await checkAfterManualReconciliation({ groupId, companyId, matchMethod }, actorUserId, transaction); // §17 alerta gerencial

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.reconciliation.match',
      entityType: 'Reconciliation',
      entityId: reconciliation.id,
      beforeJson: { financialEntryId, bankTransactionId, conciliado: false },
      afterJson: reconciliation.toJSON(),
      reason: `Lançamento financeiro conciliado com transação de extrato (valor ${formatMoneyBR(entry.amount)}).`,
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
// Tolerância ZERO no valor, igual ao 1:1 (soma em centavos: ver domain/reconciliation.js).

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
    const entry = await reconciliationRepository.findFinancialEntryForUpdate(entryId, transaction);
    if (!entry) throw AppError.notFound(`Lançamento financeiro ${entryId} não encontrado.`, 'FINANCE_ENTRY_NOT_FOUND');
    entries.push(entry);
  }
  const bankTransactions = [];
  for (const txId of txIds) {
    const bankTransaction = await reconciliationRepository.findBankTransactionForUpdate(txId, transaction);
    if (!bankTransaction) throw AppError.notFound(`Transação bancária ${txId} não encontrada.`, 'FINANCE_BANK_TRANSACTION_NOT_FOUND');
    bankTransactions.push(bankTransaction);
  }

  const entriesCents = sumEntriesCents(entries);
  const txCents = sumBankTransactionsCents(bankTransactions);
  if (entriesCents !== txCents) {
    throw AppError.conflict(
      `Valores não batem: soma dos lançamentos ${(entriesCents / 100).toFixed(2)} vs. soma das transações ` +
        `${(txCents / 100).toFixed(2)}. Conciliação em grupo bloqueada (tolerância zero).`,
      'FINANCE_RECONCILIATION_AMOUNT_MISMATCH'
    );
  }

  for (const entry of entries) {
    for (const bankTransaction of bankTransactions) assertDirectionAndAccountCompatible(entry, bankTransaction);
  }

  // Cada entry/transaction do grupo precisa estar livre — mesma regra do 1:1, aplicada item a item.
  for (const entry of entries) {
    const existing = await reconciliationRepository.findReconciliationByFinancialEntry(entry.id, transaction);
    if (existing) {
      throw AppError.conflict(
        `O lançamento ${entry.id} já está conciliado com outra transação.`,
        'FINANCE_RECONCILIATION_ENTRY_ALREADY_MATCHED'
      );
    }
  }
  for (const bankTransaction of bankTransactions) {
    const existing = await reconciliationRepository.findReconciliationByBankTransaction(bankTransaction.id, transaction);
    if (existing) {
      throw AppError.conflict(
        `A transação de extrato ${bankTransaction.id} já está conciliada com outro lançamento.`,
        'FINANCE_RECONCILIATION_TRANSACTION_ALREADY_MATCHED'
      );
    }
  }

  const matchGroupId = randomUUID();
  const matchedAt = new Date();
  const pairs = buildGroupPairs(entries, bankTransactions);

  const reconciliations = [];
  for (const pair of pairs) {
    const reconciliation = await reconciliationRepository.createReconciliation(
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
      transaction
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
      beforeJson: { financialEntryIds: entryIds, bankTransactionIds: txIds, conciliado: false },
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

  await checkAfterManualReconciliation({ groupId, companyId, matchMethod: 'MANUAL' }, actorUserId, transaction); // §17 (o grupo conta 1)
  return { matchGroupId, reconciliations, totalAmount: (entriesCents / 100).toFixed(2) };
}

async function listReconciliations(transaction, filters = {}) {
  const where = {};
  if (filters.financialEntryId) where.financialEntryId = filters.financialEntryId;
  if (filters.bankTransactionId) where.bankTransactionId = filters.bankTransactionId;
  if (filters.matchGroupId) where.matchGroupId = filters.matchGroupId;
  return reconciliationRepository.listReconciliations(where, transaction);
}

/**
 * suggestReconciliationMatches — motor de SUGESTÃO (M4-contrato §11). Para uma transação
 * bancária ainda não conciliada, calcula `scoreMatch` contra todos os FinancialEntry em aberto
 * (PENDING/PARTIALLY_SETTLED) da mesma empresa ainda sem Reconciliation, classifica cada
 * candidato, e resolve a classe final do TOPO com a regra AUTO_STRONG da empresa
 * (reconciliation-policy.js: limiares, janela de data e folga de empate são parâmetros):
 *   - só 1 candidato com classe EXATO/FORTE -> mantém essa classe;
 *   - 2+ candidatos fortes, ou empatados no topo (diferença < folga) -> AMBÍGUO, "nunca
 *     auto conciliar" (contrato, literal);
 *   - nenhum candidato com score >= mínimo de sugestão -> SEM CORRESPONDÊNCIA (fila de pendência).
 * NUNCA executa a conciliação — só sugere. `autoReconcileSuggestion` (abaixo) é quem decide se
 * executa. A resposta leva a política usada (`policy`) e a origem da linha (`source`, `sourceTrusted`).

 * @returns {Promise<any>}
 */
async function suggestReconciliationMatches(bankTransactionId, transaction, policy) {
  const bankTx = await reconciliationRepository.findBankTransactionById(bankTransactionId, transaction);
  if (!bankTx) throw AppError.notFound('Transação bancária não encontrada.', 'FINANCE_BANK_TRANSACTION_NOT_FOUND');
  const effective = policy || (await readPolicy({ groupId: bankTx.groupId, companyId: bankTx.companyId }, transaction));
  const origin = { source: bankTx.source || null, sourceTrusted: bankTx.sourceTrusted === true };

  const alreadyReconciled = await reconciliationRepository.findReconciliationByBankTransaction(bankTransactionId, transaction);
  if (alreadyReconciled) {
    return { bankTransactionId, finalClass: null, candidates: [], alreadyReconciled: true, policy: effective, ...origin };
  }

  const candidates = await reconciliationRepository.findOpenFinancialEntriesByCompany(bankTx.companyId, transaction);

  const reconciledEntryIds = new Set(
    (await reconciliationRepository.findReconciliationsByCompany(bankTx.companyId, transaction)).map((r) => r.financialEntryId)
  );

  // Elegibilidade (M4-D019 A7): valor igual, mesmo sentido e mesma conta (regra no domínio).
  const eligible = filterEligibleCandidates(bankTx, candidates, reconciledEntryIds);

  const scored = scoreCandidates(bankTx, eligible, effective);

  if (scored.length === 0) {
    return { bankTransactionId, finalClass: MATCH_CLASSES.NO_MATCH, candidates: [], policy: effective, ...origin };
  }

  // AMBÍGUO: empate no topo ou vários fortes nunca é auto (regra no domínio).
  const finalClass = resolveFinalClass(scored, effective);

  return { bankTransactionId, finalClass, candidates: scored, policy: effective, ...origin };
}

/**
 * autoReconcileSuggestion — só EXECUTA a conciliação (via matchReconciliation) quando a regra de
 * confirmação conforme risco permite (FIN-009; reconciliation-policy.js#autoConfirmDecision):
 * EXATO de fonte confiável (livro §11 "auto confirmado se fonte confiável"); FORTE de fonte
 * confiável com a política AUTO_STRONG ligada e score >= mínimo automático. Linha digitada à mão
 * (fonte não confiável), PROVÁVEL, AMBÍGUO e SEM CORRESPONDÊNCIA só devolvem a sugestão, com o
 * motivo em `autoBlockedReason` — fail closed em relação à auto-conciliação.
 */
async function autoReconcileSuggestion(payload, actorUserId, transaction) {
  const { groupId, companyId, bankTransactionId } = payload;
  const policy = await readPolicy({ groupId, companyId }, transaction);
  const suggestion = await suggestReconciliationMatches(bankTransactionId, transaction, policy);
  if (suggestion.alreadyReconciled) return { ...suggestion, autoReconciled: false, autoBlockedReason: 'ALREADY_RECONCILED' };

  const top = suggestion.candidates[0];
  const bankTx = { sourceTrusted: suggestion.sourceTrusted };
  const entry = top ? await reconciliationRepository.findFinancialEntryById(top.financialEntryId, transaction) : null;
  const decision = autoConfirmDecision({ finalClass: suggestion.finalClass, topScore: top ? top.score : 0, bankTx, entry }, policy);
  if (!decision.allowed) return { ...suggestion, autoReconciled: false, autoBlockedReason: decision.reason };

  const reconciliation = await matchReconciliation(
    { groupId, companyId, financialEntryId: top.financialEntryId, bankTransactionId, matchMethod: autoMatchMethod(suggestion.finalClass) },
    actorUserId,
    transaction
  );

  return {
    ...suggestion,
    autoReconciled: true,
    method: autoMatchMethod(suggestion.finalClass),
    reconciliation,
  };
}

module.exports = {
  matchReconciliation,
  matchReconciliationGroup,
  listReconciliations,
  // Pontuação/classe com a política padrão (DEC-006) quando chamadas sem política (uso em teste e diagnóstico).
  scoreMatch: (bankTx, candidate, policy = DEFAULT_POLICY) => scoreMatch(bankTx, candidate, policy),
  classifyMatch: (scored, policy = DEFAULT_POLICY) => classifyMatch(scored, policy),
  suggestReconciliationMatches,
  autoReconcileSuggestion,
  MATCH_CLASSES,
};
