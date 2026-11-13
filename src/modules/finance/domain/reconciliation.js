'use strict';

// Regra pura da conciliação: sentido/conta, valor em centavos, pontuação e classificação do
// match. Sem banco e sem HTTP; os erros são lançados pelo serviço.
// Limiares, janela de data e folga de empate NÃO são constantes: chegam no objeto `policy` (regra AUTO_STRONG parametrizada, Guia §9 ">= regra
// AUTO_STRONG: auto conforme policy"; DEC-006), lido dos parâmetros da empresa por application/services/reconciliation-policy.js.

const money = require('./money');

// Dia civil de São Paulo (AAAA-MM-DD), sem depender de utilitário fora do domínio (mesma regra de utils/businessDate.js).
const SP_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const businessDateKey = (value) => SP_DAY.format(new Date(value));

// Sentido do extrato (R6 / M4-D019 A7): valor negativo = saída (só concilia com DEBIT/PAYABLE),
// positivo = entrada (só com CREDIT/RECEIVABLE). Conta bancária diferente também nunca concilia
// (quando os dois lados têm conta informada).
function entryDirection(entry) {
  if (entry.entryType === 'DEBIT' || entry.entryType === 'CREDIT') return entry.entryType;
  if (entry.nature === 'PAYABLE') return 'DEBIT';
  if (entry.nature === 'RECEIVABLE') return 'CREDIT';
  return null;
}

function bankDirection(bankTransaction) {
  const value = Number(bankTransaction.amount);
  if (value < 0) return 'DEBIT';
  if (value > 0) return 'CREDIT';
  return null;
}

// Retorna qual incompatibilidade existe ('DIRECTION' ou 'ACCOUNT', nessa ordem) ou null.
function directionAndAccountMismatch(entry, bankTransaction) {
  const entrySide = entryDirection(entry);
  const bankSide = bankDirection(bankTransaction);
  if (entrySide && bankSide && entrySide !== bankSide) {
    return 'DIRECTION';
  }
  if (entry.bankAccountId && bankTransaction.bankAccountId && entry.bankAccountId !== bankTransaction.bankAccountId) {
    return 'ACCOUNT';
  }
  return null;
}

// Conciliação 1:1: valor do lançamento igual ao módulo do valor do extrato (tolerância zero).
function amountsMatchExactly(entry, bankTransaction) {
  return money.toCents(entry.amount) === Math.abs(money.toCents(bankTransaction.amount));
}

// Tolerância ZERO no valor, igual ao 1:1: Σ(lançamentos) precisa bater exatamente com
// Σ(|transações|). A soma é feita em CENTAVOS inteiros — somar DECIMAL como float
// introduziria erro de arredondamento justamente onde a regra é "bater no centavo".

const { toCents } = money;

function sumEntriesCents(entries) {
  return entries.reduce((acc, e) => acc + toCents(e.amount), 0);
}

function sumBankTransactionsCents(bankTransactions) {
  return bankTransactions.reduce((acc, t) => acc + Math.abs(toCents(t.amount)), 0);
}

