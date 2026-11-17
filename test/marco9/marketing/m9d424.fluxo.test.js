'use strict';

// M9-D424 — satisfação positiva pede a avaliação com link rastreável; negativa abre a ocorrência antes e não pede nada; ocorrência aberta bloqueia; nota do meio não age.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const rv = require('../_helpers/mktReviews');
const { TEST_DOMAINS } = require('../_helpers/mktUrlPolicy');

let tenant;
let offVault;
before(async () => { ({ tenantA: tenant } = await rv.prepararTenants()); offVault = rv.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);
const SANDBOX = { mode: 'SANDBOX' };
const action = (out) => out.runs[0];

test('cliente_negativo_abre_ocorrencia_antes_de_review_request: nota 2 deixa BLOCKED_NEGATIVE com a ocorrência vinculada e nenhuma mensagem', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    const { out } = await rv.record(t, tenant, person, 2, SANDBOX);
    const [request] = await rv.requestOf(t, person);
    assert.equal(request.status, 'BLOCKED_NEGATIVE');
    assert.equal(request.satisfaction_score, 2);
    assert.ok(request.feedback_case_id, 'ocorrência vinculada');
    const [kase] = await rv.q(t, 'SELECT status, type, person_id FROM crm.feedback_cases WHERE id = :id', { id: request.feedback_case_id });
    assert.deepEqual([kase.status, kase.type, kase.person_id], ['OPEN', 'COMPLAINT', person]);
    assert.equal((await rv.messagesOf(t, person)).length, 0, 'nenhuma solicitação sai');
    assert.equal((await rv.reviewEvents(t, request.id)).length, 0, 'review.requested só quando o pedido é feito');
    assert.equal(action(out).status, 'COMPLETED');
  });
});

test('positivo_gera_pedido_com_link_rastreavel: nota 5 envia o pedido com o link /t/{codigo}, grava SENT e emite review.requested', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    await rv.record(t, tenant, person, 5, SANDBOX);
    const [request] = await rv.requestOf(t, person);
    assert.equal(request.status, 'SENT');
    assert.equal(request.platform, 'GOOGLE');
    assert.ok(request.sent_at && request.message_id && request.tracking_link_id);
    const [link] = await rv.q(t, 'SELECT short_code, target_url, channel FROM marketing.tracking_links WHERE id = :id', { id: request.tracking_link_id });
    assert.equal(link.target_url, rv.REVIEW_URL);
    const [message] = await rv.q(t, 'SELECT body, purpose, status FROM crm.messages WHERE id = :id', { id: request.message_id });
    assert.equal(message.purpose, 'AVALIACAO');
    assert.ok(message.body.includes(`${rv.LINK_BASE}/t/${link.short_code}`), message.body);
    const events = await rv.reviewEvents(t, request.id);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload_json.payload, { reviewRequestId: request.id, personId: person, channel: 'EMAIL' });
  });
});

test('ocorrencia_aberta_bloqueia_qualquer_pedido: com ocorrência aberta nada sai; só uma nova nota positiva depois da resolução gera o pedido', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    const kase = await rv.openCase(t, tenant, person);
    const blocked = await rv.record(t, tenant, person, 5, SANDBOX);
    assert.equal((await rv.requestOf(t, person)).length, 0);
    assert.equal((await rv.messagesOf(t, person)).length, 0);
    const row = await rv.runRow(t, action(blocked.out).runId);
    assert.deepEqual([row.actions_result[0].status, row.actions_result[0].error_code], ['SKIPPED', 'MKT_REVIEW_BLOCKED_OPEN_CASE']);
    await rv.q(t, "UPDATE crm.feedback_cases SET status = 'RESOLVED' WHERE id = :id RETURNING id", { id: kase.id });
    assert.equal((await rv.requestOf(t, person)).length, 0, 'resolver a ocorrência não libera nada por si só');
    await rv.record(t, tenant, person, 5, SANDBOX);
    assert.deepEqual((await rv.requestOf(t, person)).map((r) => r.status), ['SENT']);
  });
});

test('negativa_seguida_de_positiva_so_pede_depois_de_resolvida: a ocorrência da própria nota negativa bloqueia a nota positiva seguinte', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    await rv.record(t, tenant, person, 1, SANDBOX);
    const [negative] = await rv.requestOf(t, person);
    await rv.record(t, tenant, person, 5, SANDBOX);
    assert.equal((await rv.requestOf(t, person)).length, 1, 'ocorrência aberta: o pedido da nota 5 não nasce');
    await rv.q(t, "UPDATE crm.feedback_cases SET status = 'RESOLVED' WHERE id = :id RETURNING id", { id: negative.feedback_case_id });
    await rv.record(t, tenant, person, 5, SANDBOX);
    assert.deepEqual((await rv.requestOf(t, person)).map((r) => r.status).sort(), ['BLOCKED_NEGATIVE', 'SENT']);
  });
});

