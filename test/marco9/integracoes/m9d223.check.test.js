'use strict';

// Marco 9, M9-D223 — health check ativo: atualiza provider_health, 3 falhas seguidas = DOWN + alerta, nunca lança, respeita o HALF_OPEN e o lease, e não mexe nas transições do circuito.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, carregarTenants, ctxDe, conexaoAtiva, limparCircuito, linha, forcarCircuito, mensagemComSaude, instalar, errosDe, config, limparConfig,
} = require('../_helpers/m9d223Env');
const { restaurar } = require('../_helpers/m9d214Env');
const { runConnectionHealthCheck, runHealthCheckCycle } = require('../../../src/features/integrations/health/healthCheck');

let tenant;
let Msg;
let c;
const rodar = (id = c.id, extra = {}) => runConnectionHealthCheck(ctxDe(tenant), id, extra);
const passado = (s) => new Date(Date.now() - s * 1000);

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => {
  Msg = mensagemComSaude();
  instalar(Msg);
  await limparCircuito(tenant);
  await limparConfig(tenant, ['integration.health.down_after_failures', 'integration.health.check_interval_s']);
  c = await conexaoAtiva(tenant, 'MESSAGING');
});
after(async () => { restaurar(); await limparCircuito(tenant); await limparConfig(tenant, ['integration.health.down_after_failures', 'integration.health.check_interval_s']); await sequelize.close(); });

test('health_check_atualiza_provider_health', async () => {
  Msg.H.passo = { ok: true, latencyMs: 37 };
  const r = await rodar();
  assert.deepEqual([r.status, r.ok], ['CHECKED', true]);
  const l = await linha(tenant, c.id);
  assert.equal(l.last_check_ok, true);
  assert.equal(l.last_check_latency_ms, 37);
  assert.ok(l.last_check_at && Date.now() - new Date(l.last_check_at).getTime() < 60000);
  assert.equal(l.check_consecutive_failures, 0);
  assert.equal(l.health_status, 'HEALTHY');
  assert.equal(l.check_lease_until, null, 'o lease é devolvido ao final');
});

test('health_tres_falhas_down_e_alerta', async () => {
  Msg.H.passo = { ok: false, latencyMs: 4000 };
  for (let i = 1; i <= 2; i += 1) {
    await rodar();
    const l = await linha(tenant, c.id);
    assert.equal(l.check_consecutive_failures, i);
    assert.notEqual(l.health_status, 'DOWN', `${i} falha(s) ainda não derrubam`);
  }
  assert.equal((await errosDe(tenant, c.id, 'PROVIDER_DOWN')).length, 0, 'sem alerta antes da terceira');
  await rodar();
  const l = await linha(tenant, c.id);
  assert.equal(l.health_status, 'DOWN');
  assert.equal(l.last_check_ok, false);
  const alerta = await errosDe(tenant, c.id, 'PROVIDER_DOWN');
  assert.equal(alerta.length, 1);
  assert.equal(alerta[0].severity, 'HIGH');
  assert.equal(alerta[0].source, 'HEALTH');
  // um teste bom zera a contagem e tira do DOWN
  Msg.H.passo = { ok: true };
  await rodar();
  const bom = await linha(tenant, c.id);
  assert.deepEqual([bom.check_consecutive_failures, bom.health_status], [0, 'HEALTHY']);
  // o limite é parâmetro do administrador
  const c2 = await conexaoAtiva(tenant, 'MESSAGING');
  await config(tenant, 'integration.health.down_after_failures', 1);
  Msg.H.passo = { ok: false };
  await rodar(c2.id);
  assert.equal((await linha(tenant, c2.id)).health_status, 'DOWN');
});

test('health_check_respeita_half_open', async () => {
  await forcarCircuito(tenant, c.id, { circuitState: 'HALF_OPEN', circuitOpenedAt: passado(130), circuitCooldownS: 120, halfOpenInflight: 3, halfOpenInflightSince: new Date() });
  const cheio = await rodar();
  assert.deepEqual([cheio.status, cheio.reason], ['SKIPPED', 'CIRCUIT_HALF_OPEN_FULL']);
  assert.equal(Msg.H.chamadas, 0, 'sem vaga, o teste de saúde não chama o fornecedor');
  await forcarCircuito(tenant, c.id, { halfOpenInflight: 2 });
  const livre = await rodar();
  assert.equal(livre.status, 'CHECKED');
  assert.equal(Msg.H.chamadas, 1);
  const l = await linha(tenant, c.id);
  assert.deepEqual([l.circuit_state, l.half_open_inflight], ['HALF_OPEN', 2], 'o teste de saúde não ocupa vaga nem mexe no circuito');
});

