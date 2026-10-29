'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * ÚNICO ponto de escrita em governance.calendar_items. O calendário nunca muda o próprio item por ação do usuário (não há rota
 * de escrita): quem grava é o projetor (M9-D802) e a origem de compromissos avulsos (commitments.service). UPSERT por
 * (company_id, source_type, source_id): evento repetido não duplica; a versão da projeção sobe a cada gravação.
 * Roda na transação do chamador (item e fato de origem no mesmo commit; a RLS exige o tenant já aplicado na transação).
 */
const UPSERT_SQL = `
INSERT INTO governance.calendar_items
  (group_id, company_id, source_type, source_id, title, owner_user_id, owner_team, due_at, end_at, severity, status, deep_link,
   source_kind, cancel_reason, last_event_id, last_event_occurred_at)
VALUES
  (:groupId, :companyId, :sourceType, :sourceId, :title, :ownerUserId, :ownerTeam, :dueAt, :endAt, :severity, :status, :deepLink,
   :sourceKind, :cancelReason, :lastEventId, :lastEventOccurredAt)
ON CONFLICT (company_id, source_type, source_id) DO UPDATE SET
  title = EXCLUDED.title, owner_user_id = EXCLUDED.owner_user_id, owner_team = EXCLUDED.owner_team, due_at = EXCLUDED.due_at,
  end_at = EXCLUDED.end_at, severity = EXCLUDED.severity, status = EXCLUDED.status, deep_link = EXCLUDED.deep_link,
  source_kind = EXCLUDED.source_kind, cancel_reason = EXCLUDED.cancel_reason, last_event_id = EXCLUDED.last_event_id,
  last_event_occurred_at = EXCLUDED.last_event_occurred_at,
  projection_version = governance.calendar_items.projection_version + 1, updated_at = now()
RETURNING *`;

async function upsertItem(tenant, item, transaction) {
  if (!transaction) throw new Error('upsertItem exige a transação do chamador (item e origem no mesmo commit).');
  const rows = await sequelize.query(UPSERT_SQL, {
    type: QueryTypes.SELECT,
    transaction,
    replacements: {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      title: item.title,
      ownerUserId: item.ownerUserId || null,
      ownerTeam: item.ownerTeam || null,
      dueAt: item.dueAt,
      endAt: item.endAt || null,
      severity: item.severity || 'INFO',
      status: item.status || 'OPEN',
      deepLink: item.deepLink,
      sourceKind: item.sourceKind || null,
      cancelReason: item.cancelReason || null,
      lastEventId: item.lastEventId || null,
      lastEventOccurredAt: item.lastEventOccurredAt || null,
    },
  });
  return rows[0];
}

/**
 * Trava o item da origem para a decisão do projetor (M9-D802 §6): trava de aviso por (empresa, tipo, origem) — vale também para o
 * primeiro INSERT, quando ainda não há linha para o FOR UPDATE — e depois SELECT ... FOR UPDATE. Devolve a linha (snake_case) ou null.
 */
async function lockItem(tenant, sourceType, sourceId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { transaction, replacements: { key: `calendar:${tenant.companyId}:${sourceType}:${sourceId}` } });
  const rows = await sequelize.query(
    'SELECT * FROM governance.calendar_items WHERE company_id = :companyId AND source_type = :sourceType AND source_id = :sourceId FOR UPDATE',
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, sourceType, sourceId } }
  );
  return rows[0] || null;
}

/** Registra o evento mais novo visto na origem sem mudar o item (nem a versão da projeção): evita regressão por evento atrasado. */
async function touchLastEvent(itemId, eventId, occurredAt, transaction) {
  await sequelize.query('UPDATE governance.calendar_items SET last_event_id = :eventId, last_event_occurred_at = :occurredAt WHERE id = :itemId', {
    transaction, replacements: { itemId, eventId: eventId || null, occurredAt },
  });
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Fecha (DONE) os itens ABERTOS de um `source_kind` cujo prazo já passou (ex.: PROJECT_WARRANTY depois do fim da garantia). */
async function closeExpiredItems(tenant, sourceKind, now, transaction) {
  return sequelize.query(
    `UPDATE governance.calendar_items SET status = 'DONE', projection_version = projection_version + 1, updated_at = now()
      WHERE company_id = :companyId AND source_kind = :sourceKind AND status = 'OPEN' AND due_at < :now RETURNING id, source_type, source_id, projection_version`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, sourceKind, now } }
  );
}

/** Cancela os itens ABERTOS dos `source_kinds` cuja origem não está mais entre `keepSourceIds` (origem encerrada ou removida). */
async function cancelStaleItems(tenant, sourceKinds, keepSourceIds, reason, transaction) {
  return sequelize.query(
    `UPDATE governance.calendar_items SET status = 'CANCELLED', cancel_reason = :reason, projection_version = projection_version + 1, updated_at = now()
      WHERE company_id = :companyId AND source_kind IN (:sourceKinds) AND status = 'OPEN' AND source_id NOT IN (:keep) RETURNING id, source_type, source_id, projection_version`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, sourceKinds, reason, keep: keepSourceIds.length ? keepSourceIds : [NIL_UUID] } }
  );
}

module.exports = { upsertItem, lockItem, touchLastEvent, closeExpiredItems, cancelStaleItems };
