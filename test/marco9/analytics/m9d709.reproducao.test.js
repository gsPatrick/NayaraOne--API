'use strict';

// M9-D709 — as quatro filas de decisão: o número do KPI (pela rota real) bate com o recálculo independente só pelas linhas das tabelas de origem, unidade a
// unidade e centavo a centavo; a fila NAY só tem recomendação com ação proposta. Banco descartável (127.0.0.1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d709Env');
require('../../../src/features/analytics'); // entrada real do BI: registra o read model e liga os KPIs

let env;
before(async () => { env = await e.setup(); });
after(() => e.teardown(env));

const one = async (sql, c) => (await env.admin.query(sql, { replacements: { c } }))[0][0];

test('m9d709 reproduz fin.approvals_pending a partir dos registros-fonte', async () => {
  const t = env.cX;
  const ids = [await e.finApproval(env, t, { amount: '12000.00', hours: 80 }), await e.finApproval(env, t, { amount: '8500.00', hours: 3 }), await e.finApproval(env, t, { amount: null, hours: 2 })];
  await e.finApproval(env, t, { amount: '999.00', status: 'APPROVED' }); // decidida: fora
  await e.finApproval(env, t, { amount: '777.00', status: 'STALE' }); // obsoleta: fora
  for (const id of ids) await e.applyKind(t, 'FIN_APPROVAL', id);
  await e.materialize(t);
  const want = await one(`SELECT count(*)::int AS n, COALESCE(SUM(f.amount), 0)::text AS total FROM finance.approval_requests a
    LEFT JOIN finance.financial_entries f ON a.related_entity_type = 'FinancialEntry' AND f.id = a.related_entity_id WHERE a.company_id = :c AND a.status = 'PENDING'`, t.companyId);
  const main = await e.get(env, 'fin.approvals_pending');
  assert.equal(main.status, 200, JSON.stringify(main.body));
  assert.equal(Number(main.body.data.value), want.n, 'a contagem do endpoint bate com a das linhas-fonte');
  assert.equal(Number(main.body.data.value), 3, 'exemplo do livro: 3 aprovações (12.000,00, 8.500,00 e uma sem valor)');
  assert.deepEqual([main.body.data.unit, main.body.data.status, main.body.data.version, main.body.data.owner], ['COUNT', 'OK', 1, 'Diretoria Financeira (papel financeiro-gestor)']);
  const money = await env.admin.query("SELECT value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code = 'fin.approvals_pending' AND s.dimension_key = 'valor_brl'", { replacements: { c: t.companyId } });
  assert.equal(money[0][0].v, '20500.0000');
  assert.equal(Number(money[0][0].v).toFixed(2), Number(want.total).toFixed(2), 'o valor em BRL bate com a soma das linhas-fonte: 12.000,00 + 8.500,00 + 0');
  const aged = await env.admin.query("SELECT value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code = 'fin.approvals_pending' AND s.dimension_key = 'envelhecidas_qtd'", { replacements: { c: t.companyId } });
  assert.equal(Number(aged[0][0].v), 1, 'só a de 80 h passa das 48 h do padrão');
});

test('m9d709 reproduz inv.adjustments_pending a partir dos registros-fonte', async () => {
  const t = env.cY;
  const a = await e.invProposal(env, t, { quantity: '10', cost: '12.50' });
  const b = await e.invProposal(env, t, { quantity: '4', cost: '30.00' });
  await e.invProposal(env, t, { quantity: '1', cost: '99.00', status: 'APPROVED' }); // decidida: fora
  for (const id of [a, b]) await e.applyKind(t, 'INV_ADJUSTMENT', id);
  await e.materialize(t);
  const want = await one(`SELECT count(*)::int AS n, round(COALESCE(SUM(abs(p.quantity) * i.average_cost), 0), 2)::text AS total FROM inventory.adjustment_proposals p
    JOIN inventory.inventory_items i ON i.id = p.inventory_item_id WHERE p.company_id = :c AND p.status = 'PENDING'`, t.companyId);
  const res = await e.get(env, 'inv.adjustments_pending', { tenant: 'Y' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(Number(res.body.data.value), want.n);
  assert.equal(Number(res.body.data.value), 2);
  const money = await env.admin.query("SELECT value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code = 'inv.adjustments_pending' AND s.dimension_key = 'valor_brl'", { replacements: { c: t.companyId } });
  assert.equal(Number(money[0][0].v).toFixed(2), '245.00');
  assert.equal(want.total, '245.00', 'exemplo do livro: 10 un x 12,50 + 4 un x 30,00');
});

test('m9d709 reproduz tec.rule_approvals_pending a partir dos registros-fonte', async () => {
  const t = env.cX;
  const r = await e.ruleApproval(env, t);
  await e.ruleApproval(env, t, { status: 'APPROVED' });
  await e.applyKind(t, 'RULE_APPROVAL', r.id);
  await e.materialize(t);
  const want = await one("SELECT count(*)::int AS n FROM core.rule_approval_requests WHERE company_id = :c AND status = 'PENDING'", t.companyId);
  const res = await e.get(env, 'tec.rule_approvals_pending');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(Number(res.body.data.value), want.n);
  assert.equal(Number(res.body.data.value), 1, 'exemplo do livro: 1 pedido pendente => 1');
});

test('m9d709 reproduz ai.proposals_pending a partir dos registros-fonte', async () => {
  const t = env.cX;
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(await e.nayRecommendation(env, t, { agent: 'NAY_FINANCEIRA' }));
  for (let i = 0; i < 2; i += 1) ids.push(await e.nayRecommendation(env, t, { agent: 'NAY_COMERCIAL' }));
  await e.nayRecommendation(env, t, { status: 'ACCEPTED' }); // aceita: fora
  for (const id of ids) await e.applyKind(t, 'NAY_PROPOSAL', id);
  await e.materialize(t);
  const want = await one("SELECT count(*)::int AS n FROM ai.ai_recommendations WHERE company_id = :c AND status = 'PENDING' AND proposed_action IS NOT NULL", t.companyId);
  const res = await e.get(env, 'ai.proposals_pending', { query: `asOf=${e.bi.AS_OF}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(Number(res.body.data.value), want.n);
  assert.equal(Number(res.body.data.value), 5, 'exemplo do livro: 3 da NAY Financeira e 2 da NAY Comercial => 5');
  const by = await env.admin.query("SELECT s.dimension_key, s.value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code = 'ai.proposals_pending' AND s.dimension_key LIKE 'agente:%' ORDER BY 1", { replacements: { c: t.companyId } });
  assert.deepEqual(by[0].map((r) => [r.dimension_key, Number(r.v)]), [['agente:NAY_COMERCIAL', 2], ['agente:NAY_FINANCEIRA', 3]]);
});

test('m9d709 fila NAY_PROPOSAL so tem recomendacao com proposed_action', async () => {
  const t = env.cY;
  const informative = await e.nayRecommendation(env, t, { proposed: false }); // NEXT_ACTION, REQUIRES_CONFIRMATION ou HANDOFF: sem proposed_action
  const proposal = await e.nayRecommendation(env, t, { proposed: true });
  await e.applyKind(t, 'NAY_PROPOSAL', informative);
  await e.applyKind(t, 'NAY_PROPOSAL', proposal);
  const rows = await e.queueRows(env, t, "AND kind = 'NAY_PROPOSAL'");
  assert.deepEqual(rows.map((r) => r.source_id), [proposal], 'a informativa nunca entra na fila');
  assert.equal(rows[0].status, 'PENDING');
  assert.equal(rows[0].has_sources, true);
});
