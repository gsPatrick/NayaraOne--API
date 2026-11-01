'use strict';

// Marco 9, M9-D251 — testes adversariais do livro (seção 19), chamada de saída: timeout depois do envio, 429 com Retry-After e 401 sem laço. Relógio simulado: a rodada do worker recebe
// o instante (`now`) e o envio vencido é forçado no banco; nenhum teste dorme. Banco descartável (os testes COMMITAM), falhas programadas no adapter de teste.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparTudo, enfileirar, pagamento, tentativas, instalar, restaurar, forcar, ler, dispatch, uniqueSuffix,
  bancoReconciliavel, mensagemProgramavel, erroHttp,
} = require('../_helpers/m9d215Env');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const registry = require('../../../src/features/integrations/registry/registry.service');
const secrets = require('../../../src/features/integrations/secrets');
const { clearCircuitCache } = require('../../../src/features/integrations/health');

let tenant;
let banco;
let Banco;
let Msg;
let store;
const ctx = () => ctxDe(tenant);
const agg = () => crypto.randomUUID();
const depois = (s) => new Date(Date.now() + s * 1000);

before(async () => {
  ({ tenant } = await carregarTenants());
  banco = await conexaoAtiva(tenant, 'BANK');
});
beforeEach(async () => {
  store = secrets.createHttpVaultStore({ mode: 'sandbox' });
  secrets.setSecretStoreForTests(store);
  secrets.clearSecretCache();
  Banco = bancoReconciliavel();
  instalar(Banco);
  Msg = mensagemProgramavel({ idempotente: true, renovavel: true });
  instalar(Msg);
  dispatch.registerUnknownReconciler(null);
  clearCircuitCache();
  await limparTudo(tenant);
});
after(async () => {
  secrets.setSecretStoreForTests(null); dispatch.registerUnknownReconciler(null); restaurar();
  // o teste de 401 deixa a connection de mensageria em AUTH_FAILED; fora de cena (DISABLED), para o framework voltar a criar a de laboratório nos arquivos seguintes
  await comTenant(tenant, (t) => sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code LIKE 'messaging-%' AND status IN ('ACTIVE', 'PAUSED', 'AUTH_FAILED')", { replacements: { c: tenant.companyId }, transaction: t }));
  await sequelize.close();
});

const rodar = (now) => dispatch.runDispatchCycle(ctx(), { now: now || new Date() });

test('adv_timeout_outbound_vira_unknown_e_reconcilia', async () => {
  const r = await enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: pagamento({ amount: 1250 }) });
  Banco.S.fila('submitPayment', [{ recebeEDaTimeout: true }]);
  await rodar();
  const incerto = await ler(tenant, r.dispatchId);
  assert.equal(incerto.status, 'UNKNOWN', 'o banco recebeu a ordem e a resposta se perdeu: UNKNOWN');
  const envios = () => Banco.S.chamadas.filter((c) => c.op === 'submitPayment');
  assert.equal(envios().length, 1);
  // Nem a rodada seguinte nem a data vencida reenviam: só a consulta pela chave decide.
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  await rodar();
  assert.equal(envios().length, 1, 'nenhuma segunda ordem sem consulta');
  Banco.S.pagamentos.get(incerto.idempotency_key).status = 'PAID';
  const rec = await dispatch.reconcileDispatch(ctx(), r.dispatchId, { now: depois(31) });
  assert.deepEqual([rec.status, rec.verdict], ['CONFIRMED', 'FOUND'], 'a reconciliação acha o pagamento pela chave');
  assert.equal((await ler(tenant, r.dispatchId)).unknown_since, null);
  assert.equal(Banco.S.todos.length, 1, '0 duplicata: um único pagamento no banco');
  assert.equal(envios().length, 1);
  assert.equal(Banco.S.consultas[0].metodo, 'key');
});

test('adv_429_respeita_retry_after_sem_contar_falha', async () => {
  const msg = await conexaoAtiva(tenant, 'MESSAGING');
  const r = await enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: '+5541999990000', text: 'Olá' } });
  Msg.S.fila('sendText', [{ erro: erroHttp(429, { headers: { 'retry-after': '120' } }) }]);
  const relogio = new Date();
  await rodar(relogio);
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'RETRY_WAIT');
  assert.equal(new Date(l.next_attempt_at).getTime() - relogio.getTime(), 120000, 'a próxima tentativa é exatamente o Retry-After de 120 s no relógio simulado');
  assert.equal(l.attempts, 0, '429 não conta como falha');
  assert.equal(l.last_error_class, 'RATE_LIMIT');
  const t = await tentativas(tenant, r.dispatchId);
  assert.equal(t.length, 1);
  assert.equal(t[0].rate_limited, true);
  // Antes dos 120 s o worker não chama; passados, repete e o fornecedor aceita.
  await rodar(new Date(relogio.getTime() + 60000));
  assert.equal(Msg.S.chamadas.length, 1, 'aos 60 s ainda espera');
  Msg.S.fila('sendText', [{ resposta: { status: 'SENT', externalResourceId: `m-${uniqueSuffix()}` } }]);
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'"); // o relógio da empresa chegou aos 120 s
  await rodar(new Date(relogio.getTime() + 121000));
  assert.equal(Msg.S.chamadas.length, 2);
  assert.equal((await ler(tenant, r.dispatchId)).status, 'SUBMITTED');
});

test('adv_401_nao_entra_em_loop_e_pausa_connection', async () => {
  const ref = `company/${tenant.companyId}/qa-m9-d251-${uniqueSuffix()}/api-key`;
  await store.put(ref, 'token-inicial-QA');
  const c = await comTenant(tenant, async (t) => {
    await sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = 'messaging-sandbox' AND status = 'ACTIVE'", { replacements: { c: tenant.companyId }, transaction: t });
    const nova = await registry.createConnection({ providerCode: 'messaging-sandbox', environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}`, secretRef: ref }, ctx(), t);
    await transitionConnection(nova.id, 'ACTIVE', ctx(), t);
    return nova;
  });
  const r = await enfileirar(tenant, { connectionId: c.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: '+5541999990001', text: 'Olá' } });
  Msg.S.fila('sendText', [{ erro: erroHttp(401) }, { erro: erroHttp(401) }]);
  await rodar();
  assert.equal((await ler(tenant, r.dispatchId)).status, 'RETRY_WAIT', 'primeira recusa: renova e repete');
  await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'");
  await rodar();
  assert.equal(Msg.S.renovacoes, 1, 'uma renovação, nunca duas para o mesmo envio');
  assert.equal((await ler(tenant, r.dispatchId)).status, 'FAILED');
  const [conexao] = await comTenant(tenant, async (t) => (await sequelize.query('SELECT status FROM integration.connections WHERE id = :id', { replacements: { id: c.id }, transaction: t }))[0]);
  assert.equal(conexao.status, 'AUTH_FAILED', 'a connection fica pausada com credencial recusada');
  // Zero laços: rodadas e vencimentos seguintes não chamam o fornecedor de novo.
  const chamadas = Msg.S.chamadas.length;
  assert.equal(chamadas, 2);
  for (let i = 0; i < 3; i += 1) {
    await forcar(tenant, r.dispatchId, "next_attempt_at = now() - interval '1 second'");
    await rodar(depois(60 * (i + 1)));
  }
  assert.equal(Msg.S.chamadas.length, chamadas, 'nenhuma chamada nova depois da pausa');
  assert.equal(Msg.S.renovacoes, 1);
});
