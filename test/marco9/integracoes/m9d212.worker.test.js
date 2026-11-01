'use strict';

// Marco 9, M9-D212 — o worker converte o evento da caixa de entrada em evento interno exatamente uma vez, manda dado inválido à fila morta sem retry,
// não deixa o status regredir e guarda na fila morta só o conteúdo sanitizado.
process.env.PORT = process.env.M9D212_WORKER_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d212Env');
const link = require('../../../src/features/integrations/webhooks/worker/worker.link');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const erroDe = (c, codigo) => env.errosDoCanal(tenant, c, codigo);

test('intake_worker_processa_uma_vez', async () => {
  const c = await env.criarCanal(tenant);
  const ev = env.evento({ status: 'DELIVERED' });
  await env.enviar(c, ev);
  await env.enviar(c, ev);
  const [a, b] = await Promise.all([env.rodar(tenant), env.rodar(tenant)]);
  assert.equal(a.processed + b.processed >= 1, true);
  const l = await env.linha(tenant, c.provider, ev.id);
  assert.equal(l.status, 'PROCESSED');
  assert.equal(l.attempts, 1, 'pego uma única vez');
  assert.equal(l.applied, true);
  assert.equal(l.internal_status, 'DELIVERED');
  assert.equal(l.resource_ref, ev.resourceId);
  const eventos = await env.outboxDe(tenant, l.id);
  assert.equal(eventos.length, 1, 'um único evento interno');
  assert.equal(eventos[0].event_type, 'integration.messaging.message.status');
  assert.equal(eventos[0].payload_json.status, 'DELIVERED');
  await env.rodar(tenant);
  assert.equal((await env.outboxDe(tenant, l.id)).length, 1, 'outra rodada não repete o efeito');
});

test('intake_schema_invalido_vai_para_dlq_sem_retry', async () => {
  const c = await env.criarCanal(tenant);
  const { status: _s, ...semStatus } = env.evento();
  const r = await env.enviar(c, semStatus);
  assert.equal(r.status, 200, 'a rota só confere id e tipo');
  const resumo = await env.rodar(tenant);
  assert.equal(resumo.deadLettered >= 1, true);
  const l = await env.linha(tenant, c.provider, semStatus.id);
  assert.equal(l.status, 'DEAD_LETTER');
  assert.equal(l.dead_letter_reason, 'SCHEMA_INVALID');
  assert.equal(l.attempts, 1, '0 retries: a primeira tentativa é a única');
  assert.equal(l.payload_raw, null);
  assert.equal(l.payload, null);
  await env.vencer(tenant, l.id);
  await env.rodar(tenant);
  assert.equal((await env.linha(tenant, c.provider, semStatus.id)).attempts, 1, 'a fila morta não volta ao worker');
  const [erro] = await erroDe(c, 'INTEGRATION_WEBHOOK_SCHEMA_INVALID');
  assert.equal(erro.message, 'Evento fora do formato esperado; enviado para a fila de erros.');
  assert.equal((await env.outboxDe(tenant, l.id)).length, 0);
});

test('intake_versao_nao_suportada_dlq', async () => {
  const c = await env.criarCanal(tenant);
  const ev = env.evento({ api_version: 'v9' });
  await env.enviar(c, ev);
  await env.rodar(tenant);
  const l = await env.linha(tenant, c.provider, ev.id);
  assert.deepEqual([l.status, l.dead_letter_reason, l.attempts], ['DEAD_LETTER', 'VERSION_UNSUPPORTED', 1]);
  assert.equal((await erroDe(c, 'INTEGRATION_WEBHOOK_VERSION_UNSUPPORTED')).length, 1);
  const desconhecido = env.evento({ status: 'TELEPORTADO' });
  await env.enviar(c, desconhecido);
  await env.rodar(tenant);
  const u = await env.linha(tenant, c.provider, desconhecido.id);
  assert.deepEqual([u.status, u.dead_letter_reason], ['DEAD_LETTER', 'STATUS_UNMAPPED'], 'status que o adapter não conhece nunca é presumido');
  assert.equal((await env.outboxDe(tenant, u.id)).length, 0);
});

