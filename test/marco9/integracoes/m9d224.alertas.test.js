'use strict';

// Marco 9, M9-D224 — os 6 alertas (indisponibilidade, aumento de erro, credencial, credencial expirando, sync parado e cota), antiflap, recuperação e notificação com o runbook.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparCircuito, envios, tentativas, ciclo, alertas, notificacoes, mudarConexao, forcarCircuito, mensagemComSaude,
  instalar, config, limparConfig, linha, limparAlertas, desativarConexoesDeTeste,
} = require('../_helpers/m9d224Env');
const { restaurar } = require('../_helpers/m9d214Env');
const { registerHealthSampleSource, resetHealthSampleSources } = require('../../../src/features/integrations/health/sampleSources');
const { dispatchHealthSample } = require('../../../src/features/integrations/dispatch/quota/quota.sample');
const { inboxHealthSample } = require('../../../src/features/integrations/health/inboxSample');
const { recordHealthCheck } = require('../../../src/features/integrations/health/healthRecorder');
const { IntegrationSyncCursor, OutboxEvent } = require('../../../src/models');
const { detectStalledSyncs } = require('../../../src/features/integrations/sync/sync.stalled');
const { runEventConsumers } = require('../../../src/engines/events/consumers');

const CHAVES = ['integration.alert.repeat_min', 'integration.alert.circuit_open_min', 'integration.alert.notify_roles', 'integration.health.down_after_failures', 'integration.secret.expiry_alert_days', 'integration.rate_limit.reserve_pct'];
let tenant;
let c;
const min = (n) => n * 60000;
const em = (base, ms) => new Date(base.getTime() + ms);

before(async () => {
  ({ tenant } = await carregarTenants());
  resetHealthSampleSources();
  registerHealthSampleSource(dispatchHealthSample);
  registerHealthSampleSource(inboxHealthSample);
  instalar(mensagemComSaude());
});
beforeEach(async () => { await limparConfig(tenant, CHAVES); await limparCircuito(tenant); await limparAlertas(tenant); c = await conexaoAtiva(tenant, 'MESSAGING'); });
after(async () => { resetHealthSampleSources(); restaurar(); await limparAlertas(tenant); await desativarConexoesDeTeste(tenant); await limparConfig(tenant, CHAVES); await sequelize.close(); });

const falhasDeSaude = async (id, n) => { for (let i = 0; i < n; i += 1) await comTenant(tenant, (t) => recordHealthCheck(id, { ok: false, latencyMs: 10 }, t)); };
const abertos = async (id, tipo) => (await alertas(tenant, id, tipo)).filter((a) => a.status === 'OPEN');

test('alerta_provider_down', async () => {
  const desde = new Date(Date.now() - 1000);
  await falhasDeSaude(c.id, 3);
  const r = await ciclo(tenant);
  assert.equal(r.errors, 0);
  const [a] = await abertos(c.id, 'PROVIDER_DOWN');
  assert.ok(a, 'três testes de saúde falhos seguidos abrem PROVIDER_DOWN');
  assert.equal(a.severity, 'HIGH', 'família MESSAGING é HIGH');
  assert.equal(a.runbook_path, 'docs/runbooks/integrations/messaging-sandbox.md');
  assert.equal(a.details.reason, 'HEALTH_CHECK');
  const avisos = await notificacoes(tenant, desde, 'docs/runbooks/integrations/messaging-sandbox.md');
  assert.ok(avisos.length >= 1, 'a notificação real leva o link do runbook');
  const foraDoAr = avisos.find((x) => /fora do ar/i.test(x.title));
  assert.ok(foraDoAr, 'o aviso de fornecedor fora do ar leva o link do runbook');
  assert.equal(foraDoAr.channel, 'IN_APP');
  // criticidade CRITICAL sobe a severidade
  const banco = await conexaoAtiva(tenant, 'BANK');
  await falhasDeSaude(banco.id, 3);
  await ciclo(tenant);
  assert.equal((await abertos(banco.id, 'PROVIDER_DOWN'))[0].severity, 'CRITICAL');
  // circuito OPEN: só depois de 5 minutos (parâmetro)
  const c2 = await conexaoAtiva(tenant, 'MESSAGING');
  await forcarCircuito(tenant, c2.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(Date.now() - min(3)), circuitCooldownS: 120 });
  await ciclo(tenant);
  assert.equal((await abertos(c2.id, 'PROVIDER_DOWN')).length, 0, 'aberto há 3 min ainda não alerta');
  await forcarCircuito(tenant, c2.id, { circuitOpenedAt: new Date(Date.now() - min(6)) });
  await ciclo(tenant);
  const [b] = await abertos(c2.id, 'PROVIDER_DOWN');
  assert.equal(b.details.reason, 'CIRCUIT_OPEN');
  await config(tenant, 'integration.alert.circuit_open_min', 10);
  const c3 = await conexaoAtiva(tenant, 'MESSAGING');
  await forcarCircuito(tenant, c3.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(Date.now() - min(6)), circuitCooldownS: 120 });
  await ciclo(tenant);
  assert.equal((await abertos(c3.id, 'PROVIDER_DOWN')).length, 0, 'o prazo de 5 min é parâmetro do administrador');
});

