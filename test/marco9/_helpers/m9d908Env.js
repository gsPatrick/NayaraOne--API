'use strict';

// Apoio dos testes M9-D908 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Estes testes COMMITAM dados: cada teste usa sistema de origem
// exclusivo e `cleanup` devolve a empresa ao que era (fontes semeadas reabilitadas, RACI, parâmetros, relatórios e conferências de relógio apagados).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('./m9d907Env');
const clockService = require('../../../src/features/migration-v2/clock/clock.service');
const clockReaders = require('../../../src/features/migration-v2/clock/clock.readers');
const { recheckAndResume } = require('../../../src/features/migration-v2/clock/clock.resume');
const dry = require('../../../src/features/migration-v2/dryrun');

const { openTenantTx, adminQuery, tenantOf } = env;
const PARAM_PREFIXES = ['migracao.relogio.%', 'migracao.fuso%', 'migracao.dry3.%', 'migracao.paralelo.prazo_dias', 'migracao.setor.%', 'migracao.canary.%'];

/** Arquivo de exportação do relatório num diretório temporário (o teste nunca escreve em docs/governance). */
function useTempExport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d908-'));
  process.env.MIGRATION_DRY3_REPORT_PATH = path.join(dir, 'dry3-report.json');
  process.env.MIGRATION_DRY3_SIGNING_KEY = 'chave-de-teste-nao-usar-em-producao'; // só de teste: assina o relatório exportado
  dry.install();
  return { file: process.env.MIGRATION_DRY3_REPORT_PATH, read: () => JSON.parse(fs.readFileSync(process.env.MIGRATION_DRY3_REPORT_PATH, 'utf8')), exists: () => fs.existsSync(process.env.MIGRATION_DRY3_REPORT_PATH) };
}

/** Isola a empresa: as fontes semeadas do legado (que exigem credencial externa) ficam desabilitadas durante o teste. */
async function isolate(tenant) {
  await openTenantTx(tenant, (tx) => require('../../../src/features/migration-v2/seeds/sources.seed').ensureSeeded(tenant, tx));
  await adminQuery("UPDATE governance.mig_sources SET enabled = false WHERE company_id = $1 AND source_system = 'LEGADO_ERP'", [tenant.companyId]);
}

const setParam = (tenant, key, value) => env.setParam(tenant, key, value);

/** Tira da Torre os resíduos de outros testes da empresa (registros em quarentena ou sem reconciliar, lotes sem verificar): o ensaio olha a empresa inteira. */
async function quiesce(tenant) {
  const c = tenant.companyId;
  await adminQuery("UPDATE governance.mig_records SET state = 'EXCLUDED' WHERE company_id = $1 AND state IN ('QUARANTINED', 'PENDING_REVIEW', 'MIGRATED')", [c]);
  await adminQuery("UPDATE governance.mig_batches SET status = 'ABORTED' WHERE company_id = $1 AND status IN ('APPLIED', 'HASH_MISMATCH')", [c]);
  await adminQuery('UPDATE governance.mig_blockers SET closed_at = now() WHERE company_id = $1 AND closed_at IS NULL', [c]);
  await adminQuery("UPDATE governance.mig_runs SET status = 'FAILED', finished_at = now(), error = 'QA-M9: execução pendente encerrada pelo teste' WHERE company_id = $1 AND status IN ('PAUSED', 'QUEUED', 'RUNNING')", [c]);
}

/** Apaga o que a demanda grava na empresa e restaura o que o teste mexeu. */
async function cleanup(tenant) {
  const c = tenant.companyId;
  await quiesce(tenant);
  await adminQuery('DELETE FROM governance.parallel_windows WHERE company_id = $1', [c]);
  await adminQuery('DELETE FROM governance.mig_dry_reports WHERE company_id = $1', [c]);
  await adminQuery('DELETE FROM governance.mig_clock_checks WHERE company_id = $1', [c]);
  await adminQuery('DELETE FROM governance.mig_alert_log WHERE company_id = $1', [c]);
  await adminQuery("DELETE FROM governance.mig_blockers WHERE company_id = $1 AND (code LIKE 'GOV_MIG_CLOCK_%' OR code LIKE 'GOV_PARALLEL_%' OR code LIKE 'GOV_MIG_QA908%')", [c]);
  await adminQuery("UPDATE governance.mig_sources SET enabled = (source_system = 'LEGADO_ERP') WHERE company_id = $1", [c]); // fontes de teste ficam desabilitadas; as semeadas voltam
  await adminQuery('DELETE FROM governance.cutover_raci WHERE company_id = $1', [c]);
  await adminQuery("DELETE FROM governance.mig_entity_schema WHERE company_id = $1 AND field LIKE 'qa908%'", [c]);
  await adminQuery('DELETE FROM governance.cutover_decisions WHERE company_id = $1', [c]);
  for (const prefix of PARAM_PREFIXES) await adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1 AND key LIKE $2', [c, prefix]);
  await adminQuery("DELETE FROM core.notifications WHERE company_id = $1 AND title LIKE 'CRÍTICO: janela de comparação%'", [c]);
  await env.cleanup(tenant);
}

/** Acrescenta ao esquema canônico de PERSON da empresa um campo de data e hora (`qa908At`), no fim da ordem do hash; `cleanup` o remove. */
async function addInstantField(tenant, field = 'qa908At') {
  await openTenantTx(tenant, (tx) => require('../../../src/features/migration-v2/integrity/schema.repository').loadSchema(tenant, 'PERSON', tx)); // semeia o esquema antes de acrescentar
  const [{ max }] = (await adminQuery('SELECT COALESCE(max(position), 0) AS max FROM governance.mig_entity_schema WHERE company_id = $1 AND entity = $2', [tenant.companyId, 'PERSON'])).rows;
  await adminQuery("INSERT INTO governance.mig_entity_schema (group_id, company_id, entity, position, field, type) VALUES ($1, $2, 'PERSON', $3, $4, 'instant') ON CONFLICT DO NOTHING", [tenant.groupId, tenant.companyId, Number(max) + 1, field]);
}

const checkClock = (tenant, options = {}) => clockService.check(tenantOf(tenant), options);
const lastClock = async (tenant) => (await adminQuery('SELECT * FROM governance.mig_clock_checks WHERE company_id = $1 ORDER BY checked_at DESC, id DESC LIMIT 1', [tenant.companyId])).rows[0] || null;
const runRow = async (runId) => (await adminQuery('SELECT * FROM governance.mig_runs WHERE id = $1', [runId])).rows[0];
const reportRow = async (id) => (await adminQuery('SELECT * FROM governance.mig_dry_reports WHERE id = $1', [id])).rows[0];
const towerCodes = async (tenant) => (await env.towerBlockers(tenant)).map((b) => b.code);
const fail = (promise) => promise.then(() => null, (err) => ({ status: err.statusCode, code: err.code, message: err.message, details: err.details }));

/** Leitor de relógio de mentira (a fonte antiga ou o NTP): o deslocamento é lido a cada conferência, então o teste o muda no meio. */
function fakeClockReader(name, system, state) {
  return clockReaders.register(name, async () => [{ system, offsetMs: state.offsetMs }]);
}

module.exports = {
  ...env, dry, useTempExport, isolate, setParam, cleanup, addInstantField, checkClock, lastClock, runRow, reportRow, towerCodes, fail, fakeClockReader,
  recheckAndResume, clockService, clockReaders, tenantOf,
};
