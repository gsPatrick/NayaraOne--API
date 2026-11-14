'use strict';

// Apoio dos testes da M9-D019 (propostas de ação da NAY e aprovação humana). Banco descartável, role nayara_runtime, rollback.
// Pessoas são usuários reais do seed (a auditoria tem FK para core.users); cada chamada de ctxDe devolve uma diferente.

const { sequelize, uniqueSuffix } = require('../../testHelpers');
const { uid, q, run, ctxDe, carregarPessoas, inserirAgente, levarPara } = require('../../helpers/aiAgents');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { initToolRegistry } = require('../../../src/features/ai/tools');
const { runToolCall } = require('../../../src/features/ai/orchestrator/toolCallPipeline');
const { buildUserContext } = require('../../../src/features/ai/orchestrator/executionContext');
const { criarOportunidade } = require('./aiToolsEnv');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const costCentersService = require('../../../src/modules/finance/application/services/cost-centers.service');
const bankAccountsService = require('../../../src/modules/finance/application/services/bank-accounts.service');
const financialEntriesService = require('../../../src/modules/finance/application/services/financial-entry.service');

const LIMITES = Object.freeze({ stringMax: 500, arrayMax: 50 });
const TOOLS_PADRAO = ['crm.createFollowUpTask', 'finance.proposePayment', 'legal.draftContract', 'crm.getOpportunity'];
/** Permissões de quem pede à NAY e de quem aprova (a NAY nunca tem mais do que a pessoa). */
const PERMS_PEDIDO = ['crm:tasks:create', 'crm:opportunities:read', 'finance:create', 'legal:create'];
const PERMS_APROVADOR = ['ai:approve', 'ai:read', 'crm:tasks:create', 'finance:create', 'legal:create'];

const pessoa = (tenant) => ctxDe(tenant).userId;
const ctxAprovador = (tenant, userId, permissions = PERMS_APROVADOR) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId, permissions });

/** Agente ATIVO da empresa com a allowlist informada (as permissões e o risco vêm do registro de tools). */
async function agenteAtivo(tenant, tx, tools = TOOLS_PADRAO, code = `NAY_D019_${uniqueSuffix()}`.slice(0, 40)) {
  const registry = await initToolRegistry();
  const agente = await inserirAgente(tenant, tx, { code });
  for (const nome of tools) {
    const def = registry.get(nome);
    const alto = ['HIGH', 'CRITICAL'].includes(def.riskLevel);
    await run(
      `INSERT INTO ai.agent_tools (id, group_id, company_id, agent_id, tool_name, permission_code, risk_level, requires_human_approval, enabled)
       VALUES (:id, :g, :c, :a, :t, :p, :r, :h, true)`,
      { id: uid(), g: tenant.groupId, c: tenant.companyId, a: agente.id, t: nome, p: def.permissionCode, r: def.riskLevel, h: alto || def.requiresHumanApproval }, tx
    );
  }
  await levarPara(agente.id, 'ACTIVE', tx);
  return { id: agente.id, code, version: 1, tools: tools.map((toolName) => ({ toolName, enabled: true })) };
}

async function lancamentoAPagar(tenant, tx, amount = 1250) {
  const sufixo = uniqueSuffix();
  const base = { groupId: tenant.groupId, companyId: tenant.companyId };
  const cc = await costCentersService.createCostCenter({ ...base, code: `D019-${sufixo}`, name: `D019 ${sufixo}` }, tenant.userId, tx);
  const conta = await bankAccountsService.createBankAccount({ ...base, bankCode: '001', agency: '1', accountNumber: `D019-${sufixo}` }, tenant.userId, tx);
  conta.status = 'ACTIVE';
  await conta.save({ transaction: tx });
  return financialEntriesService.createFinancialEntry({
    ...base, bankAccountId: conta.id, costCenterId: cc.id, entryType: 'DEBIT', nature: 'PAYABLE', amount, description: `Boleto D019 ${sufixo}`,
    dueAt: new Date(Date.now() + 5 * 86400000), idempotencyKey: `d019-${sufixo}`,
  }, tenant.userId, tx);
}

/** Cenário padrão: solicitante e aprovadores, oportunidade, lançamento a pagar, agente ativo e um run aberto do solicitante. */
async function cenario(tenant, tx, { tools = TOOLS_PADRAO, solicitante: quemPede } = {}) {
  await carregarPessoas();
  const solicitante = quemPede || pessoa(tenant);
  const aprovador = pessoa(tenant);
  const outro = pessoa(tenant);
  const { opp } = await criarOportunidade(tenant, tx);
  const entry = await lancamentoAPagar(tenant, tx);
  const agent = await agenteAtivo(tenant, tx, tools);
  const runId = await abrirRun(tenant, tx, solicitante, agent.code);
  return { solicitante, aprovador, outro, opp, entry, agent, runId, registry: await initToolRegistry() };
}

async function abrirRun(tenant, tx, userId, agentName = 'NAY_COMERCIAL') {
  const { run: r } = await runs.startRun({ groupId: tenant.groupId, companyId: tenant.companyId, userId }, { agentName, purpose: 'teste D019', inputSummary: 'pedido' }, tx);
  return r.id;
}

/** Uma tool call completa pelo pipeline real (autorização, executor, política de escrita, proposta). Devolve { res, err }. */
async function pedir(tenant, tx, c, { tool, args, userId, permissions = PERMS_PEDIDO, runId, agent, seq } = {}) {
  const execCtx = buildUserContext(
    { userId: userId || c.solicitante, groupId: tenant.groupId, companyId: tenant.companyId, roles: ['TESTE'], permissions },
    { correlationId: 'corr-d019', runId: runId || c.runId }
  );
  return runToolCall({
    execCtx, agent: agent || c.agent, registry: c.registry, toolName: tool, args, transaction: tx, argsLimits: LIMITES, executorOptions: seq ? { seq } : undefined,
  }).then((res) => ({ res, err: null }), (err) => ({ res: null, err }));
}

const argsTarefa = (c, extra = {}) => ({ opportunityId: c.opp.id, title: 'Retornar ao cliente', ...extra });
const argsPagamento = (c) => ({ financialEntryId: c.entry.id });
const lerRec = async (id, tx) => (await q('SELECT * FROM ai.ai_recommendations WHERE id = :id', { id }, tx))[0];
const lerRunDb = async (id, tx) => (await q('SELECT * FROM ai.ai_runs WHERE id = :id', { id }, tx))[0];
const lerChamada = async (proposalId, tx) => (await q('SELECT * FROM ai.tool_calls WHERE proposal_id = :id', { id: proposalId }, tx))[0];
const contar = async (tabela, where, params, tx) => Number((await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${where}`, params, tx))[0].n);
const setParam = (tenant, tx, chave, valor) => upsertSetting(chave, valor, { groupId: tenant.groupId, companyId: tenant.companyId }, tenant.userId, tx);

module.exports = {
  sequelize, LIMITES, PERMS_PEDIDO, PERMS_APROVADOR, pessoa, ctxAprovador, agenteAtivo, lancamentoAPagar, cenario, abrirRun, pedir,
  argsTarefa, argsPagamento, lerRec, lerRunDb, lerChamada, contar, setParam, q, run, uid,
};
