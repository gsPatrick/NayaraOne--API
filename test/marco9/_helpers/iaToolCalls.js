'use strict';

// Apoio dos testes de ai.tool_calls (M9-D006): tool que conta execuções, partes do contexto com empresa real, run aberto e
// execução da tool pelo executor (M9-D002) com o recorder real.
const crypto = require('node:crypto');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { executeTool } = require('../../../src/features/ai/tools/toolExecutor');
const { createToolCallRecorder } = require('../../../src/features/ai/tools/toolCallRecorder');
const { q, run } = require('../../helpers/aiRuns');

const LIMITES = Object.freeze({ stringMax: 500, arrayMax: 50 });
const logger = { info() {}, warn() {}, error() {}, debug() {} };

const schemaBasico = (extra = {}) => ({
  type: 'object',
  properties: { ref: { type: 'string' }, nota: { type: 'string' }, documento: { type: 'string', sensitive: true }, cpf: { type: 'string' }, ...extra },
  additionalProperties: false,
});

/** Tool de leitura. `execucoes` guarda cada chamada de execute; `resultado`/`falha`/`atrasoMs` controlam a saída. */
function ferramenta({ nome = 'crm.getOpportunity', resultado = { ok: true, itens: 3 }, falha = null, atrasoMs = 0, inputSchema = schemaBasico(), over = {} } = {}) {
  const execucoes = [];
  const tool = {
    name: nome, version: 1, permissionCode: 'crm:read', riskLevel: 'LOW', category: 'READ', domain: 'OTHER', requiresHumanApproval: false,
    inputSchema,
    async execute(_ctx, input) {
      execucoes.push(input);
      if (atrasoMs) await new Promise((r) => setTimeout(r, atrasoMs));
      if (falha) throw falha;
      return typeof resultado === 'function' ? resultado(input) : resultado;
    },
    ...over,
  };
  return { tool, execucoes };
}

const partes = (tenant, over = {}) => ({
  auth: { userId: tenant.userId, permissions: ['crm:read'] }, companyId: tenant.companyId, groupId: tenant.groupId,
  services: {}, readModels: {}, logger, correlationId: 'corr-d006', ...over,
});

/** Abre um run RUNNING e devolve o ctx (com permissões) e o id. */
async function abrirRun(ctx, tx, extra = {}) {
  const { run: r } = await runs.startRun(ctx, { agentName: 'NAY_TESTE', purpose: 'teste', inputSummary: 'pergunta', ...extra }, tx);
  return r.id;
}

/** Executa a tool pelo executor com um recorder novo (um por chamada, como faz o orquestrador). */
function rodar({ tenant, ctx, tx, runId, tool, input, seq, nome, proposeAction, over = {} }) {
  const recorder = createToolCallRecorder({ ctx, transaction: tx, runId });
  const toolName = nome || tool.name;
  return executeTool({
    registry: { [toolName]: tool }, toolName, input, contextParts: partes(tenant), recorder, proposeAction, argsLimits: LIMITES, transaction: tx, seq, ...over,
  }).then((r) => ({ ...r, recorder }));
}

const linhas = (runId, tx) => q('SELECT * FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);
const sha = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

/** Insere por SQL uma chamada já em EXECUTING (só para provar o 409 de chamada em andamento). */
async function inserirEmExecucao(tenant, tx, runId, { tool, argsHash, chave, seq = 1 }) {
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO ai.tool_calls (id, group_id, company_id, run_id, seq, tool_name, tool_version, permission_code, risk_level, args_hash, idempotency_key)
     VALUES (:id, :g, :c, :runId, :seq, :tool, '1', 'crm:read', 'LOW', :h, :k)`,
    { id, g: tenant.groupId, c: tenant.companyId, runId, seq, tool, h: argsHash, k: chave }, tx
  );
  await run("UPDATE ai.tool_calls SET status = 'VALIDATED' WHERE id = :id", { id }, tx);
  await run("UPDATE ai.tool_calls SET status = 'EXECUTING' WHERE id = :id", { id }, tx);
  return id;
}

module.exports = { LIMITES, schemaBasico, ferramenta, partes, abrirRun, rodar, linhas, sha, inserirEmExecucao };
