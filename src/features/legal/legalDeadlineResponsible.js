'use strict';

const { UserMembership } = require('../../models');
const AppError = require('../../utils/AppError');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Responsavel do prazo (Caderno M5 §15 "due_at + responsavel + severidade"; JUR-009 "Prazo tem
 * responsavel"). Quem recebe o prazo precisa ser usuario com vinculo ATIVO na empresa do
 * processo; usuario inexistente, de outra empresa ou inativo e recusado (422), nunca gravado.
 * Devolve o id normalizado (ou null quando nao ha responsavel).
 */
async function assertResponsibleInTenant(responsibleUserId, { groupId, companyId }, transaction) {
  if (responsibleUserId === undefined || responsibleUserId === null || responsibleUserId === '') return null;
  if (typeof responsibleUserId !== 'string' || !UUID_RE.test(responsibleUserId)) {
    throw AppError.badRequest('"responsibleUserId" deve ser o identificador (UUID) de um usuário.', 'LEGAL_DEADLINE_VALIDATION');
  }
  const membership = await UserMembership.findOne({
    where: { userId: responsibleUserId, groupId, companyId, status: 'ACTIVE' },
    transaction,
  });
  if (!membership) {
    throw AppError.unprocessable(
      'O responsável informado não existe ou não tem vínculo ativo com a empresa deste processo.',
      'LEGAL_DEADLINE_RESPONSIBLE_NOT_IN_TENANT'
    );
  }
  return responsibleUserId;
}

module.exports = { assertResponsibleInTenant };
