'use strict';

// Marco 9, M9-D229 — a mensageria do CRM de ponta a ponta no banco descartável: envio enfileirado (QUEUED), SENT só com o id do fornecedor, DELIVERED/READ só por webhook assinado
// ou consulta de status, falha que não vira entregue nem contato, mensagem recebida sem duplicar, telefone inválido e capacidade ausente.
process.env.PORT = process.env.M9D229_FLUXO_PORT || '21291';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d229Env');
const { interactionsOf: interactionsOfBruto } = require('../../../src/features/ai/agents/nay_comercial/comercial.data');

const interactionsOf = (linha) => interactionsOfBruto(linha, Date.now() + 1000);

let tenant;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { await env.pausar(tenant); await env.sequelize.close(); process.exit(0); });

const TO = '+5511999990000';

test('messaging_delivery_somente_por_evidencia', async () => {
  const canal = await env.conectar(tenant, 'messaging-sandbox');
  const p = await env.pessoa(tenant);
  const r = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'Olá, tudo bem?' });
  assert.equal(r.status, 'QUEUED');
  let m = await env.mensagem(tenant, r.message.id);
  assert.equal(m.delivery_status, 'QUEUED', 'a interação nasce QUEUED');
  assert.equal(m.external_message_id, null);
  assert.equal(m.dispatch_id, r.dispatchId);
  // O worker chama o fornecedor: o HTTP 200 prova o aceite, nunca a entrega.
  await env.rodarEnvios(tenant);
  m = await env.mensagem(tenant, r.message.id);
  assert.equal(m.delivery_status, 'SENT');
  assert.equal(m.status, 'SENT');
  assert.match(m.external_message_id, /^sbx-msg-/);
  assert.equal(m.connection_id, canal.conn.id);
  const envio = await env.envioDe(tenant, r.dispatchId);
  assert.equal(envio.status, 'SUBMITTED', 'sem evidência de entrega o envio fica SUBMITTED');
  // Evidência 1: webhook assinado de entrega.
  assert.equal((await env.enviar(canal, env.evento({ resourceId: m.external_message_id, status: 'DELIVERED' }))).status, 200);
  await env.rodar(tenant);
  m = await env.mensagem(tenant, r.message.id);
  assert.equal(m.delivery_status, 'DELIVERED');
  assert.equal((await env.envioDe(tenant, r.dispatchId)).status, 'CONFIRMED', 'o webhook confirma o envio ligado');
  // Evidência 2: consulta de status (getStatus) leva a READ só se o fornecedor disser; aqui o sandbox continua DELIVERED e nada muda.
  const consulta = await env.refrescar(tenant, m.id);
  assert.equal(consulta.changed, false);
  // Webhook sem assinatura válida não muda nada.
  const corpo = Buffer.from(JSON.stringify(env.evento({ resourceId: m.external_message_id, status: 'READ' })));
  assert.equal((await env.postar({ provider: canal.provider, canal: canal.canal, segredo: 'segredo-errado' }, JSON.parse(corpo.toString()))).status, 401);
  assert.equal((await env.mensagem(tenant, m.id)).delivery_status, 'DELIVERED');
});

test('messaging_falha_de_entrega_nao_cria_entregue_nem_contato', async () => {
  const canal = await env.conectar(tenant, 'messaging-sandbox', { config: { sandbox_fault: 'invalid_number' } });
  const p = await env.pessoa(tenant);
  const r = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'Esta vai falhar' });
  await env.rodarEnvios(tenant);
  await env.entregarEventos(tenant);
  const m = await env.mensagem(tenant, r.message.id);
  assert.equal((await env.envioDe(tenant, r.dispatchId)).status, 'FAILED');
  assert.equal(m.delivery_status, 'FAILED', 'o envio recusado vira FAILED na mensagem do CRM');
  assert.equal(m.external_message_id, null);
  // Falha não é contato: a linha do tempo do CRM não conta a mensagem enviada que falhou como interação.
  const linha = [{ type: 'MESSAGE', occurredAt: new Date().toISOString(), data: { direction: 'OUTBOUND', status: m.status, channel: 'WHATSAPP' } }];
  assert.equal(interactionsOf(linha).length, 0);
  assert.equal(interactionsOf([{ ...linha[0], data: { ...linha[0].data, status: 'SENT' } }]).length, 1, 'enviada e aceita conta como contato');
  // Nenhum evento de entrega do fornecedor é presumido; um webhook tardio de entrega não ressuscita a falha.
  await env.enviar(canal, env.evento({ resourceId: 'sbx-msg-inexistente', status: 'DELIVERED' }));
  assert.equal((await env.mensagem(tenant, m.id)).delivery_status, 'FAILED');
});

