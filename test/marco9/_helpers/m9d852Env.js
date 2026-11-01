'use strict';

// Apoio dos testes M9-D852 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { randomUUID } = require('node:crypto');
const http = require('./m9d806Http');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery } = require('../../m9d801.helpers');

const ACTION_PERMISSIONS = ['legal:approve', 'properties:delete', 'finance:settle', 'finance:update', 'procurement:approve', 'governance:dlp:export', 'users:update', 'governance:api:manage', 'integration:manage', 'integration:retry', 'ai:admin', 'construction:update', 'governance:data-quality:manage', 'governance:data-quality:bulk', 'governance:data-quality:read'];

// Permissões que ESTE helper concedeu (as que o papel ainda não tinha): são revogadas em `stopHttp`, para o perfil gestor voltar ao que os demais
// arquivos (m9d870.*, que contam com o gestor SEM as permissões de dono) esperam.
const concedidas = [];
// Connections que `insertConnection` criou: a ACTIVE do ai-sandbox/provedor fica única por empresa (connections_one_active), então uma segunda passada no mesmo banco quebrava; saem de cena em `stopHttp`.
const conexoesCriadas = [];

/** Garante (sem duplicar) as permissões das ações destrutivas no papel do perfil e guarda as linhas que criou. */
async function grantActionPermissions(roleName) {
  const { rows } = await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p
    WHERE r.name = $1 AND p.code = ANY($2) AND NOT EXISTS (SELECT 1 FROM core.role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id) RETURNING id`, [roleName, ACTION_PERMISSIONS]);
  concedidas.push(...rows.map((r) => r.id));
}

async function revokeActionPermissions() {
  if (!concedidas.length) return;
  const ids = concedidas.splice(0);
  await adminQuery('DELETE FROM core.role_permissions WHERE id = ANY($1::uuid[])', [ids]);
}

async function desativarConexoesCriadas() {
  if (!conexoesCriadas.length) return;
  const ids = conexoesCriadas.splice(0);
  await adminQuery("UPDATE integration.connections SET status = 'DISABLED' WHERE id = ANY($1::uuid[]) AND status IN ('ACTIVE', 'PAUSED', 'AUTH_FAILED')", [ids]);
}

async function stopHttp(...args) {
  await revokeActionPermissions().catch(() => {}); // antes: o stopHttp agenda o process.exit
  await desativarConexoesCriadas().catch(() => {});
  return http.stopHttp(...args);
}

async function startHttp(port) {
  if (!DISPOSABLE) return { skip: SKIP_DISPOSABLE };
  await grantActionPermissions('CI GESTOR');
  return http.startHttp({ port, grants: {}, logins: { gestor: ['A', 'gestor'], gestorB: ['B', 'gestor'] } });
}

const suffix = () => `${Date.now()}${Math.floor(Math.random() * 1000000)}`;

async function insertProperty(tenant, title = `QA-M9 Imóvel ${suffix()}`) {
  const { rows: [row] } = await adminQuery(
    `INSERT INTO real_estate.properties (id, group_id, company_id, title, property_type, internal_code, created_by, updated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'HOUSE',$5,$6,$6,now(),now()) RETURNING id, internal_code`,
    [randomUUID(), tenant.groupId, tenant.companyId, title, `M9D852-${suffix()}`, tenant.userId]
  );
  return { id: row.id, code: row.internal_code };
}

async function insertOwnerlessOffer(tenant, propertyId) {
  await adminQuery(
    `INSERT INTO real_estate.property_offers (id, group_id, company_id, property_id, offer_type, asking_price, status, created_by, updated_by, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,'SALE',100000,'ACTIVE',$4,$4,now(),now())`,
    [tenant.groupId, tenant.companyId, propertyId, tenant.userId]
  );
}

async function insertContract(tenant, { status = 'ACTIVE', number = `QA-M9-${suffix()}`, openInstallments = 0 } = {}) {
  const property = await insertProperty(tenant);
  const { rows: [c] } = await adminQuery(
    `INSERT INTO legal.contracts (id, group_id, company_id, property_id, contract_type, contract_number, status, total_value, created_by, updated_by, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,'LEASE',$4,$5,12000,$6,$6,now(),now()) RETURNING id`,
    [tenant.groupId, tenant.companyId, property.id, number, status, tenant.userId]
  );
  for (let i = 0; i < openInstallments; i += 1) await insertBilling(tenant, c.id, `2026-${String(i + 1).padStart(2, '0')}`, 1000);
  return { id: c.id, number };
}

async function insertBilling(tenant, contractId, period, amount, status = 'OPEN') {
  await adminQuery(
    `INSERT INTO finance.billing_schedules (id, group_id, company_id, contract_id, period, due_date, total_amount, paid_amount, balance, status, generated_at, created_by, updated_by, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'2026-12-10',$5,0,$5,$6,now(),$7,$7,now(),now())`,
    [tenant.groupId, tenant.companyId, contractId, period, amount, status, tenant.userId]
  );
}

/** Grava a configuração da empresa direto no banco (o que a tela de Configurações faria). */
async function setSetting(tenant, key, value) {
  await adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = $2', [tenant.companyId, key]);
  if (value === undefined) return;
  await adminQuery(
    `INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, created_at, updated_at) VALUES (gen_random_uuid(),$1,$2,$3,$4::jsonb,now(),now())`,
    [tenant.groupId, tenant.companyId, key, JSON.stringify(value)]
  );
}

const exists = async (table, id) => (await adminQuery(`SELECT 1 FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [id])).rowCount > 0;
const statusOf = async (table, id) => (await adminQuery(`SELECT status FROM ${table} WHERE id = $1`, [id])).rows[0].status;
const auditRows = async (tenant, action, entityId) => (await adminQuery('SELECT * FROM audit.audit_log WHERE company_id = $1 AND action = $2 AND ($3::uuid IS NULL OR entity_id = $3) ORDER BY occurred_at DESC', [tenant.companyId, action, entityId || null])).rows;

