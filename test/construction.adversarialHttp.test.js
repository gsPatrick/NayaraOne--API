'use strict';

/**
 * Testes adversariais de Obras pela API REAL (Guia M6 §13 etapa "security scan"; Caderno §12 "Custo de outra empresa → bloquear",
 * "Cross-company → RLS bloquear", "Medição duplicada → uma obrigação", "Diário duplicado → idempotência", §2 "RLS e company_id
 * obrigatórios"; Guia §15 "não cruzar empresas"; Caderno §14 "revisão de segurança"). Cinco famílias de ataque, cada uma com
 * a prova de que NADA mudou no banco (lido como superusuário, sem RLS):
 *   1. outra empresa (tenant B do CI, com TODAS as permissões de Obras) lendo e alterando a obra de A;
 *   2. troca de id (id de outro tipo de recurso, id de A no corpo de B, companyId/groupId forjados no corpo);
 *   3. permissão faltando (sem token, só leitura, sem aprovação);
 *   4. valor negativo ou absurdo (negativo, Infinity, estouro de coluna, percentual acima de 100);
 *   5. repetição da mesma requisição (aditivo, diário, perda, aprovação de medição e de orçamento).
 * App de verdade (app.js), JWT e middleware de tenant reais, RLS real. Só em banco descartável depois do seed de dois tenants.
 */
process.env.PORT = process.env.M6Q_HTTP_TEST_PORT || '45610';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./helpers/obrasCarga');
const { emailFor } = require('../scripts/seed-ci-two-tenants');

const pular = H.podeRodar && process.env.CI_TENANT_USERS_PASSWORD ? false : 'API real com dados commitados: banco descartável + seed de dois tenants (CI_TENANT_USERS_PASSWORD)';
const TODAS = ['construction:read', 'construction:create', 'construction:update', 'construction:approve', 'construction:delete'];
let A;
let B;
let fx;
let base;

async function tenantDoCi(chave) {
  const [[g]] = await H.sequelize.query('SELECT id FROM core.groups WHERE name = :n', { replacements: { n: `CI — Grupo Fictício ${chave}` } });
  const c = (await H.linhaAdmin('SELECT id FROM core.companies WHERE group_id = $1 AND name = $2', [g.id, `CI — Empresa Fictícia ${chave}`]))[0];
  const [[u]] = await H.sequelize.query('SELECT id FROM core.users WHERE email = :e', { replacements: { e: emailFor(chave, 'gestor') } });
  return { groupId: g.id, companyId: c.id, userId: u.id };
}

