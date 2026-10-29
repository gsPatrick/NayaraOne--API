'use strict';

/**
 * M9-D622 (3.3) — detalhe das entradas próprias vencidas (a receber, PENDING, sem estorno, vencimento anterior a hoje) do read model financeiro, para o valor
 * inadimplente e a taxa de inadimplência saírem por faixa de atraso e por contrato. Guarda a janela usada (`windowDays`, a mesma do agregado), o total, a
 * contagem, a soma por dia de vencimento de São Paulo com os dias de atraso (a fórmula aplica as faixas do administrador sem voltar ao OLTP) e, por contrato,
 * o valor vencido e o que cai dentro da janela. Só ids técnicos e valores: nenhum nome entra aqui. Dinheiro de terceiros fica de fora.
 */
const { sequelize } = require('../../../models');
const { calendarDaysBetween } = require('../metrics/period.calendar');

const SP = "AT TIME ZONE 'America/Sao_Paulo'";
const OVERDUE = "company_id = :companyId AND status = 'PENDING' AND nature = 'RECEIVABLE' AND NOT is_third_party_funds AND reversal_of_entry_id IS NULL AND due_at IS NOT NULL AND due_at < :today";
const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

async function readOverdueReceivablesDetail(companyId, { today, windowStart }, windowDays, asOf, transaction) {
  const r = { companyId, today: today.toISOString(), windowStart: windowStart.toISOString() };
  const [total] = await rows(`SELECT COALESCE(SUM(amount), 0)::text AS total, count(*)::int AS n FROM finance.financial_entries WHERE ${OVERDUE}`, r, transaction);
  const byDay = await rows(
    `SELECT (due_at ${SP})::date::text AS day, count(*)::int AS n, SUM(amount)::text AS total FROM finance.financial_entries WHERE ${OVERDUE} GROUP BY 1 ORDER BY 1`, r, transaction);
  const byContract = await rows(
    `SELECT contract_id::text AS k, SUM(amount)::text AS total, COALESCE(SUM(amount) FILTER (WHERE due_at >= :windowStart), 0)::text AS in_window
       FROM finance.financial_entries WHERE ${OVERDUE} GROUP BY 1 ORDER BY 1`, r, transaction);
  const contracts = {};
  let withoutContract = { amount: '0', inWindow: '0' };
  for (const c of byContract) {
    if (c.k === null) withoutContract = { amount: c.total, inWindow: c.in_window };
    else contracts[c.k] = { amount: c.total, inWindow: c.in_window };
  }
  return {
    windowDays, total: total.total, count: total.n, withoutContract, byContract: contracts,
    byAge: byDay.map((d) => ({ date: d.day, count: d.n, amount: d.total, lateDays: Math.max(1, calendarDaysBetween(d.day, asOf)) })),
  };
}

module.exports = { readOverdueReceivablesDetail };
