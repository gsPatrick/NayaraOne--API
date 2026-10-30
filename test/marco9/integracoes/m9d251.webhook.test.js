'use strict';

// Marco 9, M9-D251 — testes adversariais do livro (seção 19), webhook: assinatura falsa, evento duplicado, replay fora da janela, payload gigante, payload inválido e status fora de ordem.
// HTTP real contra o app de teste, banco descartável (os testes COMMITAM), relógio simulado (horário assinado injetado, sem sleep).
process.env.PORT = process.env.M9D251_WEBHOOK_PORT || '25251';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d212Env');
const adv = require('../_helpers/m9d251Env');
const { dispatch, conexaoAtiva, limparPendentes, enfileirar, pagamento, ler, forcar } = require('../_helpers/m9d214Env');
const { refusalsCount } = require('../../../src/features/integrations/webhooks/webhooks.metrics');

let tenant;
let desligarCofre;
const agora = () => Math.floor(Date.now() / 1000);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const MIB = 1048576;

before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await adv.aguardarApp(env.base);
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const caminho = (c) => `/v1/webhooks/${c.provider}/${c.canal}`;

test('adv_webhook_falso_assinatura_invalida_401', async () => {
  const c = await env.criarCanal(tenant);
  const marcador = `payload-confidencial-${env.uniqueSuffix()}`;
  const ev = env.evento({ nota: marcador, cpf: '123.456.789-09' });
  const corpo = Buffer.from(JSON.stringify(ev));
  const r = await env.postar(caminho(c), corpo, env.assinar('segredo-forjado', corpo));
  assert.equal(r.status, 401);
  assert.equal((await env.inbox(tenant, c.provider, ev.id)).length, 0, 'nada gravado na caixa de entrada');
  const [erro] = await env.erros(tenant, c.provider, 'INTEGRATION_WEBHOOK_SIGNATURE_INVALID');
  assert.ok(erro, 'a rejeição vira erro de integração');
  assert.equal(erro.severity, 'HIGH');
  assert.equal(erro.payload_hash, sha(corpo), 'só o hash do corpo');
  assert.ok(!JSON.stringify(erro).includes(marcador) && !JSON.stringify(erro).includes('123.456.789-09'), 'o erro não leva o payload');
  // Sem cabeçalho de assinatura também é recusado.
  const sem = await env.postar(caminho(c), corpo, {});
  assert.equal(sem.status, 401);
});

test('adv_webhook_duplicado_nao_reprocessa', async () => {
  const c = await env.criarCanal(tenant);
  const ev = env.evento({ status: 'DELIVERED' });
  const respostas = [];
  for (let i = 0; i < 5; i += 1) respostas.push(await env.enviar(c, ev));
  assert.deepEqual(respostas.map((r) => r.json.status), ['accepted', 'duplicate', 'duplicate', 'duplicate', 'duplicate'], '1 aceito e 4 duplicados');
  await env.rodar(tenant);
  await env.rodar(tenant);
  const l = await env.linha(tenant, c.provider, ev.id);
  assert.equal(l.attempts, 1, 'um único processamento');
  assert.equal((await env.outboxDe(tenant, l.id)).length, 1, 'um único evento interno');
  assert.equal((await env.sql(tenant, 'SELECT count(*)::int AS n FROM integration.webhook_inbox WHERE connection_id = :id', { id: c.conn.id }))[0].n, 1, 'uma só linha');
});

test('adv_webhook_replay_fora_da_janela_401', async () => {
  const c = await env.criarCanal(tenant);
  const antes = await refusalsCount(c.provider, 'INTEGRATION_WEBHOOK_REPLAY');
  const velho = env.evento();
  const r = await env.enviar(c, velho, { t: agora() - 12 * 60 });
  assert.equal(r.status, 401, 'assinatura válida, horário assinado de 12 minutos atrás (tolerância de 5)');
  assert.equal(r.json.error.code, 'INTEGRATION_WEBHOOK_REPLAY');
  assert.equal((await env.inbox(tenant, c.provider, velho.id)).length, 0);
  assert.equal(await refusalsCount(c.provider, 'INTEGRATION_WEBHOOK_REPLAY'), antes + 1);
  const ok = await env.enviar(c, env.evento(), { t: agora() - 60 });
  assert.equal(ok.status, 200, 'dentro da janela passa');
});

