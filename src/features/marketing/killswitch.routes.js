'use strict';

const { buildMarketingRouter } = require('./marketing.module');
const { assertKillSwitchChangeAllowed } = require('./marketing.guards');
const { confirmAction } = require('../../shared/destructive-actions/guard');
const { impactHandler } = require('../../shared/destructive-actions/impact.handler');
const { ACTIONS } = require('../core-governance/feature-flags/kill-switch/killSwitch.constants');
const controller = require('./killswitch.controller');
const { resourceIdOf } = require('./killswitch.impact');

const PERMISSION = 'marketing:killswitch:manage';
const ACTION_BY_NAME = Object.freeze({ activate: ACTIONS.activate, restore: ACTIONS.restore });

// Rota 10 do livro: permissão killswitch:manage; MFA step-up só ao REATIVAR (active diferente de true; falha fechada).
async function mfaOnlyOnReactivation(req, res, next) {
  await req.withTenantTransaction((transaction) => assertKillSwitchChangeAllowed({
    active: req.body ? req.body.active : undefined,
    userId: req.auth.userId,
    transaction,
  }));
  return next();
}

/** Roda o handler de impacto só quando o corpo pede esta ação; mantém a marca lida pela varredura do inventário (M9-D852). */
function whenAction(name, handler) {
  const wrapped = (req, res, next) => (req.body && req.body.action === name ? handler(req, res, next) : next());
  wrapped.impactActionKey = handler.impactActionKey;
  return wrapped;
}

// Linha 14 do inventário de ações destrutivas (M9-D852): acionar = nível 2 sem MFA; reativar = nível 3 com MFA recente. Passam direto quando o corpo não é a transição.
const confirmations = [
  confirmAction(ACTIONS.activate, { resourceId: resourceIdOf, reasonField: 'reason' }),
  confirmAction(ACTIONS.restore, { resourceId: resourceIdOf, reasonField: 'reason', mfa: true }),
];
const impactGates = Object.entries(ACTION_BY_NAME).map(([name, key]) => whenAction(name, impactHandler(key, { resourceId: resourceIdOf })));

module.exports = buildMarketingRouter([
  { method: 'post', path: '/marketing/kill-switch/impact', permission: PERMISSION, gates: impactGates, handler: controller.impactFallback },
  { method: 'post', path: '/marketing/kill-switch', permission: PERMISSION, gates: [mfaOnlyOnReactivation, ...confirmations], handler: controller.change },
]);
