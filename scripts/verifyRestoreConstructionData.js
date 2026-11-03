'use strict';

/**
 * GAP REAL CORRIGIDO (auditoria Marco 6, 08/10/2026 — a auditora externa da Nayara pediu
 * verificação ESPECÍFICA dos dados de Obras após um restore, não só "contagem de tabelas e
 * linhas de core.groups"). Este script compara, entre um banco de ORIGEM e um banco de DESTINO
 * (já restaurado via scripts/restoreDatabase.js), as contagens das tabelas do schema
 * `construction` e o conteúdo campo a campo de uma obra real + seu orçamento + suas medições.
 *
 * GAP REAL CORRIGIDO #2 (auditoria externa Nayara, 08/10/2026, segunda rodada — "o script
 * compara contagens de sete tabelas, quatro campos da primeira obra e dois campos do
 * orçamento, caso exista. Não compara o conteúdo das medições."): a obra de referência deixou
 * de ser simplesmente "a primeira por created_at" — agora é escolhida por uma query que exige
 * que ela TENHA orçamento (construction.budgets) E pelo menos uma medição
 * (construction.stage_measurements), e o conteúdo campo a campo de até 2 medições reais dessa
 * obra também é comparado (measuredPct/totalAmount/status/projectStageId).
 *
 * GAP REAL CORRIGIDO #3 (mesma auditoria, achado durante a implementação do #2): as tabelas do
 * schema `construction` têm Row-Level Security (policy `tenant_isolation`, fail-closed, chave
 * em `company_id`/`group_id` via `current_setting('app.company_id'/'app.group_id', true)`). Uma
 * conexão pg "crua" (sem SET LOCAL desses parâmetros, como este script fazia antes) NUNCA
 * enxerga nenhuma linha dessas tabelas — toda COUNT(*) retornava 0 e toda busca de obra de
 * referência retornava vazia, silenciosamente, independente do estado real do banco (role de
 * conexão `nayara_runtime` não tem BYPASSRLS). O script agora varre `core.groups` (sem RLS) e,
 * para cada group, `core.companies` (RLS por group_id) dentro de uma transação com
 * `SET LOCAL app.group_id`/`app.company_id`, e só então consulta `construction.*` com o
 * contexto de tenant correto — exatamente o mesmo mecanismo que `req.withTenantTransaction` usa
 * na aplicação (ver src/middlewares/tenant.middleware.js) e que scripts/seed-dev.js já replica.
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

/**
 * listGroupCompanyPairs — todos os pares (group_id, company_id) existentes (core.groups sem
 * RLS; core.companies com RLS por group_id, por isso o SET LOCAL app.group_id a cada group).
 */
async function listGroupCompanyPairs(client) {
  const groupsRes = await client.query('SELECT id FROM core.groups ORDER BY created_at ASC');
  const pairs = [];
  for (const { id: groupId } of groupsRes.rows) {
    // eslint-disable-next-line no-await-in-loop
    const companies = await withTenantContext(client, { groupId }, async () => {
      const res = await client.query('SELECT id FROM core.companies WHERE group_id = $1', [groupId]);
      return res.rows;
    });
    for (const { id: companyId } of companies) {
      pairs.push({ groupId, companyId });
    }
  }
  return pairs;
}

/**
 * countRows — soma COUNT(*) de `construction.<table>` em TODOS os tenants (group/company) do
 * banco. Necessário por causa da RLS fail-closed (ver GAP REAL CORRIGIDO #3 no cabeçalho): uma
 * conexão sem `SET LOCAL app.group_id/app.company_id` sempre vê 0 linhas nessas tabelas,
 * independente do que exista de fato no banco.
 */
async function countRows(client, table, pairs) {
  let total = 0;
  for (const pair of pairs) {
    // eslint-disable-next-line no-await-in-loop
    const count = await withTenantContext(client, pair, async () => {
      const res = await client.query(`SELECT COUNT(*)::int AS count FROM construction.${table}`);
      return res.rows[0].count;
    });
    total += count;
  }
  return total;
}

/**
 * withTenantContext — roda `fn(client)` dentro de uma transação com `SET LOCAL app.group_id`
 * (e, se informado, `app.company_id`) — necessário porque `construction.*`/`core.companies`
 * têm RLS fail-closed (ver GAP REAL CORRIGIDO #3 no cabeçalho do arquivo). Sempre ROLLBACK ao
 * final (somente leitura, não há nenhuma escrita neste script) para nunca deixar uma transação
 * pendurada.
 */
