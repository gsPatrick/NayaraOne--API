'use strict';

// Marco 9, M9-D227 — WhatsApp fora: a mensagem fica QUEUED (nunca entregue), segue por e-mail só com o consentimento do contato, o marketing aguarda e é cancelado ao vencer, a essencial
// sem alternativo vira tarefa do responsável e a mensagem vencida na fila vira modelo. Banco descartável (os testes COMMITAM). Nomes da seção 8 da demanda.
process.env.PORT = process.env.M9D227_WA_PORT || '22271';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d227Env');

const { contingency } = env;
let tenant;
const CHAVES = ['integration.whatsapp.alternate_requires_opt_in', 'integration.whatsapp.expired_template_name', 'integration.whatsapp.alternate_email_subject', 'integration.whatsapp.session_window_h'];

before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  env.e234.useTempSecretStore();
  contingency.installContingency();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
beforeEach(async () => { await env.limparContingencias(tenant); await env.limparCircuito(tenant); await env.limparPendentes(tenant); await env.restaurar(tenant, CHAVES); });
after(async () => { await env.limparContingencias(tenant); await env.limparCircuito(tenant); await env.limparPendentes(tenant); await env.restaurar(tenant, CHAVES); await env.desativarConexoesDeTeste(tenant); await env.sequelize.close(); process.exit(0); });

const recusa = (status, code) => (e) => e.statusCode === status && e.code === code;

test('contingencia_whatsapp_fila_nao_marca_entregue', async () => {
  const c = await env.whatsapp(tenant);
  const p = await env.pessoa(tenant);
  await env.derrubar(tenant, c.id);
  const r = await env.enviar(tenant, p, 'Seu boleto vence amanhã.');
  assert.equal(r.status, 'QUEUED');
  const ciclo = await env.ciclo(tenant);
  assert.ok(ciclo.activated >= 1, 'o circuito aberto ativa a contingência do WhatsApp');
  assert.equal((await env.ativas(tenant)).find((a) => a.connectionId === c.id).mode, 'QUEUE_AND_ALTERNATE');
  await env.rodarEnvios(tenant);
  const durante = await env.mensagem(tenant, r.message.id);
  assert.equal(durante.delivery_status, 'QUEUED', 'com o WhatsApp fora a mensagem continua na fila');
  assert.equal(durante.external_message_id, null);
  assert.equal((await env.envioDe(tenant, r.dispatchId)).status === 'CONFIRMED', false);
  assert.ok(!['SENT', 'DELIVERED', 'READ'].includes(durante.delivery_status), 'nunca entregue sem evidência do fornecedor');
  // O canal volta: a fila é solta em ordem e só chega a SENT (a entrega ainda depende do evento do fornecedor).
  await env.recuperar(tenant, c.id);
  const volta = await env.ciclo(tenant);
  assert.equal(volta.deactivated >= 1, true);
  await env.rodarEnvios(tenant);
  const depois = await env.mensagem(tenant, r.message.id);
  assert.equal(depois.delivery_status, 'SENT');
  assert.equal(depois.delivered_at ?? null, null);
});

