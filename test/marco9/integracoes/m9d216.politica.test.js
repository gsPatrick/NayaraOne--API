'use strict';

// Marco 9, M9-D216 — política: precedência global < fornecedor < connection, limites, classificação padrão, contador no retry humano.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparPendentes, enfileirar, pagamento, instalar, restaurar, ler, dispatch, config, limparConfig, rodarEVencer,
} = require('../_helpers/m9d214Env');
const { bancoProgramavel, erroHttp } = require('../_helpers/m9d214Scripted');
const registry = require('../../../src/features/integrations/registry/registry.service');
const providers = require('../../../src/features/integrations/registry/providers.service');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');

let tenant;
let banco;
let msg;
const ctx = () => ctxDe(tenant);
const agg = () => crypto.randomUUID();
const GLOBAL = { base_delay_ms: 5000, factor: 2, cap_delay_ms: 1800000, max_attempts: 8, jitter_pct: 25, rate_limit_max_wait_s: 3600, rate_limit_max_deferrals: 100 };

before(async () => {
  ({ tenant } = await carregarTenants());
  banco = await conexaoAtiva(tenant, 'BANK');
  msg = await conexaoAtiva(tenant, 'MESSAGING');
});
beforeEach(async () => { await limparPendentes(tenant); });
after(async () => { await limparConfig(tenant, ['integration.retry.max_attempts', 'integration.retry.base_delay_ms']); restaurar(); await sequelize.close(); });

test('retry_politica_precedencia_global_provider_connection', async () => {
  const m = dispatch.mergePolicies;
  assert.deepEqual(m({ global: GLOBAL, provider: null, connection: null }).retry, GLOBAL);
  const p = m({ global: GLOBAL, provider: { retry: { max_attempts: 6, factor: 3 } }, connection: null });
  assert.deepEqual([p.retry.max_attempts, p.retry.factor, p.origin.max_attempts, p.origin.base_delay_ms], [6, 3, 'provider', 'global']);
  const c = m({ global: GLOBAL, provider: { retry: { max_attempts: 6, factor: 3 } }, connection: { retry: { max_attempts: 3 }, rate_limit: { per_minute: 60 } } });
  assert.deepEqual([c.retry.max_attempts, c.retry.factor, c.origin.max_attempts, c.origin.factor, c.rate_limit.per_minute], [3, 3, 'connection', 'provider', 60]);
  assert.equal(m({ global: GLOBAL, provider: { retry: { max_attempts: 999 } }, connection: { retry: { factor: 'dois' } } }).retry.max_attempts, 8, 'valor fora do limite não vale');
  // Com banco: parâmetro da empresa (global), política do fornecedor e política da conexão definem o max_attempts do envio.
  await config(tenant, 'integration.retry.max_attempts', 6);
  const semPolitica = await enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: '+5541999990010', text: 'a' } });
  assert.equal((await ler(tenant, semPolitica.dispatchId)).max_attempts, 6, 'global: o parâmetro da empresa');
  const comPolitica = await comTenant(tenant, async (t) => {
    const nova = await registry.createConnection({ providerCode: 'email-sandbox', environment: 'SANDBOX', label: `QA-M9 pol ${Date.now()}`, policyJson: { retry: { max_attempts: 3, cap_delay_ms: 60000 }, rate_limit: { per_minute: 30 } } }, ctx(), t);
    await sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = 'email-sandbox' AND status = 'ACTIVE' AND id <> :id", { replacements: { c: tenant.companyId, id: nova.id }, transaction: t });
    await transitionConnection(nova.id, 'ACTIVE', ctx(), t);
    return nova;
  });
  const viaConexao = await enfileirar(tenant, { connectionId: comPolitica.id, operation: 'sendEmail', aggregateType: 'Message', aggregateId: agg(), payload: { to: 'a@b.com', subject: 'x', body: 'y' } });
  assert.equal((await ler(tenant, viaConexao.dispatchId)).max_attempts, 3, 'connection vence o global');
  const efetiva = await comTenant(tenant, (t) => dispatch.resolveEffectivePolicyById(ctx(), comPolitica.id, t));
  assert.equal(efetiva.retry.cap_delay_ms, 60000);
  assert.equal(efetiva.origin.max_attempts, 'connection');
  assert.equal(efetiva.origin.factor, 'global');
  await limparConfig(tenant, ['integration.retry.max_attempts']);
});

