'use strict';

// Marco 9, M9-D225 — SLO específico por criticidade: tabela de metas, medição de 30 dias por connection, exclusão de VALIDATION
// e edição com piso e teto. HTTP real contra o app de teste; banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D225_SLO_PORT || '21651';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d249Env');
const { aggregateConnectionHealth } = require('../../../src/features/integrations/health');
const { readHealthParams } = require('../../../src/features/integrations/health/healthParams');
const { IntegrationConnection } = require('../../../src/models');
const { registerDispatchHealthSource } = require('../../../src/features/integrations/dispatch');

let tenants;
let tokenLeitura;
let tokenEdita;
let tokenGerencia;
let chamar;
const dia = (n) => new Date(Date.now() - n * 86400000);
const chaves = ['integration.slo.CRITICAL', 'integration.slo.HIGH', 'integration.slo.MEDIUM', 'integration.slo.LOW'];

const limparMetas = () => env.sql(tenants.tenant, 'DELETE FROM core.tenant_settings WHERE company_id = :c AND key IN (:k)', { c: tenants.tenant.companyId, k: chaves });

before(async () => {
  // O app só registra a fonte de amostras fora de NODE_ENV=test: o teste a registra (idempotente) e não depende de como o app sobe.
  registerDispatchHealthSource();
  tenants = await env.carregarTenants();
  tokenLeitura = env.tokenDe(tenants.tenant, ['integration:read']);
  tokenEdita = env.tokenDe(tenants.tenant, ['settings:read', 'settings:update']);
  tokenGerencia = env.tokenDe(tenants.tenant, ['settings:read', 'settings:update', 'integration:manage']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => { await limparMetas(); await env.sequelize.close(); process.exit(0); });

const relatorio = async (c) => {
  const r = await chamar(tokenLeitura, 'GET', `/admin/integrations/${c.providerCode}/health?window=30d`);
  assert.equal(r.status, 200);
  return r.corpo.data.slo;
};

test('slo_tabela_por_criticidade', async () => {
  await limparMetas();
  const padrao = await env.comTenant(tenants.tenant, (t) => readHealthParams(env.ctxDe(tenants.tenant), t));
  assert.deepEqual(padrao.slo.CRITICAL, { minSuccessRate: 99.9, p95Ms: 3000, p99Ms: 8000, backlogMin: 5 });
  assert.deepEqual(padrao.slo.HIGH, { minSuccessRate: 99.5, p95Ms: 5000, p99Ms: 12000, backlogMin: 15 });
  assert.deepEqual(padrao.slo.MEDIUM, { minSuccessRate: 99, p95Ms: 8000, p99Ms: 20000, backlogMin: 60 });
  assert.deepEqual(padrao.slo.LOW, { minSuccessRate: 95, p95Ms: 15000, p99Ms: 40000, backlogMin: 1440 });

  // Cada connection é medida contra a meta da criticidade da sua família.
  const familias = { BANK: 'CRITICAL', MESSAGING: 'HIGH', EMAIL: 'MEDIUM', SOCIAL: 'LOW' };
  for (const [dominio, criticidade] of Object.entries(familias)) {
    const c = await env.conexao(tenants.tenant, dominio);
    const slo = await relatorio(c);
    assert.equal(slo.criticality, criticidade, dominio);
    assert.deepEqual(slo.target, padrao.slo[criticidade], dominio);
    assert.equal(slo.window, '30d');
  }

  // Relatório de 30 dias: banco (CRITICAL) com 100.000 chamadas e 130 falhas contadas = 99,87% < 99,9%: violou.
  const banco = await env.conexao(tenants.tenant, 'BANK');
  await env.janela(tenants.tenant, banco, { minutos: 1440, inicio: dia(10), total: 60000, sucesso: 59920, p95: 900, p99: 2000 });
  await env.janela(tenants.tenant, banco, { minutos: 1440, inicio: dia(5), total: 40000, sucesso: 39950, p95: 1200, p99: 2500 });
  const violado = await relatorio(banco);
  assert.equal(violado.measured.callsTotal, 100000);
  assert.equal(violado.measured.callsFailed, 130);
  assert.equal(violado.measured.successRate, 99.87);
  assert.equal(violado.compliance.successRate, false);
  assert.equal(violado.violated, true);
  assert.equal(violado.measured.latencyP95Ms, 1200, 'a pior janela do período');
  assert.equal(violado.compliance.latencyP95, true);
  assert.equal(violado.compliance.backlog, true);
  assert.ok(violado.periodStart && violado.periodEnd);
  assert.match(violado.periodEnd, /-03:00$/);

  // LOW com 96% de sucesso está dentro da meta de 95%.
  const social = await env.conexao(tenants.tenant, 'SOCIAL');
  await env.janela(tenants.tenant, social, { minutos: 1440, inicio: dia(3), total: 1000, sucesso: 960, p95: 14000, p99: 39000 });
  const dentro = await relatorio(social);
  assert.equal(dentro.measured.successRate, 96);
  assert.equal(dentro.violated, false);

  // O administrador muda a meta e a mesma medição passa a ser julgada pela nova meta.
  const r = await chamar(tokenGerencia, 'PUT', '/settings/integration.slo.LOW', { value: '97.0% / p95 10 s / p99 30 s / backlog 12 h' });
  assert.equal(r.status, 200);
  const nova = await relatorio(social);
  assert.deepEqual(nova.target, { minSuccessRate: 97, p95Ms: 10000, p99Ms: 30000, backlogMin: 720 });
  assert.equal(nova.compliance.successRate, false);
  assert.equal(nova.compliance.latencyP95, false, '14 s > 10 s');
  assert.equal(nova.violated, true);
  await limparMetas();
});

test('slo_validation_nao_conta', async () => {
  const { tenant } = tenants;
  const c = await env.conexao(tenant, 'MESSAGING');
  // Dispatch real para a FK das tentativas.
  const [{ id: dispatchId }] = await env.sql(tenant, `INSERT INTO integration.dispatches
      (group_id, company_id, connection_id, provider_code, operation, payload_snapshot, payload_hash, idempotency_key, max_attempts, criticality_op)
    VALUES (:g, :c, :cn, :p, 'sendText', '{}'::jsonb, repeat('a', 64), :k, 8, 'SAFE') RETURNING id`,
  { g: tenant.groupId, c: tenant.companyId, cn: c.id, p: c.providerCode, k: `qa-m9-d225-${Date.now()}` });
  const tentativa = (n, outcome, classe, extra = '') => env.sql(tenant, `INSERT INTO integration.dispatch_attempts
      (group_id, company_id, dispatch_id, connection_id, provider_code, attempt_no, started_at, finished_at, outcome, error_class, http_status, latency_ms ${extra ? ', rate_limited' : ''})
    VALUES (:g, :c, :d, :cn, :p, :n, now() - interval '30 seconds', now() - interval '29 seconds', :o, :k, 200, 120 ${extra ? ', true' : ''})`,
  { g: tenant.groupId, c: tenant.companyId, d: dispatchId, cn: c.id, p: c.providerCode, n, o: outcome, k: classe });
  for (let i = 1; i <= 8; i += 1) await tentativa(i, 'SUCCESS', null);
  await tentativa(9, 'ERROR', 'TRANSIENT');
  for (let i = 10; i <= 12; i += 1) await tentativa(i, 'ERROR', 'VALIDATION');
  await tentativa(13, 'ERROR', 'RATE_LIMIT', 'rl');

  const connection = await env.comTenant(tenant, (t) => IntegrationConnection.findByPk(c.id, { transaction: t }));
  await env.comTenant(tenant, (t) => aggregateConnectionHealth(connection, { now: new Date() }, t));
  const slo = await relatorio(c);
  assert.equal(slo.measured.callsTotal, 10, '8 sucessos + 1 TRANSIENT + 1 RATE_LIMIT; os 3 VALIDATION (dado nosso) ficam de fora');
  assert.equal(slo.measured.callsFailed, 2, 'o RATE_LIMIT que chegou ao fornecedor conta contra o SLO');
  assert.equal(slo.measured.successRate, 80);
  assert.equal(slo.violated, true);
  const serie = (await chamar(tokenLeitura, 'GET', `/admin/integrations/${c.providerCode}/health?window=1d`)).corpo.data.series;
  assert.equal(serie.reduce((s, p) => s + p.callsTotal, 0), 10);
});

test('slo_parametro_fora_de_faixa_recusado', async () => {
  await limparMetas();
  const meta = (pct) => `${pct}% / p95 3 s / p99 8 s / backlog 5 min`;
  for (const fora of ['89.9', '89', '99.995', '100', '0']) {
    const r = await chamar(tokenGerencia, 'PUT', '/settings/integration.slo.CRITICAL', { value: meta(fora) });
    assert.equal(r.status, 422, fora);
    assert.equal(r.corpo.error.code, 'INTEGRATION_SLO_OUT_OF_RANGE', fora);
    assert.equal(r.corpo.error.message, 'Meta de SLO fora do intervalo permitido.');
  }
  const semFormato = await chamar(tokenGerencia, 'PUT', '/settings/integration.slo.CRITICAL', { value: 'qualquer coisa' });
  assert.equal(semFormato.status, 400);
  assert.equal(semFormato.corpo.error.code, 'SETTING_INVALID_VALUE');

  // Piso e teto são aceitos.
  for (const dentro of ['90.0', '99.99']) {
    assert.equal((await chamar(tokenGerencia, 'PUT', '/settings/integration.slo.HIGH', { value: meta(dentro) })).status, 200, dentro);
  }
  // Edição só por quem gerencia integrações.
  const semGerencia = await chamar(tokenEdita, 'PUT', '/settings/integration.slo.MEDIUM', { value: meta('98.0') });
  assert.equal(semGerencia.status, 403);
  assert.equal(semGerencia.corpo.error.code, 'PERMISSION_DENIED');
  // Auditoria antes/depois.
  const auditoria = await env.sql(tenants.tenant, `SELECT before_json, after_json FROM audit.audit_log
    WHERE company_id = :c AND entity_type = 'TenantSetting' AND reason LIKE '%integration.slo.HIGH%' ORDER BY occurred_at DESC LIMIT 1`, { c: tenants.tenant.companyId });
  assert.equal(auditoria[0].before_json.value, meta('90.0'));
  assert.equal(auditoria[0].after_json.value, meta('99.99'));
  await limparMetas();
});