test('adv_payload_gigante_413_sem_estourar_memoria', async () => {
  const c = await env.criarCanal(tenant);
  const grande = Buffer.alloc(3 * MIB, 'a');
  const cab = env.assinar(c.segredo, grande);
  const url = `${env.base()}${caminho(c)}`;
  const antes = adv.rssMiB();
  for (let i = 0; i < 4; i += 1) {
    const r = await adv.postarGrande(url, grande, cab);
    assert.equal(adv.recusado(r), true, `3 MiB com limite de 1 MiB: 413 ou conexão cortada (rodada ${i})`);
  }
  const depois = adv.rssMiB();
  assert.ok(depois - antes < 150, `o consumo de memória ficou estável (${antes} MiB -> ${depois} MiB)`);
  const pouco = Buffer.alloc(MIB + 4096, 'a');
  const r413 = await env.postar(caminho(c), pouco, env.assinar(c.segredo, pouco));
  assert.equal(r413.status, 413);
  assert.equal(r413.json.error.code, 'INTEGRATION_WEBHOOK_TOO_LARGE');
  assert.equal((await env.sql(tenant, 'SELECT count(*)::int AS n FROM integration.webhook_inbox WHERE connection_id = :id', { id: c.conn.id }))[0].n, 0, 'nada do corpo grande foi gravado');
});

test('adv_payload_invalido_vai_para_dlq_sem_retry', async () => {
  const c = await env.criarCanal(tenant);
  const pii = 'fulano@exemplo.com.br';
  const { status: _s, ...semStatus } = env.evento({ email: pii, cpf: '123.456.789-09' });
  const r = await env.enviar(c, semStatus);
  assert.equal(r.status, 200, 'a rota responde 200: um 400 faria o fornecedor reenviar em laço');
  await env.rodar(tenant);
  const l = await env.linha(tenant, c.provider, semStatus.id);
  assert.equal(l.status, 'DEAD_LETTER', 'DEAD_LETTER na primeira tentativa');
  assert.equal(l.dead_letter_reason, 'SCHEMA_INVALID');
  assert.equal(l.attempts, 1);
  assert.equal(l.payload_raw, null);
  assert.equal(l.payload, null);
  await env.vencer(tenant, l.id);
  await env.rodar(tenant);
  await env.rodar(tenant);
  assert.equal((await env.linha(tenant, c.provider, semStatus.id)).attempts, 1, '0 retries');
  const guardado = JSON.stringify(await env.erros(tenant, c.provider, 'INTEGRATION_WEBHOOK_SCHEMA_INVALID'));
  assert.ok(guardado.length > 2 && !guardado.includes(pii) && !guardado.includes('123.456.789-09'), 'payload sanitizado na fila de erros');
  assert.equal((await env.outboxDe(tenant, l.id)).length, 0);
});

test('adv_status_externo_fora_de_ordem_nao_regride', async () => {
  // 1) Pela caixa de entrada: a entrega que chega depois do envio não faz a mensagem voltar.
  const c = await env.criarCanal(tenant);
  const recurso = `res-adv-${env.uniqueSuffix()}`;
  const entregue = env.evento({ resourceId: recurso, status: 'DELIVERED' });
  const atrasado = env.evento({ resourceId: recurso, status: 'SENT' });
  await env.enviar(c, entregue);
  await env.rodar(tenant);
  await env.enviar(c, atrasado);
  await env.rodar(tenant);
  const lAtrasado = await env.linha(tenant, c.provider, atrasado.id);
  assert.equal(lAtrasado.applied, false, 'SENT depois de DELIVERED: guardado, sem chegar ao domínio');
  assert.equal((await env.outboxDe(tenant, lAtrasado.id)).length, 0);
  assert.equal((await env.outboxDe(tenant, (await env.linha(tenant, c.provider, entregue.id)).id))[0].payload_json.status, 'DELIVERED');
  // 2) Pelo envio ao banco: PAID seguido de PROCESSING continua PAID.
  const banco = await conexaoAtiva(tenant, 'BANK');
  await limparPendentes(tenant);
  const r = await enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: crypto.randomUUID(), payload: pagamento() });
  await dispatch.runDispatchCycle(env.ctxDe(tenant));
  await forcar(tenant, r.dispatchId, "status = 'SUBMITTED', unknown_since = NULL");
  const chave = (await ler(tenant, r.dispatchId)).idempotency_key;
  const evento = (status) => ({ providerCode: 'bank-sandbox', idempotencyKey: chave, status, source: 'WEBHOOK_SIGNED' });
  const resolver = (e) => env.comTenant(tenant, (t) => dispatch.resolveDispatchByEvent(env.ctxDe(tenant), e, {}, t));
  assert.equal((await resolver(evento('PAID'))).status, 'CONFIRMED');
  const volta = await resolver(evento('PROCESSING'));
  assert.equal(volta.changed, false, 'PROCESSING depois de PAID não muda nada');
  const fim = await ler(tenant, r.dispatchId);
  assert.equal(fim.status, 'CONFIRMED', 'continua pago');
  assert.equal(fim.external_status, 'PAID');
});
