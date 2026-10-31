'use strict';

const access = require('./raci.access');

/**
 * Middleware das decisões do corte (M9-D902): exige que quem decide seja R ou A da atividade do RACI (403 GOV_MIG_RACI_FORBIDDEN). Vai depois da autenticação e do tenant.
 * `when(req)` opcional restringe a checagem a certos pedidos (por exemplo, só a execução com `lastDelta: true`).
 */
function requireRaci(activityCode, { when } = {}) {
  return async function raciGuard(req, res, next) {
    try {
      if (when && !when(req)) return next();
      const tenant = { groupId: req.auth.groupId, companyId: req.auth.companyId };
      const actor = { userId: req.auth.userId, roles: req.auth.roles || [] };
      await req.withTenantTransaction((transaction) => access.assertResponsibleOrAccountable(tenant, actor, activityCode, transaction));
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireRaci };
