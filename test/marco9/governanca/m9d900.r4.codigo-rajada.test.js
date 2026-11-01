'use strict';

// M9-D900 (reabertura R4-M1 da rodada 4): a trava de unicidade do código da empresa não pode esgotar o pool de conexões. Antes, quem segurava a trava abria outra conexão por empresa
// irmã, e uma rajada de gravações (mais que o pool de 10) travava a API por 30 s com SequelizeConnectionAcquireTimeoutError. Agora a conferência usa a conexão da própria transação.
// Banco descartável.

const { test, before, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const env = require('../_helpers/m9d900Env');
require('../../../src/features/settings/settings.service'); // registra a trava do código da empresa
const { runSettingGuard } = require('../../../src/features/settings/settingGuards');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const KEY = 'migracao.legado.codigo_empresa';
const extras = [];
const outcome = (promise) => promise.then(() => 'ok', (err) => err.code || err.name);
const save = (tenant, value, tx) => env.sequelize.query("INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, created_at, updated_at) VALUES (gen_random_uuid(), :groupId, :companyId, :key, to_jsonb(CAST(:value AS text)), now(), now())", { transaction: tx, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, key: KEY, value } });
const writeCode = (tenant, value) => env.openTenantTx(tenant, async (tx) => { await runSettingGuard(KEY, value, tenant, tenant.userId, tx); await save(tenant, value, tx); });

async function addCompany(groupId) {
  const id = randomUUID();
  await env.adminQuery('INSERT INTO core.companies (id, group_id, name) VALUES ($1, $2, $3)', [id, groupId, `QA-M9 D900 R4 ${id.slice(0, 6)}`]);
  extras.push(id);
  return { groupId, companyId: id, userId: tenants.A.userId };
}

before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => {
  if (!env.DISPOSABLE) return;
  while (extras.length) {
    const id = extras.pop();
    await env.adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1', [id]);
    await env.adminQuery('DELETE FROM core.companies WHERE id = $1', [id]);
  }
});
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });

test('m9d900 R4-M1: rajada de 24 gravações do código (mais que o pool) termina logo, todas gravam e o pool fica livre', { skip: skip() }, async () => {
  const companies = [];
  for (let i = 0; i < 24; i += 1) companies.push(await addCompany(tenants.A.groupId));
  const started = Date.now();
  const results = await Promise.all(companies.map((tenant, i) => outcome(writeCode(tenant, `RAJADA${i}`))));
  const elapsed = Date.now() - started;
  assert.deepEqual(results, Array(24).fill('ok'), `nenhum estouro de pool: ${results.filter((r) => r !== 'ok').join(', ')}`);
  assert.ok(elapsed < 10000, `a rajada levou ${elapsed} ms (esgotamento do pool leva 30 s)`);
  const probe = Date.now();
  await env.sequelize.query('SELECT 1');
  assert.ok(Date.now() - probe < 1000, 'outra requisição não espera conexão depois da rajada');
});

test('m9d900 R4-M1: na rajada, o código repetido continua recusado (só um dos dois grava) e o contexto da empresa é restaurado', { skip: skip() }, async () => {
  const companies = [];
  for (let i = 0; i < 12; i += 1) companies.push(await addCompany(tenants.A.groupId));
  const codes = companies.map((_, i) => (i < 2 ? 'RAJADA_IGUAL' : `RAJADA_B${i}`));
  const results = await Promise.all(companies.map((tenant, i) => outcome(writeCode(tenant, codes[i]))));
  assert.deepEqual(results.slice(0, 2).sort(), ['GOV_MIG_LEGACY_CODE_DUPLICATE', 'ok']);
  assert.deepEqual(results.slice(2), Array(10).fill('ok'));
  // a conferência troca o contexto da conexão para ler as irmãs e o devolve: a gravação seguinte da mesma transação ainda enxerga a própria empresa
  const mine = companies[5];
  const seen = await env.openTenantTx(mine, async (tx) => {
    await runSettingGuard(KEY, 'RAJADA_NOVO', mine, mine.userId, tx);
    return (await env.sequelize.query("SELECT current_setting('app.company_id', true) AS company", { transaction: tx, type: 'SELECT' }))[0].company;
  });
  assert.equal(seen, mine.companyId);
});
