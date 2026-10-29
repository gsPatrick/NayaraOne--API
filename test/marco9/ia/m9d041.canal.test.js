'use strict';

// M9-D041 — o ator externo (identidade de serviço do canal + contato do servidor), o encaminhamento como recomendação informativa, a regra
// geral para a pessoa interna que testa o agente e a lista de anúncios por regra.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { criarOportunidade, criarOportunidadeCommitada } = require('../_helpers/aiToolsEnv');
const { comTenant, ctxDe: ctxDeImovel } = require('../../integrations/dispatch/dispatchHelpers');
const { criarImovel } = require('../_helpers/intReadModel');
const rm = require('../../../src/features/properties/publicReadModel');
const { AiOrchestrator } = require('../../../src/features/ai/orchestrator');
const { loadChannelContext } = require('../../../src/features/ai/orchestrator/executionContext');
const recommendations = require('../../../src/features/ai/recommendations');
const H = require('../_helpers/m9d041Env');

let tenantA; let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const resultado = async (runId, tx) => (await H.chamadas(runId, tx))[0].result_summary;
const status = (c, mensagem, contato) => H.conversar(c, `qual o meu status? [[TOOL:crm.getCustomerContactStatus:{}]] [[RESPOSTA:Você tem solicitações [1].]]`, { externalContactId: contato });

test('m9d041_ator_externo_service_identity_com_contato_do_contexto', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const ctx = await loadChannelContext({ groupId: tenantA.groupId, companyId: tenantA.companyId }, 'NAY_ATENDIMENTO', c.contato, tx);
    assert.equal(ctx.actor.type, 'SERVICE');
    assert.equal(ctx.externalContactId, c.contato);
    assert.deepEqual([...ctx.permissions].sort(), [...H.PERMISSOES_CANAL].sort(), 'só o que a identidade de leitura tem');
    assert.ok(Object.isFrozen(ctx));
    // O run é da identidade de serviço: sem pessoa. O contato lido é o do contexto.
    const res = await status(c, null, c.contato);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const run = await H.lerRun(res.runId, tx);
    assert.equal(run.user_id, null);
    const lido = await resultado(res.runId, tx);
    assert.match(JSON.stringify(lido), /"known":\s*true/);
    assert.match(JSON.stringify(lido), /"opportunities":\s*1/);
    // Contato desconhecido (nulo): o servidor não inventa um; "outro contato" de outra empresa também não aparece (RLS).
    const { pessoa: deB } = await criarOportunidadeCommitada(tenantB);
    for (const contato of [null, deB.id]) {
      const outro = await status(c, null, contato);
      assert.equal(outro.ok, true, JSON.stringify(outro.error));
      assert.match(JSON.stringify(await resultado(outro.runId, tx)), /"known":\s*false/, `contato ${contato}`);
    }
    // O id do contato nunca é aceito como argumento de tool, nem pelo modelo.
    const { pessoa: outro } = await criarOportunidade(tenantA, tx);
    const forjado = await H.conversar(c, `oi [[TOOL:crm.createHandoffTask:{"topic":"OUTRO","summary":"x","contactId":"${outro.id}"}]] [[RESPOSTA:Ok [1].]]`);
    assert.deepEqual((await H.chamadas(forjado.runId, tx)).map((l) => [l.status, l.blocked_reason]), [['BLOCKED', 'SCHEMA']]);
    // O id do contato precisa ser um id (o canal já o resolveu); lixo é recusado antes de qualquer run.
    await assert.rejects(() => H.conversar(c, 'oi', { externalContactId: 'joao@exemplo.com' }), TypeError);
  });
});

