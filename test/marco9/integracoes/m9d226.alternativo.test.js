'use strict';

// Marco 9, M9-D226 — fornecedor alternativo: elegibilidade, troca automática só em operação alternate_safe e aprovação humana na perigosa.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d226Env');

const { sequelize, carregarTenants, comTenant, ctxDe, contingency, registry, criar, chave, ler } = env;
let tenant;
let principal;
let manual;

const trocar = (id, opts) => comTenant(tenant, (t) => contingency.switchToAlternate(ctxDe(tenant), id, { now: new Date(), ...opts }, t));
const nova = (conn, operation, extra = {}) => criar(tenant, conn.id, chave(), { operation, snapshot: { amount: '100.00', caso: 'qa-m9' }, ...extra });

before(async () => { ({ tenant } = await carregarTenants()); contingency.installContingency(); });
beforeEach(async () => {
  await env.limparContingencias(tenant);
  await env.limparCircuito(tenant);
  await env.limparPendentes(tenant);
  manual = await env.conexaoDe(tenant, 'financing-manual');
  principal = await env.conexaoDe(tenant, 'financing-sandbox', { contingencia: { alternate_connection_id: manual.id } });
});
after(async () => { await env.limparContingencias(tenant); await env.limparCircuito(tenant); await env.limparPendentes(tenant); await env.desativarConexoesDeTeste(tenant); await sequelize.close(); });

test('contingencia_alternativo_so_se_elegivel', async () => {
  const d = (await nova(principal, 'submitCase')).dispatch;
  const naoElegivel = (motivo) => (e) => e.statusCode === 409 && e.code === 'INTEGRATION_ALTERNATE_NOT_ELIGIBLE' && e.details.motivo === motivo;

  // outra família
  const msg = await env.conexaoDe(tenant, 'messaging-sandbox');
  await env.definirPolitica(tenant, principal.id, { alternate_connection_id: msg.id });
  await assert.rejects(trocar(d.id, {}), naoElegivel('OUTRA_FAMILIA'));
  // sem capability da operação (o fluxo manual não simula)
  await env.definirPolitica(tenant, principal.id, { alternate_connection_id: manual.id });
  const sim = (await nova(principal, 'simulate', { criticalityOp: 'SAFE' })).dispatch;
  await assert.rejects(trocar(sim.id, {}), naoElegivel('SEM_CAPABILITY'));
  // circuito do alternativo não está fechado
  await env.forcarCircuito(tenant, manual.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 600 });
  await assert.rejects(trocar(d.id, {}), naoElegivel('CIRCUITO_NAO_FECHADO'));
  await env.fecharCircuito(tenant, manual.id);
  // alternativo parado
  await comTenant(tenant, (t) => registry.transitionConnection(manual.id, 'PAUSED', ctxDe(tenant), t));
  await assert.rejects(trocar(d.id, {}), naoElegivel('NAO_ATIVO'));
  await comTenant(tenant, (t) => registry.transitionConnection(manual.id, 'ACTIVE', ctxDe(tenant), t));
  // sem alternativo na política
  await env.definirPolitica(tenant, principal.id, {});
  await assert.rejects(trocar(d.id, {}), naoElegivel('SEM_ALTERNATIVO_NA_POLITICA'));
  assert.equal((await ler(tenant, d.id)).status, 'PENDING', 'nenhuma recusa mexeu no envio');

  // elegível: o envio vai para o alternativo com a mesma chave e o mesmo conteúdo aprovado
  await env.definirPolitica(tenant, principal.id, { alternate_connection_id: manual.id });
  const r = await trocar(d.id, {});
  assert.equal(r.switched, true);
  const antigo = await ler(tenant, d.id);
  const novo = await ler(tenant, r.toDispatchId);
  assert.equal(antigo.status, 'CANCELLED');
  assert.deepEqual([novo.connection_id, novo.idempotency_key, novo.payload_hash, novo.status], [manual.id, antigo.idempotency_key, antigo.payload_hash, 'PENDING']);
  const evs = (await env.eventos(tenant, 'integration.contingency.switched')).filter((e) => e.payload_json.fromDispatchId === d.id);
  assert.equal(evs.length, 1);
});

test('contingencia_troca_automatica_so_em_operacao_alternate_safe', async () => {
  const seguro = (await nova(principal, 'submitCase')).dispatch; // marcada alternate_safe: o alternativo é o fluxo manual
  await env.forcarCircuito(tenant, principal.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 600 });
  const r = await env.ciclo(tenant);
  assert.equal(r.activated >= 1, true);
  assert.equal(r.switched, 1, 'o ciclo troca sozinho o envio alternate_safe');
  assert.equal((await ler(tenant, seguro.id)).status, 'CANCELLED');

  // assinatura (perigosa, não marcada): fica na fila até aprovação humana
  const clicksign = await env.conexaoDe(tenant, 'signature-clicksign');
  const assinatura = await env.conexaoDe(tenant, 'signature-sandbox', { contingencia: { alternate_connection_id: clicksign.id } });
  const perigosa = (await nova(assinatura, 'createEnvelope')).dispatch;
  await env.forcarCircuito(tenant, assinatura.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 600 });
  const r2 = await env.ciclo(tenant);
  assert.equal(r2.switched, 0, 'operação perigosa não troca sozinha');
  assert.equal((await ler(tenant, perigosa.id)).status, 'PENDING');
});

test('contingencia_perigosa_exige_aprovacao', async () => {
  const clicksign = await env.conexaoDe(tenant, 'signature-clicksign');
  const assinatura = await env.conexaoDe(tenant, 'signature-sandbox', { contingencia: { alternate_connection_id: clicksign.id } });
  const d = (await nova(assinatura, 'createEnvelope')).dispatch;
  await assert.rejects(trocar(d.id, {}), (e) => e.statusCode === 403 && e.code === 'INTEGRATION_ALTERNATE_REQUIRES_APPROVAL');
  await assert.rejects(trocar(d.id, { approved: false }), (e) => e.code === 'INTEGRATION_ALTERNATE_REQUIRES_APPROVAL');
  assert.equal((await ler(tenant, d.id)).status, 'PENDING');
  const r = await trocar(d.id, { approved: true });
  assert.equal(r.switched, true, 'aprovada por uma pessoa, a troca acontece');
  assert.equal((await ler(tenant, r.toDispatchId)).connection_id, clicksign.id);
});
