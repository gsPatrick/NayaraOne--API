'use strict';

// Relatório DRY3 exportado e assinado dos testes M9-D908 (não é teste): monta o corpo que o ensaio real exporta, com os seis critérios verdes, e deixa cada teste trocar um campo para
// provar a recusa do GO. Usa arquivo temporário e chave de assinatura só de teste (nunca a de um ambiente real).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sign } = require('../../../src/features/migration-v2/dryrun/dry.signature');
const { currentCommit, exportPath } = require('../../../src/features/migration-v2/dryrun/dry.export');

const TEST_KEY = 'chave-de-teste-nao-usar-em-producao';
const CRITERIA = ['blockers_zero', 'counts_match', 'batches_verified', 'parallel_clean', 'clock_tz_validated', 'rollback_simulated'];

/** Critérios verdes de um ensaio com volume real (100.000 linhas, 40 lotes todos VERIFIED); `override` troca um critério inteiro. */
function criteria(override = {}) {
  const base = Object.fromEntries(CRITERIA.map((name) => [name, { ok: true }]));
  base.counts_match = { ok: true, entities: 1, mismatched: 0, rows: 100000, destinationRows: 100000 };
  base.batches_verified = { ok: true, total: 40, verified: 40, pct: 100 };
  return { ...base, ...override };
}

/** Corpo assinado de um relatório válido para a empresa; `fields` sobrescreve campos de primeiro nível (company_id, commit, generated_at, report_id, conclusion, criteria). */
function signedBody(tenant, fields = {}) {
  const body = { conclusion: 'APROVADO', criteria: criteria(), commit: currentCommit(), generated_at: new Date().toISOString(), report_id: crypto.randomUUID(), company_id: tenant.companyId, ...fields };
  return { ...body, ...sign(body) };
}

/** Grava o relatório num arquivo temporário novo, aponta o ambiente para ele e devolve o caminho. */
function writeReport(tenant, fields = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d908r-'));
  process.env.MIGRATION_DRY3_REPORT_PATH = path.join(dir, 'dry3-report.json');
  const file = exportPath(tenant.companyId); // arquivo da empresa (R3-L4)
  process.env.MIGRATION_DRY3_SIGNING_KEY = TEST_KEY;
  fs.writeFileSync(file, `${JSON.stringify(signedBody(tenant, fields), null, 2)}\n`);
  return file;
}

module.exports = { writeReport, signedBody, criteria, TEST_KEY, CRITERIA };
