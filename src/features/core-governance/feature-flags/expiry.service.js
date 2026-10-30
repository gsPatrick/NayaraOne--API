'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { dateKeyInZone } = require('../calendar/sources/time');
const { STATES, AUDIT_ACTION, AUDIT_ENTITY } = require('./flags.constants');
const { readFlagsParams } = require('./flags.params');
const { snapshotOf } = require('./flags.view');
const { sendCriticalAlert } = require('./flags.alerts');
const repo = require('./flags.repository');

const EXPIRY_REASON = 'Validade da flag temporária vencida.';

/** Passa uma chave temporária vencida a EXPIRED: guarda a versão anterior, sobe a versão e audita antes e depois, tudo na transação do chamador. */
async function expireRow(tenant, row, transaction) {
  await repo.insertVersion(tenant, row.kind, row, { replacedBy: null, reason: EXPIRY_REASON }, transaction);
  const saved = await repo.update(tenant, row.kind, row.id, {
    value: row.value, ownerUserId: row.owner_user_id, scope: row.scope, scopeRef: row.scope_ref, risk: row.risk, version: row.version + 1,
    validFrom: row.valid_from, validUntil: row.valid_until, temporary: row.temporary, description: row.description, state: STATES.EXPIRED,
  }, null, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: AUDIT_ACTION, entityType: AUDIT_ENTITY[row.kind], entityId: row.id,
    beforeJson: snapshotOf(row), afterJson: snapshotOf(saved), reason: EXPIRY_REASON,
  }, transaction);
  return saved;
}

const alertOf = (row) => ({
  title: `flag temporária vencida ${row.key}`,
  body: `A flag temporária ${row.key} venceu em ${dateKeyInZone(row.valid_until)} e deixou de valer (estado EXPIRED). Remova a flag do código e do registro ou prorrogue a validade em Configurações > Governança.`,
});

/**
 * Uma execução do featureFlagExpiryJob para a empresa (M9-D871 §3.2). Toda chave temporária ACTIVE com validade vencida passa a EXPIRED (perde o efeito pela regra de
 * validade da M9-D870) e o responsável recebe notificação CRÍTICA, no máximo uma por chave e por dia. Com `governanca.flags.expiracao_lembrete_diario` ligado, a chave que
 * continua vencida no registro volta a avisar o responsável a cada dia. Devolve { expired, notified, reminded }.
 */
async function runExpiry(tenant, transaction, { now = new Date() } = {}) {
  const params = await readFlagsParams(tenant, transaction);
  const day = dateKeyInZone(now);
  const expired = [];
  for (const row of await repo.listDueForExpiry(tenant, now, transaction)) expired.push(await expireRow(tenant, row, transaction));
  const justNow = new Set(expired.map((row) => row.id));
  let notified = 0;
  let reminded = 0;
  for (const row of await repo.listPastExpired(tenant, now, transaction)) {
    const fresh = justNow.has(row.id);
    if (!fresh && !params.expiryReminderDaily) continue;
    const sent = await sendCriticalAlert(tenant, { alertKey: `flag.expired:${row.id}:${day}`, type: 'FLAG_EXPIRED', entry: row, ...alertOf(row) }, transaction);
    notified += sent;
    if (sent && !fresh) reminded += 1;
  }
  return { expired: expired.map((row) => ({ id: row.id, key: row.key, kind: row.kind, validUntil: row.valid_until })), notified, reminded };
}

module.exports = { runExpiry, EXPIRY_REASON };