test('retry_politica_invalida_recusada', async () => {
  const recusa = (policy) => assert.throws(() => dispatch.validatePolicyJson(policy), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_POLICY_INVALID');
  recusa({ retry: { max_attempts: 0 } });
  recusa({ retry: { max_attempts: 21 } });
  recusa({ retry: { cap_delay_ms: 86400001 } });
  recusa({ retry: { base_delay_ms: 10, factor: 1 } });
  recusa({ retry: { jitter_pct: 51 } });
  recusa({ retry: { factor: 2.5 } });
  recusa({ retry: { base_delay_ms: 60000, cap_delay_ms: 1000 } });
  recusa({ retry: { inventado: 1 } });
  recusa({ rate_limit: { per_minute: 0 } });
  recusa({ retry: 'muito' });
  dispatch.validatePolicyJson({ retry: { max_attempts: 1 }, rate_limit: { per_day: 1000 }, egressHosts: ['api.exemplo.com.br'] });
  dispatch.validatePolicyJson({ retry: { max_attempts: 20, cap_delay_ms: 86400000, jitter_pct: 0 } });
  dispatch.validatePolicyJson(undefined);
  // Ao salvar: conexão (criação e edição) e fornecedor.
  await comTenant(tenant, async (t) => {
    await assert.rejects(registry.createConnection({ providerCode: 'email-sandbox', environment: 'SANDBOX', label: `QA-M9 inv ${Date.now()}`, policyJson: { retry: { max_attempts: 0 } } }, ctx(), t), (e) => e.code === 'INTEGRATION_POLICY_INVALID');
  });
  const ok = await comTenant(tenant, (t) => registry.createConnection({ providerCode: 'site-sandbox', environment: 'SANDBOX', label: `QA-M9 ok ${Date.now()}`, policyJson: { retry: { max_attempts: 4 } } }, ctx(), t));
  await assert.rejects(comTenant(tenant, (t) => registry.updateConnection(ok.id, { policyJson: { retry: { jitter_pct: 80 } } }, ctx(), t)), (e) => e.code === 'INTEGRATION_POLICY_INVALID');
  await assert.rejects(comTenant(tenant, async (t) => {
    await sequelize.query("SET LOCAL app.integration_platform_admin = 'on'", { transaction: t });
    return providers.updateProvider('site-sandbox', { defaultPolicyJson: { retry: { max_attempts: 99 } } }, ctx(), t);
  }), (e) => e.code === 'INTEGRATION_POLICY_INVALID');
  // Parâmetros da empresa: a API recusa fora da faixa.
  const settings = require('../../../src/features/settings/settings.service');
  for (const [k, v] of [['integration.retry.max_attempts', 21], ['integration.retry.max_attempts', 0], ['integration.retry.factor', 11], ['integration.retry.jitter_pct', 51], ['integration.retry.cap_delay_ms', 86400001]]) {
    await assert.rejects(comTenant(tenant, (t) => settings.upsertSetting(k, v, tenant, tenant.userId, t)), (e) => e.statusCode === 400, `${k}=${v}`);
  }
});

test('retry_contador_nao_zera_na_reativacao', async () => {
  const Banco = bancoProgramavel();
  instalar(Banco);
  const r = await enfileirar(tenant, { connectionId: banco.id, operation: 'getPaymentStatus', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: { externalResourceId: 'p-1' } });
  Banco.S.fila('getPaymentStatus', [{ erro: erroHttp(503) }]);
  for (let i = 0; i < 8; i += 1) await rodarEVencer(tenant, r.dispatchId);
  const morto = await ler(tenant, r.dispatchId);
  assert.deepEqual([morto.status, morto.attempts, morto.max_attempts], ['DEAD_LETTER', 8, 8]);
  const humano = { ...ctx(), permissions: new Set(['integration:retry']) };
  await comTenant(tenant, (t) => dispatch.retryDispatchManually(humano, r.dispatchId, t));
  const reaberto = await ler(tenant, r.dispatchId);
  assert.equal(reaberto.status, 'RETRY_WAIT');
  assert.equal(reaberto.attempts, 8, 'tentativas acumuladas: o contador não zera');
  assert.equal(reaberto.max_attempts, 11, 'o retry humano auditado concede +3');
  Banco.S.fila('getPaymentStatus', [{ erro: erroHttp(503) }]);
  for (let i = 0; i < 3; i += 1) await rodarEVencer(tenant, r.dispatchId);
  const de_novo = await ler(tenant, r.dispatchId);
  assert.deepEqual([de_novo.status, de_novo.attempts], ['DEAD_LETTER', 11], 'só 3 tentativas a mais');
});

test('retry_5xx_e_504_em_dangerous_sem_idempotencia_vira_unknown_e_nao_repete', async () => {
  const Banco = bancoProgramavel();
  instalar(Banco);
  for (const status of [500, 502, 503, 504]) {
    Banco.S.reset();
    const r = await enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: pagamento({ amount: 10 + status }) });
    Banco.S.fila('submitPayment', [{ erro: erroHttp(status) }]);
    await dispatch.runDispatchCycle(ctx());
    await rodarEVencer(tenant, r.dispatchId);
    await dispatch.runDispatchCycle(ctx());
    const l = await ler(tenant, r.dispatchId);
    assert.equal(l.status, 'UNKNOWN', `HTTP ${status} em DANGEROUS sem idempotência`);
    assert.equal(Banco.S.chamadas.length, 1, `HTTP ${status}: nenhuma repetição`);
  }
  // O adapter declara que o fornecedor NÃO processou (notProcessed): vira TRANSIENT.
  const Nao = bancoProgramavel();
  Nao.prototype.classifyError = (e) => ({ class: 'TRANSIENT', code: 'HTTP_503', notProcessed: e.status === 503 });
  instalar(Nao);
  const r = await enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: pagamento({ amount: 77 }) });
  Nao.S.fila('submitPayment', [{ erro: erroHttp(503) }]);
  await dispatch.runDispatchCycle(ctx());
  assert.equal((await ler(tenant, r.dispatchId)).status, 'RETRY_WAIT');
});

