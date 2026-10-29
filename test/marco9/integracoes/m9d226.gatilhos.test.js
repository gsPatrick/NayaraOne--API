'use strict';

// Marco 9, M9-D226 — gatilhos da contingência: circuito aberto, família sem connection ativa, connection parada, saúde DOWN; ativar de novo é no-op.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d226Env');

const { sequelize, carregarTenants, comTenant, ctxDe, contingency, registry } = env;
let tenant;

before(async () => { ({ tenant } = await carregarTenants()); contingency.installContingency(); });
beforeEach(async () => { await env.limparContingencias(tenant); await env.limparCircuito(tenant); });
after(async () => { await env.limparContingencias(tenant); await env.limparCircuito(tenant); await env.desativarConexoesDeTeste(tenant); await sequelize.close(); });

const daConexao = async (id) => (await env.ativas(tenant)).filter((a) => a.connectionId === id);
const resolver = (domain) => comTenant(tenant, (t) => registry.resolveConnection({ companyId: tenant.companyId, domain }, t));

test('contingencia_ativa_com_circuito_aberto', async () => {
  const c = await env.conexaoDe(tenant, 'messaging-sandbox');
  assert.equal((await daConexao(c.id)).length, 0, 'sem falha, sem contingência');
  const antes = (await env.eventos(tenant, 'integration.contingency.activated')).length;
  await env.falhar(tenant, c.id, 5);
  const ativas = await daConexao(c.id);
  assert.equal(ativas.length, 1, 'o circuito aberto ativa a contingência da connection');
  assert.equal(ativas[0].mode, 'QUEUE_AND_ALTERNATE');
  assert.equal(ativas[0].domain, 'MESSAGING');
  assert.deepEqual(ativas[0].reasons, ['CIRCUIT_OPEN']);
  assert.equal(ativas[0].scope, 'CONNECTION');
  const evs = await env.eventos(tenant, 'integration.contingency.activated');
  assert.equal(evs.length - antes, 1, 'um evento integration.contingency.activated');
  const ev = evs[evs.length - 1];
  assert.equal(ev.payload_json.connectionId, c.id);
  assert.equal(ev.payload_json.mode, 'QUEUE_AND_ALTERNATE');
  const erros = await comTenant(tenant, async (t) => (await sequelize.query(
    "SELECT * FROM integration.integration_errors WHERE connection_id = :id AND error_code = 'CONTINGENCY_ACTIVE'", { replacements: { id: c.id }, transaction: t },
  ))[0]);
  assert.equal(erros.length, 1, 'o estado fica auditado em integration_errors (origem HEALTH)');
  assert.equal(erros[0].source, 'HEALTH');
});

test('contingencia_ativa_sem_connection', async () => {
  await env.semConexoes(tenant, 'MESSAGING');
  await assert.rejects(resolver('MESSAGING'), (e) => e.statusCode === 404 && e.code === 'INTEGRATION_CONNECTION_NOT_FOUND');
  const familia = (await env.ativas(tenant)).filter((a) => a.scope === 'FAMILY' && a.domain === 'MESSAGING');
  assert.equal(familia.length, 1, 'o 404 aciona a contingência da família e ela sobrevive ao rollback do pedido');
  assert.equal(familia[0].mode, 'QUEUE_AND_ALTERNATE');
  assert.deepEqual(familia[0].reasons, ['NO_ACTIVE_CONNECTION']);
  assert.equal(familia[0].connectionId, null);
  await assert.rejects(resolver('MESSAGING'), (e) => e.code === 'INTEGRATION_CONNECTION_NOT_FOUND');
  assert.equal((await env.ativas(tenant)).filter((a) => a.scope === 'FAMILY' && a.domain === 'MESSAGING').length, 1, 'reativar enquanto ativa é no-op');
});

test('contingencia_ativa_com_connection_pausada_ou_credencial_recusada', async () => {
  const p = await env.conexaoDe(tenant, 'messaging-sandbox');
  await comTenant(tenant, (t) => registry.transitionConnection(p.id, 'PAUSED', ctxDe(tenant), t));
  let r = await env.ciclo(tenant);
  assert.equal(r.activated >= 1, true);
  assert.deepEqual((await daConexao(p.id))[0].reasons, ['PAUSED']);
  const a = await env.conexaoDe(tenant, 'bank-sandbox');
  await comTenant(tenant, (t) => registry.transitionConnection(a.id, 'AUTH_FAILED', ctxDe(tenant), t, { system: true }));
  r = await env.ciclo(tenant);
  const doBanco = (await daConexao(a.id))[0];
  assert.deepEqual([doBanco.mode, doBanco.reasons], ['NO_ASSUME_AND_QUERY', ['AUTH_FAILED']]);
});

test('contingencia_ativa_com_saude_down_e_reativar_e_noop', async () => {
  const c = await env.conexaoDe(tenant, 'portal-sandbox');
  await env.checks(tenant, c.id, 3, false);
  const r1 = await env.ciclo(tenant);
  assert.equal(r1.activated >= 1, true);
  const ativa = (await daConexao(c.id))[0];
  assert.equal(ativa.mode, 'KEEP_INTERNAL_AND_REPROCESS');
  assert.ok(ativa.reasons.includes('HEALTH_DOWN'));
  const evs = (await env.eventos(tenant, 'integration.contingency.activated')).length;
  const r2 = await env.ciclo(tenant);
  assert.equal(r2.activated, 0, 'rodar de novo enquanto ativa não ativa outra vez');
  assert.equal((await daConexao(c.id)).length, 1);
  assert.equal((await env.eventos(tenant, 'integration.contingency.activated')).length, evs, 'nenhum evento novo');
});

test('familia_sem_modo_de_contingencia_so_tem_fila_e_retry', async () => {
  const e = await env.conexaoDe(tenant, 'email-sandbox');
  await env.falhar(tenant, e.id, 5);
  await env.ciclo(tenant);
  assert.equal((await daConexao(e.id)).length, 0, 'EMAIL (MEDIUM, fora da seção 18) não ganha modo de contingência');
});