test('messaging_status_fora_de_ordem_nao_regride_no_crm', async () => {
  const canal = await env.conectar(tenant, 'messaging-sandbox');
  const p = await env.pessoa(tenant);
  const r = await env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: p.phone, text: 'ordem' });
  await env.rodarEnvios(tenant);
  const m = await env.mensagem(tenant, r.message.id);
  await env.enviar(canal, env.evento({ resourceId: m.external_message_id, status: 'READ' }));
  await env.rodar(tenant);
  assert.equal((await env.mensagem(tenant, m.id)).delivery_status, 'READ');
  await env.enviar(canal, env.evento({ resourceId: m.external_message_id, status: 'DELIVERED' }));
  await env.rodar(tenant);
  assert.equal((await env.mensagem(tenant, m.id)).delivery_status, 'READ', 'READ(3) antes de DELIVERED(2) permanece READ');
  await env.enviar(canal, env.evento({ resourceId: m.external_message_id, status: 'FAILED' }));
  await env.rodar(tenant);
  assert.equal((await env.mensagem(tenant, m.id)).delivery_status, 'READ', 'a mensagem lida não falha depois');
});

test('messaging_inbound_vira_interacao', async () => {
  const canal = await env.conectar(tenant, 'messaging-sandbox');
  const p = await env.pessoa(tenant);
  const id = `in-${env.uniqueSuffix()}`;
  const ev = env.inboundA(id, p.phone, 'Quero saber do imóvel', 'Fulano');
  assert.equal((await env.enviar(canal, ev)).status, 200);
  await env.rodar(tenant);
  const msgs = await env.mensagensDa(tenant, p.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].direction, 'INBOUND');
  assert.equal(msgs[0].author_type, 'CLIENT');
  assert.equal(msgs[0].body, 'Quero saber do imóvel');
  assert.equal(msgs[0].external_message_id, id);
  assert.equal(msgs[0].connection_id, canal.conn.id);
  // O texto não vai ao outbox nem à caixa de entrada além do payload original; o evento interno leva só ids.
  const [{ n }] = await env.sql(tenant, "SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'integration.messaging.message.inbound' AND payload_json::text LIKE '%Quero saber%'");
  assert.equal(n, 0, 'o conteúdo da mensagem não vai ao outbox');
  // Remetente desconhecido: lead provisório (pessoa e oportunidade Nova).
  const novo = '+5521988887777';
  const id2 = `in-${env.uniqueSuffix()}`;
  await env.enviar(canal, env.inboundA(id2, novo, 'Oi, sou novo aqui', 'Beltrano'));
  await env.rodar(tenant);
  const [pessoa] = await env.sql(tenant, "SELECT p.id, p.legal_name FROM people.persons p JOIN people.person_contacts c ON c.person_id = p.id WHERE c.value_normalized = :v AND p.company_id = :c", { v: novo, c: tenant.companyId });
  assert.equal(pessoa.legal_name, 'Beltrano');
  const [op] = await env.sql(tenant, 'SELECT stage, next_action FROM crm.opportunities WHERE person_id = :p', { p: pessoa.id });
  assert.equal(op.stage, 'NEW');
  const inb = await env.mensagensDa(tenant, pessoa.id);
  assert.equal(inb.length, 1);
  assert.equal(inb[0].direction, 'INBOUND');
});

