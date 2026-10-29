'use strict';

// M9-D034 — somente leitura: nenhuma tool de escrita na allowlist, pedido de escrita recusado sem chamar modelo nem tool, e as propostas só
// com `ia.comercial.permitir_propostas` Ligado (o servidor liga a tool de proposta; a trava de gravação do parâmetro é do teste de homologação).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, q, run } = require('../../helpers/aiAgents');
const { espiaRegistry } = require('../_helpers/iaEspia');
const C = require('../_helpers/iaComercial');
const policy = require('../../../src/features/ai/agents/nay_comercial/comercial.policy');
const comercialSeed = require('../../../migrations/_helpers/aiAgentComercial');
const agents = require('../../../src/features/ai/agents');
const { computeConfigHash } = require('../../../src/features/ai/agents/agentConfigHash');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const MENSAGEM = 'Neste momento posso apenas consultar e sugerir; a alteração deve ser feita por você no CRM.';
const ligarPropostas = (c, valor) => run(
  `INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, 'ia.comercial.permitir_propostas', CAST(:v AS jsonb), now(), now())
   ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`, { g: c.tenant.groupId, c: c.tenant.companyId, v: JSON.stringify(valor) }, c.tx
);

test('m9d034_nao_existe_write_tool_na_allowlist', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const sistema = await q("SELECT a.id, a.status, a.enabled, a.criticality, a.permissions FROM ai.agents a WHERE a.company_id IS NULL AND a.code = 'NAY_COMERCIAL' AND a.version = 1", {}, tx);
    assert.equal(sistema[0].status, 'DRAFT');
    assert.equal(sistema[0].enabled, false, 'ligar exige a homologação (D032)');
    assert.equal(sistema[0].criticality, 'NON_CRITICAL');
    const tools = await q('SELECT tool_name, permission_code, risk_level, requires_human_approval, enabled FROM ai.agent_tools WHERE agent_id = :id ORDER BY tool_name', { id: sistema[0].id }, tx);
    assert.deepEqual(tools.map((t) => t.tool_name), ['crm.getCustomerSummary', 'crm.getOpportunity', 'radar.listMatchesForOpportunity']);
    const c = await C.cenario(tenantA, tx);
    for (const t of tools) {
      const def = c.registry.get(t.tool_name);
      assert.equal(def.category, 'READ', `${t.tool_name} é leitura`);
      assert.equal(t.risk_level, 'LOW');
      assert.equal(t.requires_human_approval, false);
    }
    assert.ok(!tools.some((t) => c.registry.get(t.tool_name).category === 'WRITE'), 'nenhuma tool de escrita');
    assert.ok(!tools.some((t) => t.tool_name === 'crm.createFollowUpTask'));
    // A versão ativa da empresa e a ativa resolvida pelo run (portão fechado) têm as mesmas três tools.
    const ativa = await agents.resolveActiveAgent(C.CODE, c.ctx, tx);
    assert.deepEqual(ativa.tools.map((t) => t.toolName).sort(), tools.map((t) => t.tool_name));
    // Paridade da migration com a política da aplicação e do hash do seed com o da aplicação.
    for (const k of ['purpose', 'systemPolicy', 'modelPolicy', 'dataScopes', 'limits', 'criticality']) {
      const app = { purpose: policy.PURPOSE, systemPolicy: policy.SYSTEM_POLICY, modelPolicy: policy.MODEL_POLICY, dataScopes: policy.DATA_SCOPES, limits: policy.LIMITS, criticality: policy.CRITICALITY }[k];
      assert.deepEqual(comercialSeed.AGENTE[k], app, k);
    }
    assert.deepEqual(comercialSeed.AGENTE.tools, policy.TOOLS.map((t) => ({ ...t })));
    const linha = (await q("SELECT * FROM ai.agents WHERE id = :id", { id: sistema[0].id }, tx))[0];
    assert.equal(linha.config_hash, computeConfigHash({
      code: 'NAY_COMERCIAL', purpose: linha.purpose, systemPolicy: linha.system_policy, modelPolicy: linha.model_policy, dataScopes: linha.data_scopes, limits: linha.limits,
      criticality: linha.criticality, tools: tools.map((t) => ({ toolName: t.tool_name, permissionCode: t.permission_code, riskLevel: t.risk_level, requiresHumanApproval: t.requires_human_approval, enabled: t.enabled })),
    }));
  });
});