test('intake_status_fora_de_ordem_nao_regride', async () => {
  const c = await env.criarCanal(tenant);
  const recurso = `res-ordem-${env.uniqueSuffix()}`;
  const entregue = env.evento({ resourceId: recurso, status: 'DELIVERED' });
  const enviado = env.evento({ resourceId: recurso, status: 'SENT' });
  const lido = env.evento({ resourceId: recurso, status: 'READ' });
  await env.enviar(c, entregue);
  await env.rodar(tenant);
  await env.enviar(c, enviado);
  await env.rodar(tenant);
  const atrasado = await env.linha(tenant, c.provider, enviado.id);
  assert.equal(atrasado.status, 'PROCESSED', 'o histórico é mantido');
  assert.equal(atrasado.applied, false, 'rank 2 < 3: não chega ao domínio');
  assert.equal((await env.outboxDe(tenant, atrasado.id)).length, 0);
  const primeiro = await env.linha(tenant, c.provider, entregue.id);
  assert.equal(primeiro.applied, true);
  assert.equal((await env.outboxDe(tenant, primeiro.id))[0].payload_json.status, 'DELIVERED', 'o domínio continua com DELIVERED');
  await env.enviar(c, lido);
  await env.rodar(tenant);
  assert.equal((await env.linha(tenant, c.provider, lido.id)).applied, true, 'rank maior segue em frente');
});

test('intake_dlq_payload_sanitizado_sem_pii', async () => {
  const c = await env.criarCanal(tenant);
  const { status: _s, ...base } = env.evento();
  const ev = { ...base, idempotencyKey: 'cliente 123.456.789-09 fulano@exemplo.com.br 11 98888-7777 ' + ['Bear', 'er'].join('') + ' abcdefghijklmnopqrstuvwxyz0123456789', occurredAt: 'x'.repeat(500), cpf: '987.654.321-00', token: 'segredo-do-fornecedor', card: '4111111111111111' };
  await env.enviar(c, ev);
  await env.rodar(tenant);
  const l = await env.linha(tenant, c.provider, ev.id);
  assert.equal(l.status, 'DEAD_LETTER');
  assert.equal(l.payload_raw, null);
  assert.equal(l.payload, null);
  const [erro] = await erroDe(c, 'INTEGRATION_WEBHOOK_SCHEMA_INVALID');
  const guardado = JSON.stringify(erro.sanitized_payload);
  for (const proibido of ['123.456.789-09', 'fulano@exemplo.com.br', '98888-7777', 'abcdefghijklmnopqrstuvwxyz', '987.654.321-00', 'segredo-do-fornecedor', '4111111111111111']) {
    assert.ok(!guardado.includes(proibido), `não guarda ${proibido}`);
  }
  assert.equal(erro.sanitized_payload.occurredAt.length <= 200, true, 'textos até 200 caracteres');
  assert.equal(erro.sanitized_payload.cpf, undefined, 'só os campos do esquema do adapter entram');
  assert.match(erro.payload_hash, /^[0-9a-f]{64}$/);
});

test('intake_outbox_na_mesma_transacao', async () => {
  const c = await env.criarCanal(tenant);
  const ev = env.evento({ status: 'DELIVERED' });
  await env.enviar(c, ev);
  const original = link.linkToDispatch;
  link.linkToDispatch = async () => { throw new Error('falha depois de publicar'); };
  try {
    await env.rodar(tenant);
  } finally {
    link.linkToDispatch = original;
  }
  const l = await env.linha(tenant, c.provider, ev.id);
  assert.equal(l.status, 'FAILED', 'o evento volta para nova tentativa');
  assert.equal((await env.outboxDe(tenant, l.id)).length, 0, 'o evento interno publicado antes da falha foi desfeito junto');
  await env.vencer(tenant, l.id);
  await env.rodar(tenant);
  assert.equal((await env.outboxDe(tenant, l.id)).length, 1, 'na tentativa seguinte o evento nasce uma vez só');
  assert.equal((await env.linha(tenant, c.provider, ev.id)).status, 'PROCESSED');
});
