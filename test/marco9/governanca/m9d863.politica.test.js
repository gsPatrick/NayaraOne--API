'use strict';

// M9-D863 — PROD nunca é desligado por custo: estouro sem derrubar nada, varredura estática, função crítica fora da política e auditoria (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d863.politica.test.js"

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d863Env');
const logger = require('../../../src/utils/logger');
const { assertDegradable } = require('../../../src/features/core-governance/finops/degradation/prod.guard');
const { STEPS } = require('../../../src/features/core-governance/finops/degradation/degradation.constants');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const codeOf = (fn) => Promise.resolve().then(fn).then(() => null, (err) => [err.statusCode || err.status, err.code]);

test('m9d863 estouro de orçamento em PROD não derruba nada', { skip: skip() }, async () => {
  const levelBefore = logger.level;
  try {
    await run(async (tx) => {
      const A = tenants.A;
      const budget = await env.mkBudget(A, tx);
      await env.putPolicy(A, tx, env.fullPolicy(budget.id));
      await env.spend(A, tx, 450000); // 150% do orçamento de PROD
      for (let i = 0; i < 7; i += 1) await env.degrade(A, tx); // roda mais vezes do que há passos
      const actions = await env.actionsOf(budget.id, tx);
      assert.deepEqual(actions.map((a) => a.step).sort(), [...STEPS].sort(), 'os cinco passos de função foram aplicados, e só eles');
      assert.ok(actions.every((a) => a.status === 'APPLIED'));
      const alerts = await env.alertsOf(budget.id, tx);
      assert.deepEqual(alerts.map((a) => a.threshold), [50, 75, 90, 100], 'o alerta 100 saiu normalmente');
      const health = await require('../../../src/features/core-governance/finops/finops.service').getOverview(A, tx, { includeShared: true });
      assert.equal(health.habilitado, true, 'o módulo e a leitura continuam no ar');
      assert.equal(health.status, 'CRITICAL', 'o health informa o estouro e nada mais');
      assert.equal(health.ambientes.find((a) => a.ambiente === 'PROD').dominios.find((d) => d.orcamentoId === budget.id).status, 'CRITICAL');
    });
  } finally { logger.level = levelBefore; }
});

test('m9d863 nenhum caminho de FinOps desliga PROD (varredura estática)', async () => {
  const root = path.resolve(__dirname, '../../../src');
  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : files.push(path.join(dir, e.name))));
  walk(path.join(root, 'features/core-governance/finops'));
  fs.readdirSync(path.join(root, 'engines/jobs')).filter((f) => /^finops.*Job\.js$/.test(f)).forEach((f) => files.push(path.join(root, 'engines/jobs', f)));
  assert.ok(files.length > 40, 'a varredura cobre o módulo inteiro e os jobs de FinOps');
  const forbidden = /child_process|process\.exit|process\.kill|\bexecSync\b|\bspawn(Sync)?\b|\bsystemctl\b|\bdocker\b|\bkubectl\b|@aws-sdk|stopInstances|terminateInstances|pg_terminate_backend|DROP\s+(DATABASE|SCHEMA)|\bTRUNCATE\b|shutdown\(|scaleToZero|desiredCount/i;
  const offenders = files.filter((f) => f.endsWith('.js')).filter((f) => forbidden.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepEqual(offenders, [], 'FinOps não tem como desligar, pausar ou escalar infraestrutura');
  // E a regra dura por comportamento: qualquer tentativa de desligar infraestrutura é 403 GOV_FINOPS_PROD_PROTECTED, antes de qualquer efeito.
  for (const attempt of ['SHUTDOWN_PROD', 'STOP_SERVICE', 'SCALE_TO_ZERO', 'DESLIGAR_PROD']) {
    assert.deepEqual(await codeOf(() => assertDegradable(attempt)), [403, 'GOV_FINOPS_PROD_PROTECTED'], attempt);
  }
});

