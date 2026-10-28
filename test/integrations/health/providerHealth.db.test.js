'use strict';

// Marco 9, M9-D206 — integration.provider_health no Postgres real. Roda em banco descartável:
//   node scripts/withDisposableDb.js --port <porta> -- ... node --test --test-concurrency=1 test/integrations/health/providerHealth.db.test.js

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const { Group, Company, IntegrationConnection } = require('../../../src/models');
const health = require('../../../src/features/integrations/health');
const settingsService = require('../../../src/features/settings/settings.service');

let tenant;
let tenantB;
const AGORA = new Date('2026-10-28T12:00:00Z');

before(async () => {
  tenant = await getSeedTenant();
  const grupoB = await Group.findOne({ where: { name: 'CI — Grupo Fictício B' } });
  if (grupoB) {
    const empresaB = await sequelize.transaction(async (t) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: grupoB.id }, transaction: t });
      return Company.findOne({ where: { groupId: grupoB.id, name: 'CI — Empresa Fictícia B' }, transaction: t });
    });
    if (empresaB) tenantB = { groupId: grupoB.id, companyId: empresaB.id, userId: tenant.userId };
  }
});

beforeEach(() => {
  health.resetHealthSampleSources();
  health.clearCircuitCache();
});

after(async () => {
  health.resetHealthSampleSources();
  await sequelize.close();
});

async function novaConexao(transaction, over = {}) {
  return IntegrationConnection.create({
    groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'financing-manual', environment: 'HOMOLOG',
    label: `QA-M9 ${uniqueSuffix()}`, status: 'ACTIVE', ...over,
  }, { transaction });
}

const linhas = (connectionId, transaction) => sequelize.query(
  'SELECT * FROM integration.provider_health WHERE connection_id = :id ORDER BY window_minutes, window_start',
  { replacements: { id: connectionId }, transaction, type: sequelize.QueryTypes.SELECT },
);

function amostra(total, sucessos, latencia = 100) {
  return { calls: Array.from({ length: total }, (_, i) => ({ ok: i < sucessos, latencyMs: latencia })), lastSampleAt: AGORA };
}

test('health_agregacao_grava_janelas_e_linha_atual: 100 chamadas e 96 sucessos viram success_rate 96,00 e DEGRADED', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await novaConexao(t);
    health.registerHealthSampleSource(async () => ({ ...amostra(100, 96), backlogCount: 4 }));
    const atual = await health.aggregateConnectionHealth(c, { now: AGORA }, t);
    const rows = await linhas(c.id, t);
    assert.deepEqual(rows.map((r) => r.window_minutes), [0, 5, 60, 1440]);
    const j5 = rows.find((r) => r.window_minutes === 5);
    assert.equal(Number(j5.success_rate), 96);
    assert.equal(j5.calls_total, 100);
    assert.equal(j5.calls_failed, 4);
    assert.equal(j5.backlog_count, 4);
    assert.equal(j5.provider_code, 'financing-manual');
    assert.equal(atual.window_minutes, 0);
    assert.equal(Number(atual.success_rate), 96);
    // financiamento é CRITICAL (99,9%): 96% está abaixo
    assert.equal(atual.health_status, 'DEGRADED');
    assert.equal(atual.circuit_state, 'CLOSED');
  });
});

test('health_status_regras_no_banco: parâmetro de dado velho e quantidade de falhas vêm da configuração', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await novaConexao(t);
    health.registerHealthSampleSource(async () => ({ ...amostra(10, 10), lastSampleAt: new Date(AGORA.getTime() - 200000) }));
    const a = await health.aggregateConnectionHealth(c, { now: AGORA }, t);
    assert.equal(a.health_status, 'UNKNOWN', 'último dado há 200 s com limite padrão de 180 s');
    await settingsService.upsertSetting('integration.health.stale_after_s', 300, tenant, tenant.userId, t);
    const b = await health.aggregateConnectionHealth(c, { now: AGORA }, t);
    assert.equal(b.health_status, 'HEALTHY', 'a empresa ampliou o limite para 300 s');
    // falhas seguidas de health check: 3 por padrão, 2 por configuração
    await health.recordHealthCheck(c.id, { ok: false, latencyMs: 50, at: AGORA }, t);
    await health.recordHealthCheck(c.id, { ok: false, latencyMs: 50, at: AGORA }, t);
    assert.notEqual((await health.getCurrentHealth(c.id, tenant, t, { now: AGORA })).healthStatus, 'DOWN');
    await settingsService.upsertSetting('integration.health.down_after_failures', 2, tenant, tenant.userId, t);
    assert.equal((await health.getCurrentHealth(c.id, tenant, t, { now: AGORA })).healthStatus, 'DOWN');
    const ok = await health.recordHealthCheck(c.id, { ok: true, latencyMs: 40, at: AGORA }, t);
    assert.equal(ok.check_consecutive_failures, 0, 'um health check bom zera a contagem');
    assert.equal(ok.last_check_ok, true);
    assert.equal(ok.last_check_latency_ms, 40);
  });
});

