'use strict';

const { mktForbidden } = require('../marketing.errors');
const { KEY } = require('./autopublish.settings');

const AUTOPUBLISH_PERMISSION = 'marketing:automation:manage';

/**
 * Middleware do PUT /settings/:key para as classes de autopublicação (M9-D408 item 1): além de settings:update, a alteração exige marketing:automation:manage.
 * Quem aprova conteúdo (marketing:content:approve) não autoriza a própria dispensa de aprovação: sem a permissão, 403 MKT_FORBIDDEN.
 */
function requireAutomationManageForAutopublish(req, res, next) {
  if (req.params.key !== KEY) return next();
  if (!(req.auth && req.auth.permissions || []).includes(AUTOPUBLISH_PERMISSION)) return next(mktForbidden({ required: AUTOPUBLISH_PERMISSION, key: KEY }));
  return next();
}

module.exports = { AUTOPUBLISH_PERMISSION, requireAutomationManageForAutopublish };
