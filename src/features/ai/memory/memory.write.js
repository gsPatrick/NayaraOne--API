'use strict';

const { getSetting } = require('../../settings/settings.service');
const { RECOMMENDATION_KEYS, RECOMMENDATION_SETTING_DEFAULTS } = require('../recommendations/recommendation.settings');
const E = require('./memory.errors');
const repo = require('./memory.repository');
const policy = require('./memory.policy');
const { readMemoryParams } = require('./memory.params');
const { resolveValidity } = require('./memory.validity');
const { prepareValue } = require('./memory.value');
const { toMemory } = require('./memory.mapper');
const { auditMemory } = require('./memory.audit');

const DISTINCT = RECOMMENDATION_KEYS.distinctApprover;

/**
 * Regras de gravação comuns a save e correct (M9-D009): permissão por tipo, dono, origem existente da mesma empresa, origem decidida
 * por pessoa (quando quem grava é a NAY), procedimento só de conhecimento homologado por outra pessoa, validade e valor estruturado.
 * Grava a linha ACTIVE e a auditoria. `version`/`supersedesId` vêm da correção.
 */
async function persistMemory(ctx, input, transaction, { now, version = 1, supersedesId = null, auditAction, auditReason, before = null }) {
  const { isAdmin } = policy.assertCanWrite(ctx, input);
  const params = await readMemoryParams(ctx, transaction);
  const ownerUserId = policy.resolveOwner(ctx, input, isAdmin);
  const source = await repo.findSource(ctx, input.sourceType, input.sourceId, transaction);
  if (!source) throw E.sourceNotFound();
  policy.assertSourceDecided(ctx, input.type, source);
  if (input.type === 'APPROVED_PROCEDURE') {
    const distinctApprover = (await getSetting(DISTINCT, ctx, transaction, RECOMMENDATION_SETTING_DEFAULTS[DISTINCT])) !== false;
    policy.assertProcedureSource(ctx, source, { distinctApprover });
  }
  const hasTranscript = input.value !== null && typeof input.value === 'object' && input.value.transcript !== undefined;
  const validity = resolveValidity({ scope: input.scope, expiresAt: input.expiresAt, validFrom: input.validFrom, hasTranscript }, params, now);
  const prepared = await prepareValue(ctx, { ...input, isAdmin, expiresAt: validity.expiresAt }, params, transaction, now);
  const row = await repo.insert(ctx, { ...input, ...validity, ownerUserId, value: prepared.value, version, supersedesId }, transaction);
  const memory = toMemory(row);
  await auditMemory(ctx, auditAction, memory, before, auditReason, transaction);
  return { memory, piiRemoved: prepared.piiRemoved };
}

module.exports = { persistMemory, toMemory, repo };
