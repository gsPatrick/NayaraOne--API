'use strict';

// M9-D691 (3.4 e 3.5) — concorrência, falha isolada por definição, isolamento entre empresas, eventos e o job. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d691Env');
const { runAnalyticsAlertEvaluationJob } = require('../../../src/engines/jobs/analyticsAlertEvaluationJob');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

const D = '2026-10-29';
const at = (hhmm) => new Date(`${D}T${hhmm}:00Z`).toISOString();

test('m9d691 avaliadores simultâneos em 2 conexões criam uma instância', async () => {
  env.events.length = 0;
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const def = await e.defineAlert(tenant, metric);
  await e.put(tenant, metric, { value: '42000', at: at('10:00') });
  const results = await Promise.all([1, 2, 3, 4].map(() => e.evaluate(tenant, at('10:00'))));
  const rows = await e.instances(env, tenant, def);
  assert.equal(rows.length, 1, 'o índice único parcial garante uma só instância');
  assert.equal(rows[0].occurrence_count, 1, 'quem perdeu a corrida cai no ramo da instância existente e, vendo o mesmo snapshot, não conta de novo');
  assert.equal(env.events.filter((x) => x.type === 'analytics.alert.opened' && x.alertCode === def.alert_code).length, 1, 'um só aviso');
  assert.equal(results.flatMap((r) => r.failed).length, 0, 'ninguém falhou');
  // dois snapshots diferentes avaliados ao mesmo tempo: cada ocorrência soma uma vez
  await e.put(tenant, metric, { value: '41000', at: at('10:10') });
  await Promise.all([e.evaluate(tenant, at('10:10')), e.evaluate(tenant, at('10:10'))]);
  assert.equal((await e.instances(env, tenant, def))[0].occurrence_count, 2);
});

test('m9d691 falha em uma definição não impede as outras', async () => {
  const good = await e.publish(env, tenant, { prefix: 'fin' });
  const bad = await e.publish(env, tenant, { prefix: 'fin' });
  const goodDef = await e.defineAlert(tenant, good);
  const rule = await e.seedRule(env, tenant);
  const badDef = await e.defineAlert(tenant, bad, { ruleId: rule.id });
  await e.put(tenant, good, { value: '1000', at: at('11:00') });
  await e.put(tenant, bad, { value: '1000', at: at('11:00') });
  await e.retireRule(env, rule);
  const res = await e.evaluate(tenant, at('11:00'));
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].alertCode, badDef.alert_code);
  assert.equal((await e.instances(env, tenant, goodDef)).length, 1, 'a outra definição abriu o alerta');
  assert.equal((await e.instances(env, tenant, badDef)).length, 0);
  const [logRows] = await env.admin.query('SELECT status, error_code FROM analytics.read_model_refreshes WHERE read_model = :m AND company_id = :c ORDER BY started_at DESC LIMIT 1',
    { replacements: { m: e.engine.REFRESH_LOG_MODEL, c: tenant.companyId } });
  const log = logRows[0];
  assert.equal(log.status, 'FAILED', 'o erro fica gravado no diário de refreshes');
  assert.equal(log.error_code, 'ANALYTICS_ALERT_RULE_NOT_PUBLISHED');
});

test('m9d691 alerta em empresa A não aparece para empresa B', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin' });
  const def = await e.defineAlert(tenant, metric);
  await e.put(tenant, metric, { value: '1000', at: at('12:00') });
  await e.evaluate(tenant, at('12:00'));
  await e.evaluate(env.tenantB, at('12:00')); // a empresa B avalia o que ela enxerga
  assert.equal((await e.instances(env, tenant, def)).length, 1);
  assert.equal((await e.instances(env, env.tenantB, def)).length, 0, 'B não ganha instância da definição de A');
  const seenByB = await e.sup.inTx(env.tenantB, {}, (tx) => e.sup.sequelize.query('SELECT count(*)::int AS n FROM analytics.alert_instances WHERE alert_definition_id = :d', { replacements: { d: def.id }, transaction: tx }));
  assert.equal(seenByB[0][0].n, 0, 'a RLS esconde o alerta de A');
  const defsSeenByB = await e.sup.inTx(env.tenantB, {}, (tx) => e.sup.sequelize.query('SELECT count(*)::int AS n FROM analytics.alert_definitions WHERE id = :d', { replacements: { d: def.id }, transaction: tx }));
  assert.equal(defsSeenByB[0][0].n, 0, 'nem a definição');
});

test('m9d691 abertura e resolução emitem os eventos depois do commit', async () => {
  env.events.length = 0;
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const def = await e.defineAlert(tenant, metric, { severity: 'CRITICAL', createTask: true, ownerRole: 'juridico-gestor' });
  await e.put(tenant, metric, { value: '1000', at: at('13:00') });
  await e.evaluate(tenant, at('13:00'));
  const opened = env.events.filter((x) => x.alertCode === def.alert_code && x.type !== 'analytics.alert.owner_fallback'); // o reserva do owner é da M9-D692
  assert.equal(opened.length, 1);
  assert.deepEqual([opened[0].type, opened[0].severity, opened[0].createTask, opened[0].ownerRole, opened[0].metricCode], ['analytics.alert.opened', 'CRITICAL', true, 'juridico-gestor', metric.code]);
  assert.ok(opened[0].instanceId && opened[0].companyId === tenant.companyId);
  assert.ok(!('value' in opened[0]) && !('lastValue' in opened[0]), 'o aviso traz o código da métrica e o link, nunca o valor');
  await e.put(tenant, metric, { value: '90000', at: at('13:05') });
  await e.evaluate(tenant, at('13:05'));
  await e.put(tenant, metric, { value: '90000', at: at('13:10') });
  await e.evaluate(tenant, at('13:10'));
  const types = env.events.filter((x) => x.alertCode === def.alert_code && x.type !== 'analytics.alert.owner_fallback').map((x) => x.type);
  assert.deepEqual(types, ['analytics.alert.opened', 'analytics.alert.resolved']);
});

