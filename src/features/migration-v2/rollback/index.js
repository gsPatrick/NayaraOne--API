'use strict';

const { registerRollbackHook } = require('../canary/canary.hooks');
const items = require('./items.service');
require('./blockers.provider'); // registra os blockers do plano de rollback (M9-D907) no ponto de extensão da Torre

/** Rollback de setor (M9-D904) passa a criar os rollback_items das operações externas do setor desde T0. */
registerRollbackHook('external-ops', items.createItemsForSector);

module.exports = { ...require('./log.service'), readiness: require('./readiness'), currentT0: require('./cutover.service').currentT0 };
