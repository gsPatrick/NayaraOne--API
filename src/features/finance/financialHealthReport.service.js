'use strict';

const { Op } = require('sequelize');

const { FinancialEntry } = require('../../models');

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
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const pendingEntries = await FinancialEntry.findAll({
    where: { status: 'PENDING' },
    transaction,
  });

  const report = {
    generatedAt: now.toISOString(),
    windowEndsAt: horizon.toISOString(),
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
      if (dueAt < now) {
        report.overdue[bucket].count += 1;
        report.overdue[bucket].total += amount;
      } else if (dueAt <= horizon) {
        report.dueNextSevenDays[bucket].count += 1;
        report.dueNextSevenDays[bucket].total += amount;
      }
    }
  }

  report.payablePending.total = round2(report.payablePending.total);
  report.receivablePending.total = round2(report.receivablePending.total);
  report.thirdPartyFunds.total = round2(report.thirdPartyFunds.total);
  for (const bucket of ['payable', 'receivable']) {
    report.overdue[bucket].total = round2(report.overdue[bucket].total);
    report.dueNextSevenDays[bucket].total = round2(report.dueNextSevenDays[bucket].total);
  }
  report.overdue.total = round2(report.overdue.payable.total + report.overdue.receivable.total);
  report.projectedNetBalance = round2(report.receivablePending.total - report.payablePending.total);

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
      dueAt: { [Op.lt]: now },
    },
    transaction,
  });
}

module.exports = { getWeeklyHealthReport, countOverdueEntries };