test('alerta_error_rate_up', async () => {
  const [d] = await envios(tenant, c.id, 1);
  const lote = (ok, ruim) => [
    ...Array.from({ length: ok }, () => ({ dispatchId: d, outcome: 'SUCCESS', latencyMs: 80 })),
    ...Array.from({ length: ruim }, () => ({ dispatchId: d, outcome: 'ERROR', errorClass: 'TRANSIENT', latencyMs: 80 })),
  ];
  await tentativas(tenant, c, lote(87, 13));
  await ciclo(tenant);
  const [a] = await abertos(c.id, 'ERROR_RATE_UP');
  assert.ok(a, 'criticidade HIGH (meta 99,5%) com 87% na última hora');
  assert.equal(a.severity, 'MEDIUM');
  assert.equal(Number(a.details.successRate), 87);
  assert.equal(Number(a.details.target), 99.5);
  // abaixo da meta mas em criticidade CRITICAL: HIGH
  const banco = await conexaoAtiva(tenant, 'BANK');
  const [db] = await envios(tenant, banco.id, 1);
  await tentativas(tenant, banco, [...Array.from({ length: 99 }, () => ({ dispatchId: db, outcome: 'SUCCESS' })), { dispatchId: db, outcome: 'ERROR', errorClass: 'UNKNOWN' }]);
  await ciclo(tenant);
  assert.equal((await abertos(banco.id, 'ERROR_RATE_UP'))[0].severity, 'HIGH', '99% < 99,9% em criticidade CRITICAL');
  // dentro da meta ou sem chamadas: nada
  const ok = await conexaoAtiva(tenant, 'MESSAGING');
  const [dok] = await envios(tenant, ok.id, 1);
  await tentativas(tenant, ok, Array.from({ length: 200 }, () => ({ dispatchId: dok, outcome: 'SUCCESS' })));
  const vazio = await conexaoAtiva(tenant, 'MESSAGING');
  await ciclo(tenant);
  assert.equal((await abertos(ok.id, 'ERROR_RATE_UP')).length + (await abertos(vazio.id, 'ERROR_RATE_UP')).length, 0);
});

test('alerta_secret_expiring_30_14_7', async () => {
  const agora = new Date();
  /** Faltam um pouco menos de `dias` dias: "vence em 14 dias" cai no marco de 14. */
  const vence = (dias) => mudarConexao(tenant, c.id, `secret_expires_at = TIMESTAMPTZ '${em(agora, dias * 86400000 - 3600000).toISOString()}'`);
  await vence(40);
  await ciclo(tenant, agora);
  assert.equal((await abertos(c.id, 'SECRET_EXPIRING')).length, 0, '40 dias: ainda cedo');
  await vence(29);
  await ciclo(tenant, agora);
  let [a] = await abertos(c.id, 'SECRET_EXPIRING');
  assert.deepEqual([a.window_key, a.severity], ['30', 'LOW'], 'marco de 30 dias: LOW');
  await vence(14);
  await ciclo(tenant, agora);
  [a] = await abertos(c.id, 'SECRET_EXPIRING');
  assert.deepEqual([a.window_key, a.severity], ['14', 'MEDIUM'], 'vence em 14 dias: MEDIUM');
  const todos = await alertas(tenant, c.id, 'SECRET_EXPIRING');
  const antigo = todos.find((x) => x.window_key === '30');
  assert.deepEqual([antigo.status, antigo.resolution], ['RESOLVED', 'SUPERSEDED'], 'o marco anterior é substituído, não "recuperado"');
  assert.equal(antigo.recovery_notified_at, null, 'sem aviso de recuperação para marco substituído');
  await vence(6);
  await ciclo(tenant, agora);
  [a] = await abertos(c.id, 'SECRET_EXPIRING');
  assert.deepEqual([a.window_key, a.severity], ['7', 'HIGH'], 'marco de 7 dias: HIGH');
  assert.equal((await abertos(c.id, 'SECRET_EXPIRING')).length, 1, 'um alerta aberto por vez');
  // rotação da credencial: a condição some e o alerta resolve
  await vence(200);
  await ciclo(tenant, agora);
  assert.equal((await abertos(c.id, 'SECRET_EXPIRING')).length, 0);
  // os marcos são o parâmetro do administrador (D202)
  await config(tenant, 'integration.secret.expiry_alert_days', '60,10');
  await vence(50);
  await ciclo(tenant, agora);
  assert.equal((await abertos(c.id, 'SECRET_EXPIRING'))[0].window_key, '60');
});

