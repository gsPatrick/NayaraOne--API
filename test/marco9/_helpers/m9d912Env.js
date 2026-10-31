'use strict';

// Apoio dos testes M9-D912 (não é teste): retenção legal com banco descartável. Reaproveita o ambiente da retenção (M9-D911) e acrescenta as fábricas de pessoa, contrato,
// processo e arquivo, a criação/liberação de retenção legal e a limpeza (retenção só sai depois de liberada: o gatilho do banco protege a ativa).
const { randomUUID } = require('node:crypto');
const base = require('./m9d911Env');
const holds = require('../../../src/features/core-governance/data-quality/legalHold.service');
const guard = require('../../../src/features/core-governance/data-quality/legalHold.guard');
const wiring = require('../../../src/features/core-governance/data-quality/legalHold.wiring');

const { adminQuery, inTx, actorOf } = base;
const tag = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;
const code = (label) => `QA-${label}-${tag()}`.slice(0, 40);

/** Liga a trava real à retenção (os testes da M9-D911 trocam o provedor por um stub; aqui volta o verdadeiro). */
const useRealGuard = () => wiring.install();

const createHold = (tenant, body, actor = actorOf(tenant)) => inTx(tenant, (tx) => holds.create(tenant, actor, { code: code('H'), reason: 'QA-M9 processo de teste', matter_ref: '0001234-56.2026.8.26.0100', ...body }, tx));
const releaseHold = (tenant, id, reason = 'QA-M9 encerrado') => inTx(tenant, (tx) => holds.release(tenant, actorOf(tenant), id, { release_reason: reason }, tx));
const withTx = (tenant, fn) => inTx(tenant, fn);
const assertNotOnHold = (tenant, type, id) => inTx(tenant, (tx) => guard.assertNotOnHold(type, id, tx, tenant));

/** Libera e apaga todas as retenções da empresa (e os alvos, em cascata). */
async function resetHolds(tenant) {
  await adminQuery("UPDATE governance.legal_holds SET status = 'RELEASED', released_at = now(), release_reason = 'limpeza de teste' WHERE company_id = $1 AND status = 'ACTIVE'", [tenant.companyId]);
  await adminQuery('DELETE FROM governance.legal_holds WHERE company_id = $1', [tenant.companyId]);
}

async function insertPerson(tenant, name = `QA-M9 Pessoa ${tag()}`) {
  const id = randomUUID(); const n = tag();
  await adminQuery('INSERT INTO people.persons (id, group_id, company_id, legal_name, preferred_name, tax_id_normalized, tax_id_normalized_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $4, $5, $6, now(), now())',
    [id, tenant.groupId, tenant.companyId, name, `9${n}`.slice(0, 14), `hash-912-${n}`]);
  return id;
}

async function insertContract(tenant, personId = null, { endsAt = null, status = 'DRAFT' } = {}) {
  const id = randomUUID();
  await adminQuery(`INSERT INTO legal.contracts (id, group_id, company_id, contract_type, contract_number, status, total_value, ends_at, created_by, updated_by) VALUES ($1, $2, $3, 'SALE', $4, $5, 1000, $6, $7, $7)`,
    [id, tenant.groupId, tenant.companyId, `QA912-${tag()}`, status, endsAt, tenant.userId]);
  if (personId) await adminQuery("INSERT INTO legal.contract_parties (id, group_id, company_id, contract_id, person_id, party_role) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'BUYER')", [tenant.groupId, tenant.companyId, id, personId]);
  return id;
}

const addParty = (tenant, contractId, personId) => adminQuery("INSERT INTO legal.contract_parties (id, group_id, company_id, contract_id, person_id, party_role) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'BUYER')", [tenant.groupId, tenant.companyId, contractId, personId]);

async function insertFile(tenant, { linkType = null, linkId = null } = {}) {
  const id = randomUUID();
  await adminQuery("INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, mime_type, size_bytes, created_at, updated_at) VALUES ($1, $2, $3, $4, 'qa912.pdf', 'application/pdf', 10, now(), now())", [id, tenant.groupId, tenant.companyId, `qa-m9/d912/${tag()}`]);
  if (linkType) await adminQuery("INSERT INTO people.file_links (id, group_id, company_id, file_id, related_entity_type, related_entity_id, purpose, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'ATTACHMENT', now(), now())", [tenant.groupId, tenant.companyId, id, linkType, linkId]);
  return id;
}

const targetsOf = async (holdId) => (await adminQuery('SELECT entity_type, entity_id, origin FROM governance.legal_hold_targets WHERE hold_id = $1 ORDER BY entity_type, entity_id', [holdId])).rows;
const auditRows = async (tenant, action) => (await adminQuery('SELECT entity_id, before_json, after_json FROM audit.audit_log WHERE company_id = $1 AND action = $2 ORDER BY occurred_at', [tenant.companyId, action])).rows;
const personAlive = async (id) => (await adminQuery('SELECT deleted_at FROM people.persons WHERE id = $1', [id])).rows[0];

module.exports = { ...base, tag, code, useRealGuard, createHold, releaseHold, withTx, assertNotOnHold, resetHolds, insertPerson, insertContract, addParty, insertFile, targetsOf, auditRows, personAlive, holds, guard };
