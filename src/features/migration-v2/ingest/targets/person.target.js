'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, Person } = require('../../../../models');
const { onlyDigits, hashTaxId, isValidTaxIdDigits } = require('../../../people/personDocumentFormat.service');

/**
 * Destino PERSON (cliente/proprietário/pessoa do ERP antigo). Campos canônicos: personType (PF|PJ, padrão PF), legalName, preferredName, taxId, birthDate, status. Sem eventos de
 * domínio: a carga não dispara notificações; duplicidade é tratada pela fila de merge (M9-D805) depois da carga.
 */
const TYPES = ['PF', 'PJ'];

/** null = pode gravar; { state, reason } = QUARANTINED (inválida) ou PENDING_REVIEW (possível duplicata). */
async function assess(tenant, row, existingTargetId, transaction) {
  const name = typeof row.legalName === 'string' ? row.legalName.trim() : '';
  if (!name || name.length > 200) return { state: 'QUARANTINED', reason: 'Nome ausente ou com mais de 200 caracteres.' };
  const type = row.personType || 'PF';
  if (!TYPES.includes(type)) return { state: 'QUARANTINED', reason: 'Tipo de pessoa deve ser PF ou PJ.' };
  const digits = row.taxId ? onlyDigits(String(row.taxId)) : null;
  if (digits && (!isValidTaxIdDigits(digits) || digits.length !== (type === 'PF' ? 11 : 14))) return { state: 'QUARANTINED', reason: 'CPF/CNPJ inválido.' };
  if (row.birthDate && Number.isNaN(Date.parse(row.birthDate))) return { state: 'QUARANTINED', reason: 'Data de nascimento inválida.' };
  if (digits) {
    const [dup] = await sequelize.query(
      `SELECT id FROM people.persons WHERE company_id = :companyId AND tax_id_normalized_hash = :hash AND status <> 'MERGED' AND (:self::uuid IS NULL OR id <> :self::uuid) LIMIT 1`,
      { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, hash: hashTaxId(digits), self: existingTargetId || null } }
    );
    if (dup) return { state: 'PENDING_REVIEW', reason: `Possível duplicata: o CPF/CNPJ já pertence ao cadastro ${dup.id}.` };
  }
  return null;
}

function fieldsOf(row) {
  const digits = row.taxId ? onlyDigits(String(row.taxId)) : null;
  return {
    personType: row.personType || 'PF', legalName: row.legalName.trim(), preferredName: row.preferredName || null,
    taxIdNormalized: digits, taxIdNormalizedHash: digits ? hashTaxId(digits) : null, birthOrFoundationDate: row.birthDate || null,
  };
}

async function upsert(tenant, actor, row, existingTargetId, transaction) {
  const fields = fieldsOf(row);
  if (existingTargetId) {
    await Person.update({ ...fields, updatedBy: actor.userId || null }, { where: { id: existingTargetId, companyId: tenant.companyId }, transaction });
    await sequelize.query('UPDATE people.persons SET source_deleted = false, source_deleted_at = NULL WHERE id = :id AND source_deleted', { transaction, replacements: { id: existingTargetId } });
    return existingTargetId;
  }
  const created = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields, status: 'ACTIVE', createdBy: actor.userId || null, updatedBy: actor.userId || null }, { transaction });
  return created.id;
}

/** Exclusão lógica vinda da origem: marca e preserva a linha. */
function markDeleted(tenant, targetId, transaction) {
  return sequelize.query('UPDATE people.persons SET source_deleted = true, source_deleted_at = COALESCE(source_deleted_at, now()) WHERE company_id = :companyId AND id = :id', { transaction, replacements: { companyId: tenant.companyId, id: targetId } });
}

/** Campos canônicos da linha de origem na forma em que o destino os grava (M9-D905: lado da origem da verificação do lote). */
function canonical(row) {
  const digits = row.taxId ? onlyDigits(String(row.taxId)) : null;
  return { personType: row.personType || 'PF', legalName: row.legalName, preferredName: row.preferredName || null, taxId: digits, birthDate: row.birthDate || null };
}

/** Relê do banco de destino as pessoas pedidas, nos mesmos campos canônicos (M9-D905: lado do destino). Devolve Map id -> campos; a pessoa que sumiu não aparece. */
async function readCanonical(tenant, ids, transaction) {
  if (!ids.length) return new Map();
  const rows = await sequelize.query(
    `SELECT id, person_type, legal_name, preferred_name, tax_id_normalized, to_char(birth_or_foundation_date, 'YYYY-MM-DD') AS birth
       FROM people.persons WHERE company_id = :companyId AND id IN (:ids)`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, ids } }
  );
  return new Map(rows.map((r) => [r.id, { personType: r.person_type, legalName: r.legal_name, preferredName: r.preferred_name, taxId: r.tax_id_normalized, birthDate: r.birth }]));
}

module.exports = { entityType: 'PERSON', assess, upsert, markDeleted, canonical, readCanonical };