test('m9d041_handoff_vira_recomendacao_informativa_para_o_responsavel', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const tarefasAntes = (await H.q('SELECT count(*)::int AS n FROM core.tasks', {}, tx))[0].n;
    const res = await H.conversar(c, 'quero renegociar meu contrato');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const [h] = await H.handoffs(tx);
    assert.equal(h.status, 'PENDING');
    assert.equal(h.proposed_action, null, 'informativa: não há ação a executar');
    assert.equal(h.target_user_id, c.responsavelId, 'dirigida ao responsável do papel ia.atendimento.papel_handoff');
    assert.equal(h.agent_code, 'NAY_ATENDIMENTO');
    assert.equal(h.risk_level, 'MEDIUM');
    assert.equal((await H.q('SELECT count(*)::int AS n FROM core.tasks', {}, tx))[0].n, tarefasAntes, 'nenhuma tarefa de CRM foi criada pela NAY');
    // O responsável a marca como vista com ai:read; a NAY (serviço) nunca decide; e ninguém mais com só ai:read vê a dos outros.
    const responsavel = { groupId: tenantA.groupId, companyId: tenantA.companyId, userId: c.responsavelId, permissions: ['ai:read'] };
    const aceita = await recommendations.acceptRecommendation(responsavel, h.id, {}, tx);
    assert.equal(aceita.recommendation.status, 'ACCEPTED');
    assert.equal((await H.q('SELECT count(*)::int AS n FROM core.tasks', {}, tx))[0].n, tarefasAntes, 'aceitar a informativa não executa nada');
    const servico = { groupId: tenantA.groupId, companyId: tenantA.companyId, userId: null, serviceIdentity: true, permissions: ['ai:read'] };
    await assert.rejects(() => recommendations.acceptRecommendation(servico, h.id, {}, tx), (e) => e.statusCode === 403);
    // Sem responsável com o papel, o encaminhamento ainda é registrado (sem destinatário), para quem tem ai:approve ou ai:audit.
    await H.q("UPDATE core.roles SET name = 'outro-papel' WHERE company_id = :c AND name = 'atendimento' RETURNING id", { c: tenantA.companyId }, tx);
    const sem = await H.conversar(c, 'qual o prazo para renegociar?');
    assert.equal(sem.ok, true, JSON.stringify(sem.error));
    const todos = await H.handoffs(tx);
    assert.equal(todos.length, 2);
    assert.equal(todos[1].target_user_id, null);
  });
});

test('m9d041_usuario_interno_testando_o_agente_segue_a_regra_de_proposta', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const auth = { userId: c.ctx.userId, groupId: tenantA.groupId, companyId: tenantA.companyId, permissions: ['ai:use', 'crm:tasks:create'], roles: ['TESTE'] };
    const res = await new AiOrchestrator(c.deps).run({
      agentCode: 'NAY_ATENDIMENTO', purpose: 'Teste interno do agente', input: 'oi [[TOOL:crm.createHandoffTask:{"topic":"OUTRO","summary":"Teste interno"}]]', taskType: 'triar',
    }, auth, tx);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.status, 'AWAITING_APPROVAL', 'pessoa interna: a escrita vira proposta (D019)');
    const [rec] = await H.q("SELECT proposed_action, status FROM ai.ai_recommendations WHERE id = :id", { id: res.proposals[0].id }, tx);
    assert.equal(rec.status, 'PENDING');
    assert.equal(rec.proposed_action.tool, 'crm.createHandoffTask');
    assert.equal((await H.handoffs(tx)).filter((h) => h.proposed_action === null).length, 0, 'nenhum registro informativo antes da aprovação');
  });
});

test('m9d041_anuncios_listados_por_regra_sem_modelo', async () => {
  const imovel = await criarImovel(tenantA);
  await comTenant(tenantA, (t) => rm.syncPublicPropertyReadModel(imovel.id, ctxDeImovel(tenantA), t));
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const res = await H.conversar(c, 'quais imóveis disponíveis vocês têm?');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.routingPath, 'RULE', 'listagem é regra: nenhum modelo, custo zero');
    assert.equal(Number(res.cost.amount), 0);
    assert.match(res.answer, /Apartamento de 3 quartos no Batel/);
    assert.match(res.answer, /R\$ 850\.000,00/);
    assert.doesNotMatch(res.answer, /CANARY/, 'só campos públicos');
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.equal(res.sources[0].type, 'READ_MODEL');
    assert.equal((await H.handoffs(tx)).length, 0);
  });
});
