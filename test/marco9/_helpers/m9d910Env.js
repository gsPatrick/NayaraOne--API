'use strict';

// Apoio dos testes M9-D910 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const base = require('./m9d911Env');
const wiring = require('../../../src/features/core-governance/data-quality/classification.wiring');
const classification = require('../../../src/features/core-governance/data-quality/classification.service');
const inventory = require('../../../src/features/core-governance/data-quality/classification.inventory');

const { adminQuery, inTx, actorOf } = base;
const ROOT = path.resolve(__dirname, '../../..');

/** Executa o script de cobertura (como o CI) e devolve { status, out }. */
function runCoverageScript() {
  try {
    const out = execFileSync('node', ['scripts/checkClassificationCoverage.js'], { cwd: ROOT, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (err) { return { status: err.status, out: `${err.stdout || ''}${err.stderr || ''}` }; }
}

const put = (tenant, body) => inTx(tenant, (tx) => classification.putEntry(tenant, actorOf(tenant), body, tx));
const rowOf = async (tenant, schema, table, column) => (await adminQuery('SELECT * FROM governance.data_classification_registry WHERE company_id = $1 AND schema_name = $2 AND table_name = $3 AND column_name = $4', [tenant.companyId, schema, table, column])).rows[0];
const ensure = (tenant) => inTx(tenant, (tx) => classification.ensureRegistry(tenant, tx));
const resetRegistry = async (tenant) => { await adminQuery('DELETE FROM governance.data_classification_registry WHERE company_id = $1', [tenant.companyId]); };

module.exports = { ...base, wiring, classification, inventory, runCoverageScript, put, rowOf, ensure, resetRegistry };
