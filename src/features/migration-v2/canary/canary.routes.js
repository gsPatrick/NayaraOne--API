'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { requireRecentMfa } = require('../../../middlewares/auth.middleware');
const { confirmAction } = require('../../../shared/destructive-actions/guard');
const { impactHandler } = require('../../../shared/destructive-actions/impact.handler');
const controller = require('./canary.controller');
const errors = require('./canary.errors');
const { ACTION_ROLLBACK } = require('./canary.constants');

const sectorOf = (req) => (req.params && req.params.sector) || null;

/** O motivo do retorno vem em `reason` ou na justificativa da confirmação; sem nenhum dos dois, 422 GOV_CANARY_REASON_REQUIRED antes de qualquer outra coisa. */
function requireReason(req, res, next) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const typed = (value) => typeof value === 'string' && value.trim() !== '';
  if (typed(body.reason) || typed(body.confirmation && body.confirmation.justification)) return next();
  return next(errors.reasonRequired());
}

/**
 * Rotas do canary por setor (M9-D904). `run` e `flags` são as duas permissões exigidas juntas (a checagem fica em migration.routes.js). O rollback é a linha 15 do
 * inventário de ações destrutivas: MFA recente, motivo, código do setor digitado, justificativa e impacto.
 */
function registerCanaryRoutes(router, { requireRun, requireFlags }) {
  router.get('/migration/canary', requireRun, catchAsync(controller.status));
  router.get('/migration/canary/:sector/impact', requireRun, requireFlags, impactHandler(ACTION_ROLLBACK, { resourceId: sectorOf }));
  router.post('/migration/canary/:sector/advance', requireRun, requireFlags, catchAsync(controller.advance));
  router.post('/migration/canary/:sector/rollback', requireRun, requireFlags, requireRecentMfa, requireReason,
    confirmAction(ACTION_ROLLBACK, { resourceId: sectorOf, reasonField: 'reason' }), catchAsync(controller.rollback));
}

module.exports = { registerCanaryRoutes };
