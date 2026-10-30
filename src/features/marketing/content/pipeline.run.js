'use strict';

const repo = require('./pipeline.repository');
const { executeStep } = require('./pipeline.core');
const { factualStep } = require('./step.factual');
const { brandingStep } = require('./step.branding');
const { complianceStep } = require('./step.compliance');
const { approvalStep } = require('./step.approval');
const { prepareSchedule, scheduleStep } = require('./step.schedule');
const { getDefinition, assertChannelsAllowed } = require('./types/validate');
const { assertSchedulingNotPaused } = require('../degradation.guard');

/** Os passos do pipeline, cada um em UMA transação do chamador (o executeStep trava o item e é idempotente). */
const runFactualCheck = (ctx, t) => executeStep('factual', { ...ctx, input: null }, t, factualStep);
const applyTemplate = (ctx, t) => {
  const input = { templateId: ctx.templateId || null, templateCode: ctx.templateCode || null, variables: ctx.variables || null };
  return executeStep('branding', { ...ctx, input }, t, (step) => brandingStep(step, input));
};
const applyCompliance = (ctx, t) => executeStep('compliance', { ...ctx, input: null }, t, complianceStep);
const requestApprovalIfRequired = (ctx, t) => executeStep('approval', { ...ctx, input: null }, t, approvalStep);

/** schedulePublication(contentItem, channels, when) — Guia §6, função 7. Valida antecedência antes de qualquer escrita. */
async function schedulePublication(ctx, t) {
  const current = await repo.lockItem(ctx.itemId, t);
  if (!current || !['SCHEDULED', 'PUBLISHING', 'PUBLISHED'].includes(current.status)) await assertSchedulingNotPaused(ctx.tenant, t); // M9-D863: passo PAUSE_MARKETING_CAMPAIGNS; o já agendado segue (replay)
  const prepared = await prepareSchedule(ctx.tenant, { channels: ctx.channels, when: ctx.when }, t, ctx.now);
  const item = await repo.lockItem(ctx.itemId, t);
  if (item) assertChannelsAllowed(getDefinition(item.type), prepared.channels); // M9-D409: canal permitido para o tipo
  const input = { channels: prepared.channels, when: prepared.when.toISOString() };
  const result = await executeStep('schedule', { ...ctx, input }, t, (step) => scheduleStep(step, prepared));
  if (result.replay && result.versionId) result.jobs = (await repo.listJobs(result.versionId, t)).map((j) => ({ id: j.id, channel: j.channel, status: j.status, replay: true }));
  return result;
}

/** O próximo passo automático a partir do status; o que não é automático (aprovação humana, agendamento) para a cadeia. */
const NEXT = Object.freeze({
  DRAFT: runFactualCheck, FACT_CHECKED: applyTemplate, BRANDED: applyCompliance, COMPLIANCE_CHECKED: requestApprovalIfRequired,
});

/**
 * Percorre o pipeline até onde for possível: DRAFT -> validação -> marca -> compliance -> aprovação, parando em
 * PENDING_APPROVAL/APPROVED ou numa falha (FACT_CHECK_FAILED). Cada passo roda em transação própria (`withTx`).
 * Retomar após falha é seguro: o passo já concluído devolve o resultado gravado e não duplica versão.
 */
async function runPipeline(ctx, withTx) {
  const first = await withTx((t) => repo.lockItem(ctx.itemId, t));
  let status = first ? first.status : null;
  let last = null;
  for (let guard = 0; guard < 8 && NEXT[status]; guard += 1) {
    last = await withTx((t) => NEXT[status](ctx, t));
    if (last.status === status) break;
    status = last.status;
  }
  return { status, last };
}

module.exports = { runFactualCheck, applyTemplate, applyCompliance, requestApprovalIfRequired, schedulePublication, runPipeline };
