'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { confirmAction } = require('../../../../shared/destructive-actions/guard');
const { impactHandler } = require('../../../../shared/destructive-actions/impact.handler');
const E = require('../flags.errors');
const { ACTIONS } = require('./killSwitch.constants');
const { resourceIdOf } = require('./killSwitch.impact');

const ACTION_BY_NAME = Object.freeze({ activate: ACTIONS.activate, restore: ACTIONS.restore });

/** Roda o handler de impacto só quando o corpo pede esta ação; mantém a marca lida pela varredura do inventário. */
function whenAction(name, handler) {
  const wrapped = (req, res, next) => (req.body && req.body.action === name ? handler(req, res, next) : next());
  wrapped.impactActionKey = handler.impactActionKey;
  return wrapped;
}

/** Guardas do PATCH /feature-flags (linha 14 do inventário): acionar = nível 2 sem MFA; restaurar = nível 3 com MFA recente. Passam direto quando o PATCH não é a transição. */
const patchGuards = () => [
  confirmAction(ACTIONS.activate, { resourceId: resourceIdOf, reasonField: 'reason' }),
  confirmAction(ACTIONS.restore, { resourceId: resourceIdOf, reasonField: 'reason', mfa: true }),
];

/** POST /feature-flags/impact: simulação das duas ações; o corpo diz qual (`action`: activate ou restore) e qual switch (`id` ou `key`). Não grava nada. */
const impactMiddleware = () => Object.entries(ACTION_BY_NAME).map(([name, key]) => whenAction(name, impactHandler(key, { resourceId: resourceIdOf })));
const impactFallback = catchAsync(async () => { throw E.inputInvalid('Informe a ação: "activate" ou "restore".', { field: 'action', allowed: Object.keys(ACTION_BY_NAME) }); });

module.exports = { patchGuards, impactMiddleware, impactFallback };
