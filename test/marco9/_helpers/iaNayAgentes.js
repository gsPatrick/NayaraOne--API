'use strict';

// Apoio dos testes dos agentes NAY do livro (M9-D035 em diante): o agente nasce da DEFINIÇÃO de código (provisionAgentVersion), é homologado
// e ativado por pessoas diferentes, recebe orçamento e roda pelo orquestrador com o provider sandbox. Banco descartável, role nayara_runtime, rollback.

const crypto = require('node:crypto');
const { Client } = require('pg');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const agents = require('../../../src/features/ai/agents');
const { provisionAgentVersion, installGoldenCases, applySystemDefinition } = require('../../../src/features/ai/agents/kit');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const { avaliar } = require('./iaAvaliacao');
const { AiOrchestrator } = require('../../../src/features/ai/orchestrator');
const { buildDefaultRegistry } = require('../../../src/features/ai/tools');
const { registerAiAdapters } = require('../../../src/features/ai/providers');
const { carregarPessoas, ctxDe, q } = require('../../helpers/aiAgents');
const { criarOrcamento, AGORA } = require('./iaOrcamento');

const FIXO = () => AGORA.getTime();

const como = (tenant, userId, ...permissions) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId, permissions });
const svc = new AiEvaluationService();

/**
 * Agente pelo ciclo completo: versão da empresa criada da definição (DRAFT), golden cadastrado, avaliação golden e adversarial (suíte ALL)
 * verde, homologação da versão e da avaliação por pessoas diferentes e ativação por outra. `perms` são as permissões de quem pergunta;
 * `params` são parâmetros da empresa gravados antes (chave -> valor).
 */
async function cenarioNay(tenant, tx, { definition, goldenCases, register, perms, params = {}, limit = '500.00', deps = {} }) {
  register();
  registerAiAdapters();
  await carregarPessoas();
  const registry = await buildDefaultRegistry();
  const [criador, disparador, homologador, avaliador, ativador] = [0, 1, 2, 3, 4].map(() => ctxDe(tenant).userId);
  for (const [k, v] of Object.entries(params)) await upsertSetting(k, v, como(tenant, criador), criador, tx);
  const draft = await provisionAgentVersion(como(tenant, criador), definition, tx);
  await installGoldenCases(como(tenant, criador), definition.code, goldenCases, tx);
  const ev = await avaliar(svc, como(tenant, disparador, 'ai:evaluate'), tx, { agentCode: definition.code, suite: 'all', agentVersion: draft.version });
  if (ev.status !== 'PASSED') throw new Error(`avaliação do golden não passou: ${JSON.stringify({ status: ev.status, metrics: ev.metrics, falhas: (ev.items || []).filter((i) => !i.passed).map((i) => [i.caseId, i.expected, i.actualSummary]) })}`);
  await agents.homologate(como(tenant, homologador), definition.code, draft.version, {}, tx);
  await svc.homologate(como(tenant, avaliador, 'ai:evaluate'), ev.id, { note: 'Golden e adversarial conferidos.' }, tx);
  const dono = como(tenant, ativador);
  await agents.activate(dono, definition.code, draft.version, tx);
  await criarOrcamento(dono, tx, { agentCode: definition.code, limit });
  const auth = { userId: ativador, groupId: tenant.groupId, companyId: tenant.companyId, permissions: perms, roles: ['TESTE'] };
  return { tenant, code: definition.code, registry, auth, orch: new AiOrchestrator({ toolRegistry: registry, clock: FIXO, ...deps }), tx, ctx: dono, version: draft.version, evaluation: ev, pessoas: { criador, disparador, homologador, avaliador, ativador } };
}

/** Uma consulta pelo orquestrador (`taskType` ativa o resolvedor de regra quando existe). */
const rodarNay = (c, texto, over = {}) => c.orch.run({ agentCode: c.code, purpose: 'Consulta de teste', input: texto, taskType: 'consulta', ...over }, over.auth || c.auth, c.tx);

/** Linha do padrão do sistema do agente: aplica a definição com o dono do banco (nenhuma empresa grava no padrão) e devolve a linha com as tools. */
async function semearPadraoDoSistema(definition) {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    const query = async (sql, replacements = {}) => {
      let i = 0;
      const values = [];
      const text = sql.replace(/:(\w+)/g, (_m, name) => { values.push(replacements[name]); i += 1; return `$${i}`; });
      return (await client.query(text, values)).rows;
    };
    const applied = await applySystemDefinition(query, definition);
    const [agent] = await query('SELECT * FROM ai.agents WHERE company_id IS NULL AND code = :code AND version = 1', { code: definition.code });
    const tools = await query('SELECT tool_name, permission_code, risk_level, requires_human_approval, enabled FROM ai.agent_tools WHERE agent_id = :id ORDER BY tool_name', { id: agent.id });
    return { applied, agent, tools };
  } finally {
    await client.end();
  }
}

const pcode = () => crypto.randomUUID().slice(0, 8);

module.exports = { cenarioNay, rodarNay, semearPadraoDoSistema, FIXO, q, pcode, ctxDe, como, svc };
