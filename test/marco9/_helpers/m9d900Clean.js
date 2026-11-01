'use strict';

// Limpeza do que os testes da M9-D900 deixam commitado (o executor abre transações próprias). Sem ela, a quarentena, os lotes e as pendências de PERSON/SUPPLIER/PROPERTY
// ficam no banco e o gate do canary (M9-D904), a Torre (M9-D901/D902) e o plano de rollback (M9-D907) os enxergam como blockers. Só em banco descartável.
const { adminQuery } = require('../../m9d801.helpers');

// Ordem de filhos para pais (chaves estrangeiras). As fontes semeadas ficam; só as de teste (conector FAKE_*) saem.
// Os contadores vêm depois dos registros: apagar um registro move o contador; blockers por último (a Torre os recria enquanto houver divergência).
const TABLES = ['mig_batch_leaves', 'mig_event_keys', 'mig_records', 'mig_counters', 'mig_batches', 'mig_blockers'];

/** Parâmetros `migracao.*` que os testes gravam por upsertSetting (commit): saem junto, senão ficam como chaves protegidas vivas para os arquivos seguintes (ex.: m9d870.escrita). */
async function cleanMigrationSettings() {
  await adminQuery("DELETE FROM core.tenant_settings WHERE key LIKE 'migracao.%'");
}

async function cleanMigration() {
  await cleanMigrationSettings();
  for (const table of TABLES) await adminQuery(`DELETE FROM governance.${table}`);
  // external_refs é imutável e aponta para a execução que criou a referência: essas execuções (já encerradas, sem lote nem registro) ficam; as demais saem
  await adminQuery("DELETE FROM governance.mig_runs r WHERE NOT EXISTS (SELECT 1 FROM core.external_refs e WHERE e.migration_run_id = r.id)");
  await adminQuery("UPDATE governance.mig_runs SET status = 'FAILED', finished_at = COALESCE(finished_at, now()) WHERE status IN ('QUEUED', 'RUNNING', 'PAUSED')");
  await adminQuery("DELETE FROM governance.mig_sources WHERE config->>'connector' LIKE 'FAKE\\_%'");
}

module.exports = { cleanMigration, cleanMigrationSettings };
