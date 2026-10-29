'use strict';

/**
 * ApprovalService (M9-D019) — a única porta que decide e executa uma ação proposta pela NAY. Ordem do aceite: só pessoa; ai:approve;
 * replay (mesmo decisor devolve o resultado, outro usuário ou estado final é 409); permissão da ação alvo; tool, allowlist e
 * argsHash; aprovador distinto e snapshotHash (D007); execução pelo serviço de aplicação com idempotencyKey = recommendation_id;
 * resultado; fechamento do tool_call e do run. Tudo na transação do tenant, com a recomendação travada (FOR UPDATE).
 */
const recommendations = require('../recommendations');
const E = require('../recommendations/recommendation.errors');
const V = require('../recommendations/recommendation.validation');
const P = require('../recommendations/recommendation.permissions');
const { lockOwn, assertDistinctApprover } = require('../recommendations/recommendation.decide');
const { readRecommendationParams } = require('../recommendations/recommendation.params');
const { toRecommendation } = require('../recommendations/recommendation.mapper');
const { initToolRegistry } = require('../tools/bootRegistry');
const { hashOf } = require('../tools/toolCallSanitizer');
const { resolveActiveAgent } = require('../agents/agentResolver.service');
const AE = require('./approval.errors');
const { executeApprovedAction } = require('./approval.execute');
const { closeProposal } = require('./approval.closure');
require('./approval.snapshot'); // registra o verificador de snapshot na M9-D007

const FINAL_EXECUTION = Object.freeze(['EXECUTED', 'EXECUTION_FAILED']);
const result = (rec, extra = {}) => ({ recommendation: rec, replayed: false, outcome: rec.outcome, outcomeDetail: rec.outcomeDetail, ...extra });

/** A tool continua registrada, na mesma versão, e na allowlist ativa do agente? Devolve a definição ou o motivo da perda. */
async function resolveDefinition(ctx, rec, transaction) {
  const action = rec.proposedAction;
  const def = (await initToolRegistry()).get(action.tool, action.toolVersion);
  if (!def) return { lost: 'A ferramenta não está mais disponível.' };
  try {
    const agent = await resolveActiveAgent(rec.agentCode, ctx, transaction);
    if (!(agent.tools || []).some((t) => t.enabled && t.toolName === action.tool)) return { lost: 'A ferramenta saiu da lista permitida do agente.' };
  } catch (err) {
    if (err.code !== 'AI_AGENT_DISABLED') throw err;
    return { lost: 'O agente que fez a proposta não está mais ativo.' };
  }
  return { def };
}

/** PENDING -> STALE por perda de allowlist/tool, fechando tool_call e run; o chamador responde 409 depois de gravar. */
async function staleOut(ctx, rec, reason, transaction) {
  const stale = await recommendations.markStale(ctx, rec.id, { reason }, transaction);
  await closeProposal(ctx, stale, 'STALE', transaction);
  return result(stale, { stale: true });
}

async function approveProposal(ctx, id, data, transaction, row) {
  const rec = toRecommendation(row);
  P.assertCanDecide(ctx, rec);
  if (FINAL_EXECUTION.includes(rec.status) && rec.decidedByUserId === ctx.userId) return result(rec, { replayed: true });
  if (rec.status !== 'PENDING') throw E.state();
  await assertDistinctApprover(ctx, row, await readRecommendationParams(ctx, transaction), transaction); // quem pediu o run não muda o estado da proposta

  const { def, lost } = await resolveDefinition(ctx, rec, transaction);
  if (def && !(ctx.permissions || []).includes(def.permissionCode)) throw AE.permissionDenied(def.permissionCode);
  if (lost) return staleOut(ctx, rec, lost, transaction);
  if (hashOf(rec.proposedAction.args) !== rec.proposedAction.argsHash) {
    const out = await staleOut(ctx, rec, 'Os argumentos da proposta não conferem com o hash registrado.', transaction);
    return { ...out, integrity: true };
  }

  const decided = await recommendations.acceptRecommendation(ctx, id, data, transaction);
  if (decided.stale) {
    await closeProposal(ctx, decided.recommendation, 'STALE', transaction);
    return result(decided.recommendation, { stale: true });
  }
  const run = await executeApprovedAction({ ctx, recommendation: decided.recommendation, def, transaction });
  const outcome = run.ok ? 'EXECUTED' : 'EXECUTION_FAILED';
  const detail = run.ok ? `Executada pelo serviço de ${def.name}.` : `${run.failure.code}: ${run.failure.message}`;
  const done = await recommendations.recordOutcome(ctx, id, { outcome, detail }, transaction);
  await closeProposal(ctx, done, outcome, transaction, { errorCode: run.ok ? undefined : run.failure.code, detail: run.ok ? undefined : run.failure.message });
  return result(done, { output: run.ok ? run.output : undefined });
}

/** POST /v1/ai/recommendations/:id/accept. Recomendação sem ação proposta (informativa) segue a decisão simples da D007. */
async function approveRecommendation(ctx, id, data, transaction) {
  V.ctxOk(ctx);
  P.assertHuman(ctx);
  const row = await lockOwn(ctx, id, transaction);
  const action = toRecommendation(row).proposedAction;
  if (!action || !action.tool) return recommendations.acceptRecommendation(ctx, id, data, transaction);
  return approveProposal(ctx, id, data, transaction, row);
}

/** POST /v1/ai/recommendations/:id/reject — motivo obrigatório (parâmetro da D007); nada é executado. */
async function rejectRecommendation(ctx, id, data, transaction) {
  V.ctxOk(ctx);
  P.assertHuman(ctx);
  const rec = toRecommendation(await lockOwn(ctx, id, transaction));
  const out = await recommendations.rejectRecommendation(ctx, id, data, transaction);
  if (rec.proposedAction && rec.proposedAction.tool && !out.replayed) await closeProposal(ctx, out.recommendation, 'REJECTED', transaction);
  return out;
}

module.exports = { approveRecommendation, rejectRecommendation };