test('m9d691 o job avalia as empresas na agenda configurada e a falha de uma empresa não derruba as outras', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin' });
  const def = await e.defineAlert(tenant, metric);
  await e.put(tenant, metric, { value: '1000', at: at('14:00') });
  const first = await runAnalyticsAlertEvaluationJob({ now: new Date(at('14:00')), force: true });
  assert.ok(first.companies >= 2, 'percorre as empresas');
  assert.equal(first.errors, 0);
  assert.equal((await e.instances(env, tenant, def)).length, 1);
  const quiet = await runAnalyticsAlertEvaluationJob({ now: new Date(at('14:02')) });
  assert.equal(quiet.companies, 0, 'a agenda é de 5 min: 2 min depois não roda');
  await e.setSetting(env, tenant, 'analytics.alert.intervalo_avaliacao_min', 1);
  const soon = await runAnalyticsAlertEvaluationJob({ now: new Date(at('14:03')) });
  assert.ok(soon.companies >= 1, 'com intervalo de 1 min a empresa roda');
});

test('m9d691 colunas novas da instância: só o worker mexe na instância resolvida', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin' });
  const def = await e.defineAlert(tenant, metric);
  await e.put(tenant, metric, { value: '1000', at: at('15:00') });
  await e.evaluate(tenant, at('15:00'));
  const [row] = await e.instances(env, tenant, def);
  assert.equal(row.suppressed_count, 0);
  assert.equal(row.metric_code, metric.code);
  // sem o escritor do BI, a instância não aceita atualização de contagem
  await assert.rejects(e.sup.inTx(tenant, { commit: true }, (tx) => e.sup.sequelize.query('UPDATE analytics.alert_instances SET suppressed_count = 9 WHERE id = :i', { replacements: { i: row.id }, transaction: tx })));
  assert.equal((await e.instances(env, tenant, def))[0].suppressed_count, 0);
});

test('m9d691 a definição fixada em uma versão da métrica lê o snapshot dessa versão', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin' });
  const pinned = await e.defineAlert(tenant, metric, { pin: 1 });
  const floating = await e.defineAlert(tenant, metric);
  await e.put(tenant, metric, { value: '1000', at: at('16:00') });
  e.at(at('16:00'));
  const v2 = await e.sup.inTx(tenant, { commit: true }, (tx) => e.registry.publishVersion(metric.code, {
    version: 2, validFrom: D, formulaSemantic: 'Soma dos saldos disponíveis menos as obrigações do período, versão 2.', changeReason: 'Mudança de regra para o teste da versão fixada.',
  }, e.sup.ctxOf(tenant), tx, { catalog: env.catalog }));
  await e.put(tenant, { ...metric, version: v2.version }, { value: '90000', at: at('16:10'), asOfDate: '2026-10-30' }); // a versão vigente grava um valor normal em outra data-base
  await e.evaluate(tenant, at('16:10'));
  assert.equal((await e.instances(env, tenant, pinned)).length, 1, 'fixada na versão 1: lê o snapshot dela (1000) e dispara');
  assert.equal((await e.instances(env, tenant, floating)).length, 0, 'sem fixação: lê o mais recente (versão 2, 90000) e não dispara');
});

test('m9d691 a avaliação logo depois do refresh roda uma de cada vez por empresa', async () => {
  const { evaluateAfterRefresh } = require('../../../src/engines/jobs/analyticsAlertEvaluationJob');
  const metric = await e.publish(env, tenant, { prefix: 'fin' });
  const def = await e.defineAlert(tenant, metric);
  await e.put(tenant, metric, { value: '1000', at: at('17:00') });
  const scope = { companyId: tenant.companyId, groupId: tenant.groupId };
  const [first, second] = await Promise.all([evaluateAfterRefresh(scope, { now: new Date(at('17:00')) }), evaluateAfterRefresh(scope, { now: new Date(at('17:00')) })]);
  assert.ok([first, second].some((r) => r === null), 'a segunda chamada simultânea é descartada (a primeira já cobre)');
  assert.equal((await e.instances(env, tenant, def)).length, 1);
});

test('m9d691 o alert engine não importa nenhum serviço de escrita do Financeiro', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', '..', 'src', 'features', 'analytics', 'alerts');
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!/require\([^)]*features\/finance|require\([^)]*\.\.\/\.\.\/finance/.test(text), `${name} não pode importar o módulo financeiro`);
    assert.ok(!/(payFinancial|createPayment|approvePayment|transfer\()/i.test(text), `${name} não pode chamar pagamento`);
  }
});
