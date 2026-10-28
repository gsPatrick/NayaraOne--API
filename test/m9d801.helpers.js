'use strict';

// Apoio dos testes M9-D801 (não é teste): ambiente do banco descartável, tenants semeados e inserção direta de itens.
// Rodar SEMPRE em banco descartável (node scripts/withDisposableDb.js); nunca contra o .env remoto.

const { Client } = require('pg');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP_DISPOSABLE = 'precisa do cluster descartável (node scripts/withDisposableDb.js); nunca rodar contra o banco do .env';
const { randomUUID: uuid } = require('node:crypto');

async function adminQuery(sql, params) {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/** Empresa, grupo e usuário gestor de cada tenant do seed de dois tenants. */
async function loadTenants() {
  const out = {};
  for (const key of ['A', 'B']) {
    const { rows: [company] } = await adminQuery(`SELECT id, group_id FROM core.companies WHERE name LIKE 'CI%Empresa Fictícia ${key}%'`);
    const { rows: [user] } = await adminQuery('SELECT id FROM core.users WHERE email = $1', [`ci-${key.toLowerCase()}-gestor@ci.nayaraone.test`]);
    out[key] = { groupId: company.group_id, companyId: company.id, userId: user.id };
  }
  return out;
}

/** Insere um item direto no banco (como o projetor faria); devolve o id. */
async function insertItem(tenant, fields = {}) {
  const item = {
    sourceType: 'CRM_TASK', sourceId: uuid(), title: 'QA-M9 item', ownerUserId: null, dueAt: '2026-11-05T15:00:00Z', endAt: null,
    severity: 'INFO', status: 'OPEN', deepLink: '/painel/crm/tarefas/x', ...fields,
  };
  const { rows: [row] } = await adminQuery(
    `INSERT INTO governance.calendar_items (group_id, company_id, source_type, source_id, title, owner_user_id, due_at, end_at, severity, status, deep_link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [tenant.groupId, tenant.companyId, item.sourceType, item.sourceId, item.title, item.ownerUserId, item.dueAt, item.endAt, item.severity, item.status, item.deepLink]
  );
  return { id: row.id, ...item };
}

async function cleanCalendar(tenants) {
  for (const t of tenants) {
    await adminQuery('DELETE FROM governance.calendar_items WHERE company_id = $1', [t.companyId]);
    await adminQuery('DELETE FROM governance.calendar_commitments WHERE company_id = $1', [t.companyId]);
  }
}

module.exports = { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants, insertItem, cleanCalendar };