test('m9d863 a tabela de ações não representa desligamento de infraestrutura', { skip: skip() }, async () => {
  await run(async (tx) => {
    const budget = await env.mkBudget(tenants.A, tx);
    const insert = (step) => env.sequelize.query(
      `INSERT INTO governance.degradation_actions (group_id, company_id, budget_id, step, threshold, period_start) VALUES (:g, :c, :b, :step, 90, current_date)`,
      { transaction: tx, replacements: { g: tenants.A.groupId, c: tenants.A.companyId, b: budget.id, step } }
    );
    await env.sequelize.query('SAVEPOINT s1', { transaction: tx });
    await assert.rejects(() => insert('SHUTDOWN_PROD'), /gov_degradation_actions_step_chk/);
    await env.sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
    await insert('REDUCE_LOG_LEVEL');
  });
});

test('m9d863 função crítica não entra na política', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const budget = await env.mkBudget(A, tx);
    for (const step of ['DISABLE_LOGIN', 'PAUSE_PAYMENTS', 'DISABLE_FINANCE_MODULE', 'STOP_LEGAL_DEADLINES', 'DISABLE_KILL_SWITCH', 'SKIP_RESTORE']) {
      assert.deepEqual(await codeOf(() => env.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step }] })), [422, 'GOV_FINOPS_CRITICAL_NOT_DEGRADABLE'], step);
    }
    assert.deepEqual(await codeOf(() => env.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step: 'SHUTDOWN_PROD' }] })), [403, 'GOV_FINOPS_PROD_PROTECTED']);
    assert.deepEqual(await codeOf(() => env.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step: 'COISA_NOVA' }] })), [422, 'GOV_FINOPS_POLICY_INVALID']);
    assert.deepEqual(await codeOf(() => env.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step: 'REDUCE_LOG_LEVEL', threshold: 80 }] })), [422, 'GOV_FINOPS_POLICY_INVALID'], 'limiar fora dos de alerta');
    assert.deepEqual(await codeOf(() => env.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step: 'REDUCE_LOG_LEVEL', threshold: 100 }, { step: 'LIMIT_EXPORT_SIZE', threshold: 90 }] })), [422, 'GOV_FINOPS_POLICY_INVALID'], 'limiar decrescente');
    assert.deepEqual(await codeOf(() => env.putPolicy(A, tx, { budgetId: env.randomUUID(), steps: [] })), [404, 'GOV_BUDGET_NOT_FOUND']);
    const rows = await env.sequelize.query('SELECT count(*)::int AS n FROM governance.degradation_policies WHERE budget_id = :b', { type: 'SELECT', transaction: tx, replacements: { b: budget.id } });
    assert.equal(rows[0].n, 0, 'nada foi gravado');
    const saved = await env.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step: 'REDUCE_LOG_LEVEL' }, { step: 'LIMIT_EXPORT_SIZE' }] });
    assert.deepEqual(saved.steps, [{ step: 'REDUCE_LOG_LEVEL', threshold: 90 }, { step: 'LIMIT_EXPORT_SIZE', threshold: 100 }], 'padrões do livro: 90% o primeiro, 100% os demais');
  });
});

test('m9d863 degradação aplicada pela política fica auditada e só alterar a política exige a permissão de gestão', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const budget = await env.mkBudget(A, tx);
    await env.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step: 'LIMIT_EXPORT_SIZE' }] });
    const [policyAudit] = await env.auditOf((await env.policies.listPolicies(A, tx)).politicas[0].id, 'finops.degradation.policy_saved', tx);
    assert.ok(policyAudit, 'o cadastro da política é auditado');
    await env.spend(A, tx, 285000); // 95%
    const result = await env.degrade(A, tx);
    assert.equal(result.applied.length, 1);
    const [action] = await env.actionsOf(budget.id, tx);
    const [applied] = await env.auditOf(action.id, 'finops.degradation.applied', tx);
    assert.equal(applied.beforeJson.active, false);
    assert.deepEqual([applied.afterJson.step, applied.afterJson.status, applied.afterJson.percent, applied.afterJson.threshold], ['LIMIT_EXPORT_SIZE', 'APPLIED', 95, 90]);
  });
});
