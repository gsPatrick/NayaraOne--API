'use strict';

// Apoio comum dos testes do M9-D800 (alicerce da governança): constantes do livro, cliente admin do cluster
// descartável, subida do app com logins e chamada HTTP. Rodar SEMPRE em banco descartável (nunca no .env remoto).

process.env.PORT = process.env.M9D800_HTTP_TEST_PORT || require('../marco9/_helpers/portaLivre').portaLivre();

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { Sequelize } = require('sequelize');

const API_ROOT = path.join(__dirname, '..', '..');
const GOV_DIR = path.join(API_ROOT, 'src', 'features', 'core-governance');
const DEMANDAS_DIR = path.join(API_ROOT, '..', 'Maturacao', 'demandas', 'marco-9');

const EXPECTED_MODULES = ['api-governance', 'bcp', 'calendar', 'data-quality', 'dlp', 'feature-flags', 'finops', 'lineage'];
const EXPECTED_PERMISSIONS = [
  'governance:calendar:read', 'governance:data-quality:read', 'governance:data-quality:manage', 'governance:data-quality:bulk',
  'governance:lineage:manage', 'governance:dlp:export', 'governance:dlp:admin', 'governance:dlp:view-restricted',
  'governance:bcp:record', 'governance:bcp:import', 'governance:bcp:approve', 'governance:api:read', 'governance:api:manage',
  'governance:finops:read', 'governance:finops:manage', 'governance:flags:manage', 'governance:migration:run',
  'governance:migration:admin', 'governance:classification:manage', 'governance:retention:manage', 'governance:legal-hold:manage',
];
const SENSITIVE_13 = [
  'governance:data-quality:bulk', 'governance:dlp:admin', 'governance:dlp:view-restricted', 'governance:bcp:approve',
  'governance:lineage:manage', 'governance:api:manage', 'governance:finops:manage', 'governance:flags:manage',
  'governance:migration:run', 'governance:migration:admin', 'governance:classification:manage', 'governance:retention:manage',
  'governance:legal-hold:manage',
];
const GESTAO_6 = ['governance:calendar:read', 'governance:data-quality:read', 'governance:data-quality:manage', 'governance:dlp:export', 'governance:api:read', 'governance:finops:read'];
const FINANCEIRO_5 = ['governance:calendar:read', 'governance:finops:read', 'governance:dlp:export', 'governance:bcp:record', 'governance:bcp:import'];
const EVENTS_7 = [
  'calendar.item.updated', 'data.quality.issue.opened', 'dlp.export.blocked', 'bcp.manual_operation.recorded',
  'bcp.manual_operation.imported', 'api.consumer.deprecation_due', 'finops.budget.threshold',
];
const README_TITLES = ['Objetivo', 'Tabelas', 'Rotas e permissões', 'Eventos', 'Jobs e horários', 'Parâmetros', 'Decisões (ADR)', 'Como testar', 'Como diagnosticar'];

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP_DISPOSABLE = 'precisa do cluster descartável (node scripts/withDisposableDb.js); nunca rodar contra o banco do .env';

let adminSequelize;
let sequelize;
let baseUrl;
let appLoaded = false;
let httpSkip = null;
const tokens = {};

function adminClient() {
  return new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
}

async function adminQuery(sql, params) {
  const client = adminClient();
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

// Prepara o cluster descartável, o app e os tokens; sem cluster/seed, devolve httpSkip com o motivo.
async function bootstrap() {
  if (!DISPOSABLE) {
    httpSkip = SKIP_DISPOSABLE;
    return;
  }
  adminSequelize = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  ({ sequelize } = require('../../src/models'));

  const password = process.env.CI_TENANT_USERS_PASSWORD;
  const { emailFor } = require('../../scripts/seed-ci-two-tenants');
  const seeded = password ? (await adminQuery('SELECT 1 FROM core.users WHERE email = $1', [emailFor('A', 'gestor')])).rowCount : 0;
  if (!seeded) {
    httpSkip = 'seed de dois tenants ausente (scripts/seed-ci-two-tenants.js com CI_TENANT_USERS_PASSWORD).';
    return;
  }

  // A permissão de leitura do calendário é dada ao perfil CI GESTOR da empresa A ANTES do login (o token carrega as
  // permissões efetivas lidas do banco). CI LEITURA fica sem nenhuma permissão de governança.
  await adminQuery(`
    INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now()
      FROM core.roles r CROSS JOIN core.permissions p
     WHERE r.name IN ('CI GESTOR') AND p.code IN ('governance:calendar:read', 'governance:finops:read')
       AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`);
  await adminQuery(`DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
     WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = 'CI LEITURA' AND p.code LIKE 'governance:%'`);

  require('../../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 400));

  for (const [tenant, profile] of [['A', 'gestor'], ['A', 'leitura'], ['B', 'gestor']]) {
    let res; let body;
    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailFor(tenant, profile), password }),
      });
      body = await res.json();
      if (res.status !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (tentativa + 1)));
    }
    assert.equal(res.status, 200, `login ${tenant}/${profile}: ${JSON.stringify(body)}`);
    tokens[`${tenant}:${profile}`] = body.data.accessToken;
  }
}

async function setupEnv() {
  await bootstrap();
  return { sequelize, adminSequelize, httpSkip };
}

async function teardownEnv() {
  if (adminSequelize) await adminSequelize.close().catch(() => {});
  if (sequelize) await sequelize.close().catch(() => {});
  if (appLoaded) setTimeout(() => process.exit(0), 300);
}

async function call(who, method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), correlation: res.headers.get('x-correlation-id') };
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

module.exports = {
  API_ROOT, GOV_DIR, DEMANDAS_DIR, EXPECTED_MODULES, EXPECTED_PERMISSIONS, SENSITIVE_13, GESTAO_6, FINANCEIRO_5, EVENTS_7,
  README_TITLES, DISPOSABLE, SKIP_DISPOSABLE, adminQuery, setupEnv, teardownEnv, call, listJsFiles,
};
