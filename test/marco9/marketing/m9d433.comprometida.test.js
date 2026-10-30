'use strict';

// M9-D433 — conta social comprometida: a sequência completa (token revogado, conexão COMPROMISED, kill switch do canal) por marcação manual e pelo sinal AUTH_REVOKED do
// provedor, a falha do adapter que mantém o bloqueio, a idempotência, o 423 próprio e o isolamento entre empresas. Banco descartável, tudo em transação com rollback.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktWorker');
const marketing = require('../../../src/features/marketing');
const ks = require('../../../src/features/marketing/killswitch.service');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const { SandboxChannelAdapter } = require('../../../src/features/marketing/publications/adapters/sandbox/SandboxChannelAdapter');
const { sendToChannel } = require('../../../src/features/marketing/publications/adapters');
const store = require('../../../src/features/marketing/publications/adapters/sandbox/sandbox.store');
const { prepararTenants } = require('../../helpers/marketingExecucao');

let ctx;
let tenantB;
before(async () => { ctx = await env.setup(); ({ tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });
afterEach(() => { env.reset(); env.resetSandbox(); });

const ctxDe = (tn) => ({ companyId: tn.companyId, groupId: tn.groupId, userId: tn.userId });
const ligar = (t, tenant, body) => ks.changeKillSwitch({ tenant, actorUserId: tenant.userId, transaction: t, input: { scope: 'CHANNEL', targetId: 'INSTAGRAM', active: true, reason: 'QA-M9 conta comprometida', compromised: true, ...body } });
const conexao = async (t, tenant) => {
  const c = await registry.createConnection({ providerCode: 'social-sandbox', environment: 'SANDBOX', label: `QA-M9 ${Date.now()}${Math.random()}` }, ctxDe(tenant), t);
  return transitionConnection(c.id, 'ACTIVE', ctxDe(tenant), t);
};
const statusDe = async (t, id) => (await env.fx.q(t, 'SELECT status, policy_json FROM integration.connections WHERE id = :id', { id }))[0];

test('conta_social_comprometida_revoga_token_e_ativa_kill_switch', async () => {
  assert.ok(marketing.security, 'o Marketing registra o tratador ao carregar');
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const { tenant } = ctx;
    const c = await conexao(t, tenant);
    assert.equal(store.isRevoked(tenant.companyId, 'INSTAGRAM'), false);
    const out = await ligar(t, tenant, {});
    // (1) token revogado no adapter do canal, (2) conexão COMPROMISED, (3) kill switch do canal ligado com a origem da conta comprometida
    assert.equal(out.compromised.handled, true);
    assert.equal(out.compromised.revoked, true);
    assert.equal(store.isRevoked(tenant.companyId, 'INSTAGRAM'), true, 'token revogado');
    assert.ok(out.compromised.connections.includes(c.id), 'a conexão da família do canal é marcada (outras conexões vivas da mesma família também)');
    const row = await statusDe(t, c.id);
    assert.equal(row.status, 'COMPROMISED');
    assert.ok(row.policy_json.compromised.at && /comprometida/.test(row.policy_json.compromised.reason));
    assert.equal(out.active, true);
    assert.equal(out.source, 'COMPROMISED_ACCOUNT');
    const log = await ks.listKillSwitchLog(tenant, { scope: 'CHANNEL', targetId: 'INSTAGRAM' }, t);
    assert.equal(log.slice(-1)[0].source, 'COMPROMISED_ACCOUNT');
    // o canal fica bloqueado de imediato, com o 423 próprio do comprometimento, e o adapter nem é resolvido
    await assert.rejects(() => sendToChannel('INSTAGRAM', { text: 'oi' }, { tenant, transaction: t, idempotencyKey: 'qa-m9-comp-1' }),
      (e) => e.statusCode === 423 && e.code === 'MKT_CHANNEL_COMPROMISED' && /comprometimento/.test(e.message));
    await assert.rejects(() => sendToChannel('FACEBOOK', { text: 'oi' }, { tenant, transaction: t, idempotencyKey: 'qa-m9-comp-2' }).then(() => { throw new Error('não deveria bloquear outra rede'); }), (e) => e.code !== 'MKT_CHANNEL_COMPROMISED');
  });
});

