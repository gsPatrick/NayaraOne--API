'use strict';

// Marco 9, M9-D217 — máquina de estados do circuit breaker: limiar, HALF_OPEN limitado, fechamento, reabertura, classes que não contam e política por connection.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, config, limparCircuito, desativarConexoesDeTeste, admitir, resultado, falhar, linha, forcarCircuito, errosCircuito,
} = require('../_helpers/m9d217Env');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { mergeCircuitPolicy } = require('../../../src/features/integrations/health/circuitPolicy');

let tenant;
let c;
const passado = (s) => new Date(Date.now() - s * 1000);

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => { await limparCircuito(tenant); c = await conexaoAtiva(tenant, 'MESSAGING'); });
after(async () => { await limparCircuito(tenant); await desativarConexoesDeTeste(tenant); await sequelize.close(); });

test('circuito_abre_apos_limiar_consecutivo', async () => {
  await falhar(tenant, c.id, 4);
  assert.equal((await linha(tenant, c.id)).circuit_state, 'CLOSED', '4 falhas ainda não abrem');
  assert.equal((await linha(tenant, c.id)).consecutive_failures, 4);
  const r = await resultado(tenant, c.id, { ok: false, errorClass: 'TRANSIENT' });
  assert.equal(r.opened, true);
  const l = await linha(tenant, c.id);
  assert.equal(l.circuit_state, 'OPEN');
  assert.equal(l.circuit_cooldown_s, 120);
  assert.ok(l.circuit_opened_at);
  assert.equal(l.health_status, 'DOWN');
  const erros = await errosCircuito(tenant, c.id);
  assert.equal(erros.length, 1, 'um erro CIRCUIT_OPEN por abertura');
  assert.equal(erros[0].severity, 'HIGH');
  // um sucesso no meio zera a contagem: 3 falhas, sucesso, 4 falhas não abrem
  const c2 = await conexaoAtiva(tenant, 'MESSAGING');
  await falhar(tenant, c2.id, 3);
  await resultado(tenant, c2.id, { ok: true });
  await falhar(tenant, c2.id, 4);
  assert.equal((await linha(tenant, c2.id)).circuit_state, 'CLOSED', 'falhas precisam ser consecutivas');
  // UNKNOWN também conta
  const c3 = await conexaoAtiva(tenant, 'MESSAGING');
  await falhar(tenant, c3.id, 5, 'UNKNOWN');
  assert.equal((await linha(tenant, c3.id)).circuit_state, 'OPEN');
});

test('circuito_half_open_limita_chamadas', async () => {
  await forcarCircuito(tenant, c.id, { circuitState: 'OPEN', circuitOpenedAt: passado(130), circuitCooldownS: 120 });
  const respostas = await Promise.all([1, 2, 3, 4, 5, 6].map(() => admitir(tenant, c.id)));
  assert.equal(respostas.filter((x) => x.allowed).length, 3, 'no máximo half_open_max_calls (3) testes ao mesmo tempo');
  assert.ok(respostas.filter((x) => x.allowed).every((x) => x.probe === true));
  const negadas = respostas.filter((x) => !x.allowed);
  assert.equal(negadas.length, 3);
  assert.ok(negadas.every((x) => x.reason === 'CIRCUIT_HALF_OPEN_FULL' && x.until instanceof Date));
  const l = await linha(tenant, c.id);
  assert.equal(l.circuit_state, 'HALF_OPEN');
  assert.equal(l.half_open_inflight, 3);
  // um teste que termina sem mudar o estado (erro de validação) libera a vaga
  await resultado(tenant, c.id, { ok: false, errorClass: 'VALIDATION', probe: true });
  assert.equal((await admitir(tenant, c.id)).allowed, true, 'a vaga liberada pode ser usada');
  // dentro do cooldown, antes de vencer, nada vira HALF_OPEN
  const c2 = await conexaoAtiva(tenant, 'MESSAGING');
  await forcarCircuito(tenant, c2.id, { circuitState: 'OPEN', circuitOpenedAt: passado(10), circuitCooldownS: 120 });
  const antes = await admitir(tenant, c2.id);
  assert.equal(antes.allowed, false);
  assert.equal(antes.reason, 'CIRCUIT_OPEN');
  assert.equal((await linha(tenant, c2.id)).circuit_state, 'OPEN');
});

test('circuito_fecha_apos_sucesso_em_half_open', async () => {
  await forcarCircuito(tenant, c.id, { circuitState: 'OPEN', circuitOpenedAt: passado(125), circuitCooldownS: 120, consecutiveFailures: 5 });
  const a = await admitir(tenant, c.id);
  assert.equal(a.probe, true);
  const r = await resultado(tenant, c.id, { ok: true, probe: true });
  assert.equal(r.closed, true);
  const l = await linha(tenant, c.id);
  assert.deepEqual([l.circuit_state, l.consecutive_failures, l.half_open_successes, l.half_open_inflight], ['CLOSED', 0, 0, 0], 'contadores zerados');
  assert.equal(l.circuit_opened_at, null);
  // com close_after_successes = 2 um sucesso não basta
  await config(tenant, 'integration.circuit.close_after_successes', 2);
  const c2 = await conexaoAtiva(tenant, 'MESSAGING');
  await forcarCircuito(tenant, c2.id, { circuitState: 'OPEN', circuitOpenedAt: passado(125), circuitCooldownS: 120 });
  await admitir(tenant, c2.id);
  await admitir(tenant, c2.id);
  await resultado(tenant, c2.id, { ok: true, probe: true });
  assert.equal((await linha(tenant, c2.id)).circuit_state, 'HALF_OPEN');
  await resultado(tenant, c2.id, { ok: true, probe: true });
  assert.equal((await linha(tenant, c2.id)).circuit_state, 'CLOSED');
});

