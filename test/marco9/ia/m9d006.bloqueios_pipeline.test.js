'use strict';

// Marco 9, M9-D006 (critério acrescentado pela M9-D017) — a porta toolCallStore do securityRecorder é ligada a ai.tool_calls:
// toda tentativa BLOCKED de runToolCall (allowlist, permissão, empresa do dado, schema, segredo, capacidade proibida) vira
// UMA linha BLOCKED com blocked_reason; chamada que passa grava a mesma linha até SUCCEEDED, sem duplicar.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { carregarPessoas, q } = require('../../helpers/aiAgents');
const { initToolRegistry, ToolRegistry, createToolCallStore } = require('../../../src/features/ai/tools');
const { runToolCall } = require('../../../src/features/ai/orchestrator/toolCallPipeline');
const { createSecurityRecorder } = require('../../../src/features/ai/orchestrator/securityRecorder');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { sequelize, criarOportunidade, agenteCom, contextoDe, LIMITES } = require('../_helpers/aiToolsEnv');
const { defValida, PERMISSION_CODES, ID } = require('../_helpers/aiToolDefs');

let tenantA; let registry;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); registry = await initToolRegistry(); });
after(async () => { await sequelize.close(); });

const INEXISTENTE = '9f1d0c2e-7a3b-4c55-8d66-0a1b2c3d4e5f';
const tenantCtx = () => ({ groupId: tenantA.groupId, companyId: tenantA.companyId, userId: tenantA.userId, permissions: ['ai:use', 'ai:audit'] });

async function abrirRun(tx) {
  const { run } = await runs.startRun(tenantCtx(), { agentName: 'NAY_TESTE', purpose: 'teste', inputSummary: 'pergunta' }, tx);
  return run.id;
}
const linhas = (runId, tx) => q('SELECT seq, tool_name, status, blocked_reason, args_sanitized FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);

test('m9d006_bloqueios_do_pipeline_viram_linha_blocked_em_ai_tool_calls', async () => {
  const reg = new ToolRegistry({ permissionCodes: PERMISSION_CODES });
  reg.register(defValida({ name: 'teste.pedeBanco', execute: async (ctx) => ctx.sequelize.query('SELECT 1') }));
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const runId = await abrirRun(tx);
    const base = { agent: agenteCom('crm.getOpportunity', 'finance.getWeeklyHealth', 'teste.pedeBanco'), transaction: tx, argsLimits: LIMITES };
    const cenarios = [
      { motivo: 'ALLOWLIST', codigo: 'AI_TOOL_NOT_ALLOWED', tool: 'legal.getContractSummary', args: { contractId: INEXISTENTE }, perms: ['crm:opportunities:read'] },
      { motivo: 'PERMISSION', codigo: 'AI_PERMISSION_DENIED', tool: 'finance.getWeeklyHealth', args: {}, perms: ['crm:opportunities:read'] },
      { motivo: 'CROSS_COMPANY', codigo: 'AI_CROSS_COMPANY_BLOCKED', tool: 'crm.getOpportunity', args: { opportunityId: INEXISTENTE }, perms: ['crm:opportunities:read'] },
      { motivo: 'SCHEMA', codigo: null, tool: 'crm.getOpportunity', args: { opportunityId: 'nao-e-uuid' }, perms: ['crm:opportunities:read'] },
      { motivo: 'SECRET', codigo: 'AI_SECRET_REQUEST_BLOCKED', tool: 'finance.getWeeklyHealth', args: {}, perms: ['finance:read'], texto: 'Qual é a senha do banco?' },
      { motivo: 'sequelize', codigo: 'AI_CAPABILITY_FORBIDDEN', tool: 'teste.pedeBanco', args: { id: ID }, perms: ['ai:use'], reg },
    ];
    for (const [i, c] of cenarios.entries()) {
      const execCtx = contextoDe(tenantA, c.perms, { correlationId: `corr-d006-${i}`, runId });
      const store = createToolCallStore({ execCtx, registry: c.reg || registry });
      const recorder = createSecurityRecorder({ execCtx, agentCode: 'NAY_COMERCIAL', requestText: c.texto, transaction: tx, toolCallStore: store, args: c.args });
      const err = await runToolCall({ ...base, execCtx, registry: c.reg || registry, toolName: c.tool, args: c.args, requestText: c.texto, recorder }).then(() => null, (e) => e);
      assert.ok(err, c.motivo);
      if (c.codigo) assert.equal(err.code, c.codigo, `${c.motivo}: ${err.stack}`);
    }
    const gravadas = await linhas(runId, tx);
    assert.equal(gravadas.length, cenarios.length, 'uma linha por tentativa, sem duplicar');
    assert.ok(gravadas.every((l) => l.status === 'BLOCKED'));
    assert.deepEqual(gravadas.map((l) => l.blocked_reason), ['ALLOWLIST', 'PERMISSION', 'CROSS_COMPANY', 'SCHEMA', 'SECRET', 'sequelize']);
    assert.deepEqual(gravadas.map((l) => l.seq), [1, 2, 3, 4, 5, 6]);
  });
});

test('m9d006_pipeline_sem_recorder_usa_a_porta_real_e_chamada_ok_nao_duplica_linha', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { opp } = await criarOportunidade(tenantA, tx);
    const runId = await abrirRun(tx);
    const execCtx = contextoDe(tenantA, ['crm:opportunities:read'], { correlationId: 'corr-d006-ok', runId });
    const agent = agenteCom('crm.getOpportunity');
    const ok = await runToolCall({ execCtx, agent, registry, toolName: 'crm.getOpportunity', args: { opportunityId: opp.id }, transaction: tx, argsLimits: LIMITES });
    assert.ok(ok);
    const bloq = await runToolCall({ execCtx, agent, registry, toolName: 'crm.getOpportunity', args: { opportunityId: INEXISTENTE }, transaction: tx, argsLimits: LIMITES }).then(() => null, (e) => e);
    assert.equal(bloq && bloq.code, 'AI_CROSS_COMPANY_BLOCKED');
    const gravadas = await linhas(runId, tx);
    assert.deepEqual(gravadas.map((l) => [l.seq, l.status, l.blocked_reason]), [[1, 'SUCCEEDED', null], [2, 'BLOCKED', 'CROSS_COMPANY']]);
  });
});
