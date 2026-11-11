'use strict';

const { AiOrchestrator, isAiEnabled, isAgentEnabled } = require('../../../features/ai');
const { runAiFunction, runDeterministic } = require('../../../features/ai/deterministic');
const { compareInstruction } = require('../../../features/ai/agents/nay_juridica');
const { assertUuid } = require('../../../utils/inputGuards');
const { AiRecommendation } = require('../../../models');
const { compareInspections } = require('./inspection.service');

/**
 * Livro §11 "NAY pode comparar entrada x saída e sugerir diferenças; humano valida responsabilidade/cobrança" (M5-A0092), pela
 * infraestrutura de IA do Marco 9:
 *  - IA ligada e NAY Jurídica habilitada: um run do orquestrador; o servidor chama a tool legal.compareInspections (gancho do agente),
 *    cada diferença é FONTE citável e a checagem de fontes do orquestrador corta frase sem fonte (grounding). Cada diferença vira
 *    recomendação PENDENTE (ai.ai_recommendations) para uma pessoa aceitar ou rejeitar — aceitar não cria cobrança nem muda a vistoria.
 *  - IA desligada, agente desabilitado ou provedor fora: o caminho determinístico equivalente (mesma comparação, sem texto de modelo,
 *    M9-D228); a validação humana continua na tela da vistoria.
 * Só leitura no jurídico: nada na vistoria muda.
 */
const AGENT = 'NAY_JURIDICA';
const UNAVAILABLE = ['UNAVAILABLE', 'TIMEOUT', 'RATE_LIMIT', 'AI_PROVIDER_UNAVAILABLE', 'AI_RUN_TIMEOUT'];

function shapeAiOutcome(out) {
  return {
    answer: out.answer || null,
    groundingStatus: out.groundingStatus || null,
    sources: out.sources || [],
    runId: out.runId || null,
    status: out.status || null,
    blockedReason: out.blockedReason || null,
    error: out.ok === false ? out.error || null : null,
  };
}

/** `deps.instructionSuffix` só para teste (fixtura do provedor simulado); `deps.orchestrator` troca as dependências do orquestrador. */
async function compareInspectionsWithNay(auth, { entryInspectionId, exitInspectionId }, transaction, deps = {}) {
  assertUuid(entryInspectionId, 'entryInspectionId', 'LEGAL_INSPECTION_VALIDATION');
  assertUuid(exitInspectionId, 'exitInspectionId', 'LEGAL_INSPECTION_VALIDATION');
  const input = { entryInspectionId, exitInspectionId };
  const tenant = { groupId: auth.groupId, companyId: auth.companyId };
  const aiOff = !(await isAiEnabled(tenant, transaction)) || !(await isAgentEnabled(AGENT, tenant, transaction));
  if (aiOff || !(auth.permissions || []).includes('ai:use')) {
    const det = await runDeterministic(auth, 'legal.compareInspections', input, transaction);
    return { mode: 'DETERMINISTIC', reason: aiOff ? 'AI_OFF' : 'NO_AI_PERMISSION', comparison: det.data, nay: null, requiresHumanValidation: true };
  }
  const outcome = await runAiFunction(auth, 'legal.compareInspections', {
    input,
    ai: async () => {
      const out = await new AiOrchestrator(deps.orchestrator || {}).run({
        agentCode: AGENT,
        purpose: 'Comparar a vistoria de entrada com a de saída e sugerir as diferenças para validação humana (livro M5 §11).',
        taskType: 'consulta',
        input: `${compareInstruction(entryInspectionId, exitInspectionId)}${deps.instructionSuffix ? ` ${deps.instructionSuffix}` : ''}`,
        subject: { type: 'LEGAL_INSPECTION', id: exitInspectionId },
      }, auth, transaction);
      if (!out.ok && out.error && UNAVAILABLE.includes(out.error.code)) throw Object.assign(new Error(out.error.message), { code: out.error.code });
      return out;
    },
  }, transaction);
  if (outcome.mode !== 'NORMAL') {
    return { mode: 'DETERMINISTIC', reason: outcome.reason, comparison: outcome.result.data, nay: null, requiresHumanValidation: true };
  }
  const nay = shapeAiOutcome(outcome.result);
  // As sugestões que a pessoa valida (aceita/rejeita em /v1/ai/recommendations/:id/accept|reject) e o comparativo item a item.
  const recommendations = nay.runId
    ? (await AiRecommendation.findAll({ where: { aiRunId: nay.runId }, order: [['created_at', 'ASC']], transaction })).map((r) => ({ id: r.id, title: r.title, status: r.status, rationale: r.rationale }))
    : [];
  return { mode: 'AI', reason: null, comparison: await compareInspections(entryInspectionId, exitInspectionId, transaction), nay: { ...nay, recommendations }, requiresHumanValidation: true };
}

module.exports = { compareInspectionsWithNay };
