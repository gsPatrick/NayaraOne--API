'use strict';

// Cenário da M9-D650 (exemplo do livro) na empresa A, data-base 28/10/2026 (SP). Obra Aurora: baseline 980.000,00, planejado 62%, realizado 54%, custo
// real 560.000,00, receita 1.200.000,00 (forecast 1.037.037,04). Obra Bela Vista: orçamento só na obra (100.000,00), 60% x 50%, custo real 81.000,00
// (a liquidação às 23:30 de São Paulo, que já é dia seguinte em UTC, entra; a de 00:30 do dia 29 não), receita 250.000,00 (forecast 162.000,00).
// Entram também os lançamentos e contratos que NÃO podem contar.
const bi = require('./obraKpiEnv');
const { at } = require('./m9d618Obras');

const EXPECTED = Object.freeze({
  progress: { planned: '61.81', actual: '53.63', deviation: '-8.19' },
  aurora: { baseline: '980000.00', actual: '560000.00', forecast: '1037037.04', revenue: '1200000.00', margin: '162962.96', marginPct: '13.58' },
  bela: { baseline: '100000.00', actual: '81000.00', forecast: '162000.00', revenue: '250000.00', margin: '88000.00', marginPct: '35.20' },
  company: { baseline: '1080000.00', actual: '641000.00', forecast: '1199037.04', revenue: '1450000.00', margin: '250962.96', marginPct: '17.31' },
});

async function seedAurora(env, t) {
  const p = await bi.seed(env, t, 'construction.projects', { name: 'Obra Aurora', status: 'ACTIVE', starts_at: at('09-18'), ends_at_planned: at('12-28'), budget_amount: '1000000.00' });
  const stage = await bi.seed(env, t, 'construction.project_stages', { project_id: p, name: 'Única', sequence: 1, planned_cost: '980000.00', planned_pct: '62', measured_pct: '54', status: 'IN_PROGRESS', ends_at: at('11-30') });
  await bi.seed(env, t, 'construction.budgets', { project_id: p, status: 'APPROVED', total_amount: '980000.00', baseline_amount: '980000.00', approved_at: at('09-20') });
  const base = { entry_type: 'DEBIT', nature: 'PAYABLE', construction_project_id: p };
  const rows = [
    { amount: '400000.00', status: 'SETTLED', settled_at: at('10-10') }, { amount: '160000.00', status: 'SETTLED', settled_at: at('10-20') },
    { amount: '7000.00', status: 'SETTLED', settled_at: at('10-12'), is_third_party_funds: true }, { amount: '9000.00', status: 'PENDING', due_at: at('11-05') },
    { amount: '3000.00', status: 'SETTLED', settled_at: at('10-29', 12) }, { amount: '1000.00', status: 'REVERSED', settled_at: at('10-02') },
    { amount: '1500.00', status: 'CANCELLED' }, { amount: '1000.00', status: 'SETTLED', settled_at: at('10-03'), reversal_of_entry_id: bi.uuid() },
    { amount: '800.00', status: 'SETTLED', settled_at: at('10-04'), nature: 'RECEIVABLE', entry_type: 'CREDIT' },
  ];
  const ledger = [];
  for (const r of rows) ledger.push(await bi.seed(env, t, 'finance.financial_entries', { ...base, ...r }));
  const contract = { contract_type: 'CONSTRUCTION', construction_project_id: p };
  await bi.seed(env, t, 'legal.contracts', { ...contract, status: 'ACTIVE', total_value: '1200000.00' });
  await bi.seed(env, t, 'legal.contracts', { ...contract, status: 'DRAFT', total_value: '500000.00' });
  await bi.seed(env, t, 'legal.contracts', { ...contract, status: 'TERMINATED', total_value: '111.00' });
  return { id: p, stage, ledger };
}

async function seedBela(env, t) {
  const p = await bi.seed(env, t, 'construction.projects', { name: 'Obra Bela Vista', status: 'ACTIVE', starts_at: at('10-01'), ends_at_planned: at('12-01'), budget_amount: '100000.00' });
  const stage = await bi.seed(env, t, 'construction.project_stages', { project_id: p, name: 'Única', sequence: 1, planned_cost: '100000.00', planned_pct: '60', measured_pct: '50', status: 'IN_PROGRESS', ends_at: at('11-15') });
  const base = { entry_type: 'DEBIT', nature: 'PAYABLE', construction_project_id: p, status: 'SETTLED' };
  await bi.seed(env, t, 'finance.financial_entries', { ...base, amount: '80000.00', settled_at: at('10-15') });
  await bi.seed(env, t, 'finance.financial_entries', { ...base, amount: '1000.00', settled_at: '2026-10-29T02:30:00Z' }); // 28/10 23:30 em São Paulo
  await bi.seed(env, t, 'finance.financial_entries', { ...base, amount: '2000.00', settled_at: '2026-10-29T03:30:00Z' }); // 29/10 00:30 em São Paulo: fora
  await bi.seed(env, t, 'legal.contracts', { contract_type: 'CONSTRUCTION', construction_project_id: p, status: 'ACTIVE', total_value: '250000.00' });
  return { id: p, stage };
}

/** Grava as duas obras, aplica os eventos reais e calcula os KPIs. Devolve { aurora, bela }. */
async function seedAll(env, t) {
  const aurora = await seedAurora(env, t);
  const bela = await seedBela(env, t);
  await bi.refresh(t, [aurora, bela]);
  await bi.kpis(t);
  return { aurora, bela };
}

module.exports = { EXPECTED, seedAurora, seedBela, seedAll };
