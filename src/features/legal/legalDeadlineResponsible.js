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
  // UUID e case-insensitive: normaliza para minusculas, senao o mesmo usuario em maiusculas
  // contaria como troca (e zeraria lastAlertedSeverity) ou seria gravado fora do padrao.
  const normalizedId = responsibleUserId.toLowerCase();
  const membership = await UserMembership.findOne({
    where: { userId: normalizedId, groupId, companyId, status: 'ACTIVE' },
    transaction,
  });
  if (!membership) {
    throw AppError.unprocessable(
      'O responsável informado não existe ou não tem vínculo ativo com a empresa deste processo.',
      'LEGAL_DEADLINE_RESPONSIBLE_NOT_IN_TENANT'
    );
  }
  return normalizedId;
}

/**
 * Quem pode concluir o prazo (Caderno M5 §19 "Marcar prazo concluído | Responsável/permissão +
 * evidência"): o responsável efetivo do prazo (o do prazo ou, sem ele, o do processo) OU quem tem
 * a permissão de aprovação jurídica (`legal:approve`). O responsável considerado é o de ANTES da
 * requisição, para que ninguém se atribua o prazo e o conclua na mesma chamada. A rota já exige
 * `legal:update`; a prova (evidência/nota) é cobrada à parte em updateLegalDeadline.
 */
function assertMayConclude({ actorUserId, permissions, deadline, legalCase }) {
  if ((permissions || []).includes('legal:approve')) return;
  const responsible = deadline.responsibleUserId || (legalCase && legalCase.responsibleUserId) || null;
  if (responsible && actorUserId && String(responsible).toLowerCase() === String(actorUserId).toLowerCase()) return;
  throw AppError.forbidden(
    'Somente o responsável pelo prazo ou quem tem a permissão de aprovação jurídica (legal:approve) pode concluí-lo.',
    'LEGAL_DEADLINE_NOT_RESPONSIBLE'
  );
}

module.exports = { assertResponsibleInTenant, assertMayConclude };