test('retry_5xx_em_dangerous_com_idempotencia_repete_com_mesma_chave', async () => {
  const Banco = bancoProgramavel({ idempotente: true });
  instalar(Banco);
  const r = await enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: pagamento({ amount: 321 }) });
  Banco.S.fila('submitPayment', [{ erro: erroHttp(503) }, { resposta: { status: 'ACCEPTED', externalResourceId: 'p-321' } }]);
  await rodarEVencer(tenant, r.dispatchId);
  assert.equal((await ler(tenant, r.dispatchId)).status, 'RETRY_WAIT');
  await dispatch.runDispatchCycle(ctx());
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'SUBMITTED');
  assert.equal(Banco.S.chamadas.length, 2);
  assert.equal(Banco.S.chamadas[0].meta.idempotencyKey, Banco.S.chamadas[1].meta.idempotencyKey, 'repetiu com a MESMA chave');
  assert.equal(Banco.S.chamadas[0].meta.idempotencyKey, l.idempotency_key);
});

test('retry_403_sem_credencial_e_408_425_classificados', async () => {
  const c = dispatch.classifyDispatchError;
  const e = (status, extra = {}) => Object.assign(new Error('x'), { status }, extra);
  const http = (s) => ({ class: 'TRANSIENT', code: `HTTP_${s}` });
  assert.equal(c(e(403), { class: 'AUTH', code: 'HTTP_403' }, { opClass: 'SAFE' }).class, 'VALIDATION', '403 de negócio é permanente');
  assert.equal(c(e(403, { message: 'Conta bloqueada por política do fornecedor' }), { class: 'AUTH', code: 'HTTP_403' }, {}).class, 'VALIDATION');
  assert.equal(c(e(403, { message: 'token expired' }), { class: 'AUTH', code: 'HTTP_403' }, {}).class, 'AUTH', '403 por credencial é AUTH');
  assert.equal(c(e(403, { credentialInvalid: true }), http(403), {}).class, 'AUTH');
  assert.equal(c(e(401), http(401), {}).class, 'AUTH');
  assert.equal(c(e(408), http(408), { opClass: 'SAFE' }).class, 'TRANSIENT');
  assert.equal(c(e(425), http(425), { opClass: 'SAFE' }).class, 'TRANSIENT');
  assert.equal(c(e(408), http(408), { opClass: 'DANGEROUS' }).class, 'UNKNOWN', 'em DANGEROUS segue a linha de timeout');
  for (const s of [400, 404, 409, 410, 422]) assert.equal(c(e(s), http(s), {}).class, 'VALIDATION', String(s));
  assert.equal(c(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), {}, { opClass: 'DANGEROUS' }).class, 'TRANSIENT', 'recusa de conexão: antes do envio, seguro repetir');
  assert.equal(c(Object.assign(new Error('x'), { code: 'ENOTFOUND' }), {}, { opClass: 'DANGEROUS' }).class, 'TRANSIENT');
  assert.equal(c(Object.assign(new Error('x'), { code: 'ECONNRESET', beforeSend: true }), {}, { opClass: 'DANGEROUS' }).class, 'TRANSIENT');
  assert.equal(c(Object.assign(new Error('x'), { code: 'ECONNRESET' }), {}, { opClass: 'DANGEROUS' }).class, 'UNKNOWN');
  assert.equal(c(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), {}, { opClass: 'SAFE' }).class, 'TRANSIENT');
  assert.equal(c(new Error('corpo ilegível'), {}, {}).class, 'UNKNOWN', 'resposta malformada');
  assert.equal(c(Object.assign(new Error('x'), { code: 'INTEGRATION_RESPONSE_INVALID' }), {}, {}).class, 'UNKNOWN');
  assert.equal(c(Object.assign(new Error('x'), { code: 'INTEGRATION_REQUEST_INVALID' }), {}, {}).class, 'VALIDATION');
  assert.equal(c(e(429, { headers: { 'retry-after': '5' } }), http(429), {}).retryAfterMs, 5000);
  // Código PRÓPRIO do fornecedor, mapeado pelo adapter, vale.
  assert.equal(c(e(200), { class: 'VALIDATION', code: 'CPF_INVALIDO' }, { opClass: 'DANGEROUS' }).class, 'VALIDATION');
  assert.equal(c(e(200), { class: 'RATE_LIMIT', code: 'COTA_DIARIA' }, {}).class, 'RATE_LIMIT');
  // Fluxo real: 403 sem relação com credencial não pausa a connection; 408 e 425 em SAFE repetem.
  const Banco = bancoProgramavel();
  instalar(Banco);
  const a = await enfileirar(tenant, { connectionId: banco.id, operation: 'getPaymentStatus', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: { externalResourceId: 'p-403' } });
  Banco.S.fila('getPaymentStatus', [{ erro: erroHttp(403, { message: 'Conta bloqueada' }) }]);
  await dispatch.runDispatchCycle(ctx());
  const la = await ler(tenant, a.dispatchId);
  assert.deepEqual([la.status, la.last_error_class], ['FAILED', 'VALIDATION']);
  const conexao = await comTenant(tenant, async (t) => (await sequelize.query('SELECT status FROM integration.connections WHERE id = :id', { replacements: { id: banco.id }, transaction: t }))[0][0]);
  assert.equal(conexao.status, 'ACTIVE', 'não pausa a connection');
  for (const s of [408, 425]) {
    Banco.S.reset();
    const x = await enfileirar(tenant, { connectionId: banco.id, operation: 'getPaymentStatus', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: { externalResourceId: `p-${s}` } });
    Banco.S.fila('getPaymentStatus', [{ erro: erroHttp(s) }]);
    await dispatch.runDispatchCycle(ctx());
    assert.equal((await ler(tenant, x.dispatchId)).status, 'RETRY_WAIT', `HTTP ${s} em SAFE`);
  }
});
