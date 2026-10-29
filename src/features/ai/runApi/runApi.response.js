'use strict';

const AppError = require('../../../utils/AppError');
const { AiRun } = require('../../../models');

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Corpo 200 de /ai/runs e do chat (contrato da M9-D030). A moeda vem do run gravado. */
async function toResponseData({ outcome, conversationId }, ctx, transaction) {
  const run = await AiRun.findOne({ where: { id: outcome.runId, companyId: ctx.companyId }, attributes: ['costCurrency'], transaction });
  const data = {
    runId: outcome.runId,
    status: outcome.status,
    answer: outcome.answer,
    sources: outcome.sources || [],
    groundingStatus: outcome.groundingStatus,
    confidence: outcome.confidence === undefined ? null : outcome.confidence,
    snapshotAt: outcome.snapshotAt ? new Date(outcome.snapshotAt).toISOString() : null,
    proposals: outcome.proposals || [],
    cost: { amount: outcome.cost ? outcome.cost.amount : null, currency: run ? run.costCurrency : 'BRL' },
    routingPath: outcome.routingPath,
    structured: outcome.structured || null,
    replayed: Boolean(outcome.replayed),
  };
  if (conversationId) data.conversationId = conversationId;
  return data;
}

/** Falha do orquestrador (`ok: false`) como o erro HTTP da tabela "Falha por passo"; o `runId` vai em details. */
function failureToError(outcome) {
  const { status, code, message, details } = outcome.error;
  const base = isPlain(details) ? details : {};
  return new AppError(message, status, code, outcome.runId ? { ...base, runId: outcome.runId } : (details === undefined ? undefined : details));
}

module.exports = { toResponseData, failureToError };
