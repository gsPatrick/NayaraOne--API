'use strict';

// Fontes das obras para os testes da M9-D618. Data-base 28/10/2026 (SP). Obra P1 é a completa; P3 tem orçamento só na obra e gasto acima do orçado.
const bi = require('./biObrasJuridicoEnv');

const at = (day, hour = 15) => `2026-${day}T${String(hour).padStart(2, '0')}:00:00Z`;

async function obraCompleta(env, t) {
  const p1 = await bi.seed(env, t, 'construction.projects', { name: 'Obra Aurora', status: 'ACTIVE', starts_at: at('09-18'), ends_at_planned: at('12-28'), budget_amount: '1000000.00' });
  const s1 = await bi.seed(env, t, 'construction.project_stages', { project_id: p1, name: 'Fundação', sequence: 1, planned_cost: '600000.00', planned_pct: '50', measured_pct: '40', status: 'IN_PROGRESS', ends_at: at('10-20') });
  const s2 = await bi.seed(env, t, 'construction.project_stages', { project_id: p1, name: 'Estrutura', sequence: 2, planned_cost: '400000.00', planned_pct: '20', measured_pct: '10', status: 'IN_PROGRESS', ends_at: at('11-30') });
  await bi.seed(env, t, 'construction.project_stages', { project_id: p1, name: 'Acabamento', sequence: 3, planned_pct: '0', measured_pct: '0', status: 'PENDING' });
  await bi.seed(env, t, 'construction.budgets', { project_id: p1, status: 'APPROVED', total_amount: '900000.00', baseline_amount: '900000.00', approved_at: at('09-20') });
  return { p1, s1, s2 };
}

/** Lançamentos de P1: só os dois primeiros somam (150.000,50). */
async function ledgerP1(env, t, p1) {
  const base = { entry_type: 'DEBIT', nature: 'PAYABLE', construction_project_id: p1 };
  const ids = [];
  const rows = [
    { amount: '100000.00', status: 'SETTLED', settled_at: at('10-10') },
    { amount: '50000.50', status: 'SETTLED', settled_at: at('10-20') },
    { amount: '7000.00', status: 'SETTLED', settled_at: at('10-12'), is_third_party_funds: true },
    { amount: '9000.00', status: 'PENDING', due_at: at('11-05') },
    { amount: '3000.00', status: 'SETTLED', settled_at: at('10-29', 12) }, // depois do fim do dia-base
    { amount: '1000.00', status: 'REVERSED', settled_at: at('10-02') },
    { amount: '1000.00', status: 'SETTLED', settled_at: at('10-03'), reversal_of_entry_id: bi.uuid() },
    { amount: '800.00', status: 'SETTLED', settled_at: at('10-04'), nature: 'RECEIVABLE', entry_type: 'CREDIT' },
  ];
  for (const r of rows) ids.push(await bi.seed(env, t, 'finance.financial_entries', { ...base, ...r }));
  return ids;
}

async function contratosP1(env, t, p1) {
  const base = { contract_type: 'CONSTRUCTION', construction_project_id: p1 };
  const ids = {};
  ids.active = await bi.seed(env, t, 'legal.contracts', { ...base, status: 'ACTIVE', total_value: '1200000.00' });
  ids.signed = await bi.seed(env, t, 'legal.contracts', { ...base, status: 'SIGNED', total_value: '300000.00' });
  ids.draft = await bi.seed(env, t, 'legal.contracts', { ...base, status: 'DRAFT', total_value: '500000.00' });
  ids.terminated = await bi.seed(env, t, 'legal.contracts', { ...base, status: 'TERMINATED', total_value: '111.00' });
  return ids;
}

/** P3: orçamento só na obra (100.000,00), 50% medido e R$ 80.000,00 já pagos: o custo por % está acima do orçado (fator 1,6). */
async function obraEstourada(env, t) {
  const p3 = await bi.seed(env, t, 'construction.projects', { name: 'Obra Bela Vista', status: 'ACTIVE', starts_at: at('10-01'), ends_at_planned: at('12-01'), budget_amount: '100000.00' });
  await bi.seed(env, t, 'construction.project_stages', { project_id: p3, name: 'Única', sequence: 1, planned_cost: '100000.00', planned_pct: '60', measured_pct: '50', status: 'IN_PROGRESS', ends_at: at('11-15') });
  await bi.seed(env, t, 'finance.financial_entries', { entry_type: 'DEBIT', nature: 'PAYABLE', construction_project_id: p3, amount: '80000.00', status: 'SETTLED', settled_at: at('10-15') });
  return p3;
}

/** Medições de P1 na etapa s1: medido 240.000, aprovado 180.000, pendente 60.000 (mais antiga enviada em 05/10). */
async function medicoes(env, t, s1) {
  const base = { project_stage_id: s1, measured_pct: '10', measured_at: '2026-10-01' };
  const rows = [
    { status: 'APPROVED', total_amount: '100000.00', submitted_at: at('10-01') }, { status: 'PAYABLE', total_amount: '80000.00', submitted_at: at('10-02') },
    { status: 'SUBMITTED', total_amount: '40000.00', submitted_at: at('10-05') }, { status: 'REVIEWED', total_amount: '20000.00', submitted_at: at('10-10') },
    { status: 'DRAFT', total_amount: '7000.00' }, { status: 'REJECTED', total_amount: '5000.00', submitted_at: at('10-03') }, { status: 'SUPERSEDED', total_amount: '3000.00', submitted_at: at('10-04') },
  ];
  // Medição PAYABLE sempre aponta para a conta a pagar (CHECK stage_measurements_payable_has_entry, verificação do Marco 6):
  // a conta nasce sem obra e em aberto, para não mexer no custo realizado nem no ledger da obra que os testes conferem.
  const conta = await bi.seed(env, t, 'finance.financial_entries', { entry_type: 'DEBIT', nature: 'PAYABLE', amount: '80000.00', status: 'PENDING' });
  const ids = [];
  for (const r of rows) ids.push(await bi.seed(env, t, 'construction.stage_measurements', { ...base, ...r, ...(r.status === 'PAYABLE' ? { payable_financial_entry_id: conta } : {}) }));
  return ids;
}

/** Não conformidades de P1 (ver a tabela de resultados em m9d618.numeros.test.js). */
async function naoConformidades(env, t, p1) {
  const base = { project_id: p1, description: 'Desvio de qualidade' };
  const rows = [
    { status: 'OPEN', cause_code: 'MATERIAL', team_label: 'Equipe A', created_at: at('10-15') },
    { status: 'OPEN', created_at: at('10-16') },
    { status: 'CLOSED', cause_code: 'MATERIAL', team_label: 'Equipe A', created_at: at('10-10'), closed_at: at('10-20') },
    { status: 'CLOSED', cause_code: 'MATERIAL', team_label: 'Equipe A', created_at: at('08-01'), closed_at: at('09-01') }, // fora da janela
    { status: 'CLOSED', created_at: at('10-26'), closed_at: at('10-28') },
    { status: 'CLOSED', cause_code: 'PROJETO', team_label: 'Equipe B', created_at: at('09-20'), closed_at: at('09-29') }, // 1º dia da janela de 30 dias
    { status: 'CLOSED', cause_code: 'PROJETO', team_label: 'Equipe B', created_at: at('09-20'), closed_at: at('09-28') }, // um dia antes: fora
  ];
  const ids = [];
  for (const r of rows) ids.push(await bi.seed(env, t, 'construction.nonconformities', { ...base, ...r }));
  return ids;
}

module.exports = { at, obraCompleta, ledgerP1, contratosP1, obraEstourada, medicoes, naoConformidades };
