'use strict';

// Cenários da M9-D652 (exemplos do livro), data-base 28/10/2026 (quarta-feira, São Paulo). Desperdício: 9.000,00 + 5.000,00 = 14.000,00 sobre consumo de
// 200.000,00 + 80.000,00 = 280.000,00 (5,00%). Pós-obra: caso encerrado de 38.500,00 e caso aberto de 500,00 (previsto) em obra de 1.200.000,00 de receita
// (3,21%). Recorrência: infiltração da equipe B em 5 obras. Cada cenário também grava o que NÃO deve entrar.
const e = require('./m9d652Env');

const NIL = '00000000-0000-0000-0000-000000000000';
const at = (date, hour = 15) => `${date}T${String(hour).padStart(2, '0')}:00:00Z`;

const project = (env, t, name = 'Obra Aurora') => e.seed(env, t, 'construction.projects', { name, status: 'ACTIVE', starts_at: at('2026-09-18'), ends_at_planned: at('2026-12-28'), budget_amount: '1000000.00' });
const item = (env, t, name) => e.seed(env, t, 'inventory.inventory_items', { name, item_type: 'CONSUMABLE', status: 'ACTIVE', average_cost: '10.00' });

const movement = (env, t, p, i, type, totalCost, extra = {}) => e.seed(env, t, 'inventory.inventory_movements', {
  project_id: p, inventory_item_id: i, movement_type: type, quantity: '1', total_cost: totalCost, moved_at: at('2026-10-12'), ...extra,
});

/** Perdas e saídas da obra p: exemplo do livro + o que fica de fora (entrada, perda sem obra). Devolve os ids dos movimentos. */
async function seedWaste(env, t, p) {
  const [i1, i2] = [await item(env, t, 'Cimento'), await item(env, t, 'Areia')];
  const ids = [
    await movement(env, t, p, i1, 'LOSS', '9000.00'), await movement(env, t, p, i1, 'OUT', '200000.00'), await movement(env, t, p, i2, 'LOSS', '5000.00'), await movement(env, t, p, i2, 'OUT', '80000.00'),
    await movement(env, t, p, i1, 'IN', '300000.00'), await movement(env, t, null, i1, 'LOSS', '777.00'),
  ];
  return { ids, i1, i2 };
}

const warrantyCase = (env, t, p, extra) => e.seed(env, t, 'construction.maintenance_cases', { property_id: e.uuid(), project_id: p, description: 'Infiltração', status: 'CLOSED', created_at: at('2026-10-05'), ...extra });
const action = (env, t, c, extra) => e.seed(env, t, 'construction.warranty_actions', { warranty_case_id: c, description: 'Reparo', performed_at: at('2026-10-20'), ...extra });

/** Pós-obra da obra p: C1 encerrado (38.500,00), C2 aberto (500,00 previsto); contrato de 1.200.000,00. Devolve { c1, c2, contract }. */
async function seedPostwork(env, t, p) {
  const contract = await e.seed(env, t, 'legal.contracts', { contract_type: 'CONSTRUCTION', construction_project_id: p, status: 'ACTIVE', total_value: '1200000.00' });
  await e.seed(env, t, 'legal.contracts', { contract_type: 'CONSTRUCTION', construction_project_id: p, status: 'DRAFT', total_value: '999999.00' });
  const c1 = await warrantyCase(env, t, p, { root_cause_code: 'umidade', labor_cost: '1000.00', material_cost: '500.00' });
  await action(env, t, c1, { assigned_team: 'Equipe A', material_used: 'Tinta', cost: '30000.00' });
  await action(env, t, c1, { assigned_team: 'Equipe B', cost: '7000.00' });
  const c2 = await warrantyCase(env, t, p, { status: 'OPEN', root_cause_code: 'eletrica', labor_cost: '100.00' });
  await action(env, t, c2, { assigned_team: 'Equipe A', material_used: 'Fio', cost: '400.00' });
  return { c1, c2, contract };
}

const nonconformity = (env, t, p, createdAt, extra = {}) => e.seed(env, t, 'construction.nonconformities', { project_id: p, description: 'Desvio', status: 'OPEN', created_at: createdAt, ...extra });

/** Infiltração da equipe B em 5 obras (uma não conformidade em cada), de 1 a 5 de outubro. Devolve os ids das obras. */
async function seedInfiltration(env, t) {
  const projects = [];
  for (let i = 1; i <= 5; i += 1) {
    const p = await project(env, t, `Obra ${i}`);
    projects.push(p);
    await nonconformity(env, t, p, at(`2026-10-0${i}`), { cause_code: 'infiltracao', team_label: 'Equipe B' });
  }
  return projects;
}

/** Atualiza os read models de Obras da empresa: um evento por obra (movimento, caso, não conformidade e contrato). */
async function refreshProject(t, p, ids = {}) {
  await e.apply(t, 'project.created', { id: p });
  for (const id of ids.movements || []) await e.apply(t, 'inventory.movement.recorded', { id });
  for (const id of ids.cases || []) await e.apply(t, 'warranty.case.opened', { id });
  await e.apply(t, 'nonconformity.opened', { projectId: p });
  if (ids.contract) await e.apply(t, 'contract.activated', { id: ids.contract });
}

module.exports = { NIL, at, project, item, movement, seedWaste, warrantyCase, action, seedPostwork, nonconformity, seedInfiltration, refreshProject };
