'use strict';

// Livro do Marco 3 §16 "NAY Comercial" e §2 "NAY sugere, resume, classifica e detecta falhas", pelo app real (POST /ai/runs, agente ATIVO,
// provider sandbox) com dois corretores de carteira própria. Cada teste diz a regra do livro que prova.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('./marco9/_helpers/aiHttpEnv');
const N = require('./helpers/nayComercialHttpEnv');

let env; let tenant; let pessoas;
const PARAMS = ['ia.comercial.cadastro.documentos_pf'];

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant, pessoas } = await N.subir(Number(process.env.M3CB_IA_HTTP_TEST_PORT) || 34300));
});
after(async () => { if (env) { await N.setParam(env, PARAMS[0], 'RG|CIN|CNH|RG_CPF'); await N.encerrar(env); } });

test('CAD-16 NAY Comercial resume o histórico antes do contato: agente ativo, resumo com fonte e carimbo de tempo', { skip: SKIP }, async () => {
  const { opp, pessoa } = await N.oportunidade(tenant, pessoas.checker, { dias: 3 });
  await N.mensagemRecebida(tenant, { pessoa, opp }, 'Gostaria de visitar o imóvel no sábado.');
  const res = await N.pedir(env, 'A:checker', 'resumir_oportunidade', 'Resuma o histórico desta oportunidade antes do contato', N.oppCtx(opp));
  N.evidencia('CAD-16-resumo', { taskType: 'resumir_oportunidade' }, res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.status, 'COMPLETED');
  assert.equal(d.routingPath, 'RULE');
  assert.match(d.answer, /Resumo da oportunidade de QA-M3CB Cliente/);
  assert.equal(d.structured.cliente, pessoa.legalName);
  assert.ok(d.structured.ultimaInteracaoEm, 'a última interação vem do histórico');
  assert.deepEqual(d.sources.map((s) => s.title), ['crm.opportunities', 'crm.interactions']);
  assert.ok(d.snapshotAt);
});

test('CAD-16 NAY Comercial sugere próxima ação (recomendação ao corretor) e próximos imóveis do Radar', { skip: SKIP }, async () => {
  const { opp } = await N.oportunidade(tenant, pessoas.checker, { dias: 10 });
  const acao = await N.pedir(env, 'A:checker', 'sugerir_proxima_acao', 'Qual a próxima ação desta oportunidade?', N.oppCtx(opp));
  N.evidencia('CAD-16-proxima-acao', { taskType: 'sugerir_proxima_acao' }, acao);
  assert.equal(acao.status, 200, JSON.stringify(acao.body));
  assert.match(acao.body.data.answer, /Retomar contato/);
  assert.equal(acao.body.data.proposals[0].kind, 'NEXT_ACTION');
  const radar = await N.pedir(env, 'A:checker', 'listar_imoveis_radar', 'Liste os imóveis do radar para esta oportunidade', N.oppCtx(opp));
  assert.equal(radar.status, 200, JSON.stringify(radar.body));
  assert.equal(radar.body.data.routingPath, 'RULE');
  assert.match(radar.body.data.answer, /Radar/);
  assert.equal(typeof radar.body.data.structured.total, 'number');
});

test('CAD-16 CRMX-009 NAY classifica a qualidade do cadastro e os documentos faltantes, com fonte e parâmetro do admin', { skip: SKIP }, async () => {
  const { opp } = await N.oportunidade(tenant, pessoas.checker);
  const pedir = () => N.pedir(env, 'A:checker', 'classificar_cadastro', 'Classifique a qualidade do cadastro do cliente e os documentos faltantes', N.oppCtx(opp));
  const r1 = await pedir();
  N.evidencia('CAD-16-classificacao-cadastro', { taskType: 'classificar_cadastro' }, r1);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const c1 = r1.body.data.structured;
  assert.equal(c1.tipo, 'QUALIDADE_CADASTRO');
  assert.equal(c1.classe, 'RUIM', 'cadastro só com nome: CPF, contato, endereço, documento e papel faltando');
  assert.ok(c1.camposFaltantes.includes('CPF/CNPJ informado'));
  assert.deepEqual(c1.documentosFaltantes, ['RG ou CIN ou CNH ou RG_CPF (faltante)']);
  assert.match(r1.body.data.answer, /Qualidade do cadastro de QA-M3CB Cliente .*: ruim \(nota \d+ de 100/);
  assert.deepEqual(r1.body.data.sources.map((s) => s.title), ['people', 'people.documents']);
  // O documento exigido é parâmetro do admin (grupos por vírgula, alternativas por "|").
  assert.equal((await N.setParam(env, PARAMS[0], 'CIN')).status, 200);
  const r2 = await pedir();
  assert.deepEqual(r2.body.data.structured.documentosFaltantes, ['CIN (faltante)'], 'o documento exigido é o do parâmetro');
  const outro = await N.oportunidade(tenant, pessoas.maker);
  const alheio = await N.pedir(env, 'A:checker', 'classificar_cadastro', 'Classifique o cadastro do cliente', N.oppCtx(outro.opp));
  assert.equal(alheio.status, 404, 'cadastro pela oportunidade de outro corretor: não encontrado');
});

test('CAD-16 NAY sugere recuperação de cliente perdido: só rascunho, nada é enviado', { skip: SKIP }, async () => {
  const { opp } = await N.oportunidade(tenant, pessoas.checker, { dias: 20 });
  const antes = await N.num('SELECT count(*)::int AS n FROM crm.messages WHERE opportunity_id = $1', [opp.id]);
  const res = await N.pedir(env, 'A:checker', 'rascunhar_recuperacao_cliente', 'Escreva uma mensagem para recuperar o cliente', N.oppCtx(opp));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.answer, /^RASCUNHO/);
  assert.match(res.body.data.answer, /há 20 dias/);
  assert.equal(res.body.data.structured.enviada, false);
  assert.equal(await N.num('SELECT count(*)::int AS n FROM crm.messages WHERE opportunity_id = $1', [opp.id]), antes);
});

