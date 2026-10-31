'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repo = require('./blockers.repository');

const keyOf = (b) => `${b.code}|${b.entity || ''}|${b.ref || ''}`;
const same = (a, b) => JSON.stringify([a.owner || null, a.detail]) === JSON.stringify([b.owner || null, b.detail]);

function audit(tenant, actor, action, blocker, reason, transaction) {
  return registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor && actor.userId, action, entityType: 'MigBlocker', entityId: blocker.id || null,
    afterJson: { code: blocker.code, entity: blocker.entity || null, ref: blocker.ref || '', owner: blocker.owner || null, detail: blocker.detail }, reason,
  }, transaction);
}

/**
 * Faz o conjunto de blockers abertos da empresa igual às condições de agora (M9-D901 §3.3): abre os que surgiram (com `since` = agora), atualiza o detalhe dos que seguem e
 * fecha os que deixaram de valer. Abertura e fechamento são auditados, só por quem de fato abriu ou fechou. Devolve os blockers abertos depois do ajuste.
 */
async function syncBlockers(tenant, actor, desired, transaction) {
  const current = await repo.listOpen(tenant, transaction);
  const currentByKey = new Map(current.map((b) => [keyOf(b), b]));
  const wanted = new Map(desired.map((b) => [keyOf(b), b]));
  for (const [key, blocker] of wanted) {
    const existing = currentByKey.get(key);
    if (existing) {
       
      if (!same(existing, blocker)) await repo.update(tenant, existing.id, blocker, transaction);
      continue;
    }
     
    const opened = await repo.open(tenant, blocker, transaction);
     
    if (opened) await audit(tenant, actor, 'migration.blocker.opened', { ...blocker, id: opened.id }, `Blocker ${blocker.code} aberto.`, transaction);
  }
  for (const [key, existing] of currentByKey) {
    if (wanted.has(key)) continue;
     
    const closed = await repo.close(tenant, existing.id, transaction);
     
    if (closed) await audit(tenant, actor, 'migration.blocker.closed', existing, `Blocker ${existing.code} fechado.`, transaction);
  }
  return repo.listOpen(tenant, transaction);
}

module.exports = { syncBlockers, keyOf };