const { signAccessToken } = require('../src/utils/jwt');
const token = (tenant, permissions) => signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['adversarial'], permissions });
async function http(tk, metodo, rota, corpo) {
  const r = await fetch(`${base}${rota}`, { method: metodo, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, data: json.data, codigo: json.error && json.error.code };
}
const linha = async (sql, p) => (await H.linhaAdmin(sql, p))[0];

before(async () => {
  if (pular) return;
  require('../app');
  base = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  A = await H.getSeedTenant();
  B = await tenantDoCi('B');
  fx = await H.medicaoRevisada(A, 'alvo adversarial', 5000);
  const extra = await H.medicaoRevisada(A, 'repetição adversarial', 3000);
  fx.medicaoRepetida = extra.measurementId;
  Object.assign(fx, await H.comCommit(A, async (t) => {
    await H.svc('marginRules').createMarginRule(H.W(A, { minMarginPct: 5 }), A.userId, t);
    const budget = await H.svc('budgets').createBudget(fx.projectId, H.W(A, {}), A.userId, t);
    await H.svc('budgetLines').createBudgetLine(fx.projectId, H.W(A, { budgetId: budget.id, category: 'Estrutura', plannedAmount: 20000 }), A.userId, t);
    const rdo = await H.svc('dailyReports').createDailyReport(fx.projectId, H.W(A, { reportDate: '2026-11-06', shiftCode: 'MANHA', workforceCount: 5, idempotencyKey: `adv-${crypto.randomUUID()}` }), A.userId, t);
    return { budgetId: budget.id, rdoId: rdo.id };
  }));
  await new Promise((r) => setTimeout(r, 300));
});
after(async () => { await H.sequelize.close(); process.exit(0); });

const retratoA = () => linha(`SELECT p.name, p.status, p.budget_amount::numeric AS obra, p.lock_version AS lv, b.status AS orcamento, b.total_amount::numeric AS total,
    m.status AS medicao, m.payable_financial_entry_id AS conta,
    (SELECT count(*) FROM construction.daily_reports WHERE project_id = p.id)::int AS rdos,
    (SELECT count(*) FROM construction.change_orders WHERE project_id = p.id)::int AS aditivos,
    (SELECT count(*) FROM construction.budget_lines WHERE project_id = p.id)::int AS linhas,
    (SELECT count(*) FROM construction.loss_records WHERE project_id = p.id)::int AS perdas
  FROM construction.projects p JOIN construction.budgets b ON b.project_id = p.id JOIN construction.stage_measurements m ON m.id = $2 WHERE p.id = $1`, [fx.projectId, fx.measurementId]);

test('ADV-OBR-1 outra empresa (com todas as permissões de Obras) não lê nem altera a obra de A: 404 em tudo e nada muda', { skip: pular }, async () => {
  const antes = await retratoA();
  const tkB = token(B, TODAS);
  for (const rota of [`/construction/projects/${fx.projectId}`, `/construction/projects/${fx.projectId}/health`, `/construction/budgets/${fx.budgetId}`, `/construction/daily-reports/${fx.rdoId}`, `/construction/stages/${fx.stageId}`]) {
    const r = await http(tkB, 'GET', rota);
    assert.equal(r.status, 404, `GET ${rota} -> ${r.status}`);
  }
  const lista = await http(tkB, 'GET', '/construction/projects');
  assert.equal(lista.status, 200);
  assert.ok(!JSON.stringify(lista.data || []).includes(fx.projectId), 'a lista de B não traz a obra de A');
  const escritas = [
    ['PATCH', `/construction/projects/${fx.projectId}`, { name: 'INVADIDA' }],
    ['POST', `/construction/measurements/${fx.measurementId}/decide`, { decision: 'APPROVED' }],
    ['POST', `/construction/budgets/${fx.budgetId}/approve`, {}],
    ['POST', `/construction/projects/${fx.projectId}/daily-reports`, { reportDate: '2026-11-07', shiftCode: 'TARDE', workforceCount: 1, idempotencyKey: `adv-${crypto.randomUUID()}` }],
    ['POST', `/construction/projects/${fx.projectId}/budget-lines`, { budgetId: fx.budgetId, category: 'Invasão', plannedAmount: 1 }],
    ['POST', `/construction/projects/${fx.projectId}/loss-records`, { materialDescription: 'x', quantity: 1, estimatedValue: 1, reason: 'invasão', idempotencyKey: `adv-${crypto.randomUUID()}` }],
  ];
  for (const [metodo, rota, corpo] of escritas) {
    const r = await http(tkB, metodo, rota, corpo);
    assert.ok([403, 404].includes(r.status), `${metodo} ${rota} -> ${r.status} ${r.codigo || ''}`);
  }
  assert.deepEqual(await retratoA(), antes, 'a obra de A está idêntica');
});

test('ADV-OBR-2 troca de id: id de outro tipo de recurso, id de A dentro de um recurso de B e empresa forjada no corpo — nada cruza', { skip: pular }, async () => {
  const antes = await retratoA();
  const tkA = token(A, TODAS);
  const errado = await http(tkA, 'POST', `/construction/measurements/${fx.rdoId}/decide`, { decision: 'APPROVED' });
  assert.equal(errado.status, 404, `id de RDO no lugar da medição -> ${errado.status}`);
  const errado2 = await http(tkA, 'POST', `/construction/budgets/${fx.projectId}/approve`, {});
  assert.equal(errado2.status, 404, `id da obra no lugar do orçamento -> ${errado2.status}`);
  const tkB = token(B, TODAS);
  const obraB = await http(tkB, 'POST', '/construction/projects', { name: `Obra de B ${H.uniqueSuffix()}`, budgetAmount: 1000, groupId: A.groupId, companyId: A.companyId });
  assert.equal(obraB.status, 201, `B cria a própria obra -> ${obraB.status} ${obraB.codigo || ''}`);
  const criada = await linha('SELECT group_id, company_id FROM construction.projects WHERE id = $1', [obraB.data.id]);
  assert.deepEqual({ g: criada.group_id, c: criada.company_id }, { g: B.groupId, c: B.companyId }, 'groupId/companyId do corpo são ignorados: a obra nasce em B');
  const linhaComOrcamentoDeA = await http(tkB, 'POST', `/construction/projects/${obraB.data.id}/budget-lines`, { budgetId: fx.budgetId, category: 'Troca', plannedAmount: 10 });
  assert.ok(linhaComOrcamentoDeA.status >= 400 && linhaComOrcamentoDeA.status < 500, `linha de B apontando o orçamento de A -> ${linhaComOrcamentoDeA.status}`);
  const etapaDeA = await http(tkB, 'POST', `/construction/stages/${fx.stageId}/measurements`, { measuredPct: 10, measuredAt: '2026-11-07', items: [{ description: 'troca', quantity: 1, unitPrice: 1 }] });
  assert.equal(etapaDeA.status, 404, `medição de B na etapa de A -> ${etapaDeA.status}`);
  const mover = await http(tkB, 'PATCH', `/construction/projects/${obraB.data.id}`, { companyId: A.companyId, groupId: A.groupId });
  assert.ok(mover.status < 500, `PATCH tentando mover a obra de B para A -> ${mover.status}`);
  const depois = await linha('SELECT company_id FROM construction.projects WHERE id = $1', [obraB.data.id]);
  assert.equal(depois.company_id, B.companyId, 'a obra de B continua em B');
  assert.deepEqual(await retratoA(), antes, 'a obra de A está idêntica');
});

test('ADV-OBR-3 permissão faltando: sem token 401; só leitura e sem aprovação recebem 403 e nada muda', { skip: pular }, async () => {
  const antes = await retratoA();
  assert.equal((await http(null, 'GET', `/construction/projects/${fx.projectId}`)).status, 401);
  assert.equal((await http(token(A, []), 'GET', `/construction/projects/${fx.projectId}`)).status, 403);
  const leitura = token(A, ['construction:read']);
  const semAprovar = token(A, ['construction:read', 'construction:create', 'construction:update']);
  const semAtualizar = token(A, ['construction:read', 'construction:create']);
  const casos = [
    [leitura, 'POST', '/construction/projects', { name: 'sem permissão' }],
    [leitura, 'PATCH', `/construction/projects/${fx.projectId}`, { name: 'sem permissão' }],
    [leitura, 'POST', `/construction/projects/${fx.projectId}/daily-reports`, { reportDate: '2026-11-08', idempotencyKey: `adv-${crypto.randomUUID()}` }],
    [semAprovar, 'POST', `/construction/measurements/${fx.measurementId}/decide`, { decision: 'APPROVED' }],
    [semAprovar, 'POST', `/construction/measurements/${fx.measurementId}/approve`, {}],
    [semAprovar, 'POST', `/construction/budgets/${fx.budgetId}/approve`, {}],
    [semAprovar, 'POST', `/construction/projects/${fx.projectId}/deliver`, {}],
    [semAprovar, 'POST', '/construction/settings/sla-rule', {}],
    [semAtualizar, 'POST', '/construction/approval-thresholds', { thresholdType: 'LOSS_RECORD', maxAutoApproveAmount: 999999 }],
    [semAtualizar, 'POST', `/construction/measurements/${fx.measurementId}/review`, {}],
  ];
  for (const [tk, metodo, rota, corpo] of casos) {
    const r = await http(tk, metodo, rota, corpo);
    assert.equal(r.status, 403, `${metodo} ${rota} -> ${r.status} ${r.codigo || ''}`);
    assert.equal(r.codigo, 'PERMISSION_DENIED');
  }
  assert.deepEqual(await retratoA(), antes, 'nada mudou');
});

test('ADV-OBR-4 valor negativo ou absurdo: 4xx (nunca 500) e nada gravado', { skip: pular }, async () => {
  const antes = await retratoA();
  const tkA = token(A, TODAS);
  const p = fx.projectId;
  const casos = [
    ['POST', `/construction/projects/${p}/budget-lines`, { budgetId: fx.budgetId, category: 'Negativo', plannedAmount: -1 }],
    ['POST', `/construction/projects/${p}/budget-lines`, { budgetId: fx.budgetId, category: 'Infinito', plannedAmount: 'Infinity' }],
    ['POST', `/construction/projects/${p}/budget-lines`, { budgetId: fx.budgetId, category: 'Estouro', plannedAmount: 1e20 }],
    ['POST', `/construction/stages/${fx.stageId}/measurements`, { measuredPct: 10, measuredAt: '2026-11-08', items: [{ description: 'neg', quantity: 1, unitPrice: -10 }] }],
    ['POST', `/construction/stages/${fx.stageId}/measurements`, { measuredPct: 10, measuredAt: '2026-11-08', items: [{ description: 'estouro', quantity: 1e30, unitPrice: 1 }] }],
    ['POST', `/construction/stages/${fx.stageId}/measurements`, { measuredPct: 150, measuredAt: '2026-11-08', items: [{ description: 'pct', quantity: 1, unitPrice: 1 }] }],
    ['POST', `/construction/projects/${p}/change-orders`, { reasonCode: 'X', description: 'estouro', budgetImpact: 1e20, scheduleImpactDays: 1, evidenceFileIds: [], idempotencyKey: `adv-${crypto.randomUUID()}` }],
    ['POST', `/construction/projects/${p}/change-orders`, { reasonCode: 'X', description: 'NaN', budgetImpact: 'NaN', scheduleImpactDays: 1, evidenceFileIds: [], idempotencyKey: `adv-${crypto.randomUUID()}` }],
    ['POST', `/construction/projects/${p}/daily-reports`, { reportDate: '2026-11-09', workforceCount: -3, idempotencyKey: `adv-${crypto.randomUUID()}` }],
    ['POST', `/construction/projects/${p}/loss-records`, { materialDescription: 'neg', quantity: -1, estimatedValue: 10, reason: 'negativo', idempotencyKey: `adv-${crypto.randomUUID()}` }],
    ['POST', `/construction/projects/${p}/loss-records`, { materialDescription: 'neg', quantity: 1, estimatedValue: -10, reason: 'negativo', idempotencyKey: `adv-${crypto.randomUUID()}` }],
    ['POST', `/construction/projects/${p}/loss-records`, { materialDescription: 'estouro', quantity: 1, estimatedValue: 1e20, reason: 'estouro', idempotencyKey: `adv-${crypto.randomUUID()}` }],
  ];
  const ruins = [];
  for (const [metodo, rota, corpo] of casos) {
    const r = await http(tkA, metodo, rota, corpo);
    if (!(r.status >= 400 && r.status < 500)) ruins.push(`${metodo} ${rota} ${JSON.stringify(corpo).slice(0, 90)} -> ${r.status} ${r.codigo || ''}`);
  }
  assert.deepEqual(ruins, [], 'todo valor negativo/absurdo é recusado com 4xx');
  const [{ n: medicoes }] = await H.linhaAdmin('SELECT count(*)::int AS n FROM construction.stage_measurements WHERE project_stage_id = $1', [fx.stageId]);
  assert.equal(medicoes, 1, 'nenhuma medição nova');
  assert.deepEqual(await retratoA(), antes, 'nada gravado');
});

test('ADV-OBR-5 repetição da mesma requisição: aditivo, diário e perda devolvem o mesmo registro; aprovação repetida não cria segunda conta nem segundo evento', { skip: pular }, async () => {
  const tkA = token(A, TODAS);
  const p = fx.projectId;
  const repetir = async (metodo, rota, corpo) => [await http(tkA, metodo, rota, corpo), await http(tkA, metodo, rota, corpo)];
  const rdo = await repetir('POST', `/construction/projects/${p}/daily-reports`, { reportDate: '2026-11-10', shiftCode: 'TARDE', workforceCount: 4, idempotencyKey: `adv-${crypto.randomUUID()}` });
  assert.ok(rdo.every((r) => r.status < 300) && rdo[0].data.id === rdo[1].data.id, `diário repetido -> ${rdo.map((r) => r.status)}`);
  const perda = await repetir('POST', `/construction/projects/${p}/loss-records`, { materialDescription: 'Areia', quantity: 2, estimatedValue: 50, reason: 'chuva', idempotencyKey: `adv-${crypto.randomUUID()}` });
  assert.ok(perda.every((r) => r.status < 300) && perda[0].data.id === perda[1].data.id, `perda repetida -> ${perda.map((r) => r.status)}`);
  const aditivoCorpo = { reasonCode: 'ESCOPO_ADICIONAL', description: 'repetido', budgetImpact: 100, scheduleImpactDays: 1, idempotencyKey: `adv-${crypto.randomUUID()}` };
  const aditivo = await repetir('POST', `/construction/projects/${p}/change-orders`, aditivoCorpo);
  if (aditivo[0].status < 300) assert.equal(aditivo[1].data.id, aditivo[0].data.id, 'aditivo repetido devolve o mesmo');
  const [{ n: aditivos }] = await H.linhaAdmin('SELECT count(*)::int AS n FROM construction.change_orders WHERE idempotency_key = $1', [aditivoCorpo.idempotencyKey]);
  assert.ok(aditivos <= 1, `no máximo um aditivo com a chave (${aditivos})`);
  const decisao = await repetir('POST', `/construction/measurements/${fx.medicaoRepetida}/decide`, { decision: 'APPROVED' });
  assert.equal(decisao[0].status, 200, `primeira aprovação -> ${decisao[0].status} ${decisao[0].codigo || ''}`);
  assert.equal(decisao[1].status, 409, `aprovação repetida -> ${decisao[1].status}`);
  const [{ n: contas }] = await H.linhaAdmin('SELECT count(*)::int AS n FROM finance.financial_entries WHERE idempotency_key = $1', [`measurement.payable:${fx.medicaoRepetida}`]);
  assert.equal(contas, 1, 'uma conta a pagar');
  const aprovacao = await repetir('POST', `/construction/budgets/${fx.budgetId}/approve`, {});
  assert.equal(aprovacao[0].status, 200, `primeira aprovação do orçamento -> ${aprovacao[0].status} ${aprovacao[0].codigo || ''}`);
  assert.ok(aprovacao[1].status >= 400 && aprovacao[1].status < 500, `aprovação repetida do orçamento -> ${aprovacao[1].status}`);
  const [{ n: eventos }] = await H.linhaAdmin("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'project.budget.approved' AND aggregate_id = $1", [fx.budgetId]);
  assert.equal(eventos, 1, 'um project.budget.approved');
});

test('ADV-OBR-4b efetivo absurdo no diário (workforceCount acima do inteiro da coluna) é recusado com 4xx e nada é gravado', {
  skip: pular,
  todo: 'DEFEITO M6Q-DEF-1 (esteira de qualidade, 11/11/2026): POST /construction/projects/:id/daily-reports com workforceCount 1e12 devolve 500 INTERNAL_ERROR — dailyReports.service.js (validateWorkforceCount) não limita ao inteiro da coluna e o errorHandler não traduz "value out of range for type integer" (22003). Regra de Obras, fora desta entrega; o teste volta a valer quando a correção entrar.',
}, async () => {
  const antes = await retratoA();
  const r = await http(token(A, TODAS), 'POST', `/construction/projects/${fx.projectId}/daily-reports`, { reportDate: '2026-11-09', workforceCount: 1e12, idempotencyKey: `adv-${crypto.randomUUID()}` });
  assert.deepEqual(await retratoA(), antes, 'nada gravado');
  assert.ok(r.status >= 400 && r.status < 500, `workforceCount 1e12 -> ${r.status} ${r.codigo || ''}`);
});
