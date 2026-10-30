'use strict';

// Marco 9, M9-D234 — e-mail de saída pelo adapter: o identificador da mensagem no provedor é gravado (único por connection), a entrega só vale com o evento do
// provedor, bounce, reclamação e falha ficam registrados como vieram. Envio pelo Dispatch Service e eventos pela rota única de webhooks. Banco descartável.
process.env.PORT = process.env.M9D234_ENVIO_PORT || '21234';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d234Env');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

/** Canal ativo + mensagem já aceita pelo provedor (SENT, com identificador). */
async function pronta(extra) {
  const canal = await env.conectar(tenant);
  const r = await env.enviarEEntregarAoProvedor(tenant, extra);
  return { canal, ...r };
}
const chegada = async (canal, tipo, messageId, extra) => {
  const r = await env.enviar(canal, env.evento(tipo, messageId, extra));
  await env.rodar(tenant);
  return r;
};

test('email_envio_registra_message_id', async () => {
  const canal = await env.conectar(tenant);
  const r = await env.enviarEmail(tenant, { idempotencyKey: `qa-m9-d234-${env.uniqueSuffix()}` });
  assert.equal(r.message.status, 'QUEUED', 'antes do worker a mensagem só está na fila');
  const [envio] = await env.sql(tenant, 'SELECT * FROM integration.dispatches WHERE id = :id', { id: r.dispatchId });
  assert.equal(envio.operation, 'sendEmail');
  assert.equal(envio.connection_id, canal.conn.id);
  assert.equal(envio.purpose, 'CUSTOMER_MESSAGE', 'a finalidade do mapper fica gravada no envio');
  assert.match(envio.payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(envio.aggregate_type, 'EmailMessage');
  assert.equal(envio.aggregate_id, r.message.id);
  await env.rodarEnvios(tenant);
  const m = await env.mensagem(tenant, r.message.id);
  assert.equal(m.status, 'SENT');
  assert.match(m.external_message_id, /^sbx-em-[0-9a-f]{16}$/, 'o identificador da mensagem no provedor foi gravado');
  assert.equal(m.connection_id, canal.conn.id);
  assert.ok(m.sent_at);
  assert.equal(Object.keys(m).some((c) => /^(body|body_text|body_html|content)$/.test(c)), false, 'o corpo da mensagem não é guardado na tabela de mensagens');
  // UNIQUE (connection_id, external_message_id): outra mensagem com o mesmo identificador na mesma connection é recusada pelo banco.
  const outra = await env.enviarEmail(tenant);
  await assert.rejects(env.sql(tenant, 'UPDATE integration.email_messages SET external_message_id = :x WHERE id = :id', { x: m.external_message_id, id: outra.message.id }), /email_messages_provider_id_uidx|duplicate key/);
  // Mesma chave de idempotência: a mesma mensagem, sem segundo envio.
  const repetido = await env.enviarEmail(tenant, { idempotencyKey: `qa-m9-d234-repetida` });
  const repetido2 = await env.enviarEmail(tenant, { idempotencyKey: `qa-m9-d234-repetida`, to: [repetido.message.toAddresses[0]] });
  assert.equal(repetido2.replay, true);
  assert.equal(repetido2.message.id, repetido.message.id);
  assert.equal(repetido2.dispatchId, repetido.dispatchId);
});

test('email_entrega_somente_por_evento', async () => {
  const { canal, message } = await pronta();
  assert.equal(message.status, 'SENT');
  await env.rodarEnvios(tenant);
  await env.rodar(tenant);
  assert.equal((await env.mensagem(tenant, message.id)).status, 'SENT', 'sem evento do provedor a mensagem continua SENT, nunca declara entrega');
  assert.equal((await env.mensagem(tenant, message.id)).delivered_at, null);
  const [envio] = await env.sql(tenant, 'SELECT status FROM integration.dispatches WHERE id = :id', { id: message.dispatch_id });
  assert.notEqual(envio.status, 'CONFIRMED', 'a resposta do envio não confirma a entrega');
  const falso = await env.postar(`/v1/webhooks/${canal.provider}/${canal.canal}`, Buffer.from(JSON.stringify(env.evento('delivered', message.external_message_id))), { 'x-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` });
  assert.equal(falso.status, 401);
  assert.equal((await env.mensagem(tenant, message.id)).status, 'SENT', 'evento sem assinatura válida não muda nada');
  const ok = await chegada(canal, 'delivered', message.external_message_id, { occurredAt: '2026-10-29T12:00:00Z' });
  assert.equal(ok.json.status, 'accepted');
  const depois = await env.mensagem(tenant, message.id);
  assert.equal(depois.status, 'DELIVERED');
  assert.equal(new Date(depois.delivered_at).toISOString(), '2026-10-29T12:00:00.000Z', 'o horário da entrega é o informado pelo provedor');
  const [envioFinal] = await env.sql(tenant, 'SELECT status FROM integration.dispatches WHERE id = :id', { id: message.dispatch_id });
  assert.equal(envioFinal.status, 'CONFIRMED', 'o evento entregue confirma o envio (evidência do provedor)');
  assert.deepEqual((await env.eventosDe(tenant, message.id)).map((e) => e.kind), ['DELIVERED']);
});

test('email_bounce_e_reclamacao_registrados_como_status', async () => {
  const canal = await env.conectar(tenant);
  const nova = async () => (await env.enviarEEntregarAoProvedor(tenant)).message;
  const hard = await nova();
  await chegada(canal, 'bounced', hard.external_message_id, { bounce: { type: 'hard', reason: 'Caixa inexistente para joao@qa-m9.test' } });
  const h = await env.mensagem(tenant, hard.id);
  assert.equal(h.status, 'BOUNCED_HARD');
  assert.equal(h.bounce_type, 'hard');
  assert.ok(h.failure_reason && h.failure_reason.length > 0 && !h.failure_reason.includes('joao@qa-m9.test'), 'o motivo do provedor fica registrado sem o endereço pessoal');
  const soft = await nova();
  await chegada(canal, 'bounced', soft.external_message_id, { bounce: { type: 'soft', reason: 'Caixa cheia' } });
  const s = await env.mensagem(tenant, soft.id);
  assert.equal(s.status, 'BOUNCED_SOFT');
  assert.equal(s.bounce_type, 'soft');
  const reclamada = await nova();
  await chegada(canal, 'delivered', reclamada.external_message_id);
  await chegada(canal, 'complained', reclamada.external_message_id);
  assert.equal((await env.mensagem(tenant, reclamada.id)).status, 'COMPLAINED');
  assert.deepEqual((await env.eventosDe(tenant, reclamada.id)).map((e) => e.kind), ['DELIVERED', 'COMPLAINED']);
  const falha = await nova();
  await chegada(canal, 'failed', falha.external_message_id, { reason: 'Rejeitado pela política do destino' });
  assert.equal((await env.mensagem(tenant, falha.id)).status, 'FAILED');
  // O bounce leve que chega depois da entrega é mais antigo na ordem dos estados: não regride a mensagem.
  const entregue = await nova();
  await chegada(canal, 'delivered', entregue.external_message_id);
  await chegada(canal, 'bounced', entregue.external_message_id, { bounce: { type: 'soft' } });
  assert.equal((await env.mensagem(tenant, entregue.id)).status, 'DELIVERED');
  // Evento de mensagem que o sistema não conhece: recusado com erro de integração, sem efeito.
  await chegada(canal, 'delivered', 'sbx-em-desconhecida');
  assert.ok((await env.erros(tenant, canal.provider, 'INTEGRATION_EMAIL_MESSAGE_UNKNOWN')).length >= 1);
});

test('email_envio_recusado_de_vez_vira_failed', async () => {
  await env.conectar(tenant);
  const r = await env.enviarEmail(tenant, { to: ['rejeitar@qa-m9.test'] });
  await env.rodarEnvios(tenant);
  await env.rodarEnvios(tenant); // o passo da rodada confere os envios terminados sem sucesso
  const m = await env.mensagem(tenant, r.message.id);
  assert.equal(m.status, 'FAILED');
  assert.equal(m.external_message_id, null);
  assert.match(m.failure_reason, /provedor não aceitou/i);
});
