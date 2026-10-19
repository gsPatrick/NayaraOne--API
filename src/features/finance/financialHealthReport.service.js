'use strict';

const { Op } = require('sequelize');

const { FinancialEntry, BankTransaction, Reconciliation, Commission, OwnerRepass, sequelize } = require('../../models');
const { countOpenHighRiskAnomalies } = require('./anomalyCases.service');
const { startOfBusinessDay } = require('../../utils/businessDate');

// M4-20 — Relatório semanal de saúde financeira.
//
// Cálculo REAL sobre finance.financial_entries (nenhum número inventado): tudo o que sai daqui
// é soma de linha existente no ledger, lida sob o RLS da empresa do contexto.
//
// DUAS DECISÕES QUE MUDAM O NÚMERO E PRECISAM ESTAR EXPLÍCITAS:
//  1. Dinheiro de terceiro (caução etc., M4-16) NÃO entra no "a receber próprio" nem no saldo
//     líquido projetado — ele transita, não é resultado da imobiliária. Vem separado em
//     `thirdPartyFunds` para que quem lê saiba que ele existe e quanto é.
//  2. Só lançamentos PENDING contam como "a pagar"/"a receber". SETTLED já aconteceu,
//     REVERSED/CANCELLED não vão acontecer.

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * getWeeklyHealthReport — fotografia da saúde financeira no momento da chamada, com a janela
 * dos próximos 7 dias destacada (é isso que faz dele "semanal": o que vence na semana que vem).
 *
 * Devolve:
 *   - payablePending / receivablePending: total PENDING próprio (exclui dinheiro de terceiro)
 *   - projectedNetBalance: a receber próprio − a pagar (projeção, não saldo bancário)
 *   - overdue: PENDING com vencimento já passado, separado em a pagar e a receber
 *   - dueNextSevenDays: PENDING vencendo de hoje até +7 dias
 *   - thirdPartyFunds: dinheiro de terceiro PENDING, segregado (M4-16)
 */
