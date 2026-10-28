'use strict';

const { AiSource } = require('../../../../models');
const { getSetting } = require('../../../../features/settings/settings.service');
const { redactForClassification } = require('../../security/piiRedactor');
const { AI_SETTING_DEFAULTS } = require('../../ai.settings');
const V = require('./runs.validation');
const { toSource } = require('./runs.mapper');
const { loadOwn, guarded } = require('./runLifecycle');

const EXCERPT_KEY = 'ia.fonte.excerpt_max_caracteres';

/** Limite do trecho: parâmetro da empresa (ia.fonte.excerpt_max_caracteres); padrão 500. */
async function excerptLimit(ctx, transaction) {
  const raw = await getSetting(EXCERPT_KEY, ctx, transaction, AI_SETTING_DEFAULTS[EXCERPT_KEY]);
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : AI_SETTING_DEFAULTS[EXCERPT_KEY];
}

/** Trecho sem credencial nem dado pessoal (redaction do perfil `ai`, M9-D027) e no máximo `limit` caracteres: nunca o documento completo. */
function preparedExcerpt(text, limit, classification) {
  if (text === null || text === undefined) return null;
  return redactForClassification(text, classification).slice(0, limit);
}

/** Grava uma fonte recuperada pelo run (enquanto ele não é final: run final => 409 AI_RUN_IMMUTABLE pelo gatilho). */
async function recordSource(ctx, runId, data, transaction) {
  V.ctxOk(ctx);
  const s = V.parseSource(data);
  return guarded(async () => {
    const run = await loadOwn(ctx, runId, transaction);
    const limit = await excerptLimit(ctx, transaction);
    const row = await AiSource.create({
      groupId: ctx.groupId, companyId: ctx.companyId, aiRunId: run.id, sourceType: s.sourceType, sourceRef: s.sourceRef,
      sourceVersion: s.sourceVersion, excerpt: preparedExcerpt(s.excerpt, limit, s.classification), classification: s.classification,
      effectiveFrom: s.effectiveFrom, effectiveUntil: s.effectiveUntil, retrievedAt: s.retrievedAt || new Date(),
      relevanceScore: s.relevanceScore, usedInAnswer: s.usedInAnswer, statusAtRetrieval: s.statusAtRetrieval, contentHash: s.contentHash,
      createdBy: ctx.userId || null, updatedBy: ctx.userId || null,
    }, { transaction });
    return toSource(row);
  });
}

module.exports = { recordSource, excerptLimit, EXCERPT_KEY };
