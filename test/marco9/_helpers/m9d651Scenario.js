'use strict';

// Cenário da M9-D651 (exemplo do livro) na empresa A, data-base 28/10/2026 (SP). Atrasos: 3 etapas atrasadas (12, 8 e 3 dias), máximo 12, média 7,7, em
// 2 obras. Medições: medido 220.000,00, aprovado 180.000,00, pendente 40.000,00 (a mais antiga enviada em 05/10). Não conformidades: 7 abertas, 11 fechadas
// no período e média de 9,4 dias. Entram também os registros que NÃO podem contar (concluída, 100% medida, vence hoje, futura, excluída, rascunho...).
const bi = require('./obraKpiEnv');
const { at } = require('./m9d618Obras');

const EXPECTED = Object.freeze({
  delays: { count: '3', max: '12', mean: '7.7', projects: '2' },
  measurements: { measured: '220000.00', approved: '180000.00', pending: '40000.00', oldestAge: '23' },
  nonconformities: { open: '7', opened: '16', closed: '11', mean: '9.4', byCause: { MATERIAL: '4', PROJETO: '3' } },
});

async function stage(env, t, project, n, extra) {
  return bi.seed(env, t, 'construction.project_stages', { project_id: project, name: `Etapa ${n}`, sequence: n, planned_cost: '1000.00', planned_pct: '50', status: 'IN_PROGRESS', ...extra });
}

async function seedStages(env, t) {
  const delta = await bi.seed(env, t, 'construction.projects', { name: 'Obra Delta', status: 'ACTIVE', starts_at: at('09-01'), ends_at_planned: at('12-30'), budget_amount: '100000.00' });
  const epsilon = await bi.seed(env, t, 'construction.projects', { name: 'Obra Epsilon', status: 'ACTIVE', starts_at: at('09-01'), ends_at_planned: at('12-30'), budget_amount: '100000.00' });
  const e1 = await stage(env, t, delta, 1, { ends_at: at('10-16'), measured_pct: '40' }); // 12 dias de atraso
  await stage(env, t, delta, 2, { ends_at: at('10-20') }); // 8 dias, nunca medida
  await stage(env, t, delta, 3, { ends_at: at('10-10'), status: 'DONE', measured_pct: '100' }); // concluída: não conta
  await stage(env, t, delta, 4, { ends_at: at('10-10'), measured_pct: '100' }); // 100% medida: não conta
  await stage(env, t, delta, 5, { ends_at: at('10-28') }); // vence hoje: ainda não está atrasada
  await stage(env, t, delta, 6, { ends_at: at('11-30') }); // futura
  await stage(env, t, delta, 7, { ends_at: at('10-01'), deleted_at: at('10-02') }); // excluída
  const f1 = await stage(env, t, epsilon, 1, { ends_at: at('10-25'), measured_pct: '20' }); // 3 dias
  return { delta, epsilon, e1, f1 };
}

async function payable(env, t, project, amount) {
  return bi.seed(env, t, 'finance.financial_entries', { entry_type: 'DEBIT', nature: 'PAYABLE', construction_project_id: project, amount, status: 'PENDING', due_at: at('11-10') });
}

async function seedMeasurements(env, t, { delta, e1 }) {
  const base = { project_stage_id: e1, measured_pct: '10', measured_at: '2026-10-01' };
  await bi.seed(env, t, 'construction.stage_measurements', { ...base, status: 'PAYABLE', total_amount: '100000.00', submitted_at: at('10-01'), payable_financial_entry_id: await payable(env, t, delta, '100000.00') });
  await bi.seed(env, t, 'construction.stage_measurements', { ...base, status: 'PAYABLE', total_amount: '80000.00', submitted_at: at('10-02'), payable_financial_entry_id: await payable(env, t, delta, '80000.00') });
  await bi.seed(env, t, 'construction.stage_measurements', { ...base, status: 'SUBMITTED', total_amount: '30000.00', submitted_at: at('10-05') });
  await bi.seed(env, t, 'construction.stage_measurements', { ...base, status: 'REVIEWED', total_amount: '10000.00', submitted_at: at('10-10') });
  await bi.seed(env, t, 'construction.stage_measurements', { ...base, status: 'DRAFT', total_amount: '7000.00' });
  await bi.seed(env, t, 'construction.stage_measurements', { ...base, status: 'REJECTED', total_amount: '5000.00', submitted_at: at('10-03') });
  await bi.seed(env, t, 'construction.stage_measurements', { ...base, status: 'SUPERSEDED', total_amount: '3000.00', submitted_at: at('10-04') });
}

async function seedNonconformities(env, t, project) {
  const nc = (extra) => bi.seed(env, t, 'construction.nonconformities', { project_id: project, description: 'Desvio de qualidade', ...extra });
  for (const created of ['10-15', '10-16', '10-17', '08-01']) await nc({ status: 'OPEN', cause_code: 'MATERIAL', team_label: 'Equipe A', created_at: at(created) });
  for (const created of ['10-18', '10-19', '09-01']) await nc({ status: 'OPEN', cause_code: 'PROJETO', team_label: 'Equipe B', created_at: at(created) });
  for (let i = 0; i < 6; i += 1) await nc({ status: 'CLOSED', cause_code: 'MATERIAL', team_label: 'Equipe A', created_at: at('10-11'), closed_at: at('10-20') }); // 9 dias
  for (let i = 0; i < 4; i += 1) await nc({ status: 'CLOSED', cause_code: 'PROJETO', team_label: 'Equipe B', created_at: at('10-11'), closed_at: at('10-20') }); // 9 dias
  await nc({ status: 'CLOSED', cause_code: 'PROJETO', team_label: 'Equipe B', created_at: at('10-05'), closed_at: at('10-18') }); // 13 dias
  await nc({ status: 'CLOSED', cause_code: 'PROJETO', team_label: 'Equipe B', created_at: at('08-01'), closed_at: at('09-01') }); // fechada fora da janela
  await nc({ status: 'OPEN', cause_code: 'MATERIAL', team_label: 'Equipe A', created_at: at('10-10'), deleted_at: at('10-11') }); // excluída
}

/** Grava tudo, aplica os eventos reais e calcula os KPIs. Devolve os ids. */
async function seedAll(env, t) {
  const ids = await seedStages(env, t);
  await seedMeasurements(env, t, ids);
  await seedNonconformities(env, t, ids.delta);
  await bi.refresh(t, [{ id: ids.delta, stage: ids.e1 }, { id: ids.epsilon, stage: ids.f1 }]);
  await bi.kpis(t);
  return ids;
}

module.exports = { EXPECTED, seedAll, seedStages, stage, payable };
