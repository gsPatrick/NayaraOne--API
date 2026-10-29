'use strict';

// M9-D619 — replay do mesmo evento e atomicidade: o helper compartilhado assertReplayIdempotent (M9-D607) sobre cada um dos sete read models.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biObrasJuridicoEnv');
const asserts = require('../_helpers/readModelAsserts');
const sc = require('../_helpers/m9d619Scenario');

let env;
let ids;
before(async () => {
  env = await bi.setup(sc.MODELS);
  ids = await sc.seedAll(env, env.tenantA);
});
after(() => bi.teardown(env));

const CASES = [
  ['legal.deadline.created', (i) => ({ id: i.deadlines.d1, legalCaseId: i.cases.k1 }), ['rm_legal_deadlines']],
  ['legal.case.updated', (i) => ({ id: i.cases.k1 }), ['rm_legal_cases_risk', 'rm_legal_values']],
  ['legal.contract_requirement.updated', (i) => ({ id: i.reqs.r1, contractId: i.reqs.c1 }), ['rm_legal_missing_docs']],
  ['financing.status.changed', (i) => ({ id: i.fin.f1, status: 'UNDER_ANALYSIS' }), ['rm_fin_cases_stage']],
  ['financing.approved', (i) => ({ id: i.fin.f3 }), ['rm_fin_provider_outcome']],
  ['commission.confirmed', (i) => ({ id: i.commissions.confirmed }), ['rm_fin_commission']],
];

test('m9d619 replay do mesmo evento não duplica', async () => {
  const covered = new Set();
  for (const [type, payloadOf, models] of CASES) {
    const event = bi.makeEvent(env.tenantA, type, payloadOf(ids));
    const snapshot = async () => Object.fromEntries(await Promise.all(models.map(async (m) => [m, await bi.rowsOf(env, m, env.tenantA)])));
    const { first, before: rows } = await asserts.assertReplayIdempotent({ applyEvent: () => bi.apply(env.tenantA, event), readRow: snapshot });
    assert.ok(first.upserted >= models.length, `${type} aplicou em ${models.join(', ')}`);
    for (const m of models) { assert.ok(rows[m].length >= 1, `${m} tem linha`); covered.add(m); }
  }
  assert.deepEqual([...covered].sort(), [...sc.MODELS].sort(), 'os sete read models passaram pelo replay');
});

test('m9d619 erro no meio desfaz a atualização', async () => {
  const target = bi.readModels.getReadModel('rm_legal_values'); // o segundo dos dois que o evento de processo atualiza
  const original = target.recompute;
  const event = bi.makeEvent(env.tenantA, 'legal.case.created', { id: ids.cases.k2 });
  const risk = await bi.rowsOf(env, 'rm_legal_cases_risk', env.tenantA);
  await env.admin.query("DELETE FROM analytics.rm_legal_cases_risk WHERE company_id = :c", { replacements: { c: env.tenantA.companyId } });
  target.recompute = async () => { throw Object.assign(new Error('falha simulada nos valores'), { code: 'M9D619_FALHA' }); };
  try {
    await assert.rejects(bi.apply(env.tenantA, event), (e) => e.code === 'M9D619_FALHA');
  } finally { target.recompute = original; }
  assert.equal((await bi.rowsOf(env, 'rm_legal_cases_risk', env.tenantA)).length, 0, 'os processos por risco, aplicados antes da falha, também foram desfeitos');
  const [[reg]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE source_event_id = :e', { replacements: { e: String(event.id) } });
  assert.equal(reg.n, 0, 'o evento não ficou marcado como aplicado');
  assert.equal((await bi.apply(env.tenantA, event)).upserted, 2, 'sem a falha o mesmo evento é aplicado normalmente nos dois');
  assert.equal((await bi.rowsOf(env, 'rm_legal_cases_risk', env.tenantA)).length, risk.length || 2);
});
