'use strict';

const { AiRun, AiFeedback, AiGoldenCandidate } = require('../../../../models');
const E = require('../evaluations.errors');
const C = require('../evaluations.constants');
const V = require('../evaluations.validation');
const { redactForAi } = require('../../../../shared/redaction');
const { publishDomainEvent } = require('../../../../engines/events/outbox');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');

const RATINGS = Object.freeze(['UP', 'DOWN']);
const CATEGORY_MAX = 40;

function parse(body) {
  if (!V.isObject(body)) throw E.feedbackInvalid('Corpo do feedback ausente.');
  const rating = typeof body.rating === 'string' ? body.rating.trim().toUpperCase() : '';
  if (!RATINGS.includes(rating)) throw E.feedbackInvalid('Informe a avaliação: UP ou DOWN.');
  const text = (value, nome, max) => {
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
    if (typeof value !== 'string') throw E.feedbackInvalid(`${nome} deve ser um texto.`);
    if (value.length > max) throw E.feedbackInvalid(`${nome} deve ter até ${max} caracteres.`);
    return redactForAi(value.trim());
  };
  return { rating, category: text(body.category, 'A categoria', CATEGORY_MAX), comment: text(body.comment, 'O comentário', C.COMMENT_MAX) };
}

const snapshot = (f) => ({ id: f.id, runId: f.runId, userId: f.userId, rating: f.rating, category: f.category });
const toFeedback = (f) => ({ id: f.id, runId: f.runId, userId: f.userId, rating: f.rating, category: f.category, comment: f.comment, createdAt: new Date(f.created_at || f.createdAt).toISOString() });

/**
 * Feedback humano sobre um run (POST /ai/runs/:id/feedback, ai:use). Uma linha por (run, pessoa): repetir atualiza. É dado de
 * avaliação: um DOWN abre um candidato PENDENTE na fila do golden dataset (aprovada por pessoa depois); NADA aqui altera prompt,
 * regra, permissão, modelo nem allowlist, e este arquivo não importa nenhum serviço que altere essas coisas. O run precisa ser da
 * pessoa (ou ela ter ai:audit) e da empresa: senão 404 sem revelar existência.
 */
async function recordFeedback(ctx, runId, body, transaction) {
  V.ctxOk(ctx);
  if (!ctx.userId || ctx.serviceIdentity === true) throw E.humanOnly();
  const data = parse(body);
  if (!V.isUuid(runId)) throw E.runNotFound();
  const run = await AiRun.findOne({ where: { id: runId, companyId: ctx.companyId }, transaction });
  const audit = Array.isArray(ctx.permissions) && ctx.permissions.includes('ai:audit');
  if (!run || (!audit && run.userId !== ctx.userId)) throw E.runNotFound();
  let row = await AiFeedback.findOne({ where: { runId: run.id, userId: ctx.userId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  const before = row ? snapshot(row) : null;
  const replaced = Boolean(row);
  if (row) {
    Object.assign(row, data);
    await row.save({ transaction });
  } else {
    row = await AiFeedback.create({ groupId: ctx.groupId, companyId: ctx.companyId, runId: run.id, userId: ctx.userId, ...data }, { transaction });
  }
  let candidate = null;
  if (row.rating === 'DOWN') {
    candidate = await AiGoldenCandidate.findOne({ where: { feedbackId: row.id, companyId: ctx.companyId }, transaction });
    if (!candidate) {
      candidate = await AiGoldenCandidate.create({
        groupId: ctx.groupId, companyId: ctx.companyId, feedbackId: row.id, runId: run.id, agentCode: run.agentName || null, category: row.category, comment: row.comment,
      }, { transaction });
    }
  }
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId, action: 'ai.feedback.recorded', entityType: 'AiFeedback', entityId: row.id,
    beforeJson: before || { registro: 'inexistente' }, afterJson: snapshot(row), reason: 'Feedback humano sobre uma execução da NAY.',
  }, transaction);
  await publishDomainEvent({
    groupId: ctx.groupId, companyId: ctx.companyId, aggregateType: 'AiFeedback', aggregateId: row.id, eventType: C.EVENTS.feedback,
    payload: { feedbackId: row.id, runId: run.id, rating: row.rating, candidateId: candidate ? candidate.id : null },
    idempotencyKey: `${C.EVENTS.feedback}:${row.id}:${row.rating}`,
  }, transaction);
  return { feedback: toFeedback(row), candidateId: candidate ? candidate.id : null, replaced };
}

module.exports = { recordFeedback };