async function withTenantContext(client, { groupId, companyId }, fn) {
  await client.query('BEGIN');
  try {
    if (groupId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.group_id', groupId]);
    }
    if (companyId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.company_id', companyId]);
    }
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * findReferenceProject — varre todos os groups (core.groups, sem RLS) e, para cada um, todas as
 * companies (core.companies, RLS por group_id), procurando uma obra que TENHA orçamento
 * (construction.budgets) E pelo menos uma medição (construction.stage_measurements) — exigido
 * pela auditoria externa para a comparação não ficar vazia. Prioriza a obra com mais medições
 * (para garantir pelo menos 2, quando existirem).
 */
async function findReferenceProject(client) {
  const groupsRes = await client.query('SELECT id FROM core.groups ORDER BY created_at ASC');

  for (const { id: groupId } of groupsRes.rows) {
    // eslint-disable-next-line no-await-in-loop
    const companies = await withTenantContext(client, { groupId }, async () => {
      const res = await client.query('SELECT id FROM core.companies WHERE group_id = $1 ORDER BY created_at ASC', [groupId]);
      return res.rows;
    });

    for (const { id: companyId } of companies) {
      // eslint-disable-next-line no-await-in-loop
      const candidate = await withTenantContext(client, { groupId, companyId }, async () => {
        const res = await client.query(
          `SELECT p.id, COUNT(DISTINCT b.id)::int AS n_budgets, COUNT(DISTINCT sm.id)::int AS n_measurements
           FROM construction.projects p
           JOIN construction.budgets b ON b.project_id = p.id
           JOIN construction.project_stages ps ON ps.project_id = p.id
           JOIN construction.stage_measurements sm ON sm.project_stage_id = ps.id
           WHERE p.group_id = $1 AND p.company_id = $2
           GROUP BY p.id
           HAVING COUNT(DISTINCT b.id) >= 1 AND COUNT(DISTINCT sm.id) >= 1
           ORDER BY n_measurements DESC
           LIMIT 1`,
          [groupId, companyId]
        );
        return res.rows[0] || null;
      });

      if (candidate) {
        return { groupId, companyId, projectId: candidate.id };
      }
    }
  }

  return null;
}

async function fetchProject(client, ctx) {
  return withTenantContext(client, ctx, async () => {
    const res = await client.query(
      `SELECT id, name, status, budget_amount AS "budgetAmount", responsible_user_id AS "responsibleUserId", created_at AS "createdAt"
       FROM construction.projects
       WHERE id = $1`,
      [ctx.projectId]
    );
    return res.rows[0] || null;
  });
}

async function fetchBudgetForProject(client, ctx) {
  return withTenantContext(client, ctx, async () => {
    const res = await client.query(
      `SELECT id, baseline_amount AS "baselineAmount", status
       FROM construction.budgets
       WHERE project_id = $1
       ORDER BY created_at ASC
       LIMIT 1`,
      [ctx.projectId]
    );
    return res.rows[0] || null;
  });
}

/**
 * fetchMeasurementsForProject — todas as medições (construction.stage_measurements) de todas as
 * etapas (construction.project_stages) da obra, ordenadas por measured_at/created_at para que a
 * comparação origem x destino compare sempre a mesma medição em ambos os lados (mesmo id).
 */
async function fetchMeasurementsForProject(client, ctx) {
  return withTenantContext(client, ctx, async () => {
    const res = await client.query(
      `SELECT sm.id,
              sm.project_stage_id AS "projectStageId",
              sm.measured_pct AS "measuredPct",
              sm.total_amount AS "totalAmount",
              sm.status
       FROM construction.stage_measurements sm
       JOIN construction.project_stages ps ON ps.id = sm.project_stage_id
       WHERE ps.project_id = $1
       ORDER BY sm.measured_at ASC, sm.created_at ASC`,
      [ctx.projectId]
    );
    return res.rows;
  });
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

    console.log('--- Contagem de linhas por tabela (schema construction, somada em todos os tenants) ---');
    const sourcePairs = await listGroupCompanyPairs(source);
    const targetPairs = await listGroupCompanyPairs(target);
    for (const table of CONSTRUCTION_TABLES) {
      const sourceCount = await countRows(source, table, sourcePairs);
      const targetCount = await countRows(target, table, targetPairs);
      const ok = sourceCount === targetCount;
      anyDivergence = anyDivergence || !ok;
      checks.push({ label: `contagem construction.${table}`, ok, sourceValue: sourceCount, targetValue: targetCount });
      console.log(
        ok
          ? `  ✅ idêntico — construction.${table}: ${sourceCount} linhas`
          : `  ❌ DIVERGÊNCIA: construction.${table} tinha ${sourceCount} linhas, virou ${targetCount}`
      );
    }

    console.log('\n--- Localizando obra de referência (precisa ter orçamento E ao menos 1 medição) ---');
    const ref = await findReferenceProject(source);

    if (!ref) {
      console.log('  (nenhuma obra com orçamento E medição encontrada na origem — nada a comparar além das contagens acima)');
    } else {
      console.log(`  Obra de referência: id=${ref.projectId} (group=${ref.groupId}, company=${ref.companyId})`);

      const sourceProject = await fetchProject(source, ref);
      const targetProject = await fetchProject(target, ref);

      if (!targetProject) {
        anyDivergence = true;
        checks.push({ label: 'obra de referência presente no destino', ok: false, sourceValue: ref.projectId, targetValue: null });
        console.log(`  ❌ DIVERGÊNCIA: obra "${ref.projectId}" existe na origem mas não foi encontrada no destino`);
      } else {
        console.log('\n--- Conteúdo campo a campo da obra de referência (construction.projects) ---');
        const fieldsOk = [
          compareField('name', sourceProject.name, targetProject.name, checks),
          compareField('status', sourceProject.status, targetProject.status, checks),
          compareField('budgetAmount', sourceProject.budgetAmount, targetProject.budgetAmount, checks),
          compareField('responsibleUserId', sourceProject.responsibleUserId, targetProject.responsibleUserId, checks),
        ];
        anyDivergence = anyDivergence || fieldsOk.some((ok) => !ok);

        console.log('\n--- Orçamento da obra (construction.budgets) ---');
        const sourceBudget = await fetchBudgetForProject(source, ref);
        const targetBudget = await fetchBudgetForProject(target, ref);

        if (!sourceBudget) {
          console.log('  (nenhum orçamento encontrado para essa obra na origem — nada a comparar)');
        } else if (!targetBudget) {
          anyDivergence = true;
          checks.push({ label: 'orçamento presente no destino', ok: false, sourceValue: sourceBudget.id, targetValue: null });
          console.log(`  ❌ DIVERGÊNCIA: orçamento "${sourceBudget.id}" existe na origem mas não foi encontrado no destino`);
        } else {
          const budgetFieldsOk = [
            compareField('baselineAmount', sourceBudget.baselineAmount, targetBudget.baselineAmount, checks),
            compareField('status (budget)', sourceBudget.status, targetBudget.status, checks),
          ];
          anyDivergence = anyDivergence || budgetFieldsOk.some((ok) => !ok);
        }

        console.log('\n--- Medições da obra (construction.stage_measurements), campo a campo ---');
        const sourceMeasurements = await fetchMeasurementsForProject(source, ref);
        const targetMeasurementsById = new Map(
          (await fetchMeasurementsForProject(target, ref)).map((m) => [m.id, m])
        );

        if (sourceMeasurements.length === 0) {
          console.log('  (nenhuma medição encontrada para essa obra na origem — nada a comparar)');
        } else {
          // Compara TODAS as medições encontradas (pelo menos 2, garantidas pela escolha da
          // obra de referência em findReferenceProject) — não só uma amostra.
          for (const sourceMeasurement of sourceMeasurements) {
            const targetMeasurement = targetMeasurementsById.get(sourceMeasurement.id);
            console.log(`\n  Medição id=${sourceMeasurement.id} (projectStageId=${sourceMeasurement.projectStageId})`);
            if (!targetMeasurement) {
              anyDivergence = true;
              checks.push({ label: `medição ${sourceMeasurement.id} presente no destino`, ok: false, sourceValue: sourceMeasurement.id, targetValue: null });
              console.log(`    ❌ DIVERGÊNCIA: medição "${sourceMeasurement.id}" existe na origem mas não foi encontrada no destino`);
              continue;
            }
            const measurementFieldsOk = [
              compareField('  measuredPct', sourceMeasurement.measuredPct, targetMeasurement.measuredPct, checks),
              compareField('  totalAmount', sourceMeasurement.totalAmount, targetMeasurement.totalAmount, checks),
              compareField('  status (measurement)', sourceMeasurement.status, targetMeasurement.status, checks),
              compareField('  projectStageId', sourceMeasurement.projectStageId, targetMeasurement.projectStageId, checks),
            ];
            anyDivergence = anyDivergence || measurementFieldsOk.some((ok) => !ok);
          }
        }
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