test('marcar_duas_vezes_devolve_o_mesmo_estado_e_a_conexao_comprometida_nao_volta_a_active_sem_nova_credencial', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const { tenant } = ctx;
    const c = await conexao(t, tenant);
    await ligar(t, tenant, {});
    const again = await ligar(t, tenant, {});
    assert.equal(again.active, true);
    assert.equal(again.compromised.handled, true);
    assert.deepEqual(again.compromised.connections, [], 'a conexão já comprometida não é tocada de novo');
    assert.equal((await statusDe(t, c.id)).status, 'COMPROMISED');
    // reativar a conexão exige nova credencial no cofre: sem rotação posterior à marca, 409
    await assert.rejects(() => transitionConnection(c.id, 'ACTIVE', ctxDe(tenant), t), (e) => e.statusCode === 409 && e.code === 'INTEGRATION_CONNECTION_REAUTH_REQUIRED');
    await env.fx.q(t, "UPDATE integration.connections SET last_secret_rotation_at = now() + interval '1 minute' WHERE id = :id", { id: c.id });
    assert.equal((await transitionConnection(c.id, 'ACTIVE', ctxDe(tenant), t)).status, 'ACTIVE', 'com a rotação posterior à marca, volta');
    // a transição manual comum nunca leva a COMPROMISED (só o tratamento do sistema)
    await assert.rejects(() => transitionConnection(c.id, 'COMPROMISED', ctxDe(tenant), t), (e) => e.code === 'INTEGRATION_CONNECTION_INVALID_TRANSITION');
  });
});

test('falha_do_adapter_ao_revogar_mantem_o_bloqueio_e_a_marca_da_conexao', async () => {
  const original = SandboxChannelAdapter.prototype.revoke;
  SandboxChannelAdapter.prototype.revoke = async function falha() { throw new Error('provedor fora do ar'); };
  try {
    await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
      const { tenant } = ctx;
      const c = await conexao(t, tenant);
      const out = await ligar(t, tenant, {});
      assert.equal(out.active, true, 'o bloqueio do canal permanece');
      assert.equal(out.compromised.handled, false);
      assert.equal(out.compromised.revoked, false);
      assert.ok(out.compromised.error);
      assert.equal((await statusDe(t, c.id)).status, 'COMPROMISED', 'a conexão fica marcada mesmo sem conseguir revogar');
      await assert.rejects(() => sendToChannel('INSTAGRAM', { text: 'oi' }, { tenant, transaction: t, idempotencyKey: 'qa-m9-comp-3' }), (e) => e.code === 'MKT_CHANNEL_COMPROMISED');
    });
  } finally { SandboxChannelAdapter.prototype.revoke = original; }
});

test('revogacao_informada_pelo_provedor_no_worker_aciona_a_mesma_sequencia', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const { tenant } = ctx;
    const c = await conexao(t, tenant);
    const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { INSTAGRAM: 'AUTH_REVOKED' } });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.last_error_code, 'MKT_PROVIDER_AUTH_FAILED');
    assert.equal((await statusDe(t, c.id)).status, 'COMPROMISED', 'AUTH_REVOKED marca a conexão');
    const log = await ks.listKillSwitchLog(tenant, { scope: 'CHANNEL', targetId: 'INSTAGRAM' }, t);
    assert.equal(log.slice(-1)[0].source, 'COMPROMISED_ACCOUNT');
    assert.equal(log.slice(-1)[0].compromised, true);
    assert.equal(store.isRevoked(tenant.companyId, 'INSTAGRAM'), true);
  });
});

test('credencial_recusada_sem_ser_revogada_nao_marca_conta_comprometida', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const { tenant } = ctx;
    const marketingSecurity = marketing.security;
    assert.equal(marketingSecurity.isAuthRevoked({ class: 'AUTH', code: 'HTTP_401' }), false);
    assert.equal(marketingSecurity.isAuthRevoked({ class: 'AUTH', code: 'MKT_PROVIDER_AUTH_FAILED', providerCode: 'AUTH_REVOKED' }), true);
    const log = await ks.listKillSwitchLog(tenant, { scope: 'CHANNEL', targetId: 'LINKEDIN' }, t);
    assert.equal(log.length, 0);
  });
});

test('conta_comprometida_so_vale_em_canal_e_nao_toca_a_outra_empresa', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const { tenant } = ctx;
    await assert.rejects(() => ks.parseChange({ scope: 'GLOBAL', active: true, reason: 'QA-M9 comprometida', compromised: true }, tenant, t), (e) => e.statusCode === 422 && e.code === 'MKT_KILL_SWITCH_COMPROMISED_SCOPE');
    const cb = await env.fx.q(t, "SELECT count(*)::int AS n FROM integration.connections WHERE status = 'COMPROMISED'", {});
    await conexao(t, tenant);
    await ligar(t, tenant, {});
    const depois = await env.fx.q(t, "SELECT count(*)::int AS n FROM integration.connections WHERE status = 'COMPROMISED'", {});
    assert.ok(depois[0].n >= cb[0].n + 1, 'a conexão da empresa do ator é marcada');
    const outras = await env.fx.q(t, "SELECT count(*)::int AS n FROM integration.connections WHERE status = 'COMPROMISED' AND company_id <> :c", { c: tenant.companyId });
    assert.equal(outras[0].n, 0, 'a RLS não deixa ver nem tocar conexão de outra empresa');
    assert.equal(store.isRevoked(tenantB.companyId, 'INSTAGRAM'), false, 'o token da outra empresa segue válido');
  });
});
