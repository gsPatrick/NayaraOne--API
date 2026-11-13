'use strict';

const { sequelize } = require('../../../../models');
const { getWeeklyHealthReport } = require('./finance-health.service');

// Projeção de fluxo de caixa para as ferramentas do agente financeiro da camada de IA (M9-D036): somente leitura, sob o RLS da empresa do contexto. Cada valor
// sai rotulado REALIZADO (já aconteceu: caixa livre e o liquidado no mês), PREVISTO (lançamentos pendentes por janela de vencimento) ou
// ESTIMADO (necessidade de caixa, que é estimativa do relatório), como já faz o relatório determinístico do Marco 4. Nada é calculado pelo modelo.
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function settledThisMonth(transaction) {
  const rows = await sequelize.query(
    `SELECT nature, COALESCE(SUM(amount), 0)::numeric AS total
       FROM finance.financial_entries
      WHERE status = 'SETTLED' AND is_third_party_funds = false AND nature IN ('PAYABLE','RECEIVABLE') AND settled_at IS NOT NULL
        AND to_char(settled_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM')
      GROUP BY nature`,
    { transaction, type: sequelize.QueryTypes.SELECT }
  );
  const by = { RECEIVABLE: 0, PAYABLE: 0 };
  for (const r of rows) by[r.nature] = round2(r.total);
  return by;
}

const item = (indicator, label, nature, value) => ({ indicator, label, nature, value: round2(value) });

async function getCashflowProjection(transaction) {
  const report = await getWeeklyHealthReport(transaction);
  const settled = await settledThisMonth(transaction);
  /** @type {Array<[string, string, any]>} */
  const windows = [['7d', 'na próxima semana', report.dueNextSevenDays], ['30d', 'em até um mês', report.dueNext30Days], ['60d', 'em até dois meses', report.dueNext60Days]];
  const items = [
    item('caixa_livre', 'Caixa livre (extrato menos dinheiro de terceiros)', 'REALIZADO', report.freeCash.value),
    item('recebido_mes', 'Recebido no mês', 'REALIZADO', settled.RECEIVABLE),
    item('pago_mes', 'Pago no mês', 'REALIZADO', settled.PAYABLE),
    ...windows.flatMap(([key, label, w]) => [
      item(`receber_${key}`, `A receber ${label}`, 'PREVISTO', w.receivable.total),
      item(`pagar_${key}`, `A pagar ${label}`, 'PREVISTO', w.payable.total),
    ]),
    item('saldo_projetado', 'Saldo líquido projetado', 'PREVISTO', report.projectedNetBalance),
    item('necessidade_caixa', 'Necessidade de caixa para a próxima semana', 'ESTIMADO', report.breathingNeed.value),
  ];
  return { generatedAt: report.generatedAt, source: 'finance.weeklyHealthReport', items };
}

module.exports = { getCashflowProjection };