async function insertEntry(tenant, { status = 'SETTLED', amount = 250.5, description = `QA-M9 lançamento ${suffix()}` } = {}) {
  const { rows: [row] } = await adminQuery(
    `INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, amount, competence_month, description, status, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,'DEBIT','PAYABLE',$3,'2026-10',$4,$5,now(),now()) RETURNING id`,
    [tenant.groupId, tenant.companyId, amount, description, status]
  );
  return row.id;
}

async function insertIntent(tenant, entryId, status = 'PENDING') {
  const { rows: [row] } = await adminQuery(
    `INSERT INTO finance.payment_intents (id, group_id, company_id, financial_entry_id, snapshot_json, snapshot_hash, status, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,'{}'::jsonb,'qa-m9d852',$4,now(),now()) RETURNING id`,
    [tenant.groupId, tenant.companyId, entryId, status]
  );
  return row.id;
}

async function insertProject(tenant, { status = 'PLANNED', name = `QA-M9 Obra ${suffix()}` } = {}) {
  const { rows: [row] } = await adminQuery(
    `INSERT INTO construction.projects (id, group_id, company_id, name, status, code, budget_amount, created_by, updated_by, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,100000,$6,$6,now(),now()) RETURNING id, code`,
    [tenant.groupId, tenant.companyId, name, status, `OB-${suffix()}`.slice(0, 30), tenant.userId]
  );
  return { id: row.id, code: row.code, name };
}

async function insertConnection(tenant, status = 'ACTIVE') {
  const { rows: [provider] } = await adminQuery('SELECT code FROM integration.providers ORDER BY code LIMIT 1');
  const { rows: [row] } = await adminQuery(
    `INSERT INTO integration.connections (id, group_id, company_id, provider_code, environment, label, status, created_by, updated_by, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,$3,'SANDBOX',$4,$5,$6,$6,now(),now()) RETURNING id, label`,
    [tenant.groupId, tenant.companyId, provider.code, `QA-M9 integração ${suffix()}`, status, tenant.userId]
  );
  conexoesCriadas.push(row.id);
  return { id: row.id, label: row.label };
}

module.exports = { insertEntry, insertIntent, insertProject, insertConnection, desativarConexoesCriadas, DISPOSABLE, SKIP_DISPOSABLE, adminQuery, startHttp, stopHttp, insertProperty, insertOwnerlessOffer, insertContract, insertBilling, setSetting, exists, statusOf, auditRows };
