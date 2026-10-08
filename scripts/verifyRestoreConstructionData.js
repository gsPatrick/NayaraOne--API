'use strict';

/**
 * GAP REAL CORRIGIDO (auditoria Marco 6, 08/10/2026 — a auditora externa da Nayara pediu
 * verificação ESPECÍFICA dos dados de Obras após um restore, não só "contagem de tabelas e
 * linhas de core.groups"). Este script compara, entre um banco de ORIGEM e um banco de DESTINO
 * (já restaurado via scripts/restoreDatabase.js), as contagens das tabelas do schema
 * `construction` e o conteúdo campo a campo de uma obra real (a primeira por created_at) + seu
 * orçamento, se existir.
 *
 * Uso:
 *   node scripts/verifyRestoreConstructionData.js --source-db <banco-origem> --target-db <banco-destino>
 *
 * Conexão (host/porta/usuário/senha) é a mesma para origem e destino — lida de DATABASE_URL/
 * DB_HOST/DB_PORT/DB_USER/DB_PASSWORD, igual ao padrão de backupDatabase.js/restoreDatabase.js.
 * Só o nome do banco muda entre origem e destino.
 *
 * Exit code 1 se qualquer divergência for encontrada.
 */

require('dotenv').config();
const { Client } = require('pg');
const { resolveConnection } = require('./backupDatabase');

const CONSTRUCTION_TABLES = [
  'projects',
  'budgets',
  'budget_lines',
  'stage_measurements',
  'daily_reports',
  'nonconformities',
  'maintenance_cases',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source-db' && argv[i + 1]) { out.sourceDb = argv[i + 1]; i += 1; }
    if (argv[i] === '--target-db' && argv[i + 1]) { out.targetDb = argv[i + 1]; i += 1; }
  }
  return out;
}

async function connectTo(conn, database) {
  const client = new Client({
    host: conn.host,
    port: Number(conn.port),
    user: conn.user,
    password: conn.password,
    database,
  });
  await client.connect();
  return client;
}

async function countRows(client, table) {
  const res = await client.query(`SELECT COUNT(*)::int AS count FROM construction.${table}`);
  return res.rows[0].count;
}

async function fetchFirstProject(client) {
  const res = await client.query(
    `SELECT id, name, status, budget_amount AS "budgetAmount", responsible_user_id AS "responsibleUserId", created_at AS "createdAt"
     FROM construction.projects
     ORDER BY created_at ASC
     LIMIT 1`
  );
  return res.rows[0] || null;
}

async function fetchBudgetForProject(client, projectId) {
  const res = await client.query(
    `SELECT id, baseline_amount AS "baselineAmount", status
     FROM construction.budgets
     WHERE project_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [projectId]
  );
  return res.rows[0] || null;
}

function normalize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value instanceof Date) return value.toISOString();
  return String(value);
}

function compareField(label, sourceValue, targetValue, checks) {
  const a = normalize(sourceValue);
  const b = normalize(targetValue);
  const ok = a === b;
  checks.push({ label, ok, sourceValue: a, targetValue: b });
  const line = ok
    ? `  ✅ idêntico — ${label}: "${a}"`
    : `  ❌ DIVERGÊNCIA: ${label} era "${a}", virou "${b}"`;
  console.log(line);
  return ok;
}

async function main() {
  const { sourceDb, targetDb } = parseArgs(process.argv.slice(2));
  if (!sourceDb || !targetDb) {
    throw new Error('Uso: node scripts/verifyRestoreConstructionData.js --source-db <banco-origem> --target-db <banco-destino>');
  }

  const conn = resolveConnection();
  const source = await connectTo(conn, sourceDb);
  const target = await connectTo(conn, targetDb);

  const checks = [];
  let anyDivergence = false;

  try {
    console.log(`\n=== Comparando "${sourceDb}" (origem) x "${targetDb}" (destino) ===\n`);

    console.log('--- Contagem de linhas por tabela (schema construction) ---');
    for (const table of CONSTRUCTION_TABLES) {
      const sourceCount = await countRows(source, table);
      const targetCount = await countRows(target, table);
      const ok = sourceCount === targetCount;
      anyDivergence = anyDivergence || !ok;
      checks.push({ label: `contagem construction.${table}`, ok, sourceValue: sourceCount, targetValue: targetCount });
      console.log(
        ok
          ? `  ✅ idêntico — construction.${table}: ${sourceCount} linhas`
          : `  ❌ DIVERGÊNCIA: construction.${table} tinha ${sourceCount} linhas, virou ${targetCount}`
      );
    }

    console.log('\n--- Conteúdo campo a campo da primeira obra (construction.projects, por created_at) ---');
    const sourceProject = await fetchFirstProject(source);
    const targetProject = await fetchFirstProject(target);

    if (!sourceProject) {
      console.log('  (nenhuma obra encontrada em construction.projects na origem — nada a comparar)');
    } else if (!targetProject) {
      anyDivergence = true;
      console.log(`  ❌ DIVERGÊNCIA: obra "${sourceProject.id}" existe na origem mas não foi encontrada no destino`);
    } else {
      console.log(`  Obra de referência: id=${sourceProject.id}`);
      const fieldsOk = [
        compareField('name', sourceProject.name, targetProject.name, checks),
        compareField('status', sourceProject.status, targetProject.status, checks),
        compareField('budgetAmount', sourceProject.budgetAmount, targetProject.budgetAmount, checks),
        compareField('responsibleUserId', sourceProject.responsibleUserId, targetProject.responsibleUserId, checks),
      ];
      anyDivergence = anyDivergence || fieldsOk.some((ok) => !ok);

      console.log('\n--- Orçamento da obra (construction.budgets) ---');
      const sourceBudget = await fetchBudgetForProject(source, sourceProject.id);
      const targetBudget = await fetchBudgetForProject(target, sourceProject.id);

      if (!sourceBudget) {
        console.log('  (nenhum orçamento encontrado para essa obra na origem — nada a comparar)');
      } else if (!targetBudget) {
        anyDivergence = true;
        console.log(`  ❌ DIVERGÊNCIA: orçamento "${sourceBudget.id}" existe na origem mas não foi encontrado no destino`);
      } else {
        const budgetFieldsOk = [
          compareField('baselineAmount', sourceBudget.baselineAmount, targetBudget.baselineAmount, checks),
          compareField('status (budget)', sourceBudget.status, targetBudget.status, checks),
        ];
        anyDivergence = anyDivergence || budgetFieldsOk.some((ok) => !ok);
      }
    }

    console.log('\n=== Resumo ===');
    const totalChecks = checks.length;
    const failedChecks = checks.filter((c) => !c.ok).length;
    console.log(`${totalChecks - failedChecks}/${totalChecks} checagens idênticas.`);

    if (anyDivergence) {
      console.log('❌ RESULTADO FINAL: divergência(s) encontrada(s) — ver detalhes acima.');
    } else {
      console.log('✅ RESULTADO FINAL: nenhuma divergência encontrada entre origem e destino.');
    }
  } finally {
    await source.end();
    await target.end();
  }

  if (anyDivergence) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { main, CONSTRUCTION_TABLES };
