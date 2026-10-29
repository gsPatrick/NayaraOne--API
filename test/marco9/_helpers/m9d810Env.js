'use strict';

// Apoio dos testes M9-D810/D811 (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const base = require('./m9d803Env');
const { adminQuery } = require('../../m9d801.helpers');

const { QueryTypes } = require('sequelize');

const { sequelize } = base;
const query = (sql, replacements, tx) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction: tx, replacements });
const actorOf = (tenant) => ({ userId: tenant.userId, roles: ['ADMIN'] });
const LINEAGE_PERMISSION = 'governance:lineage:manage';

/** Os cinco nós de um caminho completo de KPI, com responsável e descrição, e as quatro arestas entre as camadas. */
function fullPath(code = 'qa.kpi', overrides = {}) {
  const node = (nodeType, suffix) => ({ nodeType, code: `${code}.${suffix}`, description: `QA-M9 ${nodeType} de ${code}`, ownerDomain: 'FINANCEIRO', area: 'EXEC_KPI', ...overrides[nodeType] });
  const nodes = [node('SOURCE_FIELD', 'src'), node('DOMAIN_FIELD', 'dom'), node('EVENT', 'evt'), node('READ_MODEL', 'rm')];
  nodes.push({ ...node('METRIC', 'm'), code });
  const edges = nodes.slice(0, -1).map((from, i) => ({ from: { nodeType: from.nodeType, code: from.code }, to: { nodeType: nodes[i + 1].nodeType, code: nodes[i + 1].code }, transformation: 'QA-M9 soma' }));
  return { nodes, edges };
}

/** Grava o caminho pelo serviço (as rotas de manutenção). */
async function savePath(service, tenant, tx, path = fullPath()) {
  for (const n of path.nodes) await service.saveNode(tenant, actorOf(tenant), n, tx, { create: false });
  for (const e of path.edges) await service.saveEdge(tenant, actorOf(tenant), e, tx, { create: false });
  return path;
}

/** Pasta temporária com arquivos de semente (nome -> módulo como texto). */
function tmpSeedDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-seeds-'));
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
  return dir;
}

const codeOf = async (promise) => promise.then(() => null, (err) => ({ code: err.code, status: err.statusCode, message: err.message }));

/** Dá (ou tira) a permissão de gerir o lineage a um perfil de CI, nas duas empresas. */
async function setLineagePermission(roleName, granted) {
  await adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = $2', [roleName, LINEAGE_PERMISSION]);
  if (!granted) return;
  await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = $2`, [roleName, LINEAGE_PERMISSION]);
}

module.exports = { ...base, query, actorOf, fullPath, savePath, tmpSeedDir, codeOf, setLineagePermission, adminQuery, sequelize };