test('m9d034_pedido_de_escrita_recusado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const c = await C.cenario(tenantA, tx, { dias: 9, deps: { registry } });
    const tarefas = await C.tarefasDe(c);
    const mensagens = await C.mensagensDe(c);
    const pedidosDeEscrita = [
      'Crie uma tarefa de retorno para o cliente desta oportunidade',
      'Mude a etapa da oportunidade para proposta',
      'Por favor, marque como perdida a oportunidade do cliente',
    ];
    for (const texto of pedidosDeEscrita) {
      const { outcome: o } = await c.pedir('consulta', texto);
      assert.equal(o.ok, true, texto);
      assert.equal(o.answer, MENSAGEM, texto);
      assert.equal(o.routingPath, 'RULE');
      assert.deepEqual(await C.chamadasDe(o.runId, tx), [], 'nenhuma tool chamada');
    }
    const { outcome: envio } = await c.pedir('consulta', 'Envie a mensagem de retomada para o cliente da oportunidade');
    assert.match(envio.answer, /apenas redigir o rascunho/);
    assert.equal(pedidos.length, 0, 'a recusa não chama o modelo');
    assert.equal(await C.tarefasDe(c), tarefas, 'nenhuma tarefa criada');
    assert.equal(await C.mensagensDe(c), mensagens, 'nenhuma mensagem enviada');
    // Fora do propósito.
    const { outcome: fora } = await c.pedir('consulta', 'Qual a receita da feijoada?');
    assert.equal(fora.answer, 'Isso foge do que este assistente pode fazer.');
    // Chamar a tool de escrita diretamente também é barrado pela allowlist.
    const { outcome: tool } = await c.pedir('consulta', `Veja a oportunidade [[TOOL:crm.createFollowUpTask:{"opportunityId":"${c.opp.id}","title":"Retornar"}]] [[RESPOSTA:x]]`);
    assert.equal(tool.ok, false);
    assert.equal(tool.error.code, 'AI_TOOL_NOT_ALLOWED');
  });
});

test('m9d034_propostas_so_com_parametro_ligado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await C.cenario(tenantA, tx, { perms: [...C.PERMS_CORRETOR, 'crm:tasks:create'] });
    const pedido = `Veja a oportunidade [[TOOL:crm.createFollowUpTask:{"opportunityId":"${c.opp.id}","title":"Retornar contato"}]] [[RESPOSTA:Proposta registrada.]]`;
    // Desligado (padrão): a tool não existe para o agente.
    assert.equal((await agents.resolveActiveAgent(C.CODE, c.ctx, tx)).tools.some((t) => t.toolName === 'crm.createFollowUpTask'), false);
    const { outcome: off } = await c.pedir('consulta', pedido);
    assert.equal(off.ok, false);
    assert.equal(off.error.code, 'AI_TOOL_NOT_ALLOWED');
    const { outcome: recusa } = await c.pedir('consulta', 'Crie uma tarefa de retorno para o cliente');
    assert.equal(recusa.answer, MENSAGEM);
    // Ligado: passa a valer como PROPOSTA de aprovação humana (D019); a tarefa só nasce depois do aceite.
    await ligarPropostas(c, true);
    const ligada = await agents.resolveActiveAgent(C.CODE, c.ctx, tx);
    const extra = ligada.tools.find((t) => t.toolName === 'crm.createFollowUpTask');
    assert.ok(extra && extra.enabled && extra.requiresHumanApproval, 'tool de proposta com aprovação humana');
    const tarefas = await C.tarefasDe(c);
    const { outcome: on } = await c.pedir('consulta', pedido);
    assert.equal(on.ok, true, JSON.stringify(on.error));
    assert.equal(on.status, 'AWAITING_APPROVAL');
    assert.equal(on.proposals.length, 1);
    assert.equal(await C.tarefasDe(c), tarefas, 'a proposta não cria a tarefa');
    const { outcome: pede } = await c.pedir('consulta', 'Crie uma tarefa de retorno para o cliente da oportunidade');
    assert.notEqual(pede.answer, MENSAGEM, 'ligado, o pedido de tarefa deixa de ser recusa de fronteira');
    // Desligar de novo fecha a porta.
    await ligarPropostas(c, false);
    assert.equal((await agents.resolveActiveAgent(C.CODE, c.ctx, tx)).tools.some((t) => t.toolName === 'crm.createFollowUpTask'), false);
  });
});