test('circuito_reabre_com_falha_em_half_open', async () => {
  await forcarCircuito(tenant, c.id, { circuitState: 'OPEN', circuitOpenedAt: passado(125), circuitCooldownS: 120 });
  await admitir(tenant, c.id);
  const antes = Date.now();
  const r = await resultado(tenant, c.id, { ok: false, errorClass: 'TRANSIENT', probe: true });
  assert.equal(r.opened, true);
  const l = await linha(tenant, c.id);
  assert.equal(l.circuit_state, 'OPEN');
  assert.equal(l.circuit_cooldown_s, 120, 'mesmo cooldown de 120 s');
  assert.ok(new Date(l.circuit_opened_at).getTime() >= antes - 1000, 'o cooldown recomeça agora');
  assert.equal(l.half_open_inflight, 0);
  assert.equal((await errosCircuito(tenant, c.id)).length >= 1, true);
});

test('circuito_validation_e_ratelimit_nao_contam', async () => {
  await falhar(tenant, c.id, 10, 'VALIDATION');
  await falhar(tenant, c.id, 10, 'RATE_LIMIT');
  await falhar(tenant, c.id, 10, 'AUTH');
  const l = await linha(tenant, c.id);
  assert.equal(l.circuit_state, 'CLOSED', '10 respostas 422 e demais classes excluídas');
  assert.equal(l.consecutive_failures, 0);
  await falhar(tenant, c.id, 3);
  await falhar(tenant, c.id, 10, 'VALIDATION');
  assert.equal((await linha(tenant, c.id)).consecutive_failures, 3, 'classe excluída nem soma nem zera');
});

test('circuito_policy_da_connection_sobrescreve_a_do_provider', async () => {
  // global (parâmetro da empresa) < fornecedor < connection
  await config(tenant, 'integration.circuit.failure_threshold', 8);
  await falhar(tenant, c.id, 7);
  assert.equal((await linha(tenant, c.id)).circuit_state, 'CLOSED', 'parâmetro da empresa: 8');
  await resultado(tenant, c.id, { ok: false, errorClass: 'TRANSIENT' });
  assert.equal((await linha(tenant, c.id)).circuit_state, 'OPEN');
  const c2 = await conexaoAtiva(tenant, 'MESSAGING');
  await comTenant(tenant, (t) => registry.updateConnection(c2.id, { policyJson: { circuit: { failure_threshold: 2, cooldown_s: 30 } } }, ctxDe(tenant), t));
  await falhar(tenant, c2.id, 2);
  const l2 = await linha(tenant, c2.id);
  assert.deepEqual([l2.circuit_state, l2.circuit_cooldown_s], ['OPEN', 30], 'a connection vence o parâmetro da empresa');
  // a camada do fornecedor fica entre as duas (pura) e, gravada no catálogo, vale para as connections dele
  assert.deepEqual(mergeCircuitPolicy({ global: { cooldown_s: 60 }, provider: { cooldown_s: 90, failure_threshold: 4 }, connection: { failure_threshold: 2 } }),
    { failure_threshold: 2, cooldown_s: 90, half_open_max_calls: 3, close_after_successes: 1 });
  assert.equal(mergeCircuitPolicy({ provider: { cooldown_s: 0, half_open_max_calls: 'x' } }).cooldown_s, 120, 'valor fora do limite é descartado');
  const c3 = await conexaoAtiva(tenant, 'MESSAGING');
  const politicaDoFornecedor = (json) => sequelize.transaction(async (t) => {
    await sequelize.query("SET LOCAL app.integration_platform_admin = 'on'", { transaction: t });
    await sequelize.query("UPDATE integration.providers SET default_policy_json = CAST(:p AS jsonb) WHERE code = 'messaging-sandbox'", { replacements: { p: JSON.stringify(json) }, transaction: t });
  });
  await politicaDoFornecedor({ circuit: { failure_threshold: 3, cooldown_s: 45 } });
  try {
    await falhar(tenant, c3.id, 3);
    const l3 = await linha(tenant, c3.id);
    assert.deepEqual([l3.circuit_state, l3.circuit_cooldown_s], ['OPEN', 45], 'política do fornecedor sobre o parâmetro da empresa');
  } finally {
    await politicaDoFornecedor({});
  }
  // limites ao salvar
  for (const ruim of [{ failure_threshold: 0 }, { cooldown_s: 0 }, { half_open_max_calls: 1000 }, { close_after_successes: -1 }, { inventado: 1 }, { failure_threshold: 2.5 }]) {
    await assert.rejects(
      comTenant(tenant, (t) => registry.updateConnection(c3.id, { policyJson: { circuit: ruim } }, ctxDe(tenant), t)),
      (e) => e.statusCode === 422 && e.code === 'INTEGRATION_POLICY_INVALID',
      JSON.stringify(ruim),
    );
  }
  // parâmetro global fora do limite é recusado pela configuração
  await assert.rejects(config(tenant, 'integration.circuit.cooldown_s', 0), (e) => e.statusCode === 400);
});
