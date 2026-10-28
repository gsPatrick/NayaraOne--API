'use strict';

const { sanitizePublicFields } = require('./sanitize');
const repo = require('./pipeline.repository');
const { loadLocked } = require('./pipeline.core');
const { buildFactsFromReadModel, generateDraftWithNay } = require('./step.facts');
const { validateAgainstFacts } = require('./pipeline.factualPort');
const { createContent } = require('./content.create');
const { reviseDraft, REVISABLE } = require('./content.revise');
const { approveContent } = require('./content.approve');
const { changeStatus } = require('./content.status');
const { getContent } = require('./content.timeline');
const pipeline = require('./pipeline.run');
const { nayUnavailable } = require('./pipeline.errors');
const { approvalInvalidatedError } = require('./approval.guard');

/**
 * Marketing / content — serviço do pipeline (M9-D406): fonte -> rascunho NAY -> validação factual -> marca -> compliance ->
 * aprovação -> agendamento. As 6 funções do Guia §6 (+ agendamento) estão exportadas com os nomes do livro; cada passo é
 * idempotente, grava checks_json[passo] e roda em transação própria.
 */
const hasText = (version) => Boolean(version && version.body_json && typeof version.body_json.texto === 'string' && version.body_json.texto.trim());

/** Cria (ou retoma/revisa, com contentItemId) o conteúdo e percorre o pipeline até a aprovação. */
async function createAndRun({ tenant, actor, input, now }, withTx) {
  let itemId = input.contentItemId;
  let nayError = null;
  let created = false;
  if (!itemId) {
    const out = await withTx((t) => createContent({ tenant, actor, input }, t));
    itemId = out.itemId;
    nayError = out.nayError;
    created = true;
  } else {
    const revised = await withTx(async (t) => {
      const { item, version } = await loadLocked(itemId, t);
      const needsRevision = REVISABLE.includes(item.status) && (input.texto !== undefined || item.status === 'FACT_CHECK_FAILED' || !hasText(version));
      return needsRevision ? reviseDraft({ tenant, actor, item, version, input }, t) : null;
    });
    nayError = revised ? revised.nayError : null;
  }
  const state = await withTx(async (t) => (await loadLocked(itemId, t)).version);
  if (hasText(state)) await pipeline.runPipeline({ tenant, actor, itemId, now, ...input }, withTx);
  const content = await withTx((t) => getContent(tenant, itemId, t));
  return { created, content, nayError };
}

async function approve(ctx, transaction) {
  return approveContent(ctx, transaction);
}

/** Agenda e, se a aprovação foi invalidada, devolve o erro 409 já pronto para o chamador lançar DEPOIS do commit. */
async function schedule(ctx, transaction) {
  const result = await pipeline.schedulePublication(ctx, transaction);
  return result.approvalInvalidated ? { ...result, error: approvalInvalidatedError(result.approvalInvalidated) } : result;
}

module.exports = {
  // As funções do Guia §6
  buildFactsFromReadModel,
  generateDraftWithNay,
  validateAgainstFacts,
  sanitizePublicFields,
  applyTemplate: pipeline.applyTemplate,
  requestApprovalIfRequired: pipeline.requestApprovalIfRequired,
  schedulePublication: pipeline.schedulePublication,
  // Passos e rotas
  runFactualCheck: pipeline.runFactualCheck,
  applyCompliance: pipeline.applyCompliance,
  runPipeline: pipeline.runPipeline,
  createAndRun,
  createContent,
  approve,
  schedule,
  changeStatus,
  getContent,
  nayUnavailable,
  repo,
};
