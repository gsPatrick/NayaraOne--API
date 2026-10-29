'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, OutboxEvent } = require('../../models');
const { outboxPendingGauge, outboxDeadLetterGauge } = require('../../utils/metrics');
const { runEventConsumers, runBatchEnd } = require('./consumers');
const { getDispatchEnqueuer, buildEnqueueArgs } = require('./dispatchGateway');
const { getOutboxBackoff, applyFailure } = require('./outboxBackoff');

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

// Backoff (1m/5m/15m/1h/4h por padrão, §2.3 TRANSIENT) e limite de tentativas vêm do parâmetro
// integration.outbox.backoff_ms (M9-D204); ver outboxBackoff.js.

/**
 * Evento com destino externo (M9-D204): o evento vira uma linha de dispatch na própria transação do
 * despacho e só então é marcado PUBLISHED. Quem confirma o fornecedor é o dispatch, não o outbox.
 * Um savepoint isola a falha de um evento para não abortar o lote.
 */
async function publishExternalEvent(event, enqueue, transaction) {
  await sequelize.transaction({ transaction }, async (savepoint) => {
    await enqueue(buildEnqueueArgs(event, savepoint));
  });
  event.status = 'PUBLISHED';
  await event.save({ transaction });
}

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

    const results = { dispatched: 0, published: 0, waiting: 0, deadLettered: 0, failed: 0 };
    const backoff = await getOutboxBackoff(company, transaction);
    const enqueue = getDispatchEnqueuer();

    for (const event of pending) {
      try {
        if (event.targetDomain) {
          if (!enqueue) {
            results.waiting += 1; // sem Dispatch Service registrado: continua PENDING, sem gastar tentativa
            continue;
          }
          await publishExternalEvent(event, enqueue, transaction);
          results.published += 1;
        } else {
          await publishToBroker(event);
          await runEventConsumers(event, transaction);
          event.status = 'DISPATCHED';
          await event.save({ transaction });
          results.dispatched += 1;
        }
      } catch (err) {
        const outcome = applyFailure(event, err, backoff);
        results[outcome] += 1;
        await event.save({ transaction });
      }
    }

    await runBatchEnd(transaction);
    return results;
  });
}

async function dispatchPendingEvents({ limit = 100 } = {}) {
  const groups = await Group.findAll();
  const totals = { dispatched: 0, published: 0, waiting: 0, deadLettered: 0, failed: 0, companiesChecked: 0, errors: 0 };

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
        totals.published += result.published;
        totals.waiting += result.waiting;
        totals.deadLettered += result.deadLettered;
        totals.failed += result.failed;
      } catch (err) {
        totals.errors += 1;
        // eslint-disable-next-line no-console
        console.error(`[OutboxDispatcher] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`);
      }
    }
  }

  // Métricas (TEC-13): contagem global de PENDING/DEAD_LETTER, agregada entre todos os
  // tenants — é leitura operacional interna (nunca exposta a usuário final), não dado de
  // negócio de uma empresa específica. RESSALVA HONESTA: como "integration"."outbox_events"
  // tem RLS por company_id, esta contagem SEM SET LOCAL só enxerga todos os tenants de verdade
  // enquanto a conexão da API tiver BYPASSRLS (ver pendência TEC-03/04) — se esse privilégio
  // for corrigido no futuro, este COUNT passa a sempre ver zero e precisará ser reescrito para
  // somar por tenant (mesmo padrão de SET LOCAL usado no resto deste arquivo).
  try {
    const [pendingCount, deadLetterCount] = await Promise.all([
      OutboxEvent.count({ where: { status: 'PENDING' } }),
      OutboxEvent.count({ where: { status: 'DEAD_LETTER' } }),
    ]);
    outboxPendingGauge.set(pendingCount);
    outboxDeadLetterGauge.set(deadLetterCount);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[OutboxDispatcher] Falha ao atualizar métricas:', err.message);
  }

  return totals;
}

module.exports = { dispatchPendingEvents, dispatchPendingEventsForCompany, publishToBroker };
