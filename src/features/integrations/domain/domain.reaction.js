'use strict';

const { registerEventConsumer } = require('../../../engines/events/consumers');
const { consumeInboundEvent } = require('../../../engines/events/inbox');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

/**
 * registerDomainReaction — o jeito de um módulo de negócio reagir a um evento interno da integração (`integration.dispatch.confirmed`, `.failed`, `.needs_manual_review`, M9-D220 3.1
 * itens 2 e 4). O domínio muda o PRÓPRIO estado só por evento interno (ou ação do usuário); a ausência de resposta do fornecedor nunca muda nada. O consumo é idempotente por
 * `(consumidor, id do evento)` na caixa de entrada de eventos (`consumeInboundEvent`): o evento entregue duas vezes é aplicado uma só. A reação roda na transação do despachante, e o
 * `handler(ctx, event, transaction)` trava o agregado (FOR UPDATE) e relê o estado antes de decidir. Se devolver `{ entity: { type, id }, before, after, reason }`, a reação é auditada
 * (antes e depois). `event.payloadJson` leva só ids e códigos, nunca o conteúdo enviado.
 */
function registerDomainReaction({ eventType, consumer, handler }) {
  registerEventConsumer(eventType, consumer, async (event, transaction) => {
    const ctx = { groupId: event.groupId, companyId: event.companyId, userId: null };
    return consumeInboundEvent({
      sourceId: consumer, eventId: event.id, groupId: event.groupId, companyId: event.companyId, payload: { eventType: event.eventType, dispatchId: (event.payloadJson || {}).dispatchId || null }, transaction,
    }, async () => {
      const out = await handler(ctx, event, transaction);
      if (out && out.entity) {
        await registrarAuditoria({
          groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: `integration.reaction.${consumer}`, entityType: out.entity.type, entityId: out.entity.id,
          beforeJson: out.before || null, afterJson: out.after || null, reason: out.reason || `Reação do domínio ao evento ${event.eventType}.`,
        }, transaction);
      }
    });
  });
}

module.exports = { registerDomainReaction };
