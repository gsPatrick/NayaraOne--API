'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const params = require('../canary/canary.params');
const cutover = require('./cutover.service');
const errors = require('./rollback.errors');
const { NEEDS_COMPENSATION, STATES, NEVER_SENT, AUDIT, AUDIT_ENTITY, FIELD_MAX } = require('./rollback.constants');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gancho do rollback de setor da M9-D904 (canary.hooks): cria um item PENDING_COMPENSATION por operação externa do registro, desde T0, COMPENSABLE ou IRREVERSIBLE, cuja
 * entidade pertence ao setor (parâmetro migracao.setor.<setor>.entidades). Envio que nunca saiu (cancelado ou falho) não gera item. Repetir o rollback não duplica
 * (`log_id` único). Roda na transação do rollback: se falhar, o rollback inteiro desfaz.
 */
async function createItemsForSector(tenant, sector, ctx, transaction) {
  const t0 = await cutover.currentT0(tenant, transaction);
  if (!t0) return { created: 0 };
  const entities = await params.readEntities(tenant, sector, transaction);
  const rows = await select(
    `INSERT INTO governance.rollback_items (group_id, company_id, log_id, sector)
     SELECT l.group_id, l.company_id, l.id, :sector
       FROM governance.external_op_log l
       JOIN governance.external_op_types t ON t.company_id = l.company_id AND t.id = l.type_id
       LEFT JOIN integration.dispatches d ON d.id = l.dispatch_id AND d.company_id = l.company_id
      WHERE l.company_id = :companyId AND l.executed_at >= :t0 AND t.reversibility IN (:needs) AND l.entity IN (:entities)
        AND (d.id IS NULL OR d.status NOT IN (:never))
     ON CONFLICT (company_id, log_id) DO NOTHING RETURNING id`,
    { companyId: tenant.companyId, sector, t0, needs: NEEDS_COMPENSATION, entities, never: NEVER_SENT }, transaction
  );
  return { created: rows.length };
}

/**
 * POST /migration/rollback-items/:id/resolve (M9-D907 §3.3): marca a compensação do item como feita. Item já resolvido: 409 GOV_ROLLBACK_ITEM_FINAL. O item é travado
 * (FOR UPDATE) para duas resoluções simultâneas não passarem. `note` (o que foi feito) e `compensationRef` (protocolo do banco, número da mensagem corretiva) são opcionais.
 */
async function resolveItem(tenant, actor, id, body, transaction) {
  if (!UUID.test(String(id))) throw errors.itemNotFound();
  const [item] = await select(
    `SELECT i.id, i.state, i.sector, l.op_type AS "opType", l.reference FROM governance.rollback_items i JOIN governance.external_op_log l ON l.company_id = i.company_id AND l.id = i.log_id
      WHERE i.company_id = :companyId AND i.id = :id FOR UPDATE OF i`, { companyId: tenant.companyId, id }, transaction
  );
  if (!item) throw errors.itemNotFound();
  if (item.state !== STATES.PENDING) throw errors.itemFinal({ id: item.id, state: item.state });
  const note = body && typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, FIELD_MAX.note) : null;
  const ref = body && typeof body.compensationRef === 'string' && body.compensationRef.trim() ? body.compensationRef.trim().slice(0, FIELD_MAX.ref) : null;
  const [saved] = await select(
    `UPDATE governance.rollback_items SET state = :state, resolution_note = :note, compensation_ref = :ref, resolved_by = :userId, resolved_at = now() WHERE id = :id AND company_id = :companyId
     RETURNING id, state, sector, resolution_note AS note, compensation_ref AS "compensationRef", resolved_at AS "resolvedAt"`,
    { state: STATES.COMPENSATED, note, ref, userId: actor && actor.userId ? actor.userId : null, id, companyId: tenant.companyId }, transaction
  );
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor && actor.userId, action: AUDIT.RESOLVED, entityType: AUDIT_ENTITY.ITEM, entityId: id,
    beforeJson: { state: item.state, sector: item.sector, opType: item.opType, reference: item.reference }, afterJson: { state: saved.state, compensationRef: ref }, reason: note || `Compensação de ${item.opType} registrada.`,
  }, transaction);
  return saved;
}

module.exports = { createItemsForSector, resolveItem };
