'use strict';

const { q } = require('./healthStore');

/**
 * Lease do teste de saúde (M9-D223 seção 6: um teste por connection por vez). O lease é tomado por um UPDATE condicional na linha
 * atual de provider_health: só ganha quem encontra o lease livre ou vencido. Duas instâncias concorrentes se serializam na linha e a
 * segunda vê o lease da primeira. Se o processo cair, o lease vence sozinho (`until`).
 */
async function acquireLease(connectionId, owner, until, now, transaction) {
  const rows = await q(
    `UPDATE "integration"."provider_health" SET check_lease_owner = :owner, check_lease_until = :until
      WHERE connection_id = :id AND window_minutes = 0 AND (check_lease_until IS NULL OR check_lease_until < :now) RETURNING connection_id`,
    { id: connectionId, owner, until, now },
    transaction,
    'SELECT',
  );
  return rows.length === 1;
}

/** Devolve o lease (só se ainda for de `owner`). */
async function releaseLease(connectionId, owner, transaction) {
  await q(
    `UPDATE "integration"."provider_health" SET check_lease_owner = NULL, check_lease_until = NULL
      WHERE connection_id = :id AND window_minutes = 0 AND check_lease_owner = :owner`,
    { id: connectionId, owner },
    transaction,
    'UPDATE',
  );
}

module.exports = { acquireLease, releaseLease };
