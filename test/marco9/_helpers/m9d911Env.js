'use strict';

// Apoio dos testes M9-D911 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Os dados de apoio são gravados com commit pelo
// superusuário do cluster descartável (o apply roda lotes em transações próprias e só enxerga dado com commit).
const { randomUUID } = require('node:crypto');
const { adminQuery, loadTenants, DISPOSABLE, SKIP_DISPOSABLE } = require('../../m9d801.helpers');
const { sequelize } = require('../../../src/models');
const { openTenantTx } = require('../../../src/features/core-governance/data-quality/retention.tenantTx');
const service = require('../../../src/features/core-governance/data-quality/retention.service');
const holdGuard = require('../../../src/features/core-governance/data-quality/retention.holdGuard');

const skip = () => (DISPOSABLE ? false : SKIP_DISPOSABLE);
const actorOf = (tenant) => ({ userId: tenant.userId, roles: [] });
/** Transação do tenant COM commit (como a requisição real). */
const inTx = (tenant, fn) => openTenantTx(tenant, fn);
const dryRun = (tenant, options = {}) => inTx(tenant, (tx) => service.runDryRun(tenant, actorOf(tenant), options, tx));
const apply = (tenant, runId, options = {}) => service.applyRun(tenant, actorOf(tenant), runId, { runTx: (fn) => openTenantTx(tenant, fn), ...options });
const policies = (tenant) => inTx(tenant, (tx) => service.listPolicies(tenant, tx));
const policyOf = async (tenant, code) => (await policies(tenant)).find((policy) => policy.code === code);

/** Edita a política `code` (merge com a atual, como o PUT). */
async function editPolicy(tenant, code, changes) {
  const current = await policyOf(tenant, code);
  const body = { code, name: current.name, retention_months: current.retentionMonths, trigger: current.trigger, legal_basis: { code: current.legalBasis.code, reference_text: current.legalBasis.referenceText },
    disposition: current.disposition, exceptions: current.exceptions, owner_domain: current.ownerDomain, data_types: current.dataTypes, auto_apply: current.autoApply, ...changes };
  return inTx(tenant, (tx) => service.putPolicy(tenant, actorOf(tenant), body, tx));
}

/** Zera o estado da retenção da empresa (políticas, rodadas e itens); o arquivo de retenção é só de acréscimo e não se apaga. */
async function resetRetention(tenant) {
  await adminQuery('DELETE FROM governance.data_classification_registry WHERE company_id = $1', [tenant.companyId]);
  await adminQuery('DELETE FROM governance.retention_runs WHERE company_id = $1', [tenant.companyId]);
  await adminQuery('DELETE FROM governance.retention_policies WHERE company_id = $1', [tenant.companyId]);
}

const clearSignals = (tenant) => adminQuery('DELETE FROM governance.access_signals WHERE company_id = $1', [tenant.companyId]);
/** `count` sinais de acesso (logs técnicos) ocorridos em `occurredAt` (ISO). */
const insertSignals = (tenant, count, occurredAt) => adminQuery(
  `INSERT INTO governance.access_signals (group_id, company_id, user_id, kind, action, classification, outcome, resource_type, occurred_at)
   SELECT $1, $2, $3, 'READ', 'VIEW', 'LOW', 'ALLOWED', 'QA', $4::timestamptz FROM generate_series(1, $5)`, [tenant.groupId, tenant.companyId, tenant.userId, occurredAt, count]
);
const signalIds = async (tenant) => (await adminQuery('SELECT id::text FROM governance.access_signals WHERE company_id = $1 ORDER BY id', [tenant.companyId])).rows.map((row) => row.id);
const countSignals = async (tenant) => Number((await adminQuery('SELECT count(*) AS n FROM governance.access_signals WHERE company_id = $1', [tenant.companyId])).rows[0].n);

/** Lead: pessoa com oportunidade, sem contrato, com contato e endereço; todas as datas recuadas para `lastContact` (ISO). */
async function insertLead(tenant, { name, taxId, lastContact, phone = '11988887777' }) {
  const id = randomUUID();
  const c = [tenant.groupId, tenant.companyId];
  await adminQuery(`INSERT INTO people.persons (id, group_id, company_id, legal_name, preferred_name, tax_id_normalized, tax_id_normalized_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $7)`, [id, ...c, name, taxId, `hash-${taxId}`, lastContact]);
  await adminQuery(`INSERT INTO people.person_contacts (id, group_id, company_id, person_id, contact_type, value_normalized, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, 'PHONE', $4, $5, $5)`, [...c, id, phone, lastContact]);
  await adminQuery(`INSERT INTO people.person_addresses (id, group_id, company_id, person_id, street, number, zip_code, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, 'Rua Teste QA', '77', '01310100', $4, $4)`, [...c, id, lastContact]);
  await adminQuery(`INSERT INTO crm.opportunities (id, group_id, company_id, person_id, stage, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, 'CLOSED_LOST', $4, $4)`, [...c, id, lastContact]);
  return id;
}
const personRow = async (id) => (await adminQuery('SELECT * FROM people.persons WHERE id = $1', [id])).rows[0];

const insertFiscal = (tenant, year, status, type = 'DIMOB') => adminQuery(`INSERT INTO correspondent.fiscal_obligations (id, group_id, company_id, obligation_type, reference_year, due_at, status, description) VALUES (gen_random_uuid(), $1, $2, $5, $3, make_date($3, 12, 31), $4, 'QA-M9 D911') RETURNING id`, [tenant.groupId, tenant.companyId, year, status, type]);
const clearFiscal = (tenant) => adminQuery("DELETE FROM correspondent.fiscal_obligations WHERE company_id = $1 AND description = 'QA-M9 D911'", [tenant.companyId]);

const setHold = (heldSet) => holdGuard.setProvider({ isOnHold: async (_type, id) => heldSet.has(String(id)) });
const items = async (runId, where = 'TRUE') => (await adminQuery(`SELECT * FROM governance.retention_run_items WHERE run_id = $1 AND ${where} ORDER BY target_code, record_id`, [runId])).rows;
const audits = async (tenant, action, runId) => (await adminQuery('SELECT after_json FROM audit.audit_log WHERE company_id = $1 AND action = $2 AND entity_id = $3 ORDER BY occurred_at', [tenant.companyId, action, runId])).rows;
const policyReport = (run, code) => run.report.policies.find((policy) => policy.code === code);

module.exports = {
  DISPOSABLE, skip, loadTenants, adminQuery, sequelize, service, holdGuard, actorOf, inTx, dryRun, apply, policies, policyOf, editPolicy, resetRetention, clearSignals, insertSignals, signalIds,
  countSignals, insertLead, personRow, insertFiscal, clearFiscal, setHold, items, audits, policyReport,
};
