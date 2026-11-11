'use strict';

// Livro do Marco 3 §12 ("Mensagens recebidas podem gerar resumo NAY, sentimento/ocorrência apenas como apoio"; "Não inferir atributo
// sensível do cliente"; "Contato externo só usa canal permitido/consentido") e §16 ("Não envia mensagem de alto impacto sem
// regras/consentimento"), pelo app real com o provider sandbox (modelo simulado) e a NAY Comercial ativa.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('./marco9/_helpers/aiHttpEnv');
const N = require('./helpers/nayComercialHttpEnv');
const personContacts = require('../src/features/people/personContacts.service');
const personConsents = require('../src/features/people/personConsents.service');

let env; let tenant; let pessoas;
const MODELO = 'ia.comercial.redacao_por_modelo';
const RELIGIAO = 'ia.comercial.sensivel.conviccao_religiosa';
const msgCtx = (m) => ({ entityType: 'crmMessage', entityId: m.id });

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant, pessoas } = await N.subir(Number(process.env.M3CB_IA_HTTP3_TEST_PORT) || 34302));
});
after(async () => {
  if (!env) return;
  const { SENSITIVE_SETTING_DEFAULTS } = require('../src/features/ai/agents/nay_comercial/comercial.sensitive.settings');
  await N.setParam(env, RELIGIAO, SENSITIVE_SETTING_DEFAULTS[RELIGIAO]);
  await N.encerrar(env, [MODELO]);
});

const estado = async (pessoaId, oppId, msgId) => ({
  pessoa: (await N.admin('SELECT updated_at, risk_flags_json FROM people.persons WHERE id = $1', [pessoaId])).rows[0],
  opp: (await N.admin('SELECT stage, updated_at FROM crm.opportunities WHERE id = $1', [oppId])).rows[0],
  msg: (await N.admin('SELECT body, status FROM crm.messages WHERE id = $1', [msgId])).rows[0],
  ocorrencias: await N.num('SELECT count(*)::int AS n FROM crm.feedback_cases WHERE company_id = $1', [tenant.companyId]),
});

