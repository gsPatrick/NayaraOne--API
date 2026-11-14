'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const AppError = require('../../../utils/AppError');
const { Opportunity } = require('../../../models');
const opportunitiesService = require('../opportunity.service');
const { bulkReassign } = require('../opportunityReassign.service');

const REASSIGN_PERMISSION = 'crm:opportunities:reassign';

/**
 * PATCH /opportunities/:id (livro do Marco 3 §18: "Trocar responsável em massa — Permissão específica + audit"; CAD-18). Trocar o
 * responsável pelo PATCH comum contornava a permissão, o motivo e a auditoria da troca: agora a troca de `ownerUserId` exige a MESMA
 * permissão específica (`crm:opportunities:reassign`, 403 OPPORTUNITY_REASSIGN_FORBIDDEN), o motivo (`ownerChangeReason`, mínimo 5
 * caracteres) e responsável ativo da empresa, e grava auditoria com antes/depois (`opportunity.reassign`) — pelo mesmo serviço da troca em massa, na
 * mesma transação dos demais campos. `ownerUserId` igual ao atual não é troca (segue o PATCH sem exigir nada).
 */
const updateOpportunity = catchAsync(async (req, res) => {
  const { ownerUserId, ownerChangeReason, ...rest } = req.body || {};
  const opportunity = await req.withTenantTransaction(async (transaction) => {
    if (ownerUserId !== undefined) {
      const current = await Opportunity.findByPk(req.params.id, { attributes: ['id', 'ownerUserId'], transaction });
      if (!current) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
      if ((current.ownerUserId || null) !== (ownerUserId || null)) {
        const permissions = (req.auth && req.auth.permissions) || [];
        if (!permissions.includes(REASSIGN_PERMISSION)) {
          throw AppError.forbidden('Trocar o responsável da oportunidade exige a permissão de troca de responsável.', 'OPPORTUNITY_REASSIGN_FORBIDDEN', { required: REASSIGN_PERMISSION });
        }
        await bulkReassign({ opportunityIds: [req.params.id], toUserId: ownerUserId, reason: ownerChangeReason }, { userId: req.auth.userId, companyId: req.auth.companyId }, transaction, { single: true });
      }
    }
    return opportunitiesService.updateOpportunity(req.params.id, rest, req.auth.userId, transaction);
  });
  return success(res, { data: opportunity });
});

module.exports = { updateOpportunity, REASSIGN_PERMISSION };