test('CAD-16 CRMX-009 NAY detecta lead esquecido sob demanda, só na carteira de quem pede', { skip: SKIP }, async () => {
  const meu = await N.oportunidade(tenant, pessoas.checker, { dias: 12 });
  const recente = await N.oportunidade(tenant, pessoas.checker, { dias: 1 });
  const alheio = await N.oportunidade(tenant, pessoas.maker, { dias: 15 });
  const res = await N.pedir(env, 'A:checker', 'detectar_leads_esquecidos', 'Quais leads esquecidos tenho na carteira?');
  N.evidencia('CAD-16-lead-esquecido-sob-demanda', { taskType: 'detectar_leads_esquecidos' }, res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const ids = res.body.data.structured.oportunidades.map((o) => o.id);
  assert.ok(ids.includes(meu.opp.id), 'a oportunidade dele sem contato há 12 dias');
  assert.ok(!ids.includes(recente.opp.id), 'a aberta ontem não está esquecida');
  assert.ok(!ids.includes(alheio.opp.id), 'a de outro corretor não aparece');
  assert.equal(res.body.data.structured.prazoDias, 7);
  const gestor = await N.pedir(env, 'A:gestor', 'detectar_leads_esquecidos', 'Quais leads esquecidos existem na carteira?');
  assert.ok(gestor.body.data.structured.oportunidades.map((o) => o.id).includes(alheio.opp.id), 'o gestor vê a empresa');
});

test('Livro §18 IA acessar outro cliente: corretor A pede resumo da oportunidade do corretor B pela NAY -> recusado (regra e tool)', { skip: SKIP }, async () => {
  const deB = await N.oportunidade(tenant, pessoas.maker, { nome: `QA-M3CB Carteira B ${Date.now()}` });
  const res = await N.pedir(env, 'A:checker', 'resumir_oportunidade', 'Resuma esta oportunidade', N.oppCtx(deB.opp));
  N.evidencia('M3-18-NAY-carteira-alheia-recusada', { taskType: 'resumir_oportunidade', quem: 'corretor A (read:own)', oportunidade: 'do corretor B' }, res);
  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'AI_CROSS_COMPANY_BLOCKED');
  assert.ok(!JSON.stringify(res.body).includes('Carteira B'), 'não revela o cliente');
  for (const task of ['sugerir_proxima_acao', 'listar_imoveis_radar', 'rascunhar_recuperacao_cliente', 'propor_envio_mensagem']) {
    const r = await N.pedir(env, 'A:checker', task, 'Sugira o que fazer nesta oportunidade', N.oppCtx(deB.opp));
    assert.equal(r.status, 404, `${task}: ${JSON.stringify(r.body)}`);
  }
  // Pelo nome do cliente, a oportunidade de B nem é encontrada para A.
  const porNome = await N.pedir(env, 'A:checker', 'resumir_oportunidade', `Resuma a oportunidade do cliente ${deB.pessoa.legalName}`);
  assert.ok(!JSON.stringify(porNome.body).includes(deB.opp.id));
  // Pelo caminho de modelo: a tool crm.getOpportunity também recusa a oportunidade de outro corretor.
  const tool = await N.pedir(env, 'A:checker', 'consulta', `Resuma o cliente [[TOOL:crm.getOpportunity:{"opportunityId":"${deB.opp.id}"}]] [[RESPOSTA:A oportunidade está na etapa informada [1].]]`);
  assert.ok(!JSON.stringify(tool.body).includes('Carteira B'), JSON.stringify(tool.body));
  const chamadas = (await N.admin("SELECT status FROM ai.tool_calls WHERE tool_name = 'crm.getOpportunity' AND args_sanitized::text LIKE $1", [`%${deB.opp.id}%`])).rows;
  assert.ok(chamadas.length >= 1, JSON.stringify(tool.body));
  assert.ok(chamadas.every((c) => c.status !== 'SUCCEEDED'), JSON.stringify(chamadas));
  // O gestor (read:all) e o próprio B obtêm o resumo.
  assert.equal((await N.pedir(env, 'A:gestor', 'resumir_oportunidade', 'Resuma esta oportunidade', N.oppCtx(deB.opp))).status, 200);
  assert.equal((await N.pedir(env, 'A:maker', 'resumir_oportunidade', 'Resuma esta oportunidade', N.oppCtx(deB.opp))).status, 200);
});
