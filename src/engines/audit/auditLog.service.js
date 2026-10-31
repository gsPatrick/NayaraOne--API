'use strict';

const { AuditLog, sequelize } = require('../../models');
const { getCurrentCorrelationId } = require('../../middlewares/correlationId.middleware');

/**
 * registrarAuditoria — grava uma entrada em "audit"."audit_log". "audit"."audit_log" tem RLS
 * própria (`company_id = current_setting('app.company_id')`, ver
 * migrations/20260101000071-create-audit-audit_log.js) — então o INSERT só passa se a sessão
 * de banco da transação já tiver `SET LOCAL app.company_id` aplicado.
 *
 * Quando o chamador já está dentro de uma transação aberta por `req.withTenantTransaction`
 * (tenant.middleware.js) — que já fez esse SET LOCAL —, passar essa `transaction` aqui grava
 * o log como parte do MESMO commit da operação de negócio (mesmo princípio do Transactional
 * Outbox: "se a transação falhar, domínio e log falham juntos").
 *
 * Quando NÃO há transação (ex.: features/users, que hoje não usa `withTenantTransaction` por
 * "core"."users" ser identidade global sem RLS própria), este helper abre a sua própria
 * transação curta e faz o SET LOCAL app.group_id/app.company_id sozinho — sem isso, o INSERT
 * seria bloqueado pela RLS de audit_log com "new row violates row-level security policy"
 * (comportamento confirmado rodando contra o banco local antes de fechar esta implementação).
 *
 * Helper compartilhado por todas as features que fazem create/update/delete/status-change de
 * entidades multiempresa — antes, só personMerge.service.js escrevia em AuditLog; agora toda
 * mutação relevante do sistema passa por aqui, com uma descrição em português no campo
 * `reason` (o que aparece pra quem for ler a trilha de auditoria, ex.: na tela "Atividade" do
 * front — app/painel/usuarios/[id]/page.js).
 *
 * `actorUserId` pode ser null (ação automática do sistema, ex.: job de matching do Radar).
 */
async function registrarAuditoria(
  { groupId, companyId, actorUserId, action, entityType, entityId, beforeJson, afterJson, reason },
  transaction
) {
  const payload = {
    groupId,
    companyId,
    userId: actorUserId || null,
    action,
    entityType,
    entityId: entityId || null,
    beforeJson: beforeJson || null,
    afterJson: afterJson || null,
    reason: reason || null,
    correlationId: getCurrentCorrelationId(),
    occurredAt: new Date(),
    createdBy: actorUserId || null,
    updatedBy: actorUserId || null,
  };

  if (transaction) {
    return AuditLog.create(payload, { transaction });
  }

  return sequelize.transaction(async (ownTransaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId }, transaction: ownTransaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId }, transaction: ownTransaction });
    return AuditLog.create(payload, { transaction: ownTransaction });
  });
}

/**
 * registrarTentativaBloqueada — mesma trilha de registrarAuditoria, mas para o momento em que
 * uma operação é REJEITADA por controle de segregação de função/alçada/antifraude (ex.:
 * autoaprovação, ajuste de alto valor sem evidência, segunda aprovação de compra sem segundo
 * aprovador). GAP REAL CORRIGIDO (auditoria "mais um ciclo de 5", 2026-10-08): o contrato
 * (Anexo A, matriz de risco antifraude — "Usuário aprovando própria solicitação → Bloquear
 * quando segregação exigir", "Tentativa de apagar prova/auditoria → Bloquear e alertar") trata
 * a TENTATIVA de burlar esses controles como evento que precisa de trilha, não só um erro HTTP
 * momentâneo que desaparece sem deixar rastro — sem isso, não dá pra detectar um padrão
 * repetido de tentativa de burla nem produzir evidência pra investigação de incidente.
 */
async function registrarTentativaBloqueada({ groupId, companyId, actorUserId, action, entityType, entityId, beforeJson, reason }, transaction) {
  return registrarAuditoria(
    { groupId, companyId, actorUserId, action: `${action}.blocked`, entityType, entityId, beforeJson, afterJson: null, reason },
    transaction
  );
}

module.exports = { registrarAuditoria, registrarTentativaBloqueada };
