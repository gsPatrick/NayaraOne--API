'use strict';

const { approveRecommendation, rejectRecommendation } = require('./ApprovalService');
const { createWritePolicy, eligibleForDirectWrite } = require('./writePolicy');
const { registerApprovalRoutes } = require('./approval.routes');
const settings = require('./approval.settings');

/** Aprovação humana de ações da NAY (M9-D019): proposta, decisão, execução idempotente e fechamento de tool_call e run. */
module.exports = { approveRecommendation, rejectRecommendation, createWritePolicy, eligibleForDirectWrite, registerApprovalRoutes, ...settings };