test('contingencia_whatsapp_alternativo_com_consentimento', async () => {
  const email = await env.e234.conectar(tenant);
  const c = await env.whatsapp(tenant, { contingencia: { alternate_connection_id: email.conn.id } });
  const com = await env.pessoa(tenant, { email: `cliente-${env.uniqueSuffix()}@qa-m9.test` });
  const sem = await env.pessoa(tenant, { email: `sem-${env.uniqueSuffix()}@qa-m9.test`, optIn: null });
  const recusado = await env.pessoa(tenant, { email: `optout-${env.uniqueSuffix()}@qa-m9.test`, optIn: null, optOut: 'ALL' });
  await env.derrubar(tenant, c.id);
  const a = await env.enviar(tenant, com, 'Sua visita foi confirmada para amanhã às 10h.');
  const b = await env.enviar(tenant, sem, 'Sua visita foi confirmada para amanhã às 10h.');
  const d = await env.enviar(tenant, recusado, 'Sua visita foi confirmada para amanhã às 10h.');
  const ciclo = await env.ciclo(tenant);
  assert.equal(ciclo.switched, 1, 'só quem autorizou o e-mail muda de canal');

  const ma = await env.mensagem(tenant, a.message.id);
  assert.equal(ma.alternate_channel, 'EMAIL', 'a conversa mostra "enviada por canal alternativo"');
  assert.equal(ma.delivery_status, 'CANCELLED');
  assert.match(ma.failure_reason, /canal alternativo/);
  assert.equal((await env.envioDe(tenant, a.dispatchId)).status, 'CANCELLED', 'o envio do WhatsApp principal foi cancelado');
  const enviados = await env.emails(tenant, a.message.id);
  assert.equal(enviados.length, 1);
  assert.deepEqual(enviados[0].to_addresses, [com.email]);
  assert.equal(enviados[0].id, ma.alternate_ref);
  assert.match(enviados[0].subject, /Uma mensagem para você/);
  const [envioEmail] = await env.sql(tenant, 'SELECT payload_snapshot FROM integration.dispatches WHERE id = :id', { id: enviados[0].dispatch_id });
  assert.match(JSON.stringify(envioEmail.payload_snapshot), /WhatsApp/, 'o texto é adaptado: avisa que o WhatsApp está fora');
  assert.match(JSON.stringify(envioEmail.payload_snapshot), /Sua visita foi confirmada/);

  for (const [m, quem] of [[b, sem], [d, recusado]]) {
    const linha = await env.mensagem(tenant, m.message.id);
    assert.equal(linha.delivery_status, 'QUEUED', 'sem consentimento a mensagem segue na fila');
    assert.equal(linha.alternate_channel, null);
    assert.equal((await env.emails(tenant, m.message.id)).length, 0, `nenhum e-mail para ${quem.email}`);
  }
  const messaging = require('../../../src/features/crm/messaging');
  for (const m of [b, d]) {
    await assert.rejects(env.comTenant(tenant, (t) => messaging.sendViaAlternateChannel(env.ctxDe(tenant), m.message.id, {}, t)), (e) => recusa(409, 'INTEGRATION_MESSAGING_NO_CONSENT_ALTERNATE')(e) && e.message === 'O contato não autorizou o canal alternativo.');
  }

  // O consentimento exigido é parâmetro: sem exigir OPT_IN explícito, só o opt-out bloqueia.
  await env.parametro(tenant, 'integration.whatsapp.alternate_requires_opt_in', false);
  const r = await env.comTenant(tenant, (t) => messaging.sendViaAlternateChannel(env.ctxDe(tenant), b.message.id, {}, t));
  assert.equal(r.alternateChannel, 'EMAIL');
  await assert.rejects(env.comTenant(tenant, (t) => messaging.sendViaAlternateChannel(env.ctxDe(tenant), d.message.id, {}, t)), recusa(409, 'INTEGRATION_MESSAGING_NO_CONSENT_ALTERNATE'));
  // Mensagem que não está mais na fila não segue por e-mail.
  await assert.rejects(env.comTenant(tenant, (t) => messaging.sendViaAlternateChannel(env.ctxDe(tenant), a.message.id, {}, t)), recusa(409, 'INTEGRATION_MESSAGING_ALTERNATE_NOT_APPLICABLE'));
});

test('contingencia_whatsapp_outro_fornecedor_marca_canal_alternativo_e_marketing_nao_usa', async () => {
  // Dois fornecedores ativos na família: a empresa escolhe o mais antigo como principal (regra de resolução do registro) e o outro fica de reserva.
  await env.parametro(tenant, 'integration.registry.domain_resolution', 'oldest_active');
  const c = await env.whatsapp(tenant);
  const alt = await env.whatsapp(tenant, { provider: 'messaging-alt-sandbox', manter: true });
  await env.definirPolitica(tenant, c.id, { alternate_connection_id: alt.id });
  const p = await env.pessoa(tenant);
  await env.consentir(tenant, p.id, 'OPT_IN', 'MARKETING');
  await env.derrubar(tenant, c.id);
  const essencial = await env.enviar(tenant, p, 'Aviso importante sobre o seu contrato.');
  const mkt = await env.enviar(tenant, p, 'Conheça as novidades do mês.', { purpose: 'MARKETING' });
  const ciclo = await env.ciclo(tenant);
  assert.equal(ciclo.switched, 1, 'só a essencial troca de fornecedor');
  const me = await env.mensagem(tenant, essencial.message.id);
  assert.equal(me.alternate_channel, 'messaging-alt-sandbox');
  assert.equal(me.connection_id, alt.id);
  assert.notEqual(me.dispatch_id, essencial.dispatchId, 'a mensagem aponta para o envio novo');
  assert.equal(me.delivery_status, 'QUEUED');
  const mm = await env.mensagem(tenant, mkt.message.id);
  assert.equal(mm.alternate_channel, null, 'marketing nunca usa o alternativo');
  assert.equal(mm.connection_id, c.id);
  assert.equal((await env.envioDe(tenant, mkt.dispatchId)).status, 'PENDING', 'o marketing aguarda na fila do principal');
  await env.rodarEnvios(tenant);
  const enviada = await env.mensagem(tenant, essencial.message.id);
  assert.equal(enviada.delivery_status, 'SENT', 'a essencial saiu pelo outro fornecedor');
  assert.ok(enviada.external_message_id);
  await env.restaurar(tenant, ['integration.registry.domain_resolution']);
});

