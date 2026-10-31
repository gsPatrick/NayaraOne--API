'use strict';

// Marco 9, M9-D228 — IA fora: toda função com IA declara o caminho determinístico equivalente e o aciona por withAiFallback/resolveAiMode (busca por palavras-chave, modelos de contrato
// pré-definidos, regras e leituras do ERP, formulário da tela normal). Nenhuma ação de negócio depende só da IA. Banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D228_IA_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d249Env');
const { conexaoAtiva } = require('../_helpers/m9d214Env');
const det = require('../../../src/features/ai/deterministic');
const { buildDefaultRegistry, loadPermissionCodes } = require('../../../src/features/ai/tools');
const { RetrievalService } = require('../../../src/features/ai/retrieval/RetrievalService');
const { Task } = require('../../../src/models');

let tenant;
let token;
let chamar;
let auth;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  token = env.tokenDe(tenant, ['ai:read']);
  chamar = env.chamador();
  auth = { userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, permissions: ['ai:use', 'ai:read', 'crm:opportunities:read', 'finance:read', 'legal:create', 'crm:tasks:create', 'inventory:read', 'finance:create'], roles: [] };
  await env.sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code LIKE 'ai-%' AND status = 'ACTIVE'", { c: tenant.companyId }); // IA fora: sem connection ativa
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => {
  await env.sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code LIKE 'ai-%' AND status IN ('ACTIVE', 'PAUSED') AND label LIKE 'QA-M9%'", { c: tenant.companyId });
  await env.sequelize.close();
  process.exit(0);
});

const rodar = (nome, input) => {
  const chamadas = { ia: 0 };
  return env.comTenant(tenant, async (t) => {
    const r = await det.runAiFunction(auth, nome, { input, ai: async () => { chamadas.ia += 1; return { gerado: true }; } }, t);
    return { ...r, chamadasIa: chamadas.ia };
  });
};

test('contingencia_ia_fora_funcoes_deterministicas_continuam', async () => {
  // Leituras e regras do ERP: o dado sai dos serviços, a IA não é chamada.
  for (const [nome, entrada] of [['crm.getPipelineSummary', {}], ['finance.getWeeklyHealth', {}], ['inventory.getStockRisks', {}]]) {
    const r = await rodar(nome, entrada);
    assert.equal(r.mode, 'DEGRADE_TO_DETERMINISTIC', nome);
    assert.equal(r.reason, 'NO_ACTIVE_CONNECTION');
    assert.equal(r.chamadasIa, 0, `${nome} não chamou a IA`);
    assert.equal(r.result.functionId, nome);
    assert.ok(r.result.data && typeof r.result.data === 'object', `${nome} devolve o dado do ERP`);
  }
  // Busca: palavras-chave no lugar da semântica (o vetor da consulta nem é pedido ao provedor de vetores).
  const busca = await rodar('knowledge.search', { query: 'política de reajuste' });
  assert.equal(busca.result.kind, 'KEYWORD_SEARCH');
  assert.ok(Array.isArray(busca.result.data.items));
  const argumentos = await new RetrievalService().searchArgs({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId, permissions: [] }, 'política', { lexicalOnly: true }, { topK: 5 }, null);
  assert.deepEqual([argumentos.model, argumentos.vector], ['', [0]], 'busca por palavras-chave: sem vetor');
  // Redação: os modelos de contrato pré-definidos, sem texto gerado.
  const minuta = await rodar('legal.draftContract', { contractType: 'LEASE' });
  assert.equal(minuta.result.kind, 'PREDEFINED_TEMPLATE');
  assert.ok(Array.isArray(minuta.result.templates));
  // Ação de negócio: o formulário da tela normal; nada é gravado.
  const antes = await env.comTenant(tenant, (t) => Task.count({ transaction: t }));
  const forma = await rodar('crm.createFollowUpTask', {});
  assert.equal(forma.result.kind, 'HUMAN_FORM');
  assert.ok(forma.result.form.fields.length > 0 && forma.result.form.approvalRequired === false);
  assert.equal(await env.comTenant(tenant, (t) => Task.count({ transaction: t })), antes, 'o caminho determinístico nunca grava a ação');
  const pagamento = await rodar('finance.proposePayment', {});
  assert.equal(pagamento.result.form.approvalRequired, true, 'a ação crítica segue com aprovação humana');
  // A pessoa precisa da permissão da própria função.
  await assert.rejects(env.comTenant(tenant, (t) => det.runDeterministic({ ...auth, permissions: ['ai:read'] }, 'finance.getWeeklyHealth', {}, t)), (e) => e.statusCode === 403 && e.code === 'PERMISSION_DENIED');
  await assert.rejects(env.comTenant(tenant, (t) => det.runDeterministic(auth, 'funcao.inexistente', {}, t)), (e) => e.statusCode === 404 && e.code === 'AI_DETERMINISTIC_NOT_DECLARED');

  // A IA de pé e a função responde por ela; se ela cai na hora da chamada, o determinístico assume; defeito de programação continua erro.
  const ia = await conexaoAtiva(tenant, 'AI');
  const normal = await env.comTenant(tenant, (t) => det.runAiFunction(auth, 'crm.getPipelineSummary', { input: {}, ai: async () => ({ gerado: true }) }, t));
  assert.deepEqual([normal.mode, normal.result.gerado], ['NORMAL', true]);
  const caiu = await env.comTenant(tenant, (t) => det.runAiFunction(auth, 'crm.getPipelineSummary', { input: {}, ai: async () => { throw Object.assign(new Error('fora'), { code: 'UNAVAILABLE' }); } }, t));
  assert.deepEqual([caiu.mode, caiu.reason, caiu.result.kind], ['DEGRADE_TO_DETERMINISTIC', 'AI_UNAVAILABLE', 'READ_SERVICE']);
  await assert.rejects(env.comTenant(tenant, (t) => det.runAiFunction(auth, 'crm.getPipelineSummary', { input: {}, ai: async () => { throw new TypeError('defeito'); } }, t)), TypeError);
  assert.ok(ia.id);
});