// Estrela do grupo N:M: cada lançamento ligado à PRIMEIRA transação, cada transação extra ligada
// ao PRIMEIRO lançamento (N + M - 1 pares).
function buildGroupPairs(entries, bankTransactions) {
  return [
    ...entries.map((entry) => ({ financialEntryId: entry.id, bankTransactionId: bankTransactions[0].id })),
    ...bankTransactions.slice(1).map((bankTransaction) => ({
      financialEntryId: entries[0].id,
      bankTransactionId: bankTransaction.id,
    })),
  ];
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
//   - withinDateWindow: dia (civil, São Paulo) do extrato dentro de +-N dias do dia de vencimento
//     (ou, na ausência de vencimento, da criação) do lançamento; N = conciliacao.janela_data_dias.
// EXATO exige, além do score máximo (1.00 — todos os 4 critérios bateram), que a correspondência
// de referência tenha vindo do id externo (não só da heurística textual) — é a única forma de
// "ID externo/fingerprint" que o schema atual suporta sem campo dedicado. Sem id externo, o
// score máximo possível é FORTE (0.90 — reference textual + counterparty + dateWindow), nunca
// EXATO — fail-closed em relação à classe mais permissiva de auto-conciliação.
const MATCH_CLASSES = { EXACT: 'EXACT', STRONG: 'STRONG', PROBABLE: 'PROBABLE', AMBIGUOUS: 'AMBIGUOUS', NO_MATCH: 'NO_MATCH' };
// Política (Guia §9 "regra AUTO_STRONG"): { autoScoreMin, suggestionScoreMin, dateWindowDays, ambiguityGap }.
//   FORTE    = score >= autoScoreMin           (conciliacao.score_auto_minimo, DEC-006)
//   PROVÁVEL = suggestionScoreMin <= score < autoScoreMin (conciliacao.score_sugestao_minimo)
//   empate   = outro candidato a menos de ambiguityGap do topo (conciliacao.folga_ambiguidade, DI-M4CC-3) -> AMBÍGUO
function assertPolicy(policy) {
  const ok = policy && ['autoScoreMin', 'suggestionScoreMin', 'dateWindowDays', 'ambiguityGap'].every((k) => Number.isFinite(policy[k]));
  if (!ok) throw new TypeError('Política de conciliação ausente ou incompleta (autoScoreMin, suggestionScoreMin, dateWindowDays, ambiguityGap).');
  return policy;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

function withinDateWindow(bankTx, candidate, policy) {
  // BUG REAL CORRIGIDO (verificação cética adicional, Marco 4, 12/10/2026): o model
  // FinancialEntry (ver src/models/FinancialEntry.js) declara `createdAt: 'created_at'` em
  // conjunto com `underscored: true`, e nesta versão do Sequelize isso faz o ATRIBUTO em si se
  // chamar `created_at` (dataValues só tem a chave `created_at`, nunca `createdAt`) — então
  // `candidate.createdAt` (e até `candidate.get('createdAt')`, que resolve pelo nome lógico do
  // atributo) eram sempre `undefined` para qualquer lançamento sem `dueAt` preenchido, fazendo
  // `dateMatch` nunca bater e a classe EXATO ficar praticamente inatingível (score travava em
  // 0.9, nunca em 1.0). Lendo a chave real `created_at` diretamente.
  const reference = candidate.dueAt || candidate.created_at || candidate.get?.('created_at');
  if (!bankTx.transactionDate || !reference) return false;
  // Dia civil de São Paulo dos dois lados (M4-D019 teste 14), diferença em dias inteiros.
  const dayOf = (v) => Date.parse(`${businessDateKey(v)}T00:00:00Z`);
  const diffDays = Math.abs(dayOf(bankTx.transactionDate) - dayOf(reference)) / DAY_MS;
  return diffDays <= assertPolicy(policy).dateWindowDays;
}

/**
 * scoreMatch — pesos EXATOS do contrato bruto (0.45/0.30/0.15/0.10). Retorna o score numérico
 * (0 a 1) e o detalhe de quais critérios bateram (usado por `classifyMatch` para decidir EXATO
 * vs. FORTE sem recalcular tudo).
 */
function scoreMatch(bankTx, candidate, policy) {
  const amountMatch = sameAmount(bankTx, candidate);
  const referenceMatch = sameReference(bankTx, candidate);
  const counterpartyMatch = sameCounterparty(bankTx, candidate);
  const dateMatch = withinDateWindow(bankTx, candidate, policy);

  // Pesos do livro em centésimos inteiros (45/30/15/10): a soma é exata, sem resíduo de float.
  let points = 0;
  if (amountMatch) points += 45;
  if (referenceMatch.matched) points += 30;
  if (counterpartyMatch) points += 15;
  if (dateMatch) points += 10;

  return {
    score: points / 100,
    criteria: { amountMatch, referenceMatch: referenceMatch.matched, byExternalId: referenceMatch.byExternalId, counterpartyMatch, dateMatch },
  };
}

/**
 * classifyMatch — aplica as 5 classes do contrato a um score+critérios já calculados por
 * `scoreMatch`. EXATO é a única classe fail-closed por campo específico (precisa do id externo
 * batendo, não só o score numérico) — as demais usam só o limiar de score.
 */
function classifyMatch({ score, criteria }, policy) {
  const { autoScoreMin, suggestionScoreMin } = assertPolicy(policy);
  // EXATO (livro §11): ID externo/fingerprint + valor + data. A conta bancária já é checada na
  // elegibilidade (candidato de outra conta nunca chega aqui), então não é exigida de novo.
  if (criteria.amountMatch && criteria.byExternalId && criteria.dateMatch) {
    return MATCH_CLASSES.EXACT;
  }
  if (score >= autoScoreMin) return MATCH_CLASSES.STRONG;
  if (score >= suggestionScoreMin) return MATCH_CLASSES.PROBABLE;
  return MATCH_CLASSES.NO_MATCH;
}

function describeReasons(criteria) {
  const reasons = [];
  if (criteria.amountMatch) reasons.push('Valor igual');
  if (criteria.referenceMatch) reasons.push(criteria.byExternalId ? 'ID externo do extrato igual ao do lançamento' : 'Referência do lançamento citada no extrato');
  if (criteria.counterpartyMatch) reasons.push('Mesma conta bancária');
  if (criteria.dateMatch) reasons.push('Data dentro da janela de tolerância');
  return reasons;
}

// Elegibilidade (M4-D019 A7): valor igual (tolerância zero), mesmo sentido e mesma conta.
// Candidato incompatível NUNCA aparece como sugestão, qualquer que seja o score.
function filterEligibleCandidates(bankTx, candidates, reconciledEntryIds) {
  return candidates.filter((c) => {
    if (reconciledEntryIds.has(c.id)) return false;
    if (!sameAmount(bankTx, c)) return false;
    if (directionAndAccountMismatch(c, bankTx)) return false;
    return true;
  });
}

// Pontua e classifica os elegíveis; descarta abaixo de PROVÁVEL e ordena do maior score.
function scoreCandidates(bankTx, eligible, policy) {
  const { suggestionScoreMin } = assertPolicy(policy);
  return eligible
    .map((candidate) => {
      const { score, criteria } = scoreMatch(bankTx, candidate, policy);
      return {
        financialEntryId: candidate.id,
        score,
        criteria,
        class: classifyMatch({ score, criteria }, policy),
        reasons: describeReasons(criteria),
      };
    })
    .filter((c) => c.class === MATCH_CLASSES.EXACT || c.score >= suggestionScoreMin)
    .sort((a, b) => b.score - a.score);
}

// AMBÍGUO (livro §11 e Guia §9): mais de um candidato elegível com score parecido -> nunca
// auto. Só o EXATO por ID externo desempata sozinho (o ID externo identifica um lançamento).
function resolveFinalClass(scored, policy) {
  const { ambiguityGap } = assertPolicy(policy);
  const top = scored[0];
  // Comparação em centésimos inteiros (os scores têm 2 casas).
  const gap = (c) => Math.round((top.score - c.score) * 100);
  const tiedAtTop = scored.filter((c) => gap(c) === 0 || gap(c) < Math.round(ambiguityGap * 100));
  // Guia §9 "múltiplos candidatos fortes: AMBIGUOUS, nunca auto" vale qualquer que seja a folga configurada.
  const strongOnes = scored.filter((c) => c.class === MATCH_CLASSES.STRONG || c.class === MATCH_CLASSES.EXACT);

  let finalClass = top.class;
  if (top.class !== MATCH_CLASSES.EXACT && (tiedAtTop.length > 1 || strongOnes.length > 1)) {
    finalClass = MATCH_CLASSES.AMBIGUOUS;
  }
  return finalClass;
}

// Método gravado na conciliação automática conforme a classe final.
function autoMatchMethod(finalClass) {
  return finalClass === MATCH_CLASSES.EXACT ? 'AUTO_EXACT' : 'AUTO_STRONG';
}

module.exports = {
  MATCH_CLASSES,
  assertPolicy,
  entryDirection,
  bankDirection,
  directionAndAccountMismatch,
  amountsMatchExactly,
  toCents,
  sumEntriesCents,
  sumBankTransactionsCents,
  buildGroupPairs,
  sameAmount,
  sameReference,
  sameCounterparty,
  withinDateWindow,
  scoreMatch,
  classifyMatch,
  describeReasons,
  filterEligibleCandidates,
  scoreCandidates,
  resolveFinalClass,
  autoMatchMethod,
};
