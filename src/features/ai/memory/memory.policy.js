'use strict';

const E = require('./memory.errors');
const { ADMIN_TYPES } = require('./memory.constants');

const has = (ctx, code) => Array.isArray(ctx.permissions) && ctx.permissions.includes(code);

/** Identidade de serviço (a NAY) ou contexto sem pessoa não é humano (AI-007: a NAY não recebe bypass). */
const isHuman = (ctx) => Boolean(ctx && ctx.userId && ctx.serviceIdentity !== true && ctx.actorType !== 'NAY');

/**
 * Quem grava o quê (M9-D009, regra 5 e seção 6). COMPANY_PREFERENCE e APPROVED_PROCEDURE: só pessoa com ai:admin (a NAY propõe).
 * Classificação RESTRICTED: ai:admin. Os demais tipos: ai:use ou ai:admin. Devolve `{ isAdmin }`.
 */
function assertCanWrite(ctx, { type, classification }) {
  const isAdmin = has(ctx, 'ai:admin');
  if (!isAdmin && !has(ctx, 'ai:use')) throw E.denied('ai:use');
  if (ADMIN_TYPES.includes(type)) {
    if (!isHuman(ctx)) throw E.humanRequired();
    if (!isAdmin) throw E.denied('ai:admin');
  }
  if (classification === 'RESTRICTED' && !isAdmin) throw E.denied('ai:admin');
  return { isAdmin };
}

/** O dono de uma memória USER/SESSION: quem grava; outra pessoa só com ai:admin. */
function resolveOwner(ctx, { scope, ownerUserId }, isAdmin) {
  const needsOwner = scope === 'USER' || scope === 'SESSION';
  const wanted = ownerUserId || ctx.userId || null;
  if (needsOwner && !wanted) throw E.invalid('Informe o dono da memória.');
  if (ownerUserId && ownerUserId !== ctx.userId && !isAdmin) throw E.denied('ai:admin');
  return needsOwner ? wanted : (ownerUserId || null);
}

/** A origem da gravação feita pela NAY: DECISION e RECOMMENDATION_OUTCOME só nascem de recomendação com decisão humana registrada. */
function assertSourceDecided(ctx, type, source) {
  if (isHuman(ctx) || ADMIN_TYPES.includes(type)) return;
  if (!source || source.sourceType !== 'RECOMMENDATION' || !source.decision) throw E.sourceNotDecided();
}

/** Procedimento aprovado: origem em conhecimento HOMOLOGADO e, com aprovador distinto, quem ativa não é quem escreveu. */
function assertProcedureSource(ctx, source, { distinctApprover }) {
  if (!source || source.sourceType !== 'KNOWLEDGE_ENTRY' || source.status !== 'HOMOLOGATED') throw E.sourceNotHomologated();
  if (distinctApprover && source.createdBy && source.createdBy === ctx.userId) throw E.selfActivation();
}

/** Leitura: o que a pessoa pode ver. RESTRICTED só com ai:restricted (mesma permissão do contexto da NAY); ai:audit enxerga a empresa. */
function readScope(ctx) {
  const audit = has(ctx, 'ai:audit');
  if (!audit && !has(ctx, 'ai:use') && !has(ctx, 'ai:admin')) throw E.denied('ai:use');
  return { audit, restricted: has(ctx, 'ai:restricted') || audit };
}

/** Invalidar ou corrigir: ai:admin em qualquer memória; quem gravou, só nos tipos que a pessoa grava (decisão e resultado). */
function assertCanChange(ctx, row) {
  if (has(ctx, 'ai:admin')) return;
  if (!has(ctx, 'ai:use') || ADMIN_TYPES.includes(row.memoryType) || row.classification === 'RESTRICTED') throw E.denied('ai:admin');
  const own = row.createdBy === ctx.userId || row.ownerUserId === ctx.userId;
  if (!own || !isHuman(ctx)) throw E.denied('ai:admin');
}

module.exports = { has, isHuman, assertCanWrite, resolveOwner, assertSourceDecided, assertProcedureSource, readScope, assertCanChange };