test('alerta_sync_stalled', async () => {
  const agora = new Date();
  const ctx = ctxDe(tenant);
  const criar = (stream, minutosSemSucesso) => comTenant(tenant, async (t) => {
    const cur = await IntegrationSyncCursor.create({ groupId: tenant.groupId, companyId: tenant.companyId, connectionId: c.id, stream }, { transaction: t });
    await sequelize.query('UPDATE integration.sync_cursors SET last_success_at = :s WHERE id = :id', { replacements: { s: new Date(agora.getTime() - min(minutosSemSucesso)), id: cur.id }, transaction: t });
    return cur;
  });
  const parado = await criar('messaging.status', 40); // HIGH: 30 min
  await criar('messaging.templates', 20); // em dia: abaixo do limite
  const achados = await comTenant(tenant, (t) => detectStalledSyncs(ctx, t, { now: agora }));
  assert.deepEqual(achados.map((x) => x.cursorId), [parado.id], 'só o fluxo acima do limite da criticidade');
  // D224 consome o evento integration.sync.stalled e o transforma em alerta
  const eventos = await comTenant(tenant, (t) => OutboxEvent.findAll({ where: { eventType: 'integration.sync.stalled', aggregateId: parado.id }, transaction: t }));
  assert.equal(eventos.length, 1);
  await comTenant(tenant, async (t) => runEventConsumers(eventos[0], t));
  let [a] = await abertos(c.id, 'SYNC_STALLED');
  assert.ok(a, 'evento vira alerta');
  assert.deepEqual([a.severity, a.window_key], ['HIGH', parado.id]);
  assert.equal(a.details.stream, 'messaging.status');
  assert.equal(a.details.limitMinutes, 30);
  // o ciclo mantém um alerta só e não repete o aviso antes do prazo (antiflap)
  await ciclo(tenant, agora);
  await ciclo(tenant, em(agora, min(5)));
  [a] = await abertos(c.id, 'SYNC_STALLED');
  assert.equal((await abertos(c.id, 'SYNC_STALLED')).length, 1);
  assert.equal(a.notify_count, 1, 'sem repetir em excesso');
  // sucesso seguinte resolve
  await comTenant(tenant, (t) => sequelize.query('UPDATE integration.sync_cursors SET last_success_at = :s, status = \'IDLE\' WHERE id = :id', { replacements: { s: em(agora, min(6)), id: parado.id }, transaction: t }));
  await ciclo(tenant, em(agora, min(7)));
  const depois = (await alertas(tenant, c.id, 'SYNC_STALLED'))[0];
  assert.deepEqual([depois.status, depois.resolution], ['RESOLVED', 'CONDITION_CLEARED']);
  // o limite vem da criticidade da família (LOW = 1440 min)
  const social = await conexaoAtiva(tenant, 'SOCIAL');
  await comTenant(tenant, async (t) => {
    const cur = await IntegrationSyncCursor.create({ groupId: tenant.groupId, companyId: tenant.companyId, connectionId: social.id, stream: 'social.posts' }, { transaction: t });
    await sequelize.query('UPDATE integration.sync_cursors SET last_success_at = :s WHERE id = :id', { replacements: { s: new Date(agora.getTime() - min(600)), id: cur.id }, transaction: t });
  });
  await ciclo(tenant, agora);
  assert.equal((await abertos(social.id, 'SYNC_STALLED')).length, 0, '10 h sem sincronizar não alerta em criticidade LOW');
});