test('health_circuito_persiste_apos_reinicio: o estado é lido do banco quando o cache de memória some', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await novaConexao(t);
    assert.equal((await health.readCircuitState(c.id, tenant, t, { now: AGORA })).circuitState, 'CLOSED', 'sem linha, o circuito é CLOSED');
    await health.updateCircuitState(c.id, { circuitState: 'OPEN', circuitOpenedAt: AGORA, circuitCooldownS: 120, consecutiveFailures: 5 }, t, { now: AGORA });
    health.clearCircuitCache(); // "reinício" da API ou outra instância
    const lido = await health.readCircuitState(c.id, tenant, t, { now: AGORA });
    assert.equal(lido.circuitState, 'OPEN');
    assert.equal(lido.circuitCooldownS, 120);
    assert.equal(lido.consecutiveFailures, 5);
    assert.equal(new Date(lido.circuitOpenedAt).getTime(), AGORA.getTime());
    // cache de 2 s: uma alteração feita por outra instância só aparece depois dele
    await sequelize.query("UPDATE integration.provider_health SET circuit_state = 'HALF_OPEN' WHERE connection_id = :id AND window_minutes = 0", { replacements: { id: c.id }, transaction: t });
    assert.equal((await health.readCircuitState(c.id, tenant, t, { now: new Date(AGORA.getTime() + 1500) })).circuitState, 'OPEN');
    assert.equal((await health.readCircuitState(c.id, tenant, t, { now: new Date(AGORA.getTime() + 2500) })).circuitState, 'HALF_OPEN');
    // o status de saúde acompanha o circuito
    await health.updateCircuitState(c.id, { circuitState: 'OPEN' }, t, { now: AGORA });
    assert.equal((await health.getCurrentHealth(c.id, tenant, t, { now: AGORA })).healthStatus, 'DOWN');
    // incremento atômico (sem ler antes)
    const antes = (await health.readCircuitState(c.id, tenant, t, { now: AGORA, fresh: true })).consecutiveFailures;
    await health.updateCircuitState(c.id, { consecutiveFailures: { inc: 1 } }, t, { now: AGORA });
    assert.equal((await health.readCircuitState(c.id, tenant, t, { now: AGORA, fresh: true })).consecutiveFailures, antes + 1);
    await assert.rejects(health.updateCircuitState(c.id, { circuitState: 'PARCIAL' }, t), (e) => e.statusCode === 400 || e.status === 400);
  });
});

test('health_unique_janela: job repetido não duplica janela', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await novaConexao(t);
    health.registerHealthSampleSource(async () => amostra(10, 10));
    await health.aggregateConnectionHealth(c, { now: AGORA }, t);
    await health.aggregateConnectionHealth(c, { now: AGORA }, t);
    await health.aggregateConnectionHealth(c, { now: new Date(AGORA.getTime() + 30000) }, t);
    assert.equal((await linhas(c.id, t)).length, 4, 'uma linha atual e as janelas de 5, 60 e 1440 minutos');
    // o banco também recusa a duplicata feita por fora do serviço
    const j5 = (await linhas(c.id, t)).find((r) => r.window_minutes === 5);
    await sequelize.query('SAVEPOINT dup', { transaction: t });
    await assert.rejects(sequelize.query(
      `INSERT INTO integration.provider_health (group_id, company_id, connection_id, provider_code, window_start, window_minutes)
       VALUES (:g, :c, :id, 'financing-manual', :ws, 5)`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, id: c.id, ws: j5.window_start }, transaction: t },
    ), (e) => e.parent?.code === '23505');
    await sequelize.query('ROLLBACK TO SAVEPOINT dup', { transaction: t });
    // a linha atual também é única por connection
    await assert.rejects(sequelize.query(
      `INSERT INTO integration.provider_health (group_id, company_id, connection_id, provider_code, window_start, window_minutes)
       VALUES (:g, :c, :id, 'financing-manual', now(), 0)`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, id: c.id }, transaction: t },
    ), (e) => e.parent?.code === '23505');
  });
});

test('health_retencao_30_dias: o expurgo remove janelas vencidas e o runtime não tem DELETE', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await novaConexao(t);
    await health.aggregateConnectionHealth(c, { now: AGORA }, t);
    const ins = (dias, minutosJanela) => sequelize.query(
      `INSERT INTO integration.provider_health (group_id, company_id, connection_id, provider_code, window_start, window_minutes)
       VALUES (:g, :c, :id, 'financing-manual', now() - (:d || ' days')::interval, :m)`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, id: c.id, d: String(dias), m: minutosJanela }, transaction: t },
    );
    await ins(31, 60);
    await ins(45, 1440);
    await ins(29, 60);
    // O runtime não tem DELETE (cluster descartável e aplicarPermissoesRuntime.js); outros ambientes que concedem
    // DELETE em massa por schema (CI) ficam a cargo de M9-D244 e só têm a função como caminho previsto.
    const [{ pode }] = await sequelize.query("SELECT has_table_privilege(current_user, 'integration.provider_health', 'DELETE') AS pode", { transaction: t, type: sequelize.QueryTypes.SELECT });
    if (!pode) {
      await sequelize.query('SAVEPOINT del', { transaction: t });
      await assert.rejects(sequelize.query('DELETE FROM integration.provider_health WHERE connection_id = :id', { replacements: { id: c.id }, transaction: t }), (e) => e.parent?.code === '42501');
      await sequelize.query('ROLLBACK TO SAVEPOINT del', { transaction: t });
    }
    const antes = (await linhas(c.id, t)).length;
    const removidas = await health.purgeExpiredHealth(tenant, t);
    assert.equal(removidas, 2);
    const depois = await linhas(c.id, t);
    assert.equal(depois.length, antes - 2);
    assert.ok(depois.some((r) => r.window_minutes === 0), 'a linha atual nunca é expurgada');
    // prazo configurável pela empresa
    await settingsService.upsertSetting('integration.health.history_retention_days', 7, tenant, tenant.userId, t);
    assert.equal(await health.purgeExpiredHealth(tenant, t), 1, 'a de 29 dias passa a estar vencida');
  });
});

