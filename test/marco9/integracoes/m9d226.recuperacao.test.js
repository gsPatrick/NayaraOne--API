'use strict';

// Marco 9, M9-D226 — encerramento: só depois de integration.contingency.recovery_checks testes de saúde seguidos OK com o circuito fechado.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d226Env');

const { sequelize, carregarTenants, contingency, config, limparConfig } = env;
let tenant;

before(async () => { ({ tenant } = await carregarTenants()); contingency.installContingency(); });
beforeEach(async () => { await env.limparContingencias(tenant); await env.limparCircuito(tenant); await limparConfig(tenant, env.CHAVES); });
after(async () => { await env.limparContingencias(tenant); await env.limparCircuito(tenant); await limparConfig(tenant, env.CHAVES); await env.desativarConexoesDeTeste(tenant); await sequelize.close(); });

const daConexao = async (id) => (await env.ativas(tenant)).filter((a) => a.connectionId === id);

test('contingencia_encerra_com_tres_checks_ok', async () => {
  const c = await env.conexaoDe(tenant, 'messaging-sandbox');
  await env.falhar(tenant, c.id, 5);
  assert.equal((await daConexao(c.id)).length, 1);
  await env.checks(tenant, c.id, 3);
  let r = await env.ciclo(tenant);
  assert.equal(r.deactivated, 0, 'três testes OK não bastam com o circuito ainda aberto');
  await env.fecharCircuito(tenant, c.id);
  await env.checks(tenant, c.id, 1, false); // um teste que falha zera a contagem
  await env.checks(tenant, c.id, 2);
  r = await env.ciclo(tenant);
  assert.equal(r.deactivated, 0, 'dois testes OK depois da falha ainda não bastam');
  assert.equal((await daConexao(c.id)).length, 1);
  await env.checks(tenant, c.id, 1);
  const antes = (await env.eventos(tenant, 'integration.contingency.deactivated')).length;
  r = await env.ciclo(tenant);
  assert.equal(r.deactivated, 1, 'com 3 testes seguidos OK e o circuito fechado a contingência encerra');
  assert.equal((await daConexao(c.id)).length, 0);
  assert.equal((await env.eventos(tenant, 'integration.contingency.deactivated')).length - antes, 1);
  const r2 = await env.ciclo(tenant);
  assert.equal(r2.deactivated, 0, 'encerrar de novo é no-op');
  assert.equal((await env.eventos(tenant, 'integration.contingency.deactivated')).length - antes, 1);
});

test('contingencia_recovery_checks_e_do_administrador', async () => {
  await config(tenant, 'integration.contingency.recovery_checks', 5);
  const c = await env.conexaoDe(tenant, 'portal-sandbox');
  await env.falhar(tenant, c.id, 5);
  await env.fecharCircuito(tenant, c.id);
  await env.checks(tenant, c.id, 4);
  assert.equal((await env.ciclo(tenant)).deactivated, 0, 'com 5 exigidos, 4 não bastam');
  await env.checks(tenant, c.id, 1);
  assert.equal((await env.ciclo(tenant)).deactivated, 1);
});

test('contingencia_da_familia_sem_connection_encerra_quando_a_familia_volta', async () => {
  await env.semConexoes(tenant, 'PORTAL');
  await env.comTenant(tenant, (t) => env.registry.resolveConnection({ companyId: tenant.companyId, domain: 'PORTAL' }, t)).catch(() => null);
  assert.equal((await env.ativas(tenant)).filter((a) => a.scope === 'FAMILY' && a.domain === 'PORTAL').length, 1);
  const c = await env.conexaoDe(tenant, 'portal-sandbox');
  await env.checks(tenant, c.id, 3);
  const r = await env.ciclo(tenant);
  assert.equal(r.deactivated >= 1, true);
  assert.equal((await env.ativas(tenant)).filter((a) => a.scope === 'FAMILY' && a.domain === 'PORTAL').length, 0);
});

test('contingencia_cada_familia_com_modo_registra_o_gancho', async () => {
  const esperado = { MESSAGING: 'QUEUE_AND_ALTERNATE', PORTAL: 'KEEP_INTERNAL_AND_REPROCESS', SIGNATURE: 'PRESERVE_AND_ALTERNATE_FLOW', BANK: 'NO_ASSUME_AND_QUERY', FINANCING: 'QUEUE_QUERY_OR_ALTERNATE_PROVIDER', IDENTITY: 'PRESERVE_AND_ALTERNATE_FLOW' };
  for (const [domain, mode] of Object.entries(esperado)) {
    await env.semConexoes(tenant, domain);
    await env.comTenant(tenant, (t) => env.registry.resolveConnection({ companyId: tenant.companyId, domain }, t)).catch(() => null);
    const item = (await env.ativas(tenant)).find((a) => a.scope === 'FAMILY' && a.domain === domain);
    assert.ok(item, `${domain}: a família sem connection ativa entra na fila de contingência`);
    assert.equal(item.mode, mode);
  }
});
