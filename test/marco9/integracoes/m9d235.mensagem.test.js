'use strict';

// Marco 9, M9-D235 — e-mail recebido: dado pessoal mascarado e restrito, cartão redigido, sem vínculo fica não vinculado sem criar processo, duplicado ignorado. Banco descartável.
process.env.PORT = process.env.M9D235_MENSAGEM_PORT || '24236';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d235Env');
const inbound = require('../../../src/features/integrations/email/inbound');

let tenant;
let desligarCofre;
let canal;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  canal = await env.conectar(tenant);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

test('inbound_pii_mascarada_e_restrita', async () => {
  const { externalId } = await env.receber(canal, tenant, { subject: 'CPF 123.456.789-09 para o contrato', text: 'Meu CPF é 123.456.789-09 e o CNPJ 11.222.333/0001-81.' });
  const m = await env.mensagemIn(tenant, externalId);
  assert.equal(m.contains_pii, true);
  assert.ok(m.pii_types.includes('CPF') && m.pii_types.includes('CNPJ'));
  assert.ok(m.body_masked.includes('***.456.789-**'));
  assert.equal(/123\.456\.789-09|11\.222\.333\/0001-81/.test(m.body_masked + m.subject), false, 'o dado pessoal original nunca é guardado');
  // Restrita ao papel autorizado: sem a permissão a mensagem com dado pessoal nem aparece na lista, e o detalhe é 403.
  const semPii = await env.comTenant(tenant, (t) => inbound.listInboundMessages(env.ctxDe(tenant), { canReadPii: false }, t));
  assert.equal(semPii.items.some((x) => x.id === m.id), false);
  await assert.rejects(env.comTenant(tenant, (t) => inbound.getInboundMessage(env.ctxDe(tenant), m.id, { canReadPii: false }, t)), (e) => e.statusCode === 403 && e.code === 'INTEGRATION_EMAIL_INBOUND_PII_RESTRICTED');
  const comPii = await env.comTenant(tenant, (t) => inbound.getInboundMessage(env.ctxDe(tenant), m.id, { canReadPii: true }, t));
  assert.equal(comPii.containsPii, true);
});

test('inbound_pan_cartao_redigido', async () => {
  const { externalId } = await env.receber(canal, tenant, { text: 'Meu cartão é 4111 1111 1111 1111 validade 12/30.' });
  const m = await env.mensagemIn(tenant, externalId);
  assert.equal(m.pan_redacted, true);
  assert.equal(m.contains_pii, true);
  assert.equal(m.body_masked.includes('4111'), false);
  assert.match(m.body_masked, /removido/i, 'o corpo inteiro foi redigido');
  const alertas = await env.erros(tenant, 'email-sandbox', 'INTEGRATION_EMAIL_INBOUND_CARD_NUMBER');
  assert.ok(alertas.length >= 1, 'alerta de integração aberto');
  // Número com 16 dígitos que NÃO passa no Luhn não é cartão.
  const { externalId: outro } = await env.receber(canal, tenant, { text: 'Protocolo 4111 1111 1111 1112 do banco.' });
  assert.equal((await env.mensagemIn(tenant, outro)).pan_redacted, false);
});

test('inbound_sem_vinculo_fica_nao_vinculado_sem_criar_processo', async () => {
  const antes = await env.sql(tenant, 'SELECT (SELECT count(*) FROM correspondent.financing_cases WHERE company_id = :c)::int AS casos, (SELECT count(*) FROM integration.email_messages WHERE company_id = :c)::int AS saida', { c: tenant.companyId });
  const { externalId } = await env.receber(canal, tenant, { subject: 'Oi, tudo bem?' });
  const m = await env.mensagemIn(tenant, externalId);
  assert.equal(m.link_status, 'UNLINKED');
  assert.equal(m.linked_entity_id, null);
  const lista = await env.comTenant(tenant, (t) => inbound.listInboundMessages(env.ctxDe(tenant), { canReadPii: false, linkStatus: 'UNLINKED' }, t));
  assert.ok(lista.items.some((x) => x.id === m.id), 'visível ao papel autorizado como não vinculada');
  const depois = await env.sql(tenant, 'SELECT (SELECT count(*) FROM correspondent.financing_cases WHERE company_id = :c)::int AS casos, (SELECT count(*) FROM integration.email_messages WHERE company_id = :c)::int AS saida', { c: tenant.companyId });
  assert.deepEqual(depois[0], antes[0], 'nenhum processo nem mensagem de saída nasceu');
  // Referência inexistente no assunto também não vincula e não cria nada.
  const { externalId: ref } = await env.receber(canal, tenant, { subject: 'Re: [PROC-999999] comprovante' });
  assert.equal((await env.mensagemIn(tenant, ref)).link_status, 'UNLINKED');
  // Vínculo explícito do operador.
  const ligada = await env.comTenant(tenant, (t) => inbound.linkInboundMessage(env.ctxDe(tenant), m.id, { entityType: 'FINANCING_CASE', entityId: '1234' }, t));
  assert.equal(ligada.linkStatus, 'LINKED');
  assert.equal(ligada.linkKind, 'MANUAL');
});

test('inbound_vinculo_por_assunto_e_por_resposta', async () => {
  const enviada = await env.enviarEEntregarAoProvedor(tenant, { origin: { type: 'RENTAL_CONTRACT', id: `ctr-${env.uniqueSuffix()}` } });
  const originId = enviada.message.origin_id;
  const { externalId: porRef } = await env.receber(canal, tenant, { subject: `Re: [PROC-${originId}] segue o comprovante` });
  const a = await env.mensagemIn(tenant, porRef);
  assert.deepEqual([a.link_status, a.link_kind, a.linked_entity_type, a.linked_entity_id], ['LINKED', 'REFERENCE', 'RENTAL_CONTRACT', originId]);
  const { externalId: porResposta } = await env.receber(canal, tenant, { subject: 'Resposta', inReplyTo: `<${enviada.message.external_message_id}@mail.qa-m9.test>` });
  const b = await env.mensagemIn(tenant, porResposta);
  assert.deepEqual([b.link_status, b.link_kind, b.linked_entity_id, b.linked_email_message_id], ['LINKED', 'REPLY', originId, enviada.message.id]);
});

test('inbound_duplicado_ignorado', async () => {
  const msg = env.recebido({ attachments: [env.pdfLimpo()] });
  for (let i = 0; i < 3; i += 1) {
    await env.enviar(canal, { ...msg, id: `evt-dup-${env.uniqueSuffix()}` });
    await env.rodar(tenant);
  }
  const linhas = await env.sql(tenant, 'SELECT id FROM integration.email_inbound_messages WHERE company_id = :c AND external_message_id = :x', { c: tenant.companyId, x: msg.message.id });
  assert.equal(linhas.length, 1, 'uma só mensagem');
  const anexos = await env.anexosIn(tenant, linhas[0].id);
  assert.equal(anexos.length, 1, 'o anexo entrou uma só vez');
});
