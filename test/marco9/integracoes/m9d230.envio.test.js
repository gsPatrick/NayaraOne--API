'use strict';

// Marco 9, M9-D230 — WhatsApp: janela de atendimento e modelos, consentimento no enfileiramento e no envio, opt-out por palavra-chave e cancelamento do que já estava na fila.
// Banco descartável (os testes COMMITAM). Os nomes dos testes são os da seção 8 da demanda.
process.env.PORT = process.env.M9D230_ENVIO_PORT || '21301';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d230Env');

let tenant;
const CHAVES = ['integration.whatsapp.session_window_h', 'integration.whatsapp.optout_keywords', 'integration.whatsapp.transactional_requires_opt_in'];
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
afterEach(async () => { await env.restaurar(tenant, CHAVES); });
after(async () => { await env.pausar(tenant); await env.sequelize.close(); process.exit(0); });

const texto = (p, extra = {}) => ({ kind: 'text', personId: p.id, to: p.phone, text: 'Olá, tudo bem?', semJanela: true, ...extra });
const modeloMsg = (p, extra = {}) => ({ kind: 'template', personId: p.id, to: p.phone, templateName: 'aviso_visita', language: 'pt_BR', templateVars: ['Ana', '10h'], ...extra });
const recusa = (status, code) => (e) => e.statusCode === status && e.code === code;

test('whatsapp_fora_da_janela_exige_template', async () => {
  await env.conectarComModelos(tenant, [env.modelo('aviso_visita')]);
  const p = await env.pessoa(tenant);
  // O cliente escreveu há 24,5 h: texto livre é recusado, sem gravar nada, e a mensagem diz o que fazer.
  await env.abrirJanela(tenant, p.id, 24.5);
  const antes = await env.contagem(tenant, p.id);
  await assert.rejects(env.enviarMensagem(tenant, texto(p)), (e) => recusa(422, 'INTEGRATION_MESSAGING_OUTSIDE_SESSION_WINDOW')(e) && e.message === 'Fora da janela de 24 horas: use um modelo aprovado.');
  assert.deepEqual(await env.contagem(tenant, p.id), antes, 'nada é enfileirado');
  // Mídia também é conteúdo livre: segue a mesma regra.
  const foto = await env.arquivo(tenant);
  await assert.rejects(env.enviarMensagem(tenant, { kind: 'media', personId: p.id, to: p.phone, mediaRef: foto.id, semJanela: true }), recusa(422, 'INTEGRATION_MESSAGING_OUTSIDE_SESSION_WINDOW'));
  // Modelo aprovado envia fora da janela e dentro dela; texto dentro da janela (às 09:00, cliente escreveu às 08:00) também.
  assert.equal((await env.enviarMensagem(tenant, modeloMsg(p))).status, 'QUEUED');
  await env.abrirJanela(tenant, p.id, 1);
  assert.equal((await env.enviarMensagem(tenant, modeloMsg(p))).status, 'QUEUED');
  assert.equal((await env.enviarMensagem(tenant, texto(p))).status, 'QUEUED');
  // Quem nunca escreveu não tem janela.
  const novo = await env.pessoa(tenant);
  await assert.rejects(env.enviarMensagem(tenant, texto(novo)), recusa(422, 'INTEGRATION_MESSAGING_OUTSIDE_SESSION_WINDOW'));
  // A duração da janela é parâmetro da empresa (padrão 24 h).
  await env.abrirJanela(tenant, novo.id, 30);
  await env.parametro(tenant, 'integration.whatsapp.session_window_h', 48);
  assert.equal((await env.enviarMensagem(tenant, texto(novo))).status, 'QUEUED', '30 h cabem numa janela de 48 h');
  await env.parametro(tenant, 'integration.whatsapp.session_window_h', 12);
  await env.abrirJanela(tenant, novo.id, 13);
  await assert.rejects(env.enviarMensagem(tenant, texto(novo)), recusa(422, 'INTEGRATION_MESSAGING_OUTSIDE_SESSION_WINDOW'));
  // Uma mensagem recebida do cliente reabre a janela (webhook assinado).
  const canal = await env.conectarComModelos(tenant, []);
  await env.enviar(canal, env.inboundA(`in-${env.uniqueSuffix()}`, novo.phone, 'Oi'));
  await env.rodar(tenant);
  assert.equal((await env.enviarMensagem(tenant, texto(novo))).status, 'QUEUED', 'mensagem recebida abre a janela');
});

