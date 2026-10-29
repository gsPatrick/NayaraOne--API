'use strict';

/**
 * Proposta de ação da NAY (M9-D019): quando a tool exige aprovação humana (HIGH/CRITICAL, domínio sensível, escrita por padrão),
 * o executor não executa: chama `proposeAction`, que congela a ação numa recomendação PENDING (`proposed_action` = tool, versão,
 * argumentos sanitizados e seu hash, retrato das entidades-alvo e seu hash) e leva o run a AWAITING_APPROVAL. O orquestrador
 * PARA ali: nenhuma outra proposta ou escrita naquele run. Quem decide e executa é o ApprovalService (approval/).
 */
const crypto = require('node:crypto');
const { AiRun } = require('../../../models');
const recommendations = require('../recommendations');
const runs = require('../orchestrator/runs');
const { sanitizeToolCalls } = require('../audit/auditSanitizer');
const { hashOf } = require('./toolCallSanitizer');
const { captureSnapshot, refsOf } = require('../approval/approval.snapshot');
const { readApprovalParams } = require('../approval/approval.params');
const E = require('../approval/approval.errors');
const { isSensitiveDomain } = require('./toolRisk');

const PAYMENT_TOOL = 'finance.proposePayment';
/** AI-007: a categoria crítica de cada domínio sensível (código estável, vai no payload da recomendação para a tela de aprovação). */
const CATEGORIA_AI_007 = Object.freeze({ FINANCIAL: 'financeira', LEGAL: 'juridica', BANKING: 'bancaria', PERMISSION: 'permissao', PUBLICATION: 'publicacao' });
const RISK_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Risco da recomendação: o da tool, e no mínimo HIGH quando o domínio é sensível (financeiro, jurídico, bancário, permissão, publicação). */
function proposalRisk(def) {
  const base = RISK_ORDER.includes(def.riskLevel) ? def.riskLevel : 'HIGH';
  return isSensitiveDomain(def) && RISK_ORDER.indexOf(base) < RISK_ORDER.indexOf('HIGH') ? 'HIGH' : base;
}

async function assertRunOpen(runId, companyId, transaction) {
  const run = await AiRun.findOne({ where: { id: runId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!run) throw E.runUnavailable();
  if (run.status === 'AWAITING_APPROVAL') throw E.runAwaiting();
  if (run.status !== 'RUNNING') throw E.runUnavailable();
}

/**
 * @param {object} p registry (ToolRegistry), execCtx (executionContext), agent, runId, transaction (do tenant).
 * @returns {Function} proposeAction({ tool, toolVersion, args, derivedFromUntrusted, derivedFields }) -> { id, status, riskLevel }.
 */
function createProposeAction({ registry, execCtx, agent, runId, transaction }) {
  const ctx = {
    groupId: execCtx.groupId, companyId: execCtx.companyId, serviceIdentity: execCtx.actor.type !== 'USER',
    userId: execCtx.actor.type === 'USER' ? execCtx.actor.userId : null,
  };
  return async function proposeAction({ tool, toolVersion, args, derivedFromUntrusted, derivedFields }) {
    const def = registry.get(tool, toolVersion);
    if (!def) throw E.runUnavailable();
    const params = await readApprovalParams(ctx, transaction);
    if (tool === PAYMENT_TOOL && !params.allowPaymentProposal) throw E.paymentProposalOff();
    await assertRunOpen(runId, ctx.companyId, transaction);

    const cleanArgs = sanitizeToolCalls(args);
    const argsHash = hashOf(cleanArgs);
    const { snapshot, snapshotHash } = await captureSnapshot(refsOf(def, args), transaction);
    const first = snapshot.refs[0];
    const kind = `${String(tool).slice(0, 40)}:${crypto.createHash('sha256').update(`${runId}|${argsHash}`).digest('hex').slice(0, 16)}`;
    const { recommendation } = await recommendations.createRecommendation(ctx, {
      agentCode: (agent && agent.code) || 'NAY', aiRunId: runId,
      relatedEntityType: first ? first.entity : 'AiRun', relatedEntityId: first ? first.id : runId, recommendationType: kind,
      title: `Proposta da NAY: ${tool}`,
      rationale: `${def.description || tool} A ação só será executada depois da aprovação de uma pessoa autorizada.`,
      riskLevel: proposalRisk(def),
      proposedAction: { tool: def.name, toolVersion: def.version, permissionCode: def.permissionCode, args: cleanArgs, argsHash, snapshot, snapshotHash, snapshot_hash: snapshotHash },
      payload: { riskLevel: def.riskLevel, domain: def.domain, ...(CATEGORIA_AI_007[def.domain] ? { categoria: CATEGORIA_AI_007[def.domain] } : {}), ...(derivedFromUntrusted ? { derivedFromUntrusted: true, derivedFields: derivedFields || [] } : {}) },
    }, transaction);
    await runs.finishRun(ctx, runId, { status: 'AWAITING_APPROVAL' }, transaction);
    return { id: recommendation.id, status: recommendation.status, riskLevel: recommendation.riskLevel };
  };
}

module.exports = { createProposeAction, proposalRisk, PAYMENT_TOOL, CATEGORIA_AI_007 };
