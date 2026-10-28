'use strict';

const { buildMarketingRouter } = require('./marketing.module');
const { assertKillSwitchChangeAllowed } = require('./marketing.guards');
const controller = require('./killswitch.controller');

// Rota 10 do livro: permissão killswitch:manage; MFA step-up só ao REATIVAR (active diferente de true; falha fechada).
async function mfaOnlyOnReactivation(req, res, next) {
  await req.withTenantTransaction((transaction) => assertKillSwitchChangeAllowed({
    active: req.body ? req.body.active : undefined,
    userId: req.auth.userId,
    transaction,
  }));
  return next();
}

module.exports = buildMarketingRouter([
  { method: 'post', path: '/marketing/kill-switch', permission: 'marketing:killswitch:manage', gates: [mfaOnlyOnReactivation], handler: controller.change },
]);
