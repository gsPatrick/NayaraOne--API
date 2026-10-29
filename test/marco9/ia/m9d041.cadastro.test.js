'use strict';

// M9-D041 — cadastro do agente (propósito, tools, escopos, limites), allowlist exata, permissão da identidade de serviço e golden verde.
const { test, before, after } = require('node:test');
const { Sequelize, QueryTypes } = require('sequelize');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, ctxDe } = require('../../helpers/aiAgents');
const nay = require('../../../src/features/ai/agents/nay_atendimento');
const agents = require('../../../src/features/ai/agents');
const { applySystemDefinition } = require('../../../src/features/ai/agents/kit');
const { buildDefaultRegistry } = require('../../../src/features/ai/tools');
const identities = require('../../../src/features/ai/serviceIdentities');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const { avaliar } = require('../_helpers/iaAvaliacao');
const H = require('../_helpers/m9d041Env');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1';
let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const TOOLS = ['crm.createHandoffTask', 'crm.getCustomerContactStatus', 'knowledge.search', 'radar.listPublicListings'];

test('m9d041_agente_cadastrado_com_proposito_tools_escopos_e_limites', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { ativar: false });
    const v = await agents.getVersion(c.ctx, 'NAY_ATENDIMENTO', c.agente.version, tx);
    assert.equal(v.code, 'NAY_ATENDIMENTO');
    assert.equal(v.status, 'DRAFT');
    assert.equal(v.enabled, false, 'nasce desabilitado: ligar exige a homologação');
    assert.equal(v.criticality, 'NON_CRITICAL');
    assert.match(v.purpose, /triar mensagens de clientes/i);
    assert.equal(v.limits.max_tool_calls_por_run, 3);
    assert.deepEqual([...v.dataScopes].sort(), ['crm.status_atendimento', 'knowledge.homologado', 'radar.anuncios_publicos']);
    assert.equal(v.modelPolicy.maxDataClassification, 'INTERNAL');
    assert.match(v.systemPolicy, /outro cliente/);
    assert.match(v.systemPolicy, /prometa|prometer/i);
    // Provisionar de novo devolve a mesma versão (idempotente).
    const outra = await nay.provisionNayAtendimento(c.ctx, tx);
    assert.equal(outra.version, v.version);
  });
});

test('m9d041_so_chama_tools_da_allowlist', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const v = await agents.getVersion(c.ctx, 'NAY_ATENDIMENTO', c.agente.version, tx);
    assert.deepEqual(v.tools.filter((t) => t.enabled).map((t) => t.toolName).sort(), TOOLS, 'allowlist exata do livro');
    const handoff = v.tools.find((t) => t.toolName === 'crm.createHandoffTask');
    assert.equal(handoff.riskLevel, 'MEDIUM');
    // Tool fora da allowlist (leitura financeira, existente no registro): bloqueada e registrada, sem derrubar a conversa.
    await H.politicaHomologada(c, 'Política de atendimento: o horário de atendimento é de segunda a sexta, das 9h às 18h.');
    const res = await H.conversar(c, 'qual o horário de atendimento? [[TOOL:finance.getWeeklyHealth:{}]] [[RESPOSTA:O horário é de segunda a sexta, das 9h às 18h [1].]]');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const linhas = await H.chamadas(res.runId, tx);
    assert.deepEqual(linhas.map((l) => [l.tool_name, l.status, l.blocked_reason]), [['finance.getWeeklyHealth', 'BLOCKED', 'ALLOWLIST']]);
    // Teto de três chamadas por run: a quarta é barrada pelo limite do agente.
    const tres = '[[TOOL:crm.getCustomerContactStatus:{}]] '.repeat(4);
    const teto = await H.conversar(c, `qual o meu status? ${tres}`);
    assert.equal(teto.ok, false);
    assert.equal(teto.error.code, 'AI_TOOL_LIMIT_EXCEEDED');
  });
});

