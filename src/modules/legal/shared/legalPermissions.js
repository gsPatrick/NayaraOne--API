'use strict';

const { requirePermission } = require('../../../middlewares/auth.middleware');

/**
 * Permissões com o nome literal do livro do Marco 5 (DEC-073 "Livro"): o Guia §6 aprova a versão com
 * assertPermission(ctx, 'contracts.version.approve') e o Guia §11 entrega as chaves com 'lease.keys.deliver'.
 * Os perfis que tinham legal:approve receberam contracts.version.approve (migration 20260101015101 e seeds).
 */
const VERSION_APPROVE = 'contracts.version.approve';

/** POST /contract-versions/:id/approve — Guia §6. */
const requireVersionApprove = () => requirePermission(VERSION_APPROVE);

/**
 * POST /legal/contracts/:id/transition com targetStatus APPROVED: entrar em APPROVED é a aprovação da versão vigente
 * (LEGAL_REVIEW -> APPROVED aprova a versão, contractVersionApproval.js), então a transição genérica exige a mesma
 * permissão do Guia §6. Os demais destinos seguem só com a permissão da rota.
 */
function requireVersionApproveWhenApproving() {
  const check = requirePermission(VERSION_APPROVE);
  const middleware = function requireVersionApproveWhenApproving(req, res, next) {
    const alvo = req.body && typeof req.body.targetStatus === 'string' ? req.body.targetStatus.trim().toUpperCase() : null;
    if (alvo !== 'APPROVED') return next();
    return check(req, res, next);
  };
  middleware.conditionalPermission = { code: VERSION_APPROVE, when: 'targetStatus = APPROVED' };
  return middleware;
}

module.exports = { VERSION_APPROVE, requireVersionApprove, requireVersionApproveWhenApproving };