test('health_rls_isolamento: a empresa B não lê nem grava linhas da empresa A', async (ctx) => {
  if (!tenantB) return ctx.skip('empresa B do CI não existe neste banco');
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await novaConexao(t);
    await health.aggregateConnectionHealth(c, { now: AGORA }, t);
    assert.ok((await linhas(c.id, t)).length > 0);
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: t });
    assert.equal((await linhas(c.id, t)).length, 0, 'B não enxerga');
    await sequelize.query('SAVEPOINT rls', { transaction: t });
    await assert.rejects(sequelize.query(
      `INSERT INTO integration.provider_health (group_id, company_id, connection_id, provider_code, window_start, window_minutes)
       VALUES (:g, :c, :id, 'financing-manual', now(), 5)`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, id: c.id }, transaction: t },
    ), (e) => e.parent?.code === '42501');
    await sequelize.query('ROLLBACK TO SAVEPOINT rls', { transaction: t });
    // pelo serviço: connection de outra empresa é 404
    await assert.rejects(health.getCurrentHealth(c.id, tenantB, t, { now: AGORA }), (e) => {
      assert.equal(e.code, 'INTEGRATION_CONNECTION_NOT_FOUND');
      assert.equal(e.statusCode ?? e.status, 404);
      assert.equal(e.message, 'Integração não encontrada.');
      return true;
    });
  });
});

test('health_execucao_da_empresa: agrega só connection ACTIVE e uma falha não derruba as demais', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ativa = await novaConexao(t);
    const ativa2 = await novaConexao(t, { providerCode: 'financing-sandbox' });
    const pausada = await novaConexao(t, { status: 'PAUSED', environment: 'SANDBOX' });
    health.registerHealthSampleSource(async ({ connection }) => {
      if (connection.id === ativa.id) throw new Error('fonte quebrada');
      return amostra(10, 10);
    });
    const r = await health.runCompanyAggregation(tenant, { now: AGORA }, t);
    assert.ok(r.processed >= 1);
    assert.ok(r.failed >= 1);
    assert.equal((await linhas(ativa2.id, t)).length, 4);
    assert.equal((await linhas(pausada.id, t)).length, 0);
    // a falha não apaga nem cria a linha atual da connection com problema
    assert.equal((await linhas(ativa.id, t)).filter((x) => x.window_minutes > 0).length, 0);
  });
});

test('health_slo_por_criticidade_configuravel: a meta do parâmetro muda o estado e valor inválido é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await novaConexao(t); // financing-manual: família FINANCING, criticidade CRITICAL (meta padrão 99,9%)
    health.registerHealthSampleSource(async () => amostra(100, 96));
    assert.equal((await health.aggregateConnectionHealth(c, { now: AGORA }, t)).health_status, 'DEGRADED');
    await settingsService.upsertSetting('integration.slo.CRITICAL', '95.0% / p95 3 s / p99 8 s / backlog 5 min', tenant, tenant.userId, t);
    assert.equal((await health.aggregateConnectionHealth(c, { now: AGORA }, t)).health_status, 'HEALTHY', '96% atende a meta de 95%');
    // criticidade da família também é parâmetro (D201): LOW usa a meta de LOW
    await settingsService.upsertSetting('integration.catalog.criticality.financing', 'LOW', tenant, tenant.userId, t);
    const view = await health.getCurrentHealth(c.id, tenant, t, { now: AGORA });
    assert.equal(view.criticality, 'LOW');
    assert.equal(view.slo.minSuccessRate, 95);
    await sequelize.query('SAVEPOINT inv', { transaction: t });
    await assert.rejects(settingsService.upsertSetting('integration.slo.HIGH', 'qualquer coisa', tenant, tenant.userId, t), (e) => e.code === 'SETTING_INVALID_VALUE');
    await assert.rejects(settingsService.upsertSetting('integration.health.stale_after_s', 5, tenant, tenant.userId, t), (e) => e.code === 'SETTING_INVALID_VALUE');
    await sequelize.query('ROLLBACK TO SAVEPOINT inv', { transaction: t });
  });
});
