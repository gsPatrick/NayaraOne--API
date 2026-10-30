'use strict';

// M9-D861 — limiares 50/75/90/100 por orçamento e mês, uma vez só, sem derrubar PROD (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d861.alertas.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d861Env');
const { evaluateAll } = require('../../../src/features/core-governance/finops/budgets/budget.evaluate');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const thresholds = (alerts) => alerts.map((a) => a.threshold);

test('m9d861 FinOps budget alerta sem derrubar PROD', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.isolate(tenants.A, tx);
    const A = tenants.A;
    const budget = await env.mkBudget(A, tx);
    const before = (await env.sequelize.query("SELECT to_regclass('governance.degradation_actions') AS t", { type: 'SELECT', transaction: tx }))[0].t;
    await env.spend(A, tx, 300000);
    const alerts = await env.alertsOf(budget.id, tx);
    assert.deepEqual(thresholds(alerts), [50, 75, 90, 100]);
    const events = await env.eventsOf(budget.id, tx);
    assert.equal(events.length, 4, 'um evento por limiar');
    const at100 = events.find((e) => e.payloadJson.threshold === 100);
    assert.deepEqual([at100.payloadJson.budgetId, at100.payloadJson.environment, at100.payloadJson.domain, at100.payloadJson.percent, at100.payloadJson.consumedCents, at100.payloadJson.budgetCents], [budget.id, 'PROD', 'PLATFORM', 100, 300000, 300000]);
    const notices = await env.noticesOf(A.userId, tx);
    assert.equal(notices.filter((n) => /Orçamento de custos em 100%/.test(n.title)).length, 1, 'o owner é avisado');
    assert.match(notices.find((n) => /em 75%/.test(n.title)).body, /Parcela estimada: R\$ 3\.000,00; parcela faturada: R\$ 0,00/);
    // nada de degradação: o alerta 100 só publica e avisa (a política de PROD e sua prova são da M9-D863)
    const after = (await env.sequelize.query("SELECT to_regclass('governance.degradation_actions') AS t", { type: 'SELECT', transaction: tx }))[0].t;
    assert.equal(after, before, 'o alerta não cria nem escreve em tabela de degradação');
  });
});

test('m9d861 salto de 40% para 93% dispara 50, 75 e 90 em ordem', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.isolate(tenants.A, tx);
    const budget = await env.mkBudget(tenants.A, tx);
    await env.spend(tenants.A, tx, 120000);
    assert.deepEqual(thresholds(await env.alertsOf(budget.id, tx)), [], '40% não dispara');
    await env.spend(tenants.A, tx, 160000);
    const alerts = await env.alertsOf(budget.id, tx);
    assert.deepEqual(thresholds(alerts), [50, 75, 90]);
    assert.ok(alerts.every((a) => a.percent === 93 && a.series === 'ESTIMATED'));
  });
});

test('m9d861 limiar dispara uma vez por período', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.isolate(tenants.A, tx);
    const A = tenants.A;
    const budget = await env.mkBudget(A, tx);
    const line = env.dayLine(A, env.TODAY, { service: 'repete', sourceRef: 'COLETA-1', amountCents: 150000 });
    await env.record(A, [line], tx);
    await env.record(A, [line], tx); // mesma coleta duas vezes
    await evaluateAll(A, tx);
    await evaluateAll(A, tx);
    assert.deepEqual(thresholds(await env.alertsOf(budget.id, tx)), [50]);
    assert.equal((await env.eventsOf(budget.id, tx)).length, 1, 'um evento só');
    assert.equal((await env.noticesOf(A.userId, tx)).filter((n) => /em 50%/.test(n.title)).length, 1, 'um aviso só');
  });
});

test('m9d861 novo mês reinicia alertas', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.isolate(tenants.A, tx);
    const A = tenants.A;
    const budget = await env.mkBudget(A, tx);
    await env.spend(A, tx, 160000, { day: env.PREV_MONTH_DAY });
    await env.spend(A, tx, 160000);
    const alerts = await env.alertsOf(budget.id, tx);
    assert.deepEqual(thresholds(alerts), [50, 50], 'o 50 dispara de novo no mês seguinte');
    assert.equal(new Set(alerts.map((a) => a.period_start)).size, 2);
    assert.ok(alerts.every((a) => a.period_start.endsWith('-01')));
  });
});

test('m9d861 alterar orçamento não redispara limiar', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.isolate(tenants.A, tx);
    const A = tenants.A;
    const budget = await env.mkBudget(A, tx);
    await env.spend(A, tx, 160000);
    assert.deepEqual(thresholds(await env.alertsOf(budget.id, tx)), [50]);
    const raised = await env.budgets.updateBudget(A, budget.id, { amountCents: 400000 }, A.userId, tx);
    assert.equal(raised.valorCentavos, 400000);
    assert.deepEqual(thresholds(await env.alertsOf(budget.id, tx)), [50], 'subir o valor não repete o 50');
    await env.budgets.updateBudget(A, budget.id, { amountCents: 300000 }, A.userId, tx);
    assert.deepEqual(thresholds(await env.alertsOf(budget.id, tx)), [50], 'voltar ao valor antigo também não');
    await env.budgets.updateBudget(A, budget.id, { amountCents: 200000 }, A.userId, tx);
    assert.deepEqual(thresholds(await env.alertsOf(budget.id, tx)), [50, 75], '80%: só o limiar ainda não disparado');
    const [log] = await env.sequelize.query("SELECT before_json, after_json FROM audit.audit_log WHERE entity_id = :id AND action = 'governance.budget.updated' ORDER BY occurred_at DESC LIMIT 1", { type: 'SELECT', transaction: tx, replacements: { id: budget.id } });
    assert.deepEqual([log.before_json.amountCents, log.after_json.amountCents], [300000, 200000], 'auditoria com antes e depois');
  });
});

test('m9d861 orçamento zero recusado', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.isolate(tenants.A, tx);
    const A = tenants.A;
    for (const amountCents of [0, -5, 10.5, '1e3', null, undefined, 'abc']) assert.equal(await env.codeOf(env.mkBudget(A, tx, { amountCents })), 'GOV_BUDGET_AMOUNT_INVALID', String(amountCents));
    assert.equal(await env.codeOf(env.mkBudget(A, tx, { ownerUserId: undefined })), 'GOV_BUDGET_OWNER_REQUIRED');
    assert.equal(await env.codeOf(env.mkBudget(A, tx, { ownerUserId: env.randomUUID() })), 'GOV_BUDGET_OWNER_INVALID');
    assert.equal(await env.codeOf(env.mkBudget(A, tx, { environment: 'QA' })), 'GOV_BUDGET_SCOPE_INVALID');
    assert.equal(await env.codeOf(env.mkBudget(A, tx, { domain: 'INEXISTENTE' })), 'GOV_BUDGET_SCOPE_INVALID');
    const ok = await env.mkBudget(A, tx);
    assert.equal(await env.codeOf(env.budgets.updateBudget(A, ok.id, { amountCents: 0 }, A.userId, tx)), 'GOV_BUDGET_AMOUNT_INVALID');
  });
});

test('m9d861 escopo duplicado é recusado e escopos diferentes convivem', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.isolate(tenants.A, tx);
    const A = tenants.A;
    await env.mkBudget(A, tx);
    assert.equal(await env.codeOf(env.mkBudget(A, tx)), 'GOV_BUDGET_DUPLICATE');
    await env.mkBudget(A, tx, { environment: 'HOMOLOG' });
    assert.equal((await env.budgets.listBudgets(A, tx)).length, 2);
  });
});
