'use strict';

// Marco 9, M9-D224 — job dos alertas (intervalo por empresa), parâmetros do administrador, destinatários por papel e isolamento da tabela de alertas.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, comTenant, carregarTenants, tenantCI, conexaoAtiva, limparCircuito, ciclo, alertas, notificacoes, config, limparConfig, mudarConexao, limparAlertas, desativarConexoesDeTeste,
} = require('../_helpers/m9d224Env');
const { runIntegrationAlertJob, resetAlertSchedule } = require('../../../src/engines/jobs/integrationAlertJob');
const health = require('../../../src/features/integrations/health');
const { alertsConfigured } = require('../../../src/features/integrations/health/alerts');

const CHAVES = ['integration.alert.repeat_min', 'integration.alert.circuit_open_min', 'integration.alert.notify_roles', 'integration.alert.evaluate_interval_s'];
let tenant;

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => { resetAlertSchedule(); await limparConfig(tenant, CHAVES); await limparCircuito(tenant); await limparAlertas(tenant); });
after(async () => { await limparAlertas(tenant); await desativarConexoesDeTeste(tenant); await desativarConexoesDeTeste(await tenantCI('A')); await limparConfig(tenant, CHAVES); resetAlertSchedule(); await sequelize.close(); });

test('alerta_job_respeita_intervalo_e_parametros_validados', async () => {
  const c = await conexaoAtiva(tenant, 'MESSAGING');
  await mudarConexao(tenant, c.id, "status = 'AUTH_FAILED'");
  const t0 = new Date();
  const r1 = await runIntegrationAlertJob({ now: t0 });
  assert.ok(r1.companies >= 1 && r1.errors === 0);
  assert.equal((await alertas(tenant, c.id, 'AUTH_FAILURE')).length, 1);
  const r2 = await runIntegrationAlertJob({ now: new Date(t0.getTime() + 10000) });
  assert.equal(r2.companies, 0, 'padrão de 60 s: 10 s depois ainda não é hora');
  await config(tenant, 'integration.alert.evaluate_interval_s', 10);
  const r3 = await runIntegrationAlertJob({ now: new Date(t0.getTime() + 20000) });
  assert.ok(r3.companies >= 1, 'com 10 s a empresa volta a ser avaliada');
  // faixas e formato validados pela configuração
  for (const [chave, valor] of [
    ['integration.alert.repeat_min', 0], ['integration.alert.repeat_min', 10081], ['integration.alert.circuit_open_min', 0], ['integration.alert.evaluate_interval_s', 9],
    ['integration.alert.notify_roles', ''], ['integration.alert.notify_roles', 'ADMIN,,GERENTE'], ['integration.alert.notify_roles', 'a;b'], ['integration.alert.notify_roles', 123],
  ]) {
    await assert.rejects(config(tenant, chave, valor), (e) => e.statusCode === 400, `${chave}=${valor}`);
  }
  await config(tenant, 'integration.alert.notify_roles', 'ADMIN, Diretoria');
});

test('alerta_destinatarios_por_papel_configuravel', async () => {
  const c = await conexaoAtiva(tenant, 'MESSAGING');
  await mudarConexao(tenant, c.id, "status = 'AUTH_FAILED'");
  const desde = new Date();
  await config(tenant, 'integration.alert.notify_roles', 'PAPEL-QUE-NAO-EXISTE');
  await ciclo(tenant);
  const [a] = await alertas(tenant, c.id, 'AUTH_FAILURE');
  assert.equal(a.status, 'OPEN', 'sem destinatário o alerta existe do mesmo jeito (painel)');
  assert.equal((await notificacoes(tenant, desde, 'docs/runbooks')).length, 0, 'ninguém a avisar: nenhuma notificação');
  await limparConfig(tenant, ['integration.alert.notify_roles']);
  await mudarConexao(tenant, c.id, "status = 'ACTIVE'");
  await ciclo(tenant);
  await mudarConexao(tenant, c.id, "status = 'AUTH_FAILED'");
  await ciclo(tenant);
  assert.ok((await notificacoes(tenant, desde, 'docs/runbooks')).length >= 1, 'padrão ADMIN: o administrador da empresa é avisado');
});

test('alerta_tabela_isolada_por_empresa', async () => {
  const tA = await tenantCI('A');
  const tB = await tenantCI('B');
  const cA = await conexaoAtiva(tA, 'MESSAGING');
  await mudarConexao(tA, cA.id, "status = 'AUTH_FAILED'");
  await ciclo(tA);
  assert.equal((await alertas(tA, cA.id)).length, 1);
  const deB = await comTenant(tB, async (t) => (await sequelize.query('SELECT count(*)::int AS n FROM integration.alerts WHERE connection_id = :id', { replacements: { id: cA.id }, transaction: t }))[0][0].n);
  assert.equal(deB, 0, 'a empresa B não enxerga o alerta da A');
  await assert.rejects(
    comTenant(tB, (t) => sequelize.query(
      `INSERT INTO integration.alerts (group_id, company_id, connection_id, provider_code, alert_type, severity, runbook_path) VALUES (:g, :c, :id, 'messaging-sandbox', 'QUOTA_LOW', 'LOW', 'x')`,
      { replacements: { g: tA.groupId, c: tA.companyId, id: cA.id }, transaction: t },
    )),
    /row-level security|violates/i,
    'não se grava alerta de outra empresa',
  );
});

test('alerta_liberacao_em_producao_exige_alertas_configurados', async () => {
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId };
  const verifica = () => comTenant(tenant, (t) => alertsConfigured('messaging-sandbox', ctx, t));
  assert.equal((await verifica()).ok, true, 'padrão ADMIN: a empresa tem administrador ativo');
  await config(tenant, 'integration.alert.notify_roles', 'PAPEL-QUE-NAO-EXISTE');
  const r = await verifica();
  assert.equal(r.ok, false);
  assert.match(r.detail, /nenhuma pessoa ativa/);
  health.clearReadinessChecks();
  health.registerReadinessCheck('alerts', alertsConfigured);
  const geral = await comTenant(tenant, (t) => health.assessProductionReadiness('messaging-sandbox', ctx, t));
  assert.equal(geral.items.alerts.ok, false, 'a completude usa a mesma verificação');
  assert.ok(geral.missing.includes('alerts'));
});
