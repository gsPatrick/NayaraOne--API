'use strict';

const { ContractClause } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');

/**
 * Homologação da versão da cláusula (Caderno M5 §4 "legal.clause_versions | Versões homologadas"; verificação M5 linha 124):
 * "homologada" passa a ser aprovada de verdade, não apenas "ativa". Alçada jurídica (rota com legal:approve), segregação (quem
 * criou a versão não homologa), uma única vez, só a versão vigente, com auditoria. O banco recusa qualquer outro caminho
 * (gatilho clause_versions_homologation_guard). A NAY só sugere minuta com versões homologadas.
 */
const isHomologated = (clause) => clause.homologationStatus === 'HOMOLOGATED';
/** Homologada e, se condicional, com a condição também aprovada (F01): o que a NAY pode usar. */
const isUsableForDraft = (clause) => clause.isActive && isHomologated(clause) && (!clause.conditionJson || clause.conditionStatus === 'APPROVED');

async function homologateClauseVersion(id, actorUserId, transaction) {
  if (!actorUserId) throw AppError.forbidden('A homologação exige um usuário identificado.', 'LEGAL_CLAUSE_HOMOLOGATION_APPROVER_REQUIRED');
  const clause = typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? await ContractClause.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
  if (!clause) throw AppError.notFound('Cláusula contratual não encontrada.', 'LEGAL_CONTRACT_CLAUSE_NOT_FOUND');
  if (isHomologated(clause)) throw AppError.conflict(`A versão v${clause.versionNumber} da cláusula "${clause.code}" já está homologada.`, 'LEGAL_CLAUSE_ALREADY_HOMOLOGATED');
  if (!clause.isActive) {
    throw AppError.conflict(`A versão v${clause.versionNumber} da cláusula "${clause.code}" está fora de circulação: só a versão vigente é homologada.`, 'LEGAL_CLAUSE_HOMOLOGATION_VERSION_INACTIVE');
  }
  if (!clause.createdBy) {
    throw AppError.forbidden('Esta versão não tem autor registrado: sem ele não há como garantir que quem homologa não é quem escreveu. Crie uma nova versão.', 'LEGAL_CLAUSE_HOMOLOGATION_AUTHOR_UNKNOWN');
  }
  if (String(clause.createdBy) === String(actorUserId)) {
    throw AppError.forbidden('Quem escreveu esta versão da cláusula não pode homologá-la: peça a outra pessoa com a alçada jurídica.', 'LEGAL_CLAUSE_HOMOLOGATION_SELF_BLOCKED');
  }
  const beforeJson = { homologationStatus: clause.homologationStatus, homologatedBy: null, homologatedAt: null };
  clause.homologationStatus = 'HOMOLOGATED';
  clause.homologatedBy = actorUserId;
  clause.homologatedAt = new Date();
  await clause.save({ transaction });
  await registrarAuditoria({
    groupId: clause.groupId, companyId: clause.companyId, actorUserId, action: 'legal.contract_clause.homologate', entityType: 'ContractClause', entityId: clause.id,
    beforeJson, afterJson: { homologationStatus: 'HOMOLOGATED', homologatedBy: actorUserId, homologatedAt: clause.homologatedAt, code: clause.code, versionNumber: clause.versionNumber },
    reason: `Versão v${clause.versionNumber} da cláusula "${clause.code}" homologada.`,
  }, transaction);
  return clause;
}

module.exports = { homologateClauseVersion, isHomologated, isUsableForDraft };