test('alerta_antiflap_e_recuperacao', async () => {
  const t0 = new Date();
  const desde = new Date(t0.getTime() - 1000);
  await falhasDeSaude(c.id, 3);
  await ciclo(tenant, t0);
  await ciclo(tenant, t0); // idempotente: mesma chave, mesma linha
  let todos = await alertas(tenant, c.id, 'PROVIDER_DOWN');
  assert.equal(todos.length, 1, 'a mesma condição não abre duas linhas');
  assert.equal(todos[0].notify_count, 1);
  await ciclo(tenant, em(t0, min(10)));
  assert.equal((await alertas(tenant, c.id, 'PROVIDER_DOWN'))[0].notify_count, 1, '10 min depois: antiflap (repeat_min 60)');
  await ciclo(tenant, em(t0, min(61)));
  assert.equal((await alertas(tenant, c.id, 'PROVIDER_DOWN'))[0].notify_count, 2, 'passada a hora, avisa de novo');
  await config(tenant, 'integration.alert.repeat_min', 5);
  await ciclo(tenant, em(t0, min(67)));
  assert.equal((await alertas(tenant, c.id, 'PROVIDER_DOWN'))[0].notify_count, 3, 'o intervalo é parâmetro do administrador');
  const antes = (await notificacoes(tenant, desde, 'fora do ar')).length;
  // a condição some: resolve sozinho e avisa a recuperação uma vez
  await comTenant(tenant, (t) => recordHealthCheck(c.id, { ok: true, latencyMs: 10 }, t));
  await ciclo(tenant, em(t0, min(70)));
  todos = await alertas(tenant, c.id, 'PROVIDER_DOWN');
  assert.deepEqual([todos[0].status, todos[0].resolution], ['RESOLVED', 'CONDITION_CLEARED']);
  assert.ok(todos[0].recovery_notified_at);
  const aviso = await notificacoes(tenant, desde, 'recuperou');
  assert.ok(aviso.length >= 1, 'notificação de recuperação');
  await ciclo(tenant, em(t0, min(72)));
  assert.equal((await notificacoes(tenant, desde, 'recuperou')).length, aviso.length, 'a recuperação é avisada uma vez só');
  assert.ok((await notificacoes(tenant, desde, 'fora do ar')).length >= antes);
  // novo incidente depois de resolvido = linha nova
  await falhasDeSaude(c.id, 3);
  await ciclo(tenant, em(t0, min(80)));
  assert.equal((await alertas(tenant, c.id, 'PROVIDER_DOWN')).length, 2);
});

test('alerta_autenticacao_e_cota_baixa', async () => {
  await mudarConexao(tenant, c.id, "status = 'AUTH_FAILED'");
  await ciclo(tenant);
  const [a] = await abertos(c.id, 'AUTH_FAILURE');
  assert.equal(a.severity, 'HIGH', 'qualquer AUTH_FAILED');
  await mudarConexao(tenant, c.id, "status = 'ACTIVE'");
  await ciclo(tenant);
  assert.equal((await abertos(c.id, 'AUTH_FAILURE')).length, 0, 'volta a ACTIVE: resolve');
  // cota: 150 de 1000 (15%) está abaixo da reserva de 20%
  const q = await conexaoAtiva(tenant, 'MESSAGING');
  const [d] = await envios(tenant, q.id, 1);
  await tentativas(tenant, q, [{ dispatchId: d, outcome: 'SUCCESS', quota: { limit: 1000, remaining: 150 } }]);
  await comTenant(tenant, async (t) => { const { aggregateConnectionHealth } = require('../../../src/features/integrations/health'); await aggregateConnectionHealth(await require('../../../src/models').IntegrationConnection.findByPk(q.id, { transaction: t }), {}, t); });
  await ciclo(tenant);
  assert.equal((await abertos(q.id, 'QUOTA_LOW'))[0].severity, 'MEDIUM');
  await config(tenant, 'integration.rate_limit.reserve_pct', 10);
  await ciclo(tenant);
  assert.equal((await abertos(q.id, 'QUOTA_LOW')).length, 0, 'com reserva de 10% a cota de 15% está boa');
  assert.ok((await linha(tenant, q.id)).quota_remaining === 150);
});

test('alerta_saude_ativa_e_alerta_em_conjunto', async () => {
  // D223 + D224 juntos: três testes de saúde ativos falhos (adapter real do registro) levam ao alerta com o runbook
  const Msg = mensagemComSaude();
  Msg.H.passo = { ok: false, latencyMs: 20 };
  instalar(Msg);
  const { runConnectionHealthCheck } = require('../../../src/features/integrations/health/healthCheck');
  const desde = new Date(Date.now() - 1000);
  for (let i = 0; i < 3; i += 1) await runConnectionHealthCheck(ctxDe(tenant), c.id);
  await ciclo(tenant);
  assert.equal((await abertos(c.id, 'PROVIDER_DOWN')).length, 1);
  assert.ok((await notificacoes(tenant, desde, 'runbooks/integrations/messaging-sandbox.md')).length >= 1);
  Msg.H.passo = { ok: true };
  await runConnectionHealthCheck(ctxDe(tenant), c.id);
  await ciclo(tenant);
  assert.equal((await abertos(c.id, 'PROVIDER_DOWN')).length, 0);
});
