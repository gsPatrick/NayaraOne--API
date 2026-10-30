'use strict';

// M9-D863 — aplicação pela política (um passo por execução, limiar e evento), reversão no novo período e o efeito dos cinco passos (banco descartável).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d863Env');
const logger = require('../../../src/utils/logger');
const state = require('../../../src/features/core-governance/finops/degradation/state');
const { decide } = require('../../../src/features/ai/providers/router/decide');
const { assertSchedulingNotPaused } = require('../../../src/features/marketing/degradation.guard');
const { buildContext } = require('../../../src/features/core-governance/dlp/guard.context');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { KEYS } = require('../../../src/features/core-governance/finops/degradation/degradation.settings');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const withLevel = async (fn) => { const level = logger.level; try { return await fn(); } finally { logger.level = level; } };
const stepsOf = (actions) => actions.map((a) => a.step);

async function setup(tx, cents, steps = env.fullPolicy) {
  const A = tenants.A;
  const budget = await env.mkBudget(A, tx);
  await env.putPolicy(A, tx, steps(budget.id));
  if (cents) await env.spend(A, tx, cents);
  return budget;
}

test('m9d863 degradação aplica no máximo um passo por orçamento por execução horária', { skip: skip() }, () => withLevel(() => run(async (tx) => {
  const A = tenants.A;
  const budget = await setup(tx, 300000); // 100%
  const order = [];
  for (let i = 0; i < 6; i += 1) {
    const result = await env.degrade(A, tx);
    assert.ok(result.applied.length <= 1, `execução ${i + 1} aplicou ${result.applied.length}`);
    order.push(...result.applied.map((a) => a.step));
  }
  assert.deepEqual(order, env.FIVE, 'um por vez, na ordem da política; a sexta execução não acha nada para aplicar');
  assert.equal((await env.actionsOf(budget.id, tx)).length, 5, 'passo já aplicado no período não é aplicado de novo');
})));

test('m9d863 o 1º passo entra em 90% e os demais só em 100%, consumindo o evento do orçamento', { skip: skip() }, () => withLevel(() => run(async (tx) => {
  const A = tenants.A;
  const budget = await setup(tx, 255000); // 85%
  assert.deepEqual((await env.degrade(A, tx)).applied, [], '85% não aplica nada');
  await env.spend(A, tx, 30000); // 95%
  assert.deepEqual(stepsOf((await env.degrade(A, tx)).applied), ['SWITCH_AI_MODEL_CHEAPER']);
  assert.deepEqual((await env.degrade(A, tx)).applied, [], 'o 2º passo espera o limiar 100');
  const [action] = await env.actionsOf(budget.id, tx);
  const events = await env.eventsOf(budget.id, tx);
  assert.ok(events.some((e) => e.id === action.trigger_event_id && e.payloadJson.threshold === 90), 'a ação guarda o evento finops.budget.threshold que a disparou');
  await env.spend(A, tx, 30000); // 105%
  assert.deepEqual(stepsOf((await env.degrade(A, tx)).applied), ['PAUSE_MARKETING_CAMPAIGNS']);
})));

test('m9d863 sem evento do limiar o passo não é aplicado e orçamento sem política não degrada', { skip: skip() }, () => withLevel(() => run(async (tx) => {
  const A = tenants.A;
  const budget = await env.mkBudget(A, tx);
  await env.spend(A, tx, 300000);
  assert.deepEqual((await env.degrade(A, tx)).applied, [], 'sem política cadastrada, nada acontece mesmo a 100%');
  await env.putPolicy(A, tx, env.fullPolicy(budget.id));
  await env.sequelize.query("DELETE FROM integration.outbox_events WHERE aggregate_id = :b AND event_type = 'finops.budget.threshold'", { transaction: tx, replacements: { b: budget.id } });
  assert.deepEqual((await env.degrade(A, tx)).applied, [], 'sem o evento publicado o passo não é elegível');
})));

test('m9d863 novo período desfaz a degradação e restaura o valor anterior', { skip: skip() }, () => withLevel(() => run(async (tx) => {
  const A = tenants.A;
  logger.level = 'info';
  const budget = await setup(tx, 300000, (id) => ({ budgetId: id, steps: [{ step: 'REDUCE_LOG_LEVEL' }, { step: 'LIMIT_EXPORT_SIZE' }] }));
  await env.degrade(A, tx);
  assert.equal(logger.level, 'warn', 'o nível de log caiu para o configurado');
  const [action] = await env.actionsOf(budget.id, tx);
  assert.deepEqual(action.previous_value, { logLevel: 'info' }, 'o valor anterior fica guardado');
  const result = await env.degrade(A, tx, env.nextMonth());
  assert.deepEqual(result.reverted.map((r) => [r.step, r.reason]), [['REDUCE_LOG_LEVEL', 'PERIOD_ENDED']]);
  assert.equal(logger.level, 'info', 'o valor anterior voltou');
  const [done] = await env.actionsOf(budget.id, tx, "step = 'REDUCE_LOG_LEVEL'");
  assert.equal(done.status, 'REVERTED');
  assert.ok(done.reverted_at);
  const [audit] = await env.auditOf(action.id, 'finops.degradation.reverted', tx);
  assert.deepEqual([audit.beforeJson.status, audit.afterJson.status, audit.afterJson.restoredValue], ['APPLIED', 'REVERTED', { logLevel: 'info' }]);
})));

