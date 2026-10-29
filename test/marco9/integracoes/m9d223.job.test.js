'use strict';

// Marco 9, M9-D223 — job do teste de saúde (intervalo por parâmetro da empresa) e regra de completude para liberar em produção.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparCircuito, desativarConexoesDeTeste, linha, mensagemComSaude, instalar, config, limparConfig,
} = require('../_helpers/m9d223Env');
const { restaurar } = require('../_helpers/m9d214Env');
const { runIntegrationHealthCheckJob, resetHealthCheckSchedule } = require('../../../src/engines/jobs/integrationHealthCheckJob');
const health = require('../../../src/features/integrations/health');

let tenant;
let Msg;
let c;

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => {
  Msg = mensagemComSaude();
  instalar(Msg);
  resetHealthCheckSchedule();
  health.clearReadinessChecks();
  await limparCircuito(tenant);
  await limparConfig(tenant, ['integration.health.check_interval_s']);
  c = await conexaoAtiva(tenant, 'MESSAGING');
});
after(async () => { restaurar(); await desativarConexoesDeTeste(tenant); health.clearReadinessChecks(); resetHealthCheckSchedule(); await limparConfig(tenant, ['integration.health.check_interval_s']); await sequelize.close(); });

test('health_job_respeita_o_intervalo_do_parametro_da_empresa', async () => {
  const t0 = new Date();
  const r1 = await runIntegrationHealthCheckJob({ now: t0 });
  assert.ok(r1.companies >= 1 && r1.checked >= 1 && r1.errors === 0);
  const antes = Msg.H.chamadas;
  const r2 = await runIntegrationHealthCheckJob({ now: new Date(t0.getTime() + 10000) });
  assert.equal(r2.checked, 0, 'padrão de 60 s: 10 s depois ainda não é hora');
  assert.equal(Msg.H.chamadas, antes);
  await config(tenant, 'integration.health.check_interval_s', 5);
  const r3 = await runIntegrationHealthCheckJob({ now: new Date(t0.getTime() + 20000) });
  assert.ok(r3.checked >= 1, 'com 5 s a empresa volta a ser conferida');
  assert.ok(Msg.H.chamadas > antes);
  assert.equal((await linha(tenant, c.id)).last_check_ok, true);
  await assert.rejects(config(tenant, 'integration.health.check_interval_s', 1), (e) => e.statusCode === 400, 'fora da faixa é recusado');
  await assert.rejects(config(tenant, 'integration.health.check_interval_s', 3601), (e) => e.statusCode === 400);
});

test('health_completude_para_liberar_producao', async () => {
  const ctx = ctxDe(tenant);
  const avalia = (codigo) => comTenant(tenant, (t) => health.assessProductionReadiness(codigo, ctx, t));
  const a = await avalia('messaging-sandbox');
  assert.deepEqual([a.items.healthCheck.ok, a.items.runbook.ok, a.items.slo.ok], [true, true, true]);
  assert.equal(a.ready, false, 'sem alertas e sem contract tests registrados, não está pronto');
  assert.deepEqual(a.missing.sort(), ['alerts', 'contractTests']);
  health.registerReadinessCheck('alerts', async () => ({ ok: true, detail: 'ok' }));
  health.registerReadinessCheck('contractTests', async () => ({ ok: true, detail: 'ok' }));
  assert.equal((await avalia('messaging-sandbox')).ready, true);
  health.registerReadinessCheck('contractTests', async () => { throw new Error('quebrou'); });
  const falha = await avalia('messaging-sandbox');
  assert.deepEqual([falha.ready, falha.missing], [false, ['contractTests']], 'verificação que falha não libera');
  const sem = await avalia('provider-que-nao-existe');
  assert.equal(sem.ready, false);
  assert.ok(sem.missing.includes('healthCheck') && sem.missing.includes('runbook') && sem.missing.includes('slo'));
});