test('health_check_excecao_vira_ok_false', async () => {
  Msg.H.passo = { lanca: true };
  const r = await rodar();
  assert.deepEqual([r.status, r.ok], ['CHECKED', false]);
  assert.doesNotMatch(JSON.stringify(r), /sk-live/, 'o resultado não carrega segredo');
  assert.equal((await linha(tenant, c.id)).last_check_ok, false);
  Msg.H.passo = { malformado: true };
  assert.equal((await rodar()).ok, false, 'resposta fora do formato também é falha');
  await config(tenant, 'integration.health.check_timeout_ms', 500);
  try {
    Msg.H.passo = { espera: 1500, ok: true };
    const lento = await rodar();
    assert.equal(lento.ok, false, 'tempo esgotado é falha');
  } finally { await limparConfig(tenant, ['integration.health.check_timeout_ms']); }
  // connection que não existe: não lança, relata
  const sumiu = await rodar('00000000-0000-4000-8000-00000000dead');
  assert.equal(sumiu.status, 'SKIPPED');
});

test('health_check_lease_exclusivo', async () => {
  Msg.H.passo = { ok: true, espera: 400 };
  const [a, b, d] = await Promise.all([rodar(), rodar(), rodar()]);
  const feitos = [a, b, d].filter((x) => x.status === 'CHECKED');
  assert.equal(feitos.length, 1, 'um teste por connection por vez');
  assert.equal(Msg.H.chamadas, 1);
  assert.ok([a, b, d].filter((x) => x.status === 'SKIPPED').every((x) => x.reason === 'LEASE_HELD'));
  // lease vencido (processo que caiu) não trava para sempre
  await sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query("UPDATE integration.provider_health SET check_lease_until = now() - interval '1 minute', check_lease_owner = 'morto' WHERE connection_id = :id AND window_minutes = 0", { replacements: { id: c.id }, transaction: t });
  });
  Msg.H.passo = { ok: true };
  assert.equal((await rodar()).status, 'CHECKED');
});

test('health_ok_em_open_nao_antecipa_half_open', async () => {
  await forcarCircuito(tenant, c.id, { circuitState: 'OPEN', circuitOpenedAt: passado(10), circuitCooldownS: 120 });
  Msg.H.passo = { ok: true };
  const r = await rodar();
  assert.deepEqual([r.status, r.ok], ['CHECKED', true], 'em OPEN o teste roda, para detectar a recuperação');
  const l = await linha(tenant, c.id);
  assert.equal(l.last_check_ok, true, 'o health ok é registrado');
  assert.equal(l.circuit_state, 'OPEN', 'mas o circuito continua OPEN: só a D217 transiciona');
  assert.equal(l.half_open_inflight, 0);
  assert.equal(l.health_status, 'DOWN');
  // nem com o cooldown vencido o teste de saúde transiciona: o HALF_OPEN nasce na próxima chamada admitida
  await forcarCircuito(tenant, c.id, { circuitOpenedAt: passado(300) });
  await rodar();
  assert.equal((await linha(tenant, c.id)).circuit_state, 'OPEN');
});

test('health_ciclo_confere_so_connections_ativas', async () => {
  Msg.H.passo = { ok: true };
  const r = await runHealthCheckCycle(ctxDe(tenant), { now: new Date() });
  const meu = r.results.find((x) => x.connectionId === c.id);
  assert.deepEqual([meu.status, meu.ok], ['CHECKED', true], 'a connection ACTIVE foi conferida');
  assert.equal(Msg.H.chamadas, 1);
  const antes = (await linha(tenant, c.id)).last_check_at.getTime();
  const nova = await conexaoAtiva(tenant, 'MESSAGING'); // desativa a anterior (mesmo fornecedor)
  const r2 = await runHealthCheckCycle(ctxDe(tenant), { now: new Date() });
  assert.equal(r2.results.some((x) => x.connectionId === c.id), false, 'connection desativada não é conferida');
  assert.equal(r2.results.find((x) => x.connectionId === nova.id).ok, true);
  assert.equal(Msg.H.chamadas, 2);
  assert.equal((await linha(tenant, c.id)).last_check_at.getTime(), antes, 'o último teste da connection desativada não mudou');
  assert.equal(r2.checked, r2.ok + r2.failed);
});
