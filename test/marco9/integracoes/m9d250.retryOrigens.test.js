'use strict';

// Marco 9, M9-D250 — POST /admin/integrations/errors/:id/retry para erro de WEBHOOK e de SINCRONIZAÇÃO, e as recusas por classe e origem. Testes 3, 4, 12 e 13 da demanda.
// Roda em banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D250_ORIGENS_PORT || '21752';

const { test, before, after } = require('node:test');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d250Env');
const inbox = require('../../../src/features/integrations/inbox');
const { runSyncCycle, registerSyncRunner, unregisterSyncRunner, SYNC_ORIGINS } = require('../../../src/features/integrations/sync');
const { IntegrationWebhookInbox, IntegrationSyncCursor } = require('../../../src/models');

const { carregarTenants, conexaoAtiva, comTenant, sequelize, ctxDe } = env;
let tenant;
let chamar;
let token;

before(async () => {
  ({ tenant } = await carregarTenants());
  token = env.tokenDe(tenant, ['integration:read', 'integration:retry']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});
after(async () => { await env.sequelize.close(); process.exit(0); });

const tentar = (id, body = { reason: 'Tentar novamente.' }) => chamar(token, 'POST', `/admin/integrations/errors/${id}/retry`, body);
const codigo = (r) => (r.corpo.error ? r.corpo.error.code : null);
const ctx = () => ctxDe(tenant);
const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Evento recebido e levado à fila morta pelo worker de verdade (6 falhas seguidas), devolve { linha, erro }. */
async function eventoNaFilaMorta(prov) {
  const eventId = uniq('qa-m9-d250');
  const raw = Buffer.from(JSON.stringify({ e: eventId, valor: '10.00' }));
  await comTenant(tenant, (t) => inbox.receiveEvent(ctx(), { providerCode: prov, externalEventId: eventId, rawBody: raw, body: JSON.parse(raw.toString()), headers: {}, eventType: 'qa.evento' }, t));
  const max = (await comTenant(tenant, (t) => inbox.readInboxParams(ctx(), t))).maxAttempts;
  for (let i = 1; i <= max; i += 1) {
    await comTenant(tenant, async (t) => {
      const l = await IntegrationWebhookInbox.findOne({ where: { providerCode: prov, externalEventId: eventId }, transaction: t, lock: t.LOCK.UPDATE });
      if (l.status === 'FAILED') await l.update({ nextAttemptAt: new Date(Date.now() - 1000) }, { transaction: t });
      const pegos = await inbox.claimBatch(ctx(), 500, t);
      await inbox.markFailed(ctx(), pegos.find((p) => p.id === l.id), `falha ${i}`, t);
    });
  }
  const linha = await lerModelo(IntegrationWebhookInbox, { providerCode: prov, externalEventId: eventId });
  const [erro] = (await env.sql(tenant, "SELECT * FROM integration.integration_errors WHERE source_ref_id = :id AND source = 'WEBHOOK'", { id: linha.id }));
  return { linha, erro };
}
const lerModelo = (Modelo, where) => comTenant(tenant, (t) => Modelo.findOne({ where, transaction: t }));
const inboxLinha = (id) => env.sql(tenant, 'SELECT * FROM integration.webhook_inbox WHERE id = :id', { id }).then((r) => r[0]);

test('retry_validation_e_security_recusados', async () => {
  const c = await conexaoAtiva(tenant, 'BANK');
  const base = { providerCode: c.providerCode, connectionId: c.id, refId: undefined };
  const val = await env.erroDe(tenant, { ...base, source: 'DISPATCH', errorClass: 'VALIDATION', errorCode: uniq('QA_VAL') });
  const sec = await env.erroDe(tenant, { ...base, source: 'WEBHOOK', errorClass: 'SECURITY', errorCode: uniq('QA_SEC') });
  const hea = await env.erroDe(tenant, { ...base, source: 'HEALTH', errorClass: 'TRANSIENT', errorCode: uniq('QA_HEA') });
  const fechado = await env.erroDe(tenant, { ...base, source: 'DISPATCH', errorClass: 'TRANSIENT', errorCode: uniq('QA_FEC') });
  await env.sql(tenant, "UPDATE integration.integration_errors SET status = 'RESOLVED' WHERE id = :id", { id: fechado.id });
  for (const e of [val, sec, hea, fechado]) {
    const r = await tentar(e.id);
    assert.equal(r.status, 409, `${e.source}/${e.errorClass}`);
    assert.equal(codigo(r), 'INTEGRATION_RETRY_NOT_ALLOWED');
    assert.equal(r.corpo.error.message, 'Este erro não pode ser repetido.');
  }
  assert.equal((await env.trilha(tenant, val.id, 'integration.error.retry_requested')).length, 0);
});

test('retry_webhook_attempts_exhausted_reenfileira_dentro_da_janela', async () => {
  const prov = uniq('qa-hook').slice(0, 40);
  const { linha, erro } = await eventoNaFilaMorta(prov);
  assert.equal(linha.status, 'DEAD_LETTER');
  assert.equal(linha.deadLetterReason, 'ATTEMPTS_EXHAUSTED');
  assert.ok(erro, 'a fila morta gerou o erro que a pessoa repete');
  assert.equal(erro.error_code, 'ATTEMPTS_EXHAUSTED');
  const max = (await comTenant(tenant, (t) => inbox.readInboxParams(ctx(), t))).maxAttempts;

  const r = await tentar(erro.id, { reason: 'O fornecedor voltou.' });
  assert.equal(r.status, 202);
  assert.deepEqual(r.corpo.data, { errorId: erro.id, status: 'RETRYING', dispatchId: null });
  const depois = await inboxLinha(linha.id);
  assert.equal(depois.status, 'RECEIVED', 'o mesmo evento volta para o worker');
  assert.equal(depois.attempts, max - 3, 'tem exatamente 3 tentativas a mais');
  assert.equal(depois.dead_letter_reason, null);
  assert.equal(depois.payload_hash, linha.payloadHash, 'mesmo conteúdo');
  const [tr] = await env.trilha(tenant, erro.id, 'integration.error.retry_requested');
  assert.equal(tr.after_json.target.inboxId, linha.id);

  // O worker processa o evento reenfileirado e o erro se resolve sozinho.
  await comTenant(tenant, async (t) => {
    const pegos = await inbox.claimBatch(ctx(), 500, t);
    await inbox.markProcessed(ctx(), pegos.find((p) => p.id === linha.id), t);
  });
  const fim = await env.erroLinha(tenant, erro.id);
  assert.equal(fim.status, 'RESOLVED');
  assert.equal(fim.resolved_by, null);
});

test('retry_webhook_fora_da_janela_410', async () => {
  const prov = uniq('qa-hook').slice(0, 40);
  const { linha, erro } = await eventoNaFilaMorta(prov);
  await env.admin().query("UPDATE integration.webhook_inbox SET received_at = now() - interval '30 days' WHERE id = :id", { replacements: { id: linha.id } });
  const velho = await tentar(erro.id);
  assert.equal(velho.status, 410, 'conteúdo ainda existe mas passou da janela de reenvio');
  assert.equal(codigo(velho), 'INTEGRATION_RETRY_PAYLOAD_GONE');
  assert.equal(velho.corpo.error.message, 'O conteúdo original não está mais disponível; peça o reenvio ao fornecedor.');
  assert.equal((await inboxLinha(linha.id)).status, 'DEAD_LETTER', 'nada foi reenfileirado');
  assert.equal((await env.erroLinha(tenant, erro.id)).status, 'OPEN');
});

test('retry_webhook_sem_payload_410', async () => {
  const prov = uniq('qa-hook').slice(0, 40);
  const { linha, erro } = await eventoNaFilaMorta(prov);
  await env.admin().query('UPDATE integration.webhook_inbox SET payload_raw = NULL, payload = NULL WHERE id = :id', { replacements: { id: linha.id } });
  const r = await tentar(erro.id);
  assert.equal(r.status, 410, 'conteúdo já apagado pela retenção');
  assert.equal(codigo(r), 'INTEGRATION_RETRY_PAYLOAD_GONE');
  assert.equal((await inboxLinha(linha.id)).status, 'DEAD_LETTER');
  const sumiu = await env.erroDe(tenant, { providerCode: prov, source: 'WEBHOOK', refId: crypto.randomUUID(), errorClass: 'TRANSIENT', errorCode: uniq('QA_SUMIU') });
  assert.equal((await tentar(sumiu.id)).status, 410, 'evento que nem existe mais na caixa de entrada');
});

test('retry_webhook_dado_invalido_sempre_410', async () => {
  const prov = uniq('qa-hook').slice(0, 40);
  const eventId = uniq('qa-m9-d250-inv');
  const raw = Buffer.from(JSON.stringify({ e: eventId }));
  await comTenant(tenant, (t) => inbox.receiveEvent(ctx(), { providerCode: prov, externalEventId: eventId, rawBody: raw, body: JSON.parse(raw.toString()), headers: {}, eventType: 'qa.evento' }, t));
  await comTenant(tenant, async (t) => {
    const l = await IntegrationWebhookInbox.findOne({ where: { providerCode: prov, externalEventId: eventId }, transaction: t, lock: t.LOCK.UPDATE });
    await inbox.rejectInvalid(ctx(), l, 'campo "valor" ausente', t);
  });
  const linha = await lerModelo(IntegrationWebhookInbox, { providerCode: prov, externalEventId: eventId });
  assert.match(linha.deadLetterReason, /^SCHEMA_INVALID/);
  assert.equal(linha.payloadRaw, null, 'dado inválido nunca guarda o conteúdo');
  const [erro] = await env.sql(tenant, "SELECT * FROM integration.integration_errors WHERE source_ref_id = :id", { id: linha.id });
  const r = await tentar(erro.id);
  assert.equal(r.status, 410);
  assert.equal(codigo(r), 'INTEGRATION_RETRY_PAYLOAD_GONE');
  // Mesmo se o erro estiver classificado como VALIDATION, o evento de webhook responde 410 (não há conteúdo), nunca reenfileira.
  const val = await env.erroDe(tenant, { providerCode: prov, source: 'WEBHOOK', refId: linha.id, errorClass: 'VALIDATION', errorCode: uniq('QA_WVAL') });
  assert.equal((await tentar(val.id)).status, 410);
  assert.equal((await inboxLinha(linha.id)).status, 'DEAD_LETTER');
});

test('retry_sync_zera_falhas_roda_ciclo_e_resolve', async () => {
  const c = await conexaoAtiva(tenant, 'BANK');
  const stream = uniq('qa.d250').slice(0, 40).replace(/[^a-z0-9._-]/g, '');
  const ruim = { fetchPage: async () => { throw new Error('fornecedor fora'); }, applyItems: async () => 0 };
  for (let i = 0; i < 5; i += 1) await runSyncCycle({ connectionId: c.id, stream, cursorKind: 'TOKEN', workerId: `w-${i}` }, ctx(), ruim);
  const cursor = await lerModelo(IntegrationSyncCursor, { connectionId: c.id, stream });
  assert.equal(cursor.status, 'STALLED');
  const [erro] = await env.sql(tenant, "SELECT * FROM integration.integration_errors WHERE source_ref_id = :id AND source = 'SYNC' AND status = 'OPEN'", { id: cursor.id });
  assert.ok(erro, 'o fluxo parado tem erro aberto');

  // Sem executor registrado para o fluxo o ciclo não tem como rodar: recusa.
  assert.equal(codigo(await tentar(erro.id)), 'INTEGRATION_RETRY_NOT_ALLOWED');
  const chamadas = [];
  registerSyncRunner(stream, async ({ ctx: c2, connection, origin }) => {
    chamadas.push(origin);
    return runSyncCycle({ connectionId: connection.id, stream, cursorKind: 'TOKEN', workerId: 'retry-humano', origin }, c2, { fetchPage: async () => ({ items: [], nextCursor: null, done: true }), applyItems: async () => 0 });
  });
  try {
    const r = await tentar(erro.id, { reason: 'O fornecedor voltou.' });
    assert.equal(r.status, 202);
    assert.deepEqual(r.corpo.data, { errorId: erro.id, status: 'RETRYING', dispatchId: null });
    assert.deepEqual(chamadas, [SYNC_ORIGINS.HUMAN_RETRY], 'um ciclo, com a origem do retry humano');
    const depois = await lerModelo(IntegrationSyncCursor, { connectionId: c.id, stream });
    assert.equal(depois.status, 'IDLE');
    assert.equal(depois.consecutiveFailures, 0);
    const fim = await env.erroLinha(tenant, erro.id);
    assert.equal(fim.status, 'RESOLVED', 'o ciclo terminou bem: o erro se resolve');
    assert.equal((await env.trilha(tenant, erro.id, 'integration.error.retry_requested')).length, 1);
  } finally { unregisterSyncRunner(stream); }
});

test('retry_sync_ciclo_que_falha_reabre_o_erro', async () => {
  const c = await conexaoAtiva(tenant, 'BANK');
  const stream = uniq('qa.d250f').slice(0, 40).replace(/[^a-z0-9._-]/g, '');
  const ruim = { fetchPage: async () => { throw new Error('fornecedor fora'); }, applyItems: async () => 0 };
  for (let i = 0; i < 5; i += 1) await runSyncCycle({ connectionId: c.id, stream, cursorKind: 'TOKEN', workerId: `w-${i}` }, ctx(), ruim);
  const cursor = await lerModelo(IntegrationSyncCursor, { connectionId: c.id, stream });
  const [erro] = await env.sql(tenant, "SELECT * FROM integration.integration_errors WHERE source_ref_id = :id AND source = 'SYNC' AND status = 'OPEN'", { id: cursor.id });
  registerSyncRunner(stream, async ({ ctx: c2, connection, origin }) => runSyncCycle({ connectionId: connection.id, stream, cursorKind: 'TOKEN', workerId: 'retry-humano', origin }, c2, ruim));
  try {
    assert.equal((await tentar(erro.id)).status, 202);
    const depois = await lerModelo(IntegrationSyncCursor, { connectionId: c.id, stream });
    assert.equal(depois.status, 'FAILED', 'o ciclo falhou de novo (1 falha, sem parar)');
    assert.equal(depois.consecutiveFailures, 1);
    assert.equal((await env.erroLinha(tenant, erro.id)).status, 'OPEN', 'o erro reabre para a pessoa decidir');
  } finally { unregisterSyncRunner(stream); }
});

test('retry_sync_do_correspondente_tem_executor_registrado', async () => {
  require('../../../src/engines/jobs/correspondentStatusPollJob');
  const { getSyncRunner } = require('../../../src/features/integrations/sync');
  assert.equal(typeof getSyncRunner('financing.case_status'), 'function', 'o fluxo financing.case_status sai de STALLED pelo retry humano');
  assert.ok(sequelize);
});