async function getWeeklyHealthReport(transaction, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  // Vencimento é data de calendário em São Paulo (auditoria Marco 7 "final2", 18/10/2026: a
  // parcela que vencia HOJE já aparecia como vencida à tarde, porque dueAt é gravado ao meio-dia
  // e a comparação era com o instante atual). Vencido = vence antes de hoje; as janelas de N dias
  // incluem hoje e vão até o fim do N-ésimo dia (limite superior exclusivo à meia-noite seguinte).
  const startToday = startOfBusinessDay(now);
  const horizon7 = startOfBusinessDay(now, 8);
  const horizon30 = startOfBusinessDay(now, 31);
  const horizon60 = startOfBusinessDay(now, 61);

  const pendingEntries = await FinancialEntry.findAll({
    where: { status: 'PENDING' },
    transaction,
  });

  const emptyWindow = () => ({ payable: { count: 0, total: 0 }, receivable: { count: 0, total: 0 } });

  const report = {
    generatedAt: now.toISOString(),
    windowEndsAt: horizon7.toISOString(),
    payablePending: { count: 0, total: 0 },
    receivablePending: { count: 0, total: 0 },
    projectedNetBalance: 0,
    overdue: {
      payable: { count: 0, total: 0 },
      receivable: { count: 0, total: 0 },
      total: 0,
    },
    dueNextSevenDays: {
      payable: { count: 0, total: 0 },
      receivable: { count: 0, total: 0 },
    },
    // GAP REAL CORRIGIDO (Caderno §19, indicador "Contas/Recebíveis 7/30/60 dias"): só a janela
    // de 7 dias existia. 30/60 dias são CUMULATIVOS (tudo que vence até ali, não só a "fatia"
    // entre 30 e 60) — é a leitura usual de "contas a pagar nos próximos N dias".
    dueNext30Days: emptyWindow(),
    dueNext60Days: emptyWindow(),
    thirdPartyFunds: { count: 0, total: 0 },
  };

  for (const entry of pendingEntries) {
    const amount = toNumber(entry.amount);

    if (entry.isThirdPartyFunds) {
      report.thirdPartyFunds.count += 1;
      report.thirdPartyFunds.total += amount;
      continue; // decisão 1: dinheiro de terceiro não compõe resultado próprio.
    }

    // Natureza é a fonte da verdade sobre "a pagar" vs "a receber". ADJUSTMENT/TRANSFER não
    // entram em nenhum dos dois: não são obrigação nem direito contra terceiros.
    const bucket =
      entry.nature === 'PAYABLE' ? 'payable' : entry.nature === 'RECEIVABLE' ? 'receivable' : null;
    if (!bucket) continue;

    const totals = bucket === 'payable' ? report.payablePending : report.receivablePending;
    totals.count += 1;
    totals.total += amount;

    if (entry.dueAt) {
      const dueAt = new Date(entry.dueAt);
      if (dueAt < startToday) {
        report.overdue[bucket].count += 1;
        report.overdue[bucket].total += amount;
      } else if (dueAt < horizon7) {
        report.dueNextSevenDays[bucket].count += 1;
        report.dueNextSevenDays[bucket].total += amount;
      }
      if (dueAt >= startToday && dueAt < horizon30) {
        report.dueNext30Days[bucket].count += 1;
        report.dueNext30Days[bucket].total += amount;
      }
      if (dueAt >= startToday && dueAt < horizon60) {
        report.dueNext60Days[bucket].count += 1;
        report.dueNext60Days[bucket].total += amount;
      }
    }
  }

  report.payablePending.total = round2(report.payablePending.total);
  report.receivablePending.total = round2(report.receivablePending.total);
  report.thirdPartyFunds.total = round2(report.thirdPartyFunds.total);
  for (const bucket of ['payable', 'receivable']) {
    report.overdue[bucket].total = round2(report.overdue[bucket].total);
    report.dueNextSevenDays[bucket].total = round2(report.dueNextSevenDays[bucket].total);
    report.dueNext30Days[bucket].total = round2(report.dueNext30Days[bucket].total);
    report.dueNext60Days[bucket].total = round2(report.dueNext60Days[bucket].total);
  }
  report.overdue.total = round2(report.overdue.payable.total + report.overdue.receivable.total);
  report.projectedNetBalance = round2(report.receivablePending.total - report.payablePending.total);

  // GAP REAL CORRIGIDO (Caderno §19): os indicadores abaixo nunca tinham sido implementados —
  // o relatório só cobria "contas 7 dias" e "dinheiro de terceiros" de todo o conjunto de 10
  // indicadores exigidos. Cada um é calculado sobre dado que já existe (nenhum número novo
  // inventado), na mesma transação/RLS desta chamada.

  // "Inadimplência — Vencidos/total elegível": total elegível é tudo que já venceu + o que
  // ainda vai vencer (overdue + pending futuro), próprio (sem terceiros).
  const totalElegivel = report.payablePending.total + report.receivablePending.total;
  report.delinquencyRatio = totalElegivel > 0 ? round2(report.overdue.total / totalElegivel) : 0;

  // "Pendências de conciliação": extrato bancário importado sem nenhum vínculo em
  // finance.reconciliations ainda — fila real de trabalho manual.
  const [pendingReconciliationRow] = await sequelize.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(bt.amount), 0)::numeric AS total
     FROM finance.bank_transactions bt
     LEFT JOIN finance.reconciliations r ON r.bank_transaction_id = bt.id
     WHERE r.id IS NULL`,
    { transaction, type: sequelize.QueryTypes.SELECT }
  );
  report.pendingReconciliations = {
    count: Number(pendingReconciliationRow?.count || 0),
    total: round2(toNumber(pendingReconciliationRow?.total)),
  };

  // "Comissões provisionadas": direito já calculado (PENDING/APPROVED), ainda não pago.
  const provisionedCommissions = await Commission.findAll({
    where: { status: { [Op.in]: ['PENDING', 'APPROVED'] } },
    attributes: ['totalAmount'],
    transaction,
  });
  report.provisionedCommissions = {
    count: provisionedCommissions.length,
    total: round2(provisionedCommissions.reduce((acc, c) => acc + toNumber(c.totalAmount), 0)),
  };

  // "Repasses pendentes": valores de proprietários ainda não pagos.
  const pendingRepasses = await OwnerRepass.findAll({
    where: { status: 'PENDING' },
    attributes: ['netAmount'],
    transaction,
  });
  report.pendingOwnerRepasses = {
    count: pendingRepasses.length,
    total: round2(pendingRepasses.reduce((acc, r) => acc + toNumber(r.netAmount), 0)),
  };

  // "Anomalias — Casos HIGH/CRITICAL abertos": companyId vem de options porque esta função
  // roda sob RLS (não filtra company_id explicitamente em nenhuma outra query acima), mas
  // AnomalyCase.count exige o valor porque não tem uma "sessão implícita" nesse service.
  report.openHighRiskAnomalies = options.companyId
    ? await countOpenHighRiskAnomalies(options.companyId, transaction)
    : null;

  // GAP REAL CORRIGIDO (Caderno §19, indicador "Caixa disponível"): não existe uma tabela
  // finance.ledger nem um campo de saldo materializado em BankAccount — o saldo bancário real é
  // a soma assinada (entrada positiva, saída negativa, já é a convenção usada por
  // importBankStatement) de todo o extrato já importado (finance.bank_transactions), que É o
  // fato bancário realizado. "Excluindo dinheiro de terceiros" (§19): subtrai o que está
  // efetivamente retido hoje — recebido e ainda não devolvido — calculado sobre os lançamentos
  // de terceiro já SETTLED (RECEIVABLE de terceiro menos PAYABLE de devolução de terceiro).
  const [bankBalanceRow] = await sequelize.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM finance.bank_transactions`,
    { transaction, type: sequelize.QueryTypes.SELECT }
  );
  const grossBankBalance = round2(toNumber(bankBalanceRow?.total));

  const settledThirdParty = await FinancialEntry.findAll({
    where: { status: 'SETTLED', isThirdPartyFunds: true },
    attributes: ['amount', 'nature'],
    transaction,
  });
  const thirdPartyHeld = round2(
    settledThirdParty.reduce((acc, e) => {
      const amt = toNumber(e.amount);
      if (e.nature === 'RECEIVABLE') return acc + amt;
      if (e.nature === 'PAYABLE') return acc - amt;
      return acc;
    }, 0)
  );

  report.freeCash = {
    grossBankBalance,
    thirdPartyHeld,
    value: round2(grossBankBalance - thirdPartyHeld),
  };

  // GAP REAL CORRIGIDO (Caderno §19, indicador "Margem por setor" — "Receita realizada − custos
  // atribuídos"): "setor" não é um conceito solto — o próprio Caderno (§4) define
  // result_center_id como a dimensão obrigatória "para receita e análise de margem". Agrupa
  // todo lançamento SETTLED próprio (exclui terceiro) por centro de resultado.
  const settledForMargin = await FinancialEntry.findAll({
    where: { status: 'SETTLED', isThirdPartyFunds: false, nature: { [Op.in]: ['PAYABLE', 'RECEIVABLE'] } },
    attributes: ['amount', 'nature', 'resultCenterId'],
    transaction,
  });
  const bySector = new Map();
  for (const entry of settledForMargin) {
    const key = entry.resultCenterId || '__SEM_CENTRO_RESULTADO__';
    if (!bySector.has(key)) bySector.set(key, { revenueRealized: 0, costsAttributed: 0 });
    const bucket = bySector.get(key);
    const amt = toNumber(entry.amount);
    if (entry.nature === 'RECEIVABLE') bucket.revenueRealized += amt;
    else bucket.costsAttributed += amt;
  }
  report.marginBySector = Array.from(bySector.entries()).map(([resultCenterId, v]) => ({
    resultCenterId: resultCenterId === '__SEM_CENTRO_RESULTADO__' ? null : resultCenterId,
    revenueRealized: round2(v.revenueRealized),
    costsAttributed: round2(v.costsAttributed),
    margin: round2(v.revenueRealized - v.costsAttributed),
  }));

  // "Necessidade para respirar": saídas obrigatórias já vencidas ou vencendo em 7 dias, menos o
  // caixa livre, menos o que deve entrar com alta probabilidade na mesma janela (recebíveis que
  // ainda não venceram e vencem em até 7 dias — overdue de recebível NÃO conta como "altamente
  // provável", é inadimplência, não entrada certa). Agora usa o caixa livre real (freeCash.value
  // acima) — a limitação documentada anteriormente (sem saldo bancário rastreado) foi fechada.
  const saidasObrigatorias = report.overdue.payable.total + report.dueNextSevenDays.payable.total;
  const entradasProvaveis = report.dueNextSevenDays.receivable.total;
  report.breathingNeed = {
    value: round2(saidasObrigatorias - report.freeCash.value - entradasProvaveis),
    excludesFreeCashBalance: false,
  };

  return report;
}

/**
 * countOverdueEntries — contagem direta no banco de contas vencidas (PENDING com vencimento no
 * passado), útil para alerta/monitoramento sem carregar o relatório inteiro.
 */
async function countOverdueEntries(transaction, now = new Date()) {
  return FinancialEntry.count({
    where: {
      status: 'PENDING',
      isThirdPartyFunds: false,
      nature: { [Op.in]: ['PAYABLE', 'RECEIVABLE'] },
      dueAt: { [Op.lt]: startOfBusinessDay(now) },
    },
    transaction,
  });
}

module.exports = { getWeeklyHealthReport, countOverdueEntries };