test('m9d863 consumo que volta abaixo do limiar desfaz o passo; tirar o passo da política também', { skip: skip() }, () => withLevel(() => run(async (tx) => {
  const A = tenants.A;
  const budget = await setup(tx, 300000, (id) => ({ budgetId: id, steps: [{ step: 'LIMIT_EXPORT_SIZE' }, { step: 'DEFER_NON_CRITICAL_JOBS' }] }));
  await env.degrade(A, tx);
  await env.degrade(A, tx);
  assert.equal((await env.actionsOf(budget.id, tx, "status = 'APPLIED'")).length, 2);
  await env.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step: 'LIMIT_EXPORT_SIZE' }] });
  assert.deepEqual((await env.actionsOf(budget.id, tx, "status = 'APPLIED'")).map((a) => a.step), ['LIMIT_EXPORT_SIZE'], 'o passo que saiu da política foi desfeito na hora');
  await env.sequelize.query("DELETE FROM governance.cost_ledger WHERE group_id = :g AND service <> 'nenhum'", { transaction: tx, replacements: { g: A.groupId } }).catch(() => null);
  await env.sequelize.query("UPDATE governance.budgets SET amount_cents = 3000000 WHERE id = :b", { transaction: tx, replacements: { b: budget.id } }); // 10%
  const result = await env.degrade(A, tx);
  assert.deepEqual(result.reverted.map((r) => r.reason), ['BELOW_THRESHOLD']);
  await upsertSetting(KEYS.enabled, false, A, A.userId, tx);
  assert.deepEqual((await env.degrade(A, tx)).applied, [], 'degradação desligada pelo administrador não aplica');
})));

const model = (name, micros, extra = {}) => ({ providerCode: 'p', model: name, classe: 'SMALL', estimatedCostMicros: micros, estimatedCost: String(micros), cheaperAlternative: null, ...extra });
const fakeRegistry = (strict, relaxed) => ({ candidates: async (q) => (q.latencyBudgetMs === undefined ? relaxed : strict) });
const route = (tx, input, registry) => decide({ taskType: 'summarize', inputSize: 100, latencyBudgetMs: 100, ...input }, { groupId: tenants.A.groupId, companyId: tenants.A.companyId }, tx, { registry, resolvers: { guards: () => [], get: () => null }, cache: { lookup: async () => null } });

test('m9d863 cada um dos 5 passos altera a flag correspondente e é revertido', { skip: skip() }, () => withLevel(() => run(async (tx) => {
  const A = tenants.A;
  logger.level = 'info';
  const budget = await setup(tx, 300000);
  const strict = [model('rapido', 100, { cheaperAlternative: 'lento' })];
  const relaxed = [model('lento', 10), model('rapido', 100, { cheaperAlternative: 'lento' })];
  const registry = fakeRegistry(strict, relaxed);
  const dlpRows = async () => (await buildContext(A, { action: 'EXPORT', resources: [], actorUserId: A.userId, permissions: [] }, tx)).policy.maxRows;
  const deferred = (hour) => state.shouldDeferJob('dataQualityScanJob', A, tx, new Date(Date.UTC(2026, 9, 30, hour + 3)));
  const baseline = { dlp: await dlpRows() };
  // antes: nada degradado
  assert.equal((await route(tx, {}, registry)).model, 'rapido');
  await assertSchedulingNotPaused(A, tx);
  assert.equal(await deferred(12), false);
  for (let i = 0; i < 5; i += 1) await env.degrade(A, tx);
  // depois: cada passo no seu efeito
  const decision = await route(tx, {}, registry);
  assert.deepEqual([decision.model, decision.degradedByCost], ['lento', true], 'SWITCH_AI_MODEL_CHEAPER');
  assert.equal((await route(tx, { criticality: 'CRITICAL' }, registry)).model, 'rapido', 'tarefa crítica não é degradada');
  await assert.rejects(() => assertSchedulingNotPaused(A, tx), (e) => e.code === 'MKT_SCHEDULING_PAUSED_BY_COST', 'PAUSE_MARKETING_CAMPAIGNS');
  assert.equal(logger.level, 'warn', 'REDUCE_LOG_LEVEL');
  assert.ok(baseline.dlp > 1, 'a política de exportação tem max_rows');
  assert.equal(await dlpRows(), Math.floor(baseline.dlp / 2), 'LIMIT_EXPORT_SIZE (política do DLP)');
  assert.equal(await deferred(12), true, 'DEFER_NON_CRITICAL_JOBS: meio-dia espera');
  assert.equal(await deferred(2), false, 'dentro da janela 00:00-05:00 roda');
  assert.equal(await state.shouldDeferJob('finopsCollectJob', A, tx, new Date(Date.UTC(2026, 9, 30, 15))), false, 'job fora da lista de baixa prioridade não é adiado');
  // revertido no novo período: tudo volta
  const result = await env.degrade(A, tx, env.nextMonth());
  assert.equal(result.reverted.length, 5);
  assert.equal((await route(tx, {}, registry)).model, 'rapido');
  await assertSchedulingNotPaused(A, tx);
  assert.equal(logger.level, 'info');
  assert.equal(await dlpRows(), baseline.dlp);
  assert.equal(await deferred(12), false);
  assert.equal((await env.actionsOf(budget.id, tx, "status = 'APPLIED'")).length, 0);
})));
