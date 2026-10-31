'use strict';

// M9-D842 — o contract test não deixa kill switch commitado no banco descartável (o probe dele só existe na memória do processo do contrato).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d842.limpeza.test.js"

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');
const { purgeKillSwitchResidue, plantKillSwitch } = require('../_helpers/killSwitchResidue');
const { CONTRACT_SWITCH_PATTERNS } = require('../_helpers/m9d842SeedFlags');

const skip = () => (DISPOSABLE ? false : SKIP_DISPOSABLE);
let tenants;
before(async () => { if (DISPOSABLE) tenants = await loadTenants(); });
after(async () => { if (DISPOSABLE) await purgeKillSwitchResidue(CONTRACT_SWITCH_PATTERNS || ['qa.contrato.%']); });

test('m9d842 a limpeza do contrato remove o kill switch criado pelo exemplo', { skip: skip() }, async () => {
  const A = tenants.A;
  const key = `qa.contrato.limpeza_${Date.now()}`;
  await plantKillSwitch(A, key);
  assert.ok(Array.isArray(CONTRACT_SWITCH_PATTERNS) && CONTRACT_SWITCH_PATTERNS.length > 0, 'o contrato declara quais chaves cria');
  assert.ok(await purgeKillSwitchResidue(CONTRACT_SWITCH_PATTERNS) >= 1);
  assert.equal((await adminQuery('SELECT 1 FROM governance.feature_flags WHERE key = $1', [key])).rowCount, 0);
});

test('m9d842 o after do contract test chama a limpeza dos kill switches', () => {
  const source = fs.readFileSync(path.join(__dirname, 'm9d842.contrato.test.js'), 'utf8');
  assert.match(source, /purgeKillSwitchResidue\(CONTRACT_SWITCH_PATTERNS\)/);
});
