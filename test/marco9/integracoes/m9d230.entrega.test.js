'use strict';

// Marco 9, M9-D230 — falha de envio nunca vira entregue (modelo e mídia incluídos, com o motivo em português) e a conversa e o canal têm identificador interno estável: a troca de fornecedor
// cria um par externo novo e mantém o histórico. Banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D230_ENTREGA_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d230Env');
const { swapProvider } = require('../../../src/features/integrations/swap');
const { conversaDe } = require('../_helpers/m9d230Janela');
const { interactionsOf: interactionsOfBruto } = require('../../../src/features/ai/agents/nay_comercial/comercial.data');

let tenant;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { await env.pausar(tenant); await env.sequelize.close(); process.exit(0); });

const contatos = (m) => interactionsOfBruto([{ type: 'MESSAGE', occurredAt: new Date().toISOString(), data: { direction: m.direction, status: m.status, channel: m.channel } }], Date.now() + 1000).length;
const modeloMsg = (p) => ({ kind: 'template', personId: p.id, to: p.phone, templateName: 'aviso_visita', language: 'pt_BR', templateVars: ['Ana', '10h'] });
const midia = async (p) => ({ kind: 'media', personId: p.id, to: p.phone, mediaRef: (await env.arquivo(tenant)).id, auth: env.authDe(tenant) });

test('whatsapp_falha_nao_cria_interacao_entregue', async () => {
  // Teste do livro, sem corpo próprio: repete messaging_delivery_somente_por_evidencia sobre o fluxo de modelo e de mídia.
  const canal = await env.conectarComModelos(tenant, [env.modelo('aviso_visita')]);
  const p = await env.pessoa(tenant);
  for (const montar of [async () => modeloMsg(p), async () => midia(p)]) {
    const r = await env.enviarMensagem(tenant, await montar());
    assert.equal((await env.mensagem(tenant, r.message.id)).delivery_status, 'QUEUED');
    await env.rodarEnvios(tenant);
    let m = await env.mensagem(tenant, r.message.id);
    assert.equal(m.delivery_status, 'SENT', 'o HTTP 200 prova só o aceite');
    await env.enviar(canal, env.evento({ resourceId: m.external_message_id, status: 'DELIVERED' }));
    await env.rodar(tenant);
    m = await env.mensagem(tenant, r.message.id);
    assert.equal(m.delivery_status, 'DELIVERED', 'entregue só depois do webhook assinado');
    assert.equal(m.failure_reason, null);
  }
  // Fornecedor aceitou (200) e depois informou que falhou (número inexistente, bloqueado ou modelo rejeitado): FAILED com motivo; um aviso de entrega tardio não ressuscita.
  for (const montar of [async () => modeloMsg(p), async () => midia(p)]) {
    const r = await env.enviarMensagem(tenant, await montar());
    await env.rodarEnvios(tenant);
    const aceita = await env.mensagem(tenant, r.message.id);
    await env.enviar(canal, env.evento({ resourceId: aceita.external_message_id, status: 'FAILED' }));
    await env.rodar(tenant);
    const m = await env.mensagem(tenant, r.message.id);
    assert.equal(m.delivery_status, 'FAILED');
    assert.match(m.failure_reason, /n[uú]mero|bloquead|modelo|fornecedor/i, 'motivo em português');
    assert.equal(contatos(m), 0, 'a mensagem que falhou não conta como contato');
    await env.enviar(canal, env.evento({ resourceId: aceita.external_message_id, status: 'DELIVERED' }));
    await env.rodar(tenant);
    assert.equal((await env.mensagem(tenant, r.message.id)).delivery_status, 'FAILED');
  }
  // Número inexistente recusado já no envio: FAILED com o motivo, nunca "entregue".
  await env.conectarComModelos(tenant, [env.modelo('aviso_visita')], 'messaging-sandbox', { sandbox_fault: 'invalid_number' });
  for (const montar of [async () => modeloMsg(p), async () => midia(p)]) {
    const r = await env.enviarMensagem(tenant, await montar());
    await env.rodarEnvios(tenant);
    await env.entregarEventos(tenant);
    const m = await env.mensagem(tenant, r.message.id);
    assert.equal(m.delivery_status, 'FAILED');
    assert.match(m.failure_reason, /n[uú]mero/i);
    assert.equal(m.external_message_id, null);
  }
});

test('whatsapp_mapping_troca_de_fornecedor_preserva_conversa_e_canal', async () => {
  const antiga = await env.conectarComModelos(tenant, [env.modelo('aviso_visita')]);
  const p = await env.pessoa(tenant);
  await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'antes da troca' });
  await env.rodarEnvios(tenant);
  const conversa = await conversaDe(tenant, p.id);
  assert.ok(conversa && conversa.channel_id, 'a conversa tem identificador interno e canal interno');
  const ligacoes = (id) => env.sql(tenant, 'SELECT * FROM crm.conversation_links WHERE internal_id = :i ORDER BY created_at, id', { i: id });
  let l = await ligacoes(conversa.id);
  assert.deepEqual(l.map((x) => [x.connection_id, x.superseded_at === null]), [[antiga.conn.id, true]], 'o par externo é (connection, id externo) e está vigente');
  assert.ok(l[0].external_id);
  // Troca de fornecedor no meio da conversa.
  const nova = await env.criarCanal(tenant, { provider: 'messaging-alt-sandbox' });
  await env.comTenant(tenant, (t) => swapProvider(env.ctxDe(tenant), { fromConnectionId: antiga.conn.id, toConnectionId: nova.conn.id }, t));
  const r = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'depois da troca' });
  await env.rodarEnvios(tenant);
  const depois = await conversaDe(tenant, p.id);
  assert.equal(depois.id, conversa.id, 'a conversa continua com o mesmo id interno');
  assert.equal(depois.channel_id, conversa.channel_id, 'o canal interno também');
  l = await ligacoes(conversa.id);
  const porConexao = Object.fromEntries(l.map((x) => [x.connection_id, x.superseded_at !== null]));
  assert.deepEqual(porConexao, { [antiga.conn.id]: true, [nova.conn.id]: false }, 'o par antigo fica superado e o novo vigente');
  assert.equal(l.length, 2);
  // O histórico anterior permanece na mesma conversa, com as duas connections.
  const msgs = (await env.mensagensDa(tenant, p.id)).filter((m) => m.direction === 'OUTBOUND');
  assert.deepEqual([...new Set(msgs.map((m) => m.conversation_id))], [conversa.id]);
  assert.deepEqual(msgs.map((m) => m.connection_id), [antiga.conn.id, nova.conn.id]);
  assert.equal((await env.envioDe(tenant, r.dispatchId)).payload_snapshot.conversationId, conversa.id);
  // Mensagem recebida pelo fornecedor novo cai na mesma conversa e abre a janela.
  await env.postar(nova, env.inboundB(`in-${env.uniqueSuffix()}`, p.phone.slice(1), 'voltei'));
  await env.postar(nova, env.inboundB(`in-${env.uniqueSuffix()}`, p.phone.slice(1), 'voltei de novo'));
  await env.rodar(tenant);
  const todas = await env.mensagensDa(tenant, p.id);
  assert.ok(todas.filter((m) => m.direction === 'INBOUND').every((m) => m.conversation_id === conversa.id));
  assert.ok((await conversaDe(tenant, p.id)).last_inbound_at, 'a mensagem recebida registra o último contato do cliente');
});