test('m9d041_sem_permissao_bloqueia', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // A identidade de serviço do canal não tem a leitura do CRM: a tool é bloqueada pela permissão efetiva (interseção) e o run segue.
    const c = await H.cenario(tenantA, tx, { permissoes: ['ai:read', 'properties:read'] });
    const res = await H.conversar(c, 'qual o meu status? [[TOOL:crm.getCustomerContactStatus:{}]] [[RESPOSTA:Sem dados [1].]]');
    assert.equal(res.ok, false, 'sem nenhuma fonte útil, o bloqueio encerra o run');
    assert.equal(res.error.status, 403);
    assert.equal(res.error.code, 'AI_PERMISSION_DENIED');
    assert.equal(res.error.message, 'Você não tem permissão para consultar estes dados.');
    assert.equal(res.status, 'BLOCKED');
    const linhas = await H.chamadas(res.runId, tx);
    assert.deepEqual(linhas.map((l) => [l.tool_name, l.status, l.blocked_reason]), [['crm.getCustomerContactStatus', 'BLOCKED', 'PERMISSION']]);
    // Com outra fonte útil na conversa, a parte sem permissão é citada e o resto responde.
    await H.politicaHomologada(c, 'Política de atendimento: o horário de atendimento é de segunda a sexta, das 9h às 18h.');
    const parcial = await H.conversar(c, 'horário [[TOOL:knowledge.search:{"query":"horário de atendimento"}]] [[TOOL:crm.getCustomerContactStatus:{}]] [[RESPOSTA:O horário de atendimento é de segunda a sexta, das 9h às 18h [1].]]');
    assert.equal(parcial.ok, true, JSON.stringify(parcial.error));
    assert.match(parcial.answer, /Sem permissão para crm/);
    // A lista de anúncios (regra, sem modelo) sem properties:read: 403 AI_PERMISSION_DENIED com a mensagem do livro.
    const [identidade] = await identities.listServiceIdentities(c.admin, tx);
    await identities.updateServiceIdentity(c.admin, identidade.id, { permissions: ['ai:read'] }, tx);
    const lista = await H.conversar(c, 'quais imóveis disponíveis vocês têm?');
    assert.equal(lista.ok, false);
    assert.equal(lista.error.status, 403);
    assert.equal(lista.error.code, 'AI_PERMISSION_DENIED');
    assert.equal(lista.error.message, 'Você não tem permissão para consultar estes dados.');
  });
});

test('m9d041_golden_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { ativar: false });
    const svc = new AiEvaluationService();
    const gatilho = { ...ctxDe(tenantA), permissions: ['ai:evaluate'] };
    const ev = await avaliar(svc, gatilho, tx, { agentCode: 'NAY_ATENDIMENTO', suite: 'all' });
    assert.equal(ev.status, 'PASSED', JSON.stringify(ev.items.filter((i) => !i.passed)));
    const cats = new Set(ev.items.map((i) => i.category));
    for (const cat of ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'COST', 'LATENCY']) assert.ok(cats.has(cat), `categoria ${cat} medida`);
    assert.ok(ev.items.every((i) => i.passed), 'nenhum caso reprovado');
    assert.ok(nay.GOLDEN_CASES.length >= 6);
    const casos = await H.q("SELECT case_key FROM ai.golden_cases WHERE agent_code = 'NAY_ATENDIMENTO' AND company_id = :c AND status = 'ACTIVE'", { c: tenantA.companyId }, tx);
    assert.deepEqual(casos.map((r) => r.case_key).sort(), nay.GOLDEN_CASES.map((g) => g.caseKey).sort(), 'o dataset cadastrado é o da definição');
    assert.equal(c.agente.status, 'DRAFT');
  });
});

test('m9d041_allowlist_da_definicao_confere_com_o_registro_de_tools', async () => {
  const registry = await buildDefaultRegistry();
  assert.deepEqual([...nay.TOOL_NAMES].sort(), TOOLS);
  for (const linha of nay.DEFINITION.tools) {
    const def = registry.get(linha.toolName);
    assert.ok(def, `${linha.toolName} está registrada`);
    assert.equal(linha.permissionCode, def.permissionCode, `${linha.toolName}: permissão`);
    assert.equal(linha.riskLevel, def.riskLevel, `${linha.toolName}: risco`);
    assert.equal(linha.requiresHumanApproval, def.requiresHumanApproval, `${linha.toolName}: aprovação`);
  }
  // Nenhuma tool de escrita além do encaminhamento, que para a identidade de serviço só deixa um registro informativo.
  const escritas = nay.DEFINITION.tools.filter((t) => registry.get(t.toolName).category === 'WRITE').map((t) => t.toolName);
  assert.deepEqual(escritas, ['crm.createHandoffTask']);
  assert.equal(registry.get('crm.createHandoffTask').servicePath, 'INFORMATIVE');
  assert.equal(registry.get('knowledge.search').servicePermissionCode, 'ai:read');
});

test('m9d041_padrao_do_sistema_recebe_o_cadastro_pelo_seed', { skip: DISPOSABLE ? false : 'precisa do cluster descartável' }, async () => {
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  const tx = await admin.transaction();
  try {
    const query = (sql, replacements) => admin.query(sql, { replacements, transaction: tx, type: QueryTypes.SELECT });
    const out = await applySystemDefinition(query, nay.DEFINITION);
    const [row] = await query("SELECT * FROM ai.agents WHERE company_id IS NULL AND code = 'NAY_ATENDIMENTO' AND version = 1");
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.enabled, false);
    assert.equal(row.config_hash, out.configHash);
    assert.equal(row.purpose, nay.PURPOSE);
    assert.equal(row.criticality, 'NON_CRITICAL');
    assert.deepEqual(row.data_scopes, nay.DATA_SCOPES);
    assert.equal(row.limits.max_tool_calls_por_run, 3);
    const tools = await query('SELECT tool_name FROM ai.agent_tools WHERE agent_id = :id ORDER BY tool_name', { id: row.id });
    assert.deepEqual(tools.map((t) => t.tool_name), TOOLS);
    assert.equal((await applySystemDefinition(query, nay.DEFINITION)).configHash, out.configHash, 'idempotente');
  } finally {
    await tx.rollback();
    await admin.close();
  }
});