test('contingencia_ia_toda_funcao_declara_caminho_deterministico', async () => {
  const registro = await buildDefaultRegistry(await loadPermissionCodes());
  const nomes = registro.list().map((t) => t.name);
  assert.ok(nomes.length >= 30, 'o registro tem as tools iniciais e as dos agentes');
  assert.deepEqual(det.functionsWithoutDeterministicPath(nomes), [], 'toda tool, todo agente do sistema e a busca do RAG declaram o caminho');
  assert.deepEqual(det.staleEntries(nomes), [], 'o catálogo não aponta para função que não existe');
  // Função nova sem caminho declarado reprova.
  assert.deepEqual(det.functionsWithoutDeterministicPath([...nomes, 'nova.funcaoComIa']), ['tool:nova.funcaoComIa']);
  // A escrita nunca roda pelo caminho determinístico: só formulário ou modelo.
  for (const tool of registro.list().filter((t) => t.category === 'WRITE')) assert.ok(['HUMAN_FORM', 'PREDEFINED_TEMPLATE'].includes(det.toolEntry(tool.name).kind), `${tool.name} é escrita`);
  assert.ok(det.systemAgentCodes().includes('NAY_FINANCEIRA') && det.systemAgentCodes().length >= 8);
});

test('contingencia_ia_rotas_do_caminho_deterministico_nao_dependem_da_chave_geral_da_ia', async () => {
  await env.sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code LIKE 'ai-%' AND status = 'ACTIVE'", { c: tenant.companyId });
  const lista = await chamar(token, 'GET', '/ai/deterministic');
  assert.equal(lista.status, 200);
  assert.equal(lista.corpo.data.mode.mode, 'DEGRADE_TO_DETERMINISTIC');
  assert.ok(lista.corpo.data.functions.some((f) => f.id === 'tool:knowledge.search' && f.kind === 'KEYWORD_SEARCH'));
  const semPermissao = await chamar(env.tokenDe(tenant, ['ai:read']), 'POST', '/ai/deterministic/finance.getWeeklyHealth', { input: {} });
  assert.equal(semPermissao.status, 403);
  const ok = await chamar(env.tokenDe(tenant, ['ai:read', 'finance:read']), 'POST', '/ai/deterministic/finance.getWeeklyHealth', { input: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.corpo.data.mode, 'DEGRADE_TO_DETERMINISTIC');
  assert.equal((await chamar(token, 'GET', '/ai/deterministic')).status, 200);
  const semToken = await fetch(`http://127.0.0.1:${process.env.PORT}/api/v1/ai/deterministic`);
  assert.equal(semToken.status, 401);
});