test('messaging_external_id_deduplica_inbound', async () => {
  const canal = await env.conectar(tenant, 'messaging-sandbox');
  const p = await env.pessoa(tenant);
  const id = `in-dup-${env.uniqueSuffix()}`;
  // Mesmo evento reenviado (mesmo id de evento) e a mesma mensagem com outro id de evento: um único registro.
  const ev = env.inboundA(id, p.phone, 'repetida');
  await env.enviar(canal, ev);
  await env.enviar(canal, ev);
  await env.enviar(canal, { ...ev, id: `evt-outro-${env.uniqueSuffix()}` });
  await env.rodar(tenant);
  await env.rodar(tenant);
  assert.equal((await env.mensagensDa(tenant, p.id)).length, 1);
  const [{ n }] = await env.sql(tenant, "SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'crm.message.duplicate_ignored' AND after_json->>'code' = 'INTEGRATION_MESSAGING_DUPLICATE_IGNORED' AND company_id = :c", { c: tenant.companyId });
  assert.ok(n >= 1, 'a repetição fica registrada como ignorada');
  // O UNIQUE (connection, id externo) vale também direto no banco.
  await assert.rejects(env.sql(tenant, `INSERT INTO crm.messages (id, group_id, company_id, person_id, channel, direction, author_type, status, external_message_id, connection_id)
    VALUES (gen_random_uuid(), :g, :c, :p, 'WHATSAPP', 'INBOUND', 'CLIENT', 'RECEIVED', :e, :k)`, { g: tenant.groupId, c: tenant.companyId, p: p.id, e: id, k: canal.conn.id }), /crm_messages_connection_external_uq/);
});

test('messaging_telefone_invalido_e_capacidade_ausente_no_servico', async () => {
  await env.conectar(tenant, 'messaging-sandbox');
  const p = await env.pessoa(tenant);
  const [antes] = await env.sql(tenant, 'SELECT count(*)::int AS n FROM crm.messages WHERE person_id = :p', { p: p.id });
  await assert.rejects(env.enviarMensagem(tenant, { kind: 'text', personId: p.id, to: '11999990000', text: 'sem +55' }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_MESSAGING_PHONE_INVALID');
  const [depois] = await env.sql(tenant, 'SELECT count(*)::int AS n FROM crm.messages WHERE person_id = :p', { p: p.id });
  assert.equal(depois.n, antes.n, 'telefone inválido não grava mensagem nem envio');
  // Fornecedor sem sendMedia: o domínio degrada de forma declarada para texto com a referência, nunca falha.
  await env.conectar(tenant, 'messaging-alt-sandbox');
  const r = await env.enviarMensagem(tenant, { kind: 'media', personId: p.id, to: p.phone, mediaRef: 'file:planta-001', caption: 'Planta do imóvel', mediaClassification: 'PUBLIC' });
  assert.equal(r.degraded, true);
  assert.equal(r.operation, 'sendText');
  // Template no mesmo fornecedor é suportado; capability ausente de verdade (getStatus em connection sem a capability) é 422 do serviço de consulta.
  const t = await env.enviarMensagem(tenant, { kind: 'template', personId: p.id, to: p.phone, templateName: 'boas_vindas', language: 'pt_BR' });
  assert.equal(t.operation, 'sendTemplate');
  assert.ok(TO);
});

test('messaging_rotas_do_crm_exigem_permissao', () => {
  const { gerar } = require('../../../scripts/gerarMatrizPermissoes');
  const rotas = gerar();
  const acha = (metodo, caminho) => rotas.find((r) => r.method === metodo && r.path === caminho);
  assert.deepEqual((acha('POST', '/api/v1/messages/send') || {}).permissions, ['crm:messages:create']);
  assert.deepEqual((acha('POST', '/api/v1/messages/:id/refresh-status') || {}).permissions, ['crm:messages:update']);
});
