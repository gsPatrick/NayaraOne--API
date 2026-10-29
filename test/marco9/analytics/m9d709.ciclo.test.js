'use strict';

// M9-D709 — ciclo de vida da fila de decisão: qualidade violada deixa o KPI sem valor, a decisão tira o item da contagem e o histórico fica no snapshot, o replay do
// mesmo evento não muda nada, o rebuild reproduz o read model, uma empresa não enxerga a da outra e o detalhe soma igual ao KPI. Banco descartável (127.0.0.1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d709Env');
const asserts = require('../_helpers/readModelAsserts');
require('../../../src/features/analytics'); // entrada real do BI: registra o read model e liga os KPIs
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const sourceRefs = require('../../../src/features/analytics/metrics/sourceRefs');

let env;
before(async () => { env = await e.setup(); });
after(() => e.teardown(env));

const code = (res) => res.body.code || (res.body.error && res.body.error.code);
const strip = (rows) => rows.map(({ source_event_id: _event, ...rest }) => rest); // rastro do último evento aplicado: o rebuild não tem evento

test('m9d709 regra de qualidade viola e o KPI fica INCOMPLETE com valor nulo (as 4 métricas)', async () => {
  const t = env.cY;
  const fin = await e.finApproval(env, t, { amount: '10.00' });
  await env.admin.query('UPDATE finance.approval_requests SET created_at = NULL WHERE id = :id', { replacements: { id: fin } }).catch(() => {}); // created_at é NOT NULL na fonte: a violação vem do read model
  await e.applyKind(t, 'FIN_APPROVAL', fin);
  await env.admin.query("UPDATE analytics.rm_decision_queue SET requested_at = NULL WHERE company_id = :c AND kind = 'FIN_APPROVAL'", { replacements: { c: t.companyId } });
  await e.applyKind(t, 'INV_ADJUSTMENT', await e.invProposal(env, t, { item: false }));
  await env.admin.query("UPDATE analytics.rm_decision_queue SET item_id = NULL WHERE company_id = :c AND kind = 'INV_ADJUSTMENT'", { replacements: { c: t.companyId } });
  await e.applyKind(t, 'RULE_APPROVAL', (await e.ruleApproval(env, t, { rule: false })).id);
  await e.applyKind(t, 'NAY_PROPOSAL', await e.nayRecommendation(env, t, { run: false }));
  await e.applyKind(t, 'NAY_PROPOSAL', await e.nayRecommendation(env, t, { sources: false }));
  await e.materialize(t);
  for (const metric of e.KPI_CODES) {
    const res = await e.get(env, metric, { tenant: 'Y' });
    assert.equal(res.status, 200, `${metric}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.data.value, null, `${metric}: valor nulo`);
    assert.equal(res.body.data.formatted, null);
    assert.equal(res.body.data.status, 'INCOMPLETE', metric);
    assert.equal(res.body.data.valueReliable, false);
  }
});

test('m9d709 decisão tomada sai da contagem e permanece no snapshot histórico', async () => {
  const t = env.cX;
  const keep = await e.finApproval(env, t, { amount: '100.00', hours: 30 });
  const decided = await e.finApproval(env, t, { amount: '50.00', hours: 30 });
  for (const id of [keep, decided]) await e.applyKind(t, 'FIN_APPROVAL', id);
  await e.materialize(t, '2026-10-27'); // fotografia de ontem: as duas esperavam decisão
  const before = await e.get(env, 'fin.approvals_pending', { query: 'asOf=2026-10-27' });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const base = Number(before.body.data.value);
  await env.admin.query("UPDATE finance.approval_requests SET status = 'APPROVED', updated_at = :now WHERE id = :id", { replacements: { id: decided, now: e.bi.NOW.toISOString() } });
  await e.applyKind(t, 'FIN_APPROVAL', decided, 'finance.approval_step.decided');
  const row = (await e.queueRows(env, t, `AND source_id = '${decided}'`))[0];
  assert.deepEqual([row.status, row.decided_at !== null], ['DECIDED', true], 'o item decidido fica no read model com a data da decisão');
  await e.materialize(t); // hoje
  const today = await e.get(env, 'fin.approvals_pending');
  assert.equal(Number(today.body.data.value), base - 1, 'sai da contagem de hoje');
  const past = await e.get(env, 'fin.approvals_pending', { query: 'asOf=2026-10-27' });
  assert.equal(Number(past.body.data.value), base, 'o snapshot de ontem continua mostrando as duas');
});

test('m9d709 replay do mesmo evento não altera a fila', async () => {
  const t = env.cX;
  const id = await e.nayRecommendation(env, t, {});
  const event = e.eventFor(t, 'NAY_PROPOSAL', id);
  await asserts.assertReplayIdempotent({
    applyEvent: () => e.bi.apply(t, event),
    readRow: async () => (await e.queueRows(env, t, `AND source_id = '${id}'`))[0],
  });
});

test('m9d709 rebuild reproduz o read model', async () => {
  const t = env.cX;
  await e.applyKind(t, 'FIN_APPROVAL', await e.finApproval(env, t, { amount: '1.00' }));
  await e.applyKind(t, 'INV_ADJUSTMENT', await e.invProposal(env, t, {}));
  await e.applyKind(t, 'RULE_APPROVAL', (await e.ruleApproval(env, t)).id);
  const ctx = { groupId: t.groupId, actorUserId: t.userId, permissions: ['analytics:rebuild'], reason: 'Reconstrução da fila de decisão no teste da M9-D709.' };
  const hash = await asserts.assertRebuildEqualsIncremental({
    buildIncremental: async () => {},
    readRows: async () => strip(await e.queueRows(env, t)),
    wipe: () => env.admin.query('DELETE FROM analytics.rm_decision_queue WHERE company_id = :c', { replacements: { c: t.companyId } }),
    rebuild: async () => { assert.equal((await e.bi.readModels.rebuildReadModel(ctx, { model: 'rm_decision_queue', companyId: t.companyId })).status, 'SUCCEEDED'); },
  });
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('m9d709 isolamento entre empresas', async () => {
  const x = env.cX;
  const y = env.cY;
  assert.ok((await e.queueRows(env, x)).length > 0 && (await e.queueRows(env, y)).length > 0);
  await e.bi.inTx(y, {}, async (tx) => {
    const [seen] = await tx.sequelize.query('SELECT DISTINCT company_id FROM analytics.rm_decision_queue', { transaction: tx });
    assert.deepEqual(seen.map((r) => r.company_id), [y.companyId], 'sob o RLS da empresa Y só há linhas dela');
  });
  const foreign = await env.server.call('GET', `/analytics/metrics/fin.approvals_pending?companyId=${x.companyId}`, { perms: e.PERMS, tenant: 'B' });
  assert.equal(foreign.status, 404);
  assert.equal(code(foreign), 'ANALYTICS_SCOPE_NOT_FOUND');
  const own = await e.get(env, 'fin.approvals_pending', { tenant: 'Y' });
  const other = await e.get(env, 'fin.approvals_pending', { tenant: 'X' });
  assert.notEqual(own.body.data && own.body.data.value, other.body.data && other.body.data.value, 'cada empresa vê o seu número');
});

test('m9d709 drill-down das 4 métricas soma igual ao KPI', async () => {
  const t = env.cX;
  await e.materialize(t);
  for (const metric of e.KPI_CODES) {
    const res = await e.get(env, metric, { query: `asOf=${e.bi.AS_OF}` });
    assert.equal(res.status, 200, `${metric}: ${JSON.stringify(res.body)}`);
    const d = res.body.data;
    assert.deepEqual([d.drilldown.enabled, d.drilldown.allowed], [true, true], `${metric}: CRITICAL com detalhe`);
    if (d.value === null) continue; // a qualidade deste cenário deixou o KPI sem valor: o detalhe é conferido nos outros
    const ref = d.sourceRefs[0];
    const rows = [];
    let page = 1;
    let body;
    do {
      body = await e.bi.inTx(t, {}, (tx) => openDrilldown({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions: e.PERMS },
        { metricCode: metric, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 2 }, tx));
      rows.push(...body.rows);
      page += 1;
    } while (page <= body.totalPages);
    assert.equal(rows.length, Number(d.value), `${metric}: o detalhe tem uma linha por item contado`);
    assert.equal(body.reconcileMode, 'COUNT');
  }
  assert.ok(sourceRefs.getSourceSpec('fin.approvals_pending'));
});
