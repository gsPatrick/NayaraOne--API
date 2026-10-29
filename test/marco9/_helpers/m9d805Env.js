'use strict';

// Apoio dos testes M9-D805 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { QueryTypes } = require('sequelize');
const base = require('./m9d807Env');
const stewardship = require('../../../src/features/core-governance/data-quality/stewardship.service');
const repository = require('../../../src/features/core-governance/data-quality/merge.repository');
const { PersonContact } = require('../../../src/models');

const { sequelize } = base;
const DOMAINS = Object.freeze({ PERSON: 'PESSOAS', PROPERTY: 'IMOVEIS', SUPPLIER: 'FORNECEDORES' });

async function contact(tenant, tx, personId, value, contactType = 'PHONE') {
  return PersonContact.create({
    groupId: tenant.groupId, companyId: tenant.companyId, personId, contactType, valueNormalized: value, isPrimary: false, createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction: tx });
}

/** Usuário novo designado STEWARD dos domínios pedidos (padrão: os três da fila). */
async function steward(tenant, tx, domains = Object.values(DOMAINS)) {
  const user = await base.newUser(tenant, tx);
  for (const code of domains) await stewardship.designate(tenant, base.actorOf(tenant), code, { designations: [{ role: 'STEWARD', userId: user.id }] }, tx);
  return { user, actor: { userId: user.id, roles: [] } };
}

/** Par na fila (como a detecção grava). */
async function candidate(tenant, tx, entityType, a, b, { reason = 'PERSON_TAX_ID', score = 100 } = {}) {
  return repository.insertCandidate(tenant, { entityType, primaryId: a, secondaryId: b, reason, score }, tx);
}

const query = (sql, replacements, tx) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction: tx, replacements });
const queueRows = (tenant, tx, where = 'TRUE', replacements = {}) => query(`SELECT * FROM governance.review_queue_items WHERE company_id = :companyId AND ${where} ORDER BY created_at, id`, { companyId: tenant.companyId, ...replacements }, tx);

async function feedbackCase(tenant, tx, personId) {
  const [row] = await query(
    `INSERT INTO crm.feedback_cases (id, group_id, company_id, person_id, type, description, sla_due_at, created_at, updated_at)
     VALUES (gen_random_uuid(), :groupId, :companyId, :personId, 'COMPLAINT', 'QA-M9 caso', now() + interval '1 day', now(), now()) RETURNING id`,
    { groupId: tenant.groupId, companyId: tenant.companyId, personId }, tx
  );
  return row.id;
}

async function supplierEvaluation(tenant, tx, supplierPersonId) {
  const [row] = await query(
    `INSERT INTO procurement.supplier_evaluations (id, group_id, company_id, supplier_person_id, score, created_at, updated_at)
     VALUES (gen_random_uuid(), :groupId, :companyId, :supplierPersonId, 4, now(), now()) RETURNING id`,
    { groupId: tenant.groupId, companyId: tenant.companyId, supplierPersonId }, tx
  );
  return row.id;
}

async function fileLink(tenant, tx, fileId, type, entityId) {
  await query(
    `INSERT INTO people.file_links (id, group_id, company_id, file_id, related_entity_type, related_entity_id, created_at, updated_at)
     VALUES (gen_random_uuid(), :groupId, :companyId, :fileId, :type, :entityId, now(), now()) RETURNING id`,
    { groupId: tenant.groupId, companyId: tenant.companyId, fileId, type, entityId }, tx
  );
}

module.exports = { ...base, DOMAINS, contact, steward, candidate, query, queueRows, feedbackCase, supplierEvaluation, fileLink, sequelize };