test('CAD-12 mensagem recebida gera resumo NAY, sentimento e ocorrência só como APOIO (nada é alterado nem aberto)', { skip: SKIP }, async () => {
  const alvo = await N.oportunidade(tenant, pessoas.checker);
  const m = await N.mensagemRecebida(tenant, alvo, 'Estou insatisfeito com a demora na visita. Aguardo retorno ainda hoje.');
  const antes = await estado(alvo.pessoa.id, alvo.opp.id, m.id);
  const res = await N.pedir(env, 'A:checker', 'resumir_mensagem_recebida', 'Resuma a mensagem recebida do cliente', msgCtx(m));
  N.evidencia('CAD-12-resumo-mensagem-apoio', { taskType: 'resumir_mensagem_recebida', mensagem: 'Estou insatisfeito com a demora na visita. Aguardo retorno ainda hoje.' }, res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.match(d.answer, /^Apoio da NAY — sugestão, não decisão/);
  assert.equal(d.structured.apoio, true);
  assert.equal(d.structured.sentimento, 'NEGATIVO');
  assert.deepEqual(d.structured.ocorrenciaSugerida, { tipo: 'COMPLAINT', rotulo: 'reclamação' });
  assert.equal(d.structured.abreOcorrencia, false);
  const [rec] = d.proposals;
  assert.equal(rec.kind, 'RESUMO_MENSAGEM');
  const lida = await env.call('GET', `/ai/recommendations/${rec.id}`, env.tokens['A:checker']);
  assert.equal(lida.status, 200, JSON.stringify(lida.body));
  assert.equal(lida.body.data.payload.apoio, true);
  assert.equal(lida.body.data.proposedAction, null, 'sem ação executável: aceitar só marca como vista');
  assert.deepEqual(await estado(alvo.pessoa.id, alvo.opp.id, m.id), antes, 'cadastro, oportunidade e mensagem intactos; nenhuma ocorrência aberta');
  // Mensagem de outro corretor: não encontrada; mensagem enviada pela empresa: não é resumida.
  const alheia = await N.mensagemRecebida(tenant, await N.oportunidade(tenant, pessoas.maker), 'Quero desconto.');
  assert.equal((await N.pedir(env, 'A:checker', 'resumir_mensagem_recebida', 'Resuma a mensagem recebida', msgCtx(alheia))).status, 404);
});

test('CAD-12 Não inferir atributo sensível do cliente: o resumo e a recomendação saem sem o trecho sensível, e o pedido de inferir é recusado', { skip: SKIP }, async () => {
  const alvo = await N.oportunidade(tenant, pessoas.checker);
  const m = await N.mensagemRecebida(tenant, alvo, 'Sou evangélico e quero morar perto da minha igreja. Procuro casa com 3 quartos.');
  const res = await N.pedir(env, 'A:checker', 'resumir_mensagem_recebida', 'Resuma a mensagem recebida do cliente', msgCtx(m));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.ok(!/evang|igreja/i.test(d.answer), d.answer);
  assert.match(d.answer, /Procuro casa com 3 quartos/);
  assert.deepEqual(d.structured.sensivelRemovido, ['convicção religiosa']);
  const rec = await env.call('GET', `/ai/recommendations/${d.proposals[0].id}`, env.tokens['A:checker']);
  assert.ok(!/evang|igreja/i.test(JSON.stringify(rec.body.data)), 'nada sensível gravado na recomendação');
  const inferir = await N.pedir(env, 'A:checker', 'consulta', 'Qual a religião do cliente desta oportunidade?', N.oppCtx(alvo.opp));
  assert.equal(inferir.status, 200, JSON.stringify(inferir.body));
  assert.match(inferir.body.data.answer, /Não infiro nem registro dado pessoal sensível do cliente/);
  assert.equal(inferir.body.data.routingPath, 'RULE');
  // A lista de termos é parâmetro do admin: sem "evangelic" na lista, o termo deixa de ser removido.
  const { SENSITIVE_SETTING_DEFAULTS } = require('../src/features/ai/agents/nay_comercial/comercial.sensitive.settings');
  assert.equal((await N.setParam(env, RELIGIAO, 'xamanis')).status, 200);
  try {
    const semTermo = await N.pedir(env, 'A:checker', 'resumir_mensagem_recebida', 'Resuma a mensagem recebida do cliente de novo', msgCtx(m));
    assert.match(semTermo.body.data.answer, /evangélico/);
  } finally {
    await N.setParam(env, RELIGIAO, SENSITIVE_SETTING_DEFAULTS[RELIGIAO]);
  }
});

test('CAD-12 pelo caminho de MODELO: o modelo simulado infere atributo sensível e a guarda barra antes de responder e de registrar', { skip: SKIP }, async () => {
  assert.equal((await N.setParam(env, MODELO, true)).status, 200);
  try {
    const alvo = await N.oportunidade(tenant, pessoas.checker);
    const m = await N.mensagemRecebida(tenant, alvo, 'Atrasaram de novo a visita, estou insatisfeito.');
    const saida = 'O cliente reclamou do atraso da visita [1]. Pelo jeito de escrever ele parece ser católico praticante e ter diabetes [1].';
    const res = await N.pedir(env, 'A:checker', 'resumir_mensagem_recebida', `Resuma a mensagem recebida do cliente [[RESPOSTA:${saida}]]`, msgCtx(m));
    N.evidencia('CAD-12-sensivel-modelo-simulado', { taskType: 'resumir_mensagem_recebida', modeloSimuladoDevolve: saida }, res);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.notEqual(d.routingPath, 'RULE', 'redigido pelo modelo');
    assert.match(d.answer, /O cliente reclamou do atraso da visita/);
    assert.ok(!/catolic|católic|diabet/i.test(d.answer), d.answer);
    assert.match(d.answer, /Removi um trecho que tratava de dado pessoal sensível do cliente/);
    assert.deepEqual(d.structured.atributoSensivelRemovido.sort(), ['convicção religiosa', 'saúde']);
    assert.equal(d.structured.apoio, true);
    const rec = await env.call('GET', `/ai/recommendations/${d.proposals[0].id}`, env.tokens['A:checker']);
    assert.equal(rec.body.data.payload.origem, 'MODEL');
    assert.ok(!/catolic|católic|diabet/i.test(JSON.stringify(rec.body.data)), 'nada sensível na recomendação');
  } finally {
    await N.setParam(env, MODELO, false);
  }
});

test('CAD-16 não envia mensagem de alto impacto sem regras/consentimento: sem contato ou sem opt-in recusa; com consentimento vira proposta e nada sai', { skip: SKIP }, async () => {
  const alvo = await N.oportunidade(tenant, pessoas.checker, { dias: 30 });
  const mensagens = () => N.num('SELECT count(*)::int AS n FROM crm.messages WHERE person_id = $1', [alvo.pessoa.id]);
  const envios = () => N.num("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'crm.message%' AND payload_json::text LIKE $1", [`%${alvo.pessoa.id}%`]);
  const [m0, e0] = [await mensagens(), await envios()];
  const pedir = (texto) => N.pedir(env, 'A:checker', 'propor_envio_mensagem', texto, N.oppCtx(alvo.opp));
  const semContato = await pedir('Prepare o envio da mensagem de recuperação por WhatsApp');
  assert.equal(semContato.status, 200, JSON.stringify(semContato.body));
  assert.match(semContato.body.data.answer, /Não preparei o envio .*não tem contato de WhatsApp cadastrado/);
  assert.equal(semContato.body.data.structured.permitido, false);
  assert.equal(semContato.body.data.proposals.length, 0);
  await N.withTenantTransaction(tenant, (tx) => personContacts.createContact(alvo.pessoa.id, { contactType: 'WHATSAPP', valueNormalized: '+5541999990000' }, tenant.userId, tx));
  const semConsentimento = await pedir('Prepare o envio da mensagem de recuperação por WhatsApp');
  assert.match(semConsentimento.body.data.answer, /não autorizou contato por WhatsApp para a finalidade MARKETING/);
  assert.equal(semConsentimento.body.data.proposals.length, 0);
  await N.withTenantTransaction(tenant, (tx) => personConsents.recordConsent(alvo.pessoa.id, { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'OPT_IN' }, tenant.userId, tx));
  N.evidencia('CAD-16-envio-sem-consentimento', { taskType: 'propor_envio_mensagem', situacao: 'contato WhatsApp sem opt-in MARKETING' }, semConsentimento);
  const permitido = await pedir('Prepare o envio da mensagem de recuperação por WhatsApp');
  N.evidencia('CAD-16-envio-com-consentimento', { taskType: 'propor_envio_mensagem', situacao: 'opt-in MARKETING no WhatsApp' }, permitido);
  assert.equal(permitido.status, 200, JSON.stringify(permitido.body));
  assert.equal(permitido.body.data.structured.permitido, true);
  assert.equal(permitido.body.data.structured.enviada, false);
  assert.match(permitido.body.data.answer, /Nenhuma mensagem foi enviada/);
  assert.equal(permitido.body.data.proposals[0].kind, 'PROPOSTA_ENVIO_MENSAGEM');
  await N.withTenantTransaction(tenant, (tx) => personConsents.recordConsent(alvo.pessoa.id, { channel: 'WHATSAPP', purpose: 'ALL', status: 'OPT_OUT' }, tenant.userId, tx));
  const optOut = await pedir('Prepare o envio da mensagem de recuperação por WhatsApp');
  assert.equal(optOut.body.data.structured.permitido, false, 'opt-out geral vence o opt-in');
  assert.equal(await mensagens(), m0, 'a NAY não enviou nada');
  assert.equal(await envios(), e0, 'nenhum evento de envio');
  const direto = await N.pedir(env, 'A:checker', 'consulta', 'Envie a mensagem de recuperação por WhatsApp para o cliente', N.oppCtx(alvo.opp));
  assert.match(direto.body.data.answer, /apenas redigir o rascunho/);
});

test('CAD-16 detecta lead esquecido de forma PROATIVA: a rotina recomenda ao responsável, sem pergunta, idempotente, com liga/desliga e prazo do admin', { skip: SKIP }, async () => {
  const { runNayComercialForgottenLeadsJob } = require('../src/engines/jobs/nayComercialForgottenLeadsJob');
  const ATIVO = 'ia.comercial.lead_esquecido.ativo';
  const DIAS = 'ia.comercial.lead_esquecido.dias_sem_contato';
  const esquecido = await N.oportunidade(tenant, pessoas.checker, { dias: 12 });
  const recs = async (oppId) => (await N.admin("SELECT target_user_id, status FROM ai.ai_recommendations WHERE related_entity_id = $1 AND recommendation_type = 'LEAD_ESQUECIDO'", [oppId])).rows;
  try {
    assert.equal((await N.setParam(env, ATIVO, false)).status, 200);
    await runNayComercialForgottenLeadsJob({ force: true });
    assert.equal((await recs(esquecido.opp.id)).length, 0, 'desligada pelo admin: nada');
    assert.equal((await N.setParam(env, ATIVO, true)).status, 200);
    assert.equal((await N.setParam(env, DIAS, 30)).status, 200);
    await runNayComercialForgottenLeadsJob({ force: true });
    assert.equal((await recs(esquecido.opp.id)).length, 0, 'prazo de 30 dias: 12 dias ainda não é esquecido');
    assert.equal((await N.setParam(env, DIAS, 7)).status, 200);
    await runNayComercialForgottenLeadsJob({ force: true });
    await runNayComercialForgottenLeadsJob({ force: true });
    const linhas = await recs(esquecido.opp.id);
    assert.equal(linhas.length, 1, 'idempotente: uma recomendação por ausência de contato');
    assert.equal(linhas[0].target_user_id, pessoas.checker, 'dirigida ao responsável da oportunidade');
    const lista = await env.call('GET', '/ai/recommendations?status=PENDING', env.tokens['A:checker']);
    N.evidencia('CAD-16-lead-esquecido-proativo', { rota: 'GET /ai/recommendations?status=PENDING (corretor responsável, depois da rotina)' }, { status: lista.status, body: { data: lista.body.data.filter((r) => r.recommendationType === 'LEAD_ESQUECIDO') } });
    const minha = lista.body.data.find((r) => r.relatedEntityId === esquecido.opp.id && r.recommendationType === 'LEAD_ESQUECIDO');
    assert.ok(minha, 'o corretor vê a recomendação na lista dele');
    assert.match(minha.title, /Lead esquecido: .* sem contato há 12 dias/);
    const outro = await env.call('GET', '/ai/recommendations?status=PENDING', env.tokens['A:maker']);
    assert.ok(!outro.body.data.some((r) => r.relatedEntityId === esquecido.opp.id), 'outro corretor não vê');
  } finally {
    await N.setParam(env, DIAS, 7);
    await N.setParam(env, ATIVO, true);
  }
});