test('contingencia_whatsapp_marketing_vence_e_cancela', async () => {
  const c = await env.whatsapp(tenant);
  const clientes = [];
  for (let i = 0; i < 3; i += 1) { const p = await env.pessoa(tenant); await env.consentir(tenant, p.id, 'OPT_IN', 'MARKETING'); clientes.push(p); }
  await env.derrubar(tenant, c.id);
  const mkt = await env.enviar(tenant, clientes[0], 'Promoção de aluguel só esta semana.', { purpose: 'MARKETING' });
  const mkt2 = await env.enviar(tenant, clientes[1], 'Promoção de aluguel só esta semana.', { purpose: 'MARKETING' });
  const essencial = await env.enviar(tenant, clientes[2], 'Precisamos confirmar a vistoria do seu imóvel.');
  await env.envelhecer(tenant, mkt.dispatchId, 25);
  await env.envelhecer(tenant, essencial.dispatchId, 25);
  await env.envelhecer(tenant, mkt2.dispatchId, 23); // ainda dentro do prazo
  const ciclo = await env.ciclo(tenant);
  assert.equal(ciclo.manualTasks, 1, 'só a essencial vira tarefa');
  const m1 = await env.mensagem(tenant, mkt.message.id);
  assert.equal(m1.delivery_status, 'CANCELLED', 'marketing vencido é cancelado, não vira tarefa');
  assert.match(m1.failure_reason, /marketing cancelada/);
  assert.equal((await env.envioDe(tenant, mkt.dispatchId)).status, 'CANCELLED');
  assert.equal((await env.mensagem(tenant, mkt2.message.id)).delivery_status, 'QUEUED', 'com 23 h o marketing ainda aguarda');
  await env.consumir(tenant, 'integration.contingency.manual_task');
  assert.equal((await env.tarefasDe(tenant, mkt.dispatchId)).length, 0, 'nenhuma tarefa para o marketing');
  assert.equal((await env.tarefasDe(tenant, mkt2.dispatchId)).length, 0);
  const tarefas = await env.tarefasDe(tenant, essencial.dispatchId);
  assert.equal(tarefas.length, 1);
  assert.match(tarefas[0].title, /^Ligar para o cliente QA-M9 Cliente/);
  assert.match(tarefas[0].description, /Ligar para o cliente QA-M9 Cliente .*; mensagem pendente: Precisamos confirmar a vistoria do seu imóvel\./);
  const [evento] = (await env.eventos(tenant, 'integration.contingency.manual_task')).filter((e) => e.payload_json.dispatchId === essencial.dispatchId);
  assert.ok(!JSON.stringify(evento.payload_json).includes('vistoria'), 'o evento do outbox leva só ids: o texto da mensagem fica na tarefa interna');
  assert.equal((await env.ciclo(tenant)).manualTasks, 0, 'repetir a rodada não gera outra tarefa');
});

test('contingencia_whatsapp_mensagem_vencida_na_janela_vira_modelo', async () => {
  await env.parametro(tenant, 'integration.whatsapp.expired_template_name', 'aviso_geral');
  const c = await env.whatsapp(tenant, { config: { templates: [env.modelo('aviso_geral', { variables: 1 })] } });
  const p = await env.pessoa(tenant);
  const r = await env.enviar(tenant, p, 'Segue o aviso sobre o seu atendimento.'); // janela aberta (1 h)
  await env.abrirJanela(tenant, p.id, 30); // a janela venceu enquanto a mensagem esperava
  await env.rodarEnvios(tenant);
  const m = await env.mensagem(tenant, r.message.id);
  assert.notEqual(m.dispatch_id, r.dispatchId, 'a mensagem passou a apontar para o envio do modelo');
  const novo = await env.envioDe(tenant, m.dispatch_id);
  assert.equal(novo.operation, 'sendTemplate');
  assert.equal((await env.envioDe(tenant, r.dispatchId)).status, 'CANCELLED');
  assert.equal(novo.connection_id, c.id);
  await env.rodarEnvios(tenant);
  assert.equal((await env.mensagem(tenant, r.message.id)).delivery_status, 'SENT');
  // Sem modelo configurado a mensagem vencida é cancelada com o motivo (e a pessoa liga para o cliente).
  await env.restaurar(tenant, ['integration.whatsapp.expired_template_name']);
  await env.abrirJanela(tenant, p.id, 1);
  const r2 = await env.enviar(tenant, p, 'Outro aviso importante.');
  await env.abrirJanela(tenant, p.id, 30);
  await env.rodarEnvios(tenant);
  const m2 = await env.mensagem(tenant, r2.message.id);
  assert.equal(m2.delivery_status, 'CANCELLED');
  assert.match(m2.failure_reason, /janela de 24 horas venceu/);
});
