'use strict';

// Marco 9, M9-D216 — AUTH: renova a credencial uma vez e repete uma vez; sem renovação (ou na segunda recusa) pausa a connection.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  sequelize, comTenant, carregarTenants, ctxDe, limparPendentes, enfileirar, tentativas, eventos, erros, instalar, restaurar, ler, dispatch, uniqueSuffix, forcar,
} = require('../_helpers/m9d214Env');
const { mensagemProgramavel, erroHttp } = require('../_helpers/m9d214Scripted');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const registry = require('../../../src/features/integrations/registry/registry.service');
const secrets = require('../../../src/features/integrations/secrets');
const { clearCircuitCache } = require('../../../src/features/integrations/health');

let tenant;
let store;
let Msg;
const ctx = () => ctxDe(tenant);
const agg = () => crypto.randomUUID();

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => {
  store = secrets.createHttpVaultStore({ mode: 'sandbox' });
  secrets.setSecretStoreForTests(store);
  secrets.clearSecretCache();
  clearCircuitCache();
  await limparPendentes(tenant);
});
after(async () => { secrets.setSecretStoreForTests(null); restaurar(); await sequelize.close(); });

/** Conexão de mensageria ATIVA com credencial no cofre. */
async function conexaoComSegredo() {
  const ref = `company/${tenant.companyId}/qa-m9-d216-${uniqueSuffix()}/api-key`;
  await store.put(ref, 'token-inicial-QA');
  const c = await comTenant(tenant, async (t) => {
    await sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = 'messaging-sandbox' AND status = 'ACTIVE'", { replacements: { c: tenant.companyId }, transaction: t });
    const nova = await registry.createConnection({ providerCode: 'messaging-sandbox', environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}`, secretRef: ref }, ctx(), t);
    await transitionConnection(nova.id, 'ACTIVE', ctx(), t);
    return nova;
  });
  return { c, ref };
}
const texto = (c, n = 0) => enfileirar(tenant, { connectionId: c.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: `+554199999${String(n).padStart(4, '0')}`, text: 'Olá' } });
const statusDe = (id) => comTenant(tenant, async (t) => (await sequelize.query('SELECT status, auth_renewals FROM integration.connections c, (SELECT 0 AS auth_renewals) x WHERE c.id = :id', { replacements: { id }, transaction: t }))[0][0].status);

test('retry_auth_renova_uma_vez', async () => {
  Msg = mensagemProgramavel({ idempotente: true, renovavel: true });
  instalar(Msg);
  const { c, ref } = await conexaoComSegredo();
  const versaoAntes = (await store.describe(ref)).version;
  const r = await texto(c);
  Msg.S.fila('sendText', [{ erro: erroHttp(401) }, { resposta: { status: 'SENT', externalResourceId: 'm-1' } }]);
  await dispatch.runDispatchCycle(ctx());
  const meio = await ler(tenant, r.dispatchId);
  assert.equal(meio.status, 'RETRY_WAIT', '401 com renovação possível: repete');
  assert.equal(meio.attempts, 0, 'a recusa de credencial não consome tentativa');
  assert.equal(meio.auth_renewals, 1);
  assert.equal(Msg.S.renovacoes, 1, 'uma renovação');
  assert.ok((await store.describe(ref)).version > versaoAntes, 'a nova credencial virou nova versão no cofre');
  assert.equal((await store.get(ref)).value.reveal(), 'token-renovado-1');
  await dispatch.runDispatchCycle(ctx());
  const fim = await ler(tenant, r.dispatchId);
  assert.equal(fim.status, 'SUBMITTED', 'uma repetição e o fornecedor aceitou');
  assert.equal(fim.attempts, 1);
  assert.equal(Msg.S.chamadas.length, 2);
  assert.equal(await statusDe(c.id), 'ACTIVE');
  assert.equal((await tentativas(tenant, r.dispatchId)).map((t) => `${t.outcome}:${t.error_class}`).join(','), 'ERROR:AUTH,SUCCESS:null');
  // Segunda recusa do mesmo envio depois de renovar: não renova de novo, pausa.
  const r2 = await texto(c, 1);
  Msg.S.fila('sendText', [{ erro: erroHttp(401) }, { erro: erroHttp(401) }]);
  await dispatch.runDispatchCycle(ctx());
  await forcar(tenant, r2.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await dispatch.runDispatchCycle(ctx());
  assert.equal(Msg.S.renovacoes, 2, 'uma renovação para cada envio, nunca duas para o mesmo');
  assert.equal((await ler(tenant, r2.dispatchId)).status, 'FAILED');
  assert.equal(await statusDe(c.id), 'AUTH_FAILED');
});

test('retry_auth_sem_renovacao_pausa_connection', async () => {
  Msg = mensagemProgramavel({ idempotente: true });
  instalar(Msg);
  const { c } = await conexaoComSegredo();
  const r = await texto(c);
  const esperando = await texto(c, 2);
  Msg.S.fila('sendText', [{ erro: erroHttp(401) }, { resposta: { status: 'SENT', externalResourceId: 'nunca' } }]);
  await dispatch.runDispatchCycle(ctx(), { limit: 1 });
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'FAILED', 'o envio fica FAILED, sem loop');
  assert.equal(l.attempts, 0, '0 tentativas extras');
  assert.equal(l.last_error_class, 'AUTH');
  assert.equal(await statusDe(c.id), 'AUTH_FAILED', 'connection pausada');
  const inc = await erros(tenant, c.id, 'HTTP_401');
  assert.equal(inc[inc.length - 1].severity, 'HIGH', 'incidente HIGH');
  assert.equal(inc[inc.length - 1].message, 'O fornecedor recusou a credencial; a integração foi pausada.');
  assert.equal((await eventos(tenant, dispatch.EVENTS.FAILED, r.dispatchId)).length, 1);
  // Nenhum loop: outras rodadas não chamam o fornecedor; o outro envio espera a connection voltar sem gastar tentativa.
  await dispatch.runDispatchCycle(ctx());
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await dispatch.runDispatchCycle(ctx());
  assert.equal(Msg.S.chamadas.length, 1, 'uma única chamada ao fornecedor');
  const w = await ler(tenant, esperando.dispatchId);
  assert.equal(w.status, 'RETRY_WAIT');
  assert.equal(w.attempts, 0);
  // test-connection verde reativa a connection: o envio recusado volta sem gastar tentativa e o que esperava segue.
  await comTenant(tenant, (t) => transitionConnection(c.id, 'ACTIVE', ctx(), t, { testConnectionOk: true }));
  const volta = await ler(tenant, r.dispatchId);
  assert.equal(volta.status, 'RETRY_WAIT');
  assert.equal(volta.attempts, 0, 'o contador não foi gasto nem zerado');
  await forcar(tenant, esperando.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await dispatch.runDispatchCycle(ctx());
  assert.equal((await ler(tenant, r.dispatchId)).status, 'SUBMITTED');
  assert.equal((await ler(tenant, esperando.dispatchId)).status, 'SUBMITTED');
});

test('retry_renovacao_que_falha_pausa_a_connection', async () => {
  Msg = mensagemProgramavel({ idempotente: true, renovavel: true });
  instalar(Msg);
  Msg.S.falharRenovacao = true;
  const { c } = await conexaoComSegredo();
  const r = await texto(c);
  Msg.S.fila('sendText', [{ erro: erroHttp(401) }]);
  await dispatch.runDispatchCycle(ctx());
  assert.equal(Msg.S.renovacoes, 1);
  assert.equal((await ler(tenant, r.dispatchId)).status, 'FAILED');
  assert.equal(await statusDe(c.id), 'AUTH_FAILED');
});