test('whatsapp_template_variaveis_conferem', async () => {
  await env.conectarComModelos(tenant, [env.modelo('aviso_visita', { variables: 2 }), env.modelo('rascunho', { approved: false })]);
  const p = await env.pessoa(tenant);
  const antes = await env.contagem(tenant, p.id);
  await assert.rejects(env.enviarMensagem(tenant, modeloMsg(p, { templateVars: ['só um'] })), (e) => recusa(422, 'INTEGRATION_MESSAGING_TEMPLATE_VARIABLES_MISMATCH')(e) && e.message === 'O número de variáveis não confere com o modelo.');
  await assert.rejects(env.enviarMensagem(tenant, modeloMsg(p, { templateVars: undefined })), recusa(422, 'INTEGRATION_MESSAGING_TEMPLATE_VARIABLES_MISMATCH'));
  await assert.rejects(env.enviarMensagem(tenant, modeloMsg(p, { templateVars: ['a', 'b', 'c'] })), recusa(422, 'INTEGRATION_MESSAGING_TEMPLATE_VARIABLES_MISMATCH'));
  assert.deepEqual(await env.contagem(tenant, p.id), antes);
  // Modelo que o fornecedor não aprovou (ou que não existe) não sai.
  await assert.rejects(env.enviarMensagem(tenant, modeloMsg(p, { templateName: 'rascunho' })), recusa(422, 'INTEGRATION_MESSAGING_TEMPLATE_NOT_APPROVED'));
  await assert.rejects(env.enviarMensagem(tenant, modeloMsg(p, { templateName: 'nao_existe' })), recusa(422, 'INTEGRATION_MESSAGING_TEMPLATE_NOT_APPROVED'));
  const ok = await env.enviarMensagem(tenant, modeloMsg(p));
  await env.rodarEnvios(tenant);
  const m = await env.mensagem(tenant, ok.message.id);
  assert.equal(m.delivery_status, 'SENT', 'o modelo aprovado com as variáveis certas chega ao fornecedor');
});

test('whatsapp_sem_consentimento_bloqueia', async () => {
  await env.conectarComModelos(tenant, [env.modelo('aviso_visita')]);
  const p = await env.pessoa(tenant);
  await env.abrirJanela(tenant, p.id, 1);
  // Revogado: 403, nada enfileirado.
  await env.consentir(tenant, p.id, 'OPT_OUT');
  const antes = await env.contagem(tenant, p.id);
  await assert.rejects(env.enviarMensagem(tenant, texto(p, { semJanela: false })), (e) => recusa(403, 'INTEGRATION_MESSAGING_NO_CONSENT')(e) && e.message === 'O contato não autorizou receber mensagens por este canal.');
  await assert.rejects(env.enviarMensagem(tenant, modeloMsg(p)), recusa(403, 'INTEGRATION_MESSAGING_NO_CONSENT'));
  assert.deepEqual(await env.contagem(tenant, p.id), antes);
  // Marketing exige o consentimento de marketing; o transacional não vale por ele.
  const q = await env.pessoa(tenant);
  await env.abrirJanela(tenant, q.id, 1);
  await env.consentir(tenant, q.id, 'OPT_IN', 'TRANSACTIONAL');
  await assert.rejects(env.enviarMensagem(tenant, texto(q, { semJanela: false, purpose: 'MARKETING' })), recusa(403, 'INTEGRATION_MESSAGING_NO_CONSENT'));
  await env.consentir(tenant, q.id, 'OPT_IN', 'MARKETING');
  assert.equal((await env.enviarMensagem(tenant, texto(q, { semJanela: false, purpose: 'MARKETING' }))).status, 'QUEUED');
  // Sem pessoa identificada não há como provar consentimento de marketing.
  await assert.rejects(env.enviarMensagem(tenant, { kind: 'template', to: q.phone, templateName: 'aviso_visita', templateVars: ['a', 'b'], purpose: 'MARKETING' }), recusa(403, 'INTEGRATION_MESSAGING_NO_CONSENT'));
  // Parâmetro: com o transacional exigindo consentimento explícito, quem nunca consentiu é recusado; com o consentimento, envia.
  const r = await env.pessoa(tenant);
  await env.abrirJanela(tenant, r.id, 1);
  assert.equal((await env.enviarMensagem(tenant, texto(r, { semJanela: false }))).status, 'QUEUED', 'padrão: o transacional sem registro de consentimento sai');
  await env.parametro(tenant, 'integration.whatsapp.transactional_requires_opt_in', true);
  await assert.rejects(env.enviarMensagem(tenant, texto(r, { semJanela: false })), recusa(403, 'INTEGRATION_MESSAGING_NO_CONSENT'));
  await env.consentir(tenant, r.id, 'OPT_IN', 'TRANSACTIONAL');
  assert.equal((await env.enviarMensagem(tenant, texto(r, { semJanela: false }))).status, 'QUEUED');
});

