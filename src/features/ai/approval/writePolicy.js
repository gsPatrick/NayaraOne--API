'use strict';

/**
 * Política de escrita da NAY (M9-D019), montada por tool call: decide o que executa direto e entrega o `proposeAction`.
 * Só escrita LOW/MEDIUM de domínio OTHER, idempotente e sem aprovação exigida pode executar direto, e apenas com
 * `ia.escrita_direta_baixo_risco` Ligado (padrão Desligado: tudo vira proposta), por uma pessoa (nunca identidade de serviço) e
 * com o run ainda livre (depois de uma proposta o run PARA). HIGH, CRITICAL e domínio sensível nunca executam direto.
 */
const { AiRun } = require('../../../models');
const { createProposeAction } = require('../tools/proposals');
const { isSensitiveDomain } = require('../tools/toolRisk');
const { readApprovalParams } = require('./approval.params');

const DIRECT_RISKS = Object.freeze(['LOW', 'MEDIUM']);

function eligibleForDirectWrite(def) {
  return def.category === 'WRITE' && def.domain === 'OTHER' && !isSensitiveDomain(def) && DIRECT_RISKS.includes(def.riskLevel)
    && def.requiresHumanApproval === false && def.idempotent === true;
}

async function createWritePolicy({ registry, execCtx, agent, runId, transaction }) {
  const params = await readApprovalParams(execCtx, transaction);
  const run = runId ? await AiRun.findOne({ where: { id: runId, companyId: execCtx.companyId }, transaction }) : null;
  const open = Boolean(run) && run.status === 'RUNNING';
  const directWriteEnabled = params.directLowRiskWrite && open && execCtx.actor.type === 'USER';
  return {
    directWriteEnabled,
    allowDirectWrite: (def) => directWriteEnabled && eligibleForDirectWrite(def),
    proposeAction: runId ? createProposeAction({ registry, execCtx, agent, runId, transaction }) : undefined,
  };
}

module.exports = { createWritePolicy, eligibleForDirectWrite };
