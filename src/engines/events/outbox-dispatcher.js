'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, OutboxEvent } = require('../../models');

/**
 * Outbox dispatcher — worker/processor simples do padrão Transactional Outbox
 * (03_MOTORES_TRANSVERSAIS.md §2.2/§2.4).
 *
 * NESTA ETAPA (Marco 1/2) não há broker real (RabbitMQ) plugado — ver decisão de design
 * documentada em src/documentacao/features/EventsEngine.md. `dispatchPendingEvents` lê um
 * lote de eventos PENDING com `SELECT ... FOR UPDATE SKIP LOCKED` (permite múltiplos workers
 * concorrentes sem processar o mesmo evento duas vezes — §2.2 "Publisher concorrente"),
 * loga cada evento (stand-in do publish real) e marca como DISPATCHED.
 *
 * Para plugar um broker real depois, troque apenas a função `publishToBroker` abaixo — o
 * contrato de leitura/lock/retry do outbox permanece o mesmo.
 */
async function publishToBroker(event) {
  // eslint-disable-next-line no-console
  console.log(
    `[OutboxDispatcher] publish ${event.eventType} aggregate=${event.aggregateType}:${event.aggregateId} idempotencyKey=${event.idempotencyKey}`
  );
  return true;
}

const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000]; // 1m/5m/15m/1h/4h (§2.3 TRANSIENT)
const MAX_RETRIES = RETRY_BACKOFF_MS.length;

/**
 * dispatchPendingEventsForCompany — a query original não definia `app.company_id` nenhuma
 * (`SET LOCAL`) antes de ler "integration"."outbox_events" — uma tabela com RLS habilitado e
 * FORÇADO (ver migration). Sem esse contexto, a política `tenant_isolation` compara
 * `company_id = NULL::uuid`, que nunca bate com nada — ou seja, com RLS realmente em vigor
 * (usuário de banco sem BYPASSRLS), esta função sempre devolveria zero eventos, silenciosamente,
 * para sempre. Corrigido para abrir o contexto de tenant explicitamente por empresa, mesmo
 * padrão já usado em radarMatchingJob.js.
 */
async function dispatchPendingEventsForCompany(group, company, { limit }) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });

    const pending = await OutboxEvent.findAll({
      where: {
        status: 'PENDING',
        [Op.or]: [{ nextRetryAt: null }, { nextRetryAt: { [Op.lte]: new Date() } }],
      },
      order: [['occurred_at', 'ASC']],
      limit,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
      transaction,
    });

    const results = { dispatched: 0, deadLettered: 0, failed: 0 };

    for (const event of pending) {
      try {
        await publishToBroker(event);
        event.status = 'DISPATCHED';
        await event.save({ transaction });
        results.dispatched += 1;
      } catch (err) {
        event.retryCount += 1;
        if (event.retryCount >= MAX_RETRIES) {
          event.status = 'DEAD_LETTER';
          event.deadLetterReason = err.message;
          results.deadLettered += 1;
        } else {
          event.nextRetryAt = new Date(Date.now() + RETRY_BACKOFF_MS[event.retryCount - 1]);
          results.failed += 1;
        }
        await event.save({ transaction });
      }
    }

    return results;
  });
}

async function dispatchPendingEvents({ limit = 100 } = {}) {
  const groups = await Group.findAll();
  const totals = { dispatched: 0, deadLettered: 0, failed: 0, companiesChecked: 0, errors: 0 };

  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });

    for (const company of companies) {
      totals.companiesChecked += 1;
      try {
        const result = await dispatchPendingEventsForCompany(group, company, { limit });
        totals.dispatched += result.dispatched;
        totals.deadLettered += result.deadLettered;
        totals.failed += result.failed;
      } catch (err) {
        totals.errors += 1;
        // eslint-disable-next-line no-console
        console.error(`[OutboxDispatcher] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`);
      }
    }
  }

  return totals;
}

module.exports = { dispatchPendingEvents, dispatchPendingEventsForCompany, publishToBroker };