test('whatsapp_optout_por_palavra_chave_revoga_consentimento', async () => {
  const canal = await env.conectarComModelos(tenant, [env.modelo('aviso_visita')]);
  const p = await env.pessoa(tenant);
  const inbound = async (corpo) => { await env.enviar(canal, env.inboundA(`in-${env.uniqueSuffix()}`, p.phone, corpo)); await env.rodar(tenant); };
  // Frase que apenas contém a palavra não é opt-out.
  await inbound('quero parar de ver esse imóvel e ver outro');
  assert.equal(await env.consentimentoAtual(tenant, p.id, 'ALL'), undefined);
  // A palavra sozinha (qualquer caixa, com espaços e pontuação) revoga o canal imediatamente.
  await inbound('  Parar. ');
  assert.equal((await env.consentimentoAtual(tenant, p.id, 'ALL')).status, 'OPT_OUT');
  const [aud] = await env.sql(tenant, "SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'crm.message.optout_keyword' AND company_id = :c", { c: tenant.companyId });
  assert.ok(aud.n >= 1, 'a revogação fica na auditoria');
  await env.abrirJanela(tenant, p.id, 1);
  await assert.rejects(env.enviarMensagem(tenant, texto(p, { semJanela: false })), recusa(403, 'INTEGRATION_MESSAGING_NO_CONSENT'));
  await assert.rejects(env.enviarMensagem(tenant, modeloMsg(p, { purpose: 'MARKETING' })), recusa(403, 'INTEGRATION_MESSAGING_NO_CONSENT'));
  // A interação do cliente continua registrada (ele pode falar com a empresa).
  assert.equal((await env.mensagensDa(tenant, p.id)).filter((m) => m.direction === 'INBOUND').length, 2);
  // As palavras são parâmetro da empresa.
  const q = await env.pessoa(tenant);
  await env.parametro(tenant, 'integration.whatsapp.optout_keywords', 'BASTA, Chega');
  await env.enviar(canal, env.inboundA(`in-${env.uniqueSuffix()}`, q.phone, 'PARAR'));
  await env.rodar(tenant);
  assert.equal(await env.consentimentoAtual(tenant, q.id, 'ALL'), undefined, 'PARAR deixou de ser palavra de saída');
  await env.enviar(canal, env.inboundA(`in-${env.uniqueSuffix()}`, q.phone, 'chega'));
  await env.rodar(tenant);
  assert.equal((await env.consentimentoAtual(tenant, q.id, 'ALL')).status, 'OPT_OUT');
});

test('whatsapp_optout_cancela_itens_na_fila', async () => {
  await env.conectarComModelos(tenant, [env.modelo('aviso_visita')]);
  const p = await env.pessoa(tenant);
  const a = await env.enviarMensagem(tenant, texto(p, { semJanela: false }));
  const b = await env.enviarMensagem(tenant, modeloMsg(p));
  const outra = await env.pessoa(tenant);
  const c = await env.enviarMensagem(tenant, texto(outra, { semJanela: false }));
  // O contato pede para sair DEPOIS de a mensagem entrar na fila.
  await env.consentir(tenant, p.id, 'OPT_OUT', 'ALL');
  await env.rodarEnvios(tenant);
  for (const r of [a, b]) {
    const m = await env.mensagem(tenant, r.message.id);
    assert.equal((await env.envioDe(tenant, r.dispatchId)).status, 'CANCELLED', 'o envio é cancelado, não falha');
    assert.equal(m.delivery_status, 'CANCELLED');
    assert.equal(m.external_message_id, null, 'o fornecedor nunca recebeu');
    assert.match(m.failure_reason, /revog|optou|autoriz/i, 'motivo em português');
  }
  assert.equal((await env.mensagem(tenant, c.message.id)).delivery_status, 'SENT', 'quem não saiu continua recebendo');
  const [aud] = await env.sql(tenant, "SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'crm.message.cancelled_no_consent' AND entity_id IN (:ids)", { ids: [a.message.id, b.message.id] });
  assert.equal(aud.n, 2, 'evento de auditoria por item cancelado');
  // Cancelado não é tentado de novo.
  await env.rodarEnvios(tenant);
  assert.equal((await env.envioDe(tenant, a.dispatchId)).status, 'CANCELLED');
  assert.equal((await env.envioDe(tenant, a.dispatchId)).attempts, 0, 'nenhuma tentativa gasta');
});
