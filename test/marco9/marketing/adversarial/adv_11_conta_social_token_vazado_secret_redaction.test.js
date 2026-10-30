'use strict';

// M9-D437 adv_11 (Caderno §16: "Conta social token vazado -> secret redaction"). Token injetado na resposta de erro do provedor, no registro do adapter e no que a falha grava: response_redacted_json,
// o log do adapter e as respostas mostram [REDIGIDO] e nunca o token; e o comprometimento (AUTH_REVOKED do provedor) revoga o token, marca a conexão COMPROMISED e liga o kill switch do canal.
// Cenários das donas (M9-D428, M9-D433), sem lógica própria. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const env = require('../../_helpers/mktWorker');
const adv = require('../../_helpers/mktAdv');
const marketing = require('../../../../src/features/marketing');
const ks = require('../../../../src/features/marketing/killswitch.service');
const registry = require('../../../../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../../../../src/features/integrations/registry/connections.transition');
const { sendToChannel } = require('../../../../src/features/marketing/publications/adapters');
const results = require('../../../../src/features/marketing/publications/worker/worker.results');
const store = require('../../../../src/features/marketing/publications/adapters/sandbox/sandbox.store');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => { env.reset(); env.resetSandbox(); });

// Token fictício montado em tempo de execução (o scanner de segredos do repositório não pode vê-lo escrito inteiro).
const TOKEN = ['EAAB', 'sbCS1iHgBAPl', 'mnopQRSTuvwxYZ0123456789', 'tokenDaRede'].join('');
const BEARER = `Bearer ${['ya29', 'a0AfB_byCqF7mXk2LnPq8RtVwYz1234567890abcdef'].join('.')}`;
const ctxDe = (tn) => ({ companyId: tn.companyId, groupId: tn.groupId, userId: tn.userId });
const conexao = async (t, tenant) => {
  const c = await registry.createConnection({ providerCode: 'social-sandbox', environment: 'SANDBOX', label: `QA-M9 adv11 ${Date.now()}${Math.random()}` }, ctxDe(tenant), t);
  return transitionConnection(c.id, 'ACTIVE', ctxDe(tenant), t);
};

test('adv_11_conta_social_token_vazado_secret_redaction: token no erro do provedor, no log do adapter e no resultado gravado', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const { tenant } = ctx;
    // o sandbox do Instagram responde um erro 5xx cuja mensagem carrega o token (como um provedor que ecoa o cabeçalho)
    const restore = env.overrideSandbox('INSTAGRAM', (adapter) => {
      adapter.execute = async (operation, payload, options) => {
        adapter.log('request', { operation, payload, headers: { authorization: BEARER }, accessToken: TOKEN });
        return adapter.failure(operation, options.idempotencyKey, 'FAILED', 503, 'HTTP_5XX', `Falha com ${BEARER} e access_token=${TOKEN}`);
      };
      return adapter;
    });
    try {
      const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
      await env.cycle(t, ctx, { now: s.now });
      // (1) o efeito proibido não ocorreu: nenhum resultado, job ou log guarda o token
      const rows = await env.results(t, s.jobId);
      assert.ok(rows.length >= 1, 'a falha do provedor gerou resultado');
      const job = await env.job(t, s.jobId);
      for (const dump of [JSON.stringify(rows), JSON.stringify(job)]) {
        assert.ok(!dump.includes(TOKEN) && !dump.includes('ya29'), 'nenhum token no resultado nem no job');
      }
      // o que o banco recebe de um adapter que tenta gravar o token em response_redacted_json sai redigido
      await results.insertResult(job, { outcome: 'FAILURE', attemptNo: 9, response: { errorMessage: `falha ${BEARER}`, accessToken: TOKEN, nested: { authorization: BEARER, nota: `token=${TOKEN}` } } }, t);
      const saved = (await env.results(t, s.jobId)).find((r) => r.attempt_no === 9);
      const texto = JSON.stringify(saved.response_redacted_json);
      assert.ok(!texto.includes(TOKEN) && !texto.includes('ya29'), `o token não pode ficar no resultado: ${texto}`);
      assert.ok(texto.includes('[REDIGIDO]'), 'o marcador [REDIGIDO] aparece no resultado');
      // o log do adapter também sai redigido (com o sandbox de rede social de volta ao registro)
      restore();
      const adapter = adv.adapters.channelRegistry.get('INSTAGRAM', 'SANDBOX').create({ scope: tenant.companyId }); // o adapter de rede social, com o marcador único
      adapter.log('erro', { message: `Falha com ${BEARER}`, accessToken: TOKEN, headers: { authorization: BEARER } });
      const log = JSON.stringify(adapter.logEntries());
      assert.ok(!log.includes(TOKEN) && !log.includes('ya29'), 'nenhum token no log do adapter');
      assert.ok(log.includes('[REDIGIDO]'), 'o log mostra [REDIGIDO]');
      // (2) isolamento (RLS): a outra empresa não enxerga o resultado gravado
      await adv.assertIsolated(t, tenant, [{ tabela: 'marketing.publication_results', ids: [saved.id] }]);
    } finally { restore(); }
  });
});

test('adv_11_conta_social_token_vazado_secret_redaction: o comprometimento revoga o token, marca a conexão e liga o kill switch do canal', async () => {
  assert.ok(marketing.security, 'o Marketing registra o tratador ao carregar');
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const { tenant } = ctx;
    const c = await conexao(t, tenant);
    const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
    assert.equal(store.isRevoked(tenant.companyId, 'INSTAGRAM'), false);
    await env.cycle(t, ctx, { now: s.now, scenarios: { INSTAGRAM: 'AUTH_REVOKED' } }); // o provedor informa o token revogado
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.last_error_code, 'MKT_PROVIDER_AUTH_FAILED');
    assert.equal(store.isRevoked(tenant.companyId, 'INSTAGRAM'), true, 'token revogado no adapter');
    assert.equal((await env.fx.q(t, 'SELECT status FROM integration.connections WHERE id = :id', { id: c.id }))[0].status, 'COMPROMISED');
    const log = await ks.listKillSwitchLog(tenant, { scope: 'CHANNEL', targetId: 'INSTAGRAM' }, t);
    assert.equal(log.slice(-1)[0].source, 'COMPROMISED_ACCOUNT');
    assert.equal(log.slice(-1)[0].compromised, true);
    // o canal fica travado com o 423 próprio e a resposta não carrega segredo
    let recusa;
    await assert.rejects(() => sendToChannel('INSTAGRAM', { text: `oi ${TOKEN}` }, { tenant, transaction: t, idempotencyKey: 'qa-m9-adv11-1' }), (e) => { recusa = e; return e.statusCode === 423 && e.code === 'MKT_CHANNEL_COMPROMISED'; });
    assert.ok(!JSON.stringify({ message: recusa.message, details: recusa.details }).includes(TOKEN), 'a resposta de recusa não repete o token');
    // as outras redes e o resultado gravado seguem sem token
    assert.ok(!JSON.stringify(await env.results(t, s.jobId)).includes(TOKEN));
    await adv.assertIsolated(t, tenant, [{ tabela: 'marketing.publication_jobs', ids: [s.jobId] }]);
  });
});
