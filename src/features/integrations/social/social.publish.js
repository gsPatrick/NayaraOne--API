'use strict';

const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { enqueue } = require('../dispatch/enqueue/dispatch.service');
const { assertPublishable } = require('./social.gate');
const { socialIdempotencyKey, slotOf } = require('./social.key');
const { formatContentRef, buildPostPayload, MODES } = require('./social.payload');
const errors = require('./social.errors');

const OPERATION = 'publishPost';
const AGGREGATE = 'MarketingContentItem';

function parseSchedule(scheduledAt) {
  if (scheduledAt === undefined || scheduledAt === null || scheduledAt === '') return null;
  const quando = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(quando.getTime())) throw errors.scheduleInvalid();
  return quando;
}

/** Um envio de post para UMA rede (connection), num savepoint: o erro de uma rede não desfaz nem atrasa as outras. */
async function enqueueOne(ctx, { content, mode, connectionId, scheduledAt }, transaction) {
  const contentRef = formatContentRef({ itemId: content.item_id, versionId: content.version_id, approvedHash: content.approved_hash, mode });
  const key = socialIdempotencyKey({ contentId: content.item_id, contentVersion: content.version_no, connectionId, scheduledSlot: slotOf(scheduledAt) });
  const r = await enqueue({
    companyId: ctx.companyId, connectionId, operation: OPERATION, aggregateType: AGGREGATE, aggregateId: content.item_id, userId: ctx.userId || null,
    payload: buildPostPayload({ version: content, contentRef, scheduledAt }), idempotencyKey: key, nextAttemptAt: scheduledAt || undefined, transaction,
  });
  return { dispatchId: r.dispatchId, status: r.status, created: r.created, idempotencyKey: key };
}

/**
 * publishToSocial — publica um conteúdo APROVADO em uma ou mais redes (M9-D239). A porta (`assertPublishable`) recusa o que não foi aprovado,
 * foi editado depois da aprovação, é da NAY sem aprovação humana, está sob kill switch ou é automático sem política. Cada rede (connection,
 * com o seu segredo no cofre) vira UM envio com chave sha256(conteúdo|versão|rede|horário): repetir o mesmo pedido devolve o mesmo envio
 * (`created:false`). O agendamento grava o envio UMA vez com `next_attempt_at` = horário. O resultado é por rede e independente: a falha de
 * enfileirar uma não cancela as outras. `args`: { contentItemId, connectionIds[], scheduledAt?, mode? ('MANUAL'|'AUTO'), transaction }.
 */
async function publishToSocial(ctx, args) {
  const { contentItemId, transaction } = args;
  const mode = args.mode || 'MANUAL';
  if (!MODES.includes(mode)) throw AppError.badRequest('Modo de publicação inválido. Use MANUAL ou AUTO.', 'INTEGRATION_SOCIAL_MODE_INVALID');
  const redes = [...new Set(Array.isArray(args.connectionIds) ? args.connectionIds : [])];
  if (redes.length === 0) throw errors.noNetwork();
  const scheduledAt = parseSchedule(args.scheduledAt);
  const content = await assertPublishable(ctx, { itemId: contentItemId, mode }, transaction, { lock: true });
  const results = [];
  for (const connectionId of redes) {
    try {
      const r = await sequelize.transaction({ transaction }, (savepoint) => enqueueOne(ctx, { content, mode, connectionId, scheduledAt }, savepoint));
      results.push({ connectionId, ok: true, ...r });
    } catch (err) {
      results.push({ connectionId, ok: false, code: err.code || 'INTEGRATION_SOCIAL_NETWORK_FAILED', message: err.message });
    }
  }
  return { contentItemId, versionId: content.version_id, versionNo: content.version_no, scheduledAt, mode, results };
}

module.exports = { publishToSocial, enqueueOne, parseSchedule, OPERATION, AGGREGATE };