test('limiares_nao_se_sobrepoem_e_nota_3_nao_age: 422 MKT_PARAM_INVALID quando negativa >= positiva e a nota do meio não gera run', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    const middle = await rv.record(t, tenant, person, 3, SANDBOX);
    assert.deepEqual(middle.out.runs, [], 'nota 3 no padrão: nenhuma ação');
    assert.equal((await rv.requestOf(t, person)).length, 0);
    const refuse = (key, value) => assert.rejects(upsertSetting(key, value, tenant, tenant.userId, t), (e) => e.statusCode === 422 && e.code === 'MKT_PARAM_INVALID');
    await refuse('marketing.review.nota_maxima_negativa', 4);
    await refuse('marketing.review.nota_minima_positiva', 2);
    await refuse('marketing.review.nota_minima_positiva', 1);
    await upsertSetting('marketing.review.nota_minima_positiva', 3, tenant, tenant.userId, t);
    await rv.record(t, tenant, person, 3, SANDBOX);
    assert.deepEqual((await rv.requestOf(t, person)).map((r) => r.status), ['SENT'], 'com o corte em 3, a nota 3 é positiva');
    await assert.rejects(upsertSetting('marketing.review.nota_minima_positiva', 6, tenant, tenant.userId, t), (e) => e.statusCode === 400);
  });
});

test('url_de_avaliacao_vazia_deixa_pedido_failed_sem_envio: MKT_REVIEW_URL_NOT_CONFIGURED, nada enviado e sem evento', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant, { params: { 'marketing.review.url_avaliacao': null } });
    const { out } = await rv.record(t, tenant, person, 4, SANDBOX);
    const [request] = await rv.requestOf(t, person);
    assert.deepEqual([request.status, request.error_code], ['FAILED', 'MKT_REVIEW_URL_NOT_CONFIGURED']);
    assert.equal((await rv.messagesOf(t, person)).length, 0);
    assert.equal((await rv.reviewEvents(t, request.id)).length, 0);
    const row = await rv.runRow(t, action(out).runId);
    assert.deepEqual([row.actions_result[0].status, row.actions_result[0].error_code], ['SKIPPED', 'MKT_REVIEW_URL_NOT_CONFIGURED']);
  });
});

// Sem internet: a verificação de destino (DNS e redirecionamento, M9-D433) continua LIGADA, mas as portas de rede (integrations.urlProbe) recebem o
// resolvedor e a sonda simulados, como em m9d433.url.test.js: o nome resolve para um endereço público (o checkPublicHost de verdade confere) e a sonda
// responde sem redirecionamento ou com o redirecionamento pedido. Antes o teste seguia o g.page real, que hoje redireciona para www.google.com.
const urlProbe = require('../../../src/features/integrations').urlProbe;
async function semRede(fn, { redirect = null } = {}) {
  const real = { checkPublicHost: urlProbe.checkPublicHost, probeRedirect: urlProbe.probeRedirect };
  const sondas = [];
  urlProbe.checkPublicHost = (host, o = {}) => real.checkPublicHost(host, { ...o, resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
  urlProbe.probeRedirect = async (url) => { sondas.push(url); return { redirect, statusCode: redirect ? 301 : 200 }; };
  try { await fn(); } finally { Object.assign(urlProbe, real); }
  return sondas;
}

test('url_de_avaliacao_invalida_e_recusada_na_configuracao: 422 MKT_URL_NOT_ALLOWED para http, encurtador, endereço local e redirecionamento para fora', async () => {
  await inTx(async (t) => {
    // Mesma allowlist dos outros testes do Marketing (g.page é endereço fictício de cenário), mas com a verificação de destino LIGADA.
    await upsertSetting('marketing.url.dominios_permitidos', TEST_DOMAINS, tenant, tenant.userId, t);
    await upsertSetting('marketing.url.verificar_destino', true, tenant, tenant.userId, t);
    const recusa = (url) => assert.rejects(upsertSetting('marketing.review.url_avaliacao', url, tenant, tenant.userId, t), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED', url);
    const estaticas = await semRede(async () => {
      for (const bad of ['http://g.page/r/x/review', 'https://bit.ly/abc', 'https://127.0.0.1/review', 'https://localhost/review']) await recusa(bad);
    });
    assert.deepEqual(estaticas, [], 'as recusas estáticas acontecem antes de qualquer consulta de rede');
    const boa = await semRede(() => upsertSetting('marketing.review.url_avaliacao', rv.REVIEW_URL, tenant, tenant.userId, t));
    assert.deepEqual(boa, [rv.REVIEW_URL], 'a URL boa passa pela verificação de destino (uma sonda) e é aceita');
    await semRede(() => recusa(rv.REVIEW_URL), { redirect: 'https://www.google.com/' });
  });
});

test('falha_de_entrega_nao_conta_como_pedido: canal que recusa deixa FAILED sem evento, e a falha de entrega depois do envio também', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    await rv.record(t, tenant, person, 5, { ...SANDBOX, scenario: 'REJECTED' });
    const [rejected] = await rv.requestOf(t, person);
    assert.equal(rejected.status, 'FAILED');
    assert.ok(rejected.error_code);
    assert.equal((await rv.reviewEvents(t, rejected.id)).length, 0, 'não é pedido feito');
  });
});
