'use strict';

// M9-D810 — o arquivo versionado do registro bate com as sementes (gerador único) e o gerador só roda em banco descartável.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d810Env');
const seed = require('../../../src/features/core-governance/lineage/lineage.seed');
const registryFile = require('../../../src/features/core-governance/lineage/lineage.registryFile');

const ROOT = path.join(__dirname, '../../..');
const FILE = path.join(ROOT, 'docs/governance/lineage-registry.json');
let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });

test('m9d810 o arquivo versionado do registro é exatamente o que o gerador único produz das sementes', { skip: skip() }, async () => {
  await env.withRollbackTenantTransaction(tenants.A, async (tx) => {
    await seed.ensureSeeded(tenants.A, tx);
    const generated = await registryFile.buildRegistryFile(tenants.A, tx);
    const committed = fs.readFileSync(FILE, 'utf8');
    assert.deepEqual(registryFile.diffRegistryFiles(committed, generated), [], 'rode npm run sync:lineage e commite o arquivo');
    assert.equal(committed, generated);
  });
});

test('m9d810 existe um único gerador e um único arquivo de registro', () => {
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /lineage/i.test(f) && f !== 'checkLineageCoverage.js').sort();
  assert.deepEqual(scripts, ['syncLineageRegistry.js']);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'docs/governance')).filter((f) => /lineage/i.test(f)), ['lineage-registry.json']);
  assert.match(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['sync:lineage'], /syncLineageRegistry\.js/);
});

test('m9d810 o gerador recusa banco que não seja local descartável', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/syncLineageRegistry.js'), '--check'], { encoding: 'utf8', env: { ...process.env, DISPOSABLE_DB: '', DATABASE_URL: 'postgres://u:p@db.exemplo.invalid:5432/x', DATABASE_ADMIN_URL: 'postgres://u:p@db.exemplo.invalid:5432/x' } });
  assert.equal(res.status, 2);
  assert.match(`${res.stdout}${res.stderr}`, /banco local descart[aá]vel/);
});
