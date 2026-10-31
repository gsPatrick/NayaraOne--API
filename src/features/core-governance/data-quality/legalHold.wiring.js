'use strict';

const holdGuard = require('./retention.holdGuard');
const guard = require('./legalHold.guard');

/** Liga a retenção (M9-D911) à trava jurídica: a interface `holdGuard` deixa de ser o stub e passa a consultar as retenções legais ativas (M9-D912). */
function install() {
  holdGuard.setProvider({
    isOnHold: (entityType, entityId, ctx) => guard.isOnHold(entityType, entityId, ctx),
    heldIds: (entityType, ids, ctx) => guard.heldIds(entityType, ids, ctx),
  });
}

module.exports = { install };
