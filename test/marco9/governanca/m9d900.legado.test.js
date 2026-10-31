'use strict';

// M9-D900 (reabertura, auditoria M6): o legado é um só para o grupo; cada empresa lê só as linhas dela, e grupo com várias empresas sem filtro é recusado. Banco descartável.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const env = require('../_helpers/m9d900Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const sqlConnector = require('../../../src/features/migration-v2/ingest/connectors/sql.connector');
const { resolveScope } = require('../../../src/features/migration-v2/ingest/connectors/company.scope');
const connectors = require('../../../src/features/migration-v2/ingest/connectors');
const runsService = require('../../../src/features/migration-v2/ingest/runs.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const A = () => tenants.A;
const K = { filter: 'migracao.legado.filtrar_por_empresa', column: 'migracao.legado.coluna_empresa', value: 'migracao.legado.codigo_empresa', require: 'migracao.legado.exigir_filtro_multiempresa' };
const setSetting = (key, value) => env.openTenantTx(A(), (tx) => upsertSetting(key, value, A(), A().userId, tx));
const scopeOf = () => env.openTenantTx(A(), (tx) => resolveScope(A(), tx));
const codeOf = (promise) => promise.then(() => null, (err) => err.code);

before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => {
  if (!env.DISPOSABLE) return;
  await setSetting(K.filter, false);
  await setSetting(K.column, 'empresa_id');
  await setSetting(K.value, 'A_DEFINIR');
  await setSetting(K.require, true);
});
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });

test('m9d900 conector SQL com filtro de empresa traz só as linhas dela em todas as leituras', { skip: skip() }, async () => {
  const schema = `legado_${env.suffix()}`.toLowerCase().slice(0, 40);
  await env.adminQuery(`CREATE SCHEMA ${schema}`);
  await env.adminQuery(`CREATE TABLE ${schema}.clientes (id integer PRIMARY KEY, empresa_id text, legal_name text, updated_at timestamptz NOT NULL)`);
  await env.adminQuery(`INSERT INTO ${schema}.clientes VALUES (1, 'E1', 'QA-M9 Um', '2026-10-27 01:00:00+00'), (2, 'E2', 'QA-M9 Dois', '2026-10-27 01:00:00+00'), (3, 'E1', 'QA-M9 Tres', '2026-10-27 02:00:00+00')`);
  await env.adminQuery(`CREATE TABLE ${schema}.log (seq bigint PRIMARY KEY, op text, id integer, empresa_id text, legal_name text)`);
  await env.adminQuery(`INSERT INTO ${schema}.log VALUES (11, 'I', 1, 'E1', 'QA-M9 Um'), (12, 'I', 2, 'E2', 'QA-M9 Dois'), (13, 'D', 3, 'E1', NULL)`);
  process.env.QA_M9_LEGACY_URL = process.env.DATABASE_ADMIN_URL;
  const config = { relation: `${schema}.clientes`, keyColumn: 'id', updatedAtColumn: 'updated_at', logRelation: `${schema}.log`, positionColumn: 'seq', opColumn: 'op' };
  const scoped = await sqlConnector.createSqlConnector({ config, secret_ref: 'QA_M9_LEGACY_URL' }, { column: 'empresa_id', value: 'E1' });
  const open = await sqlConnector.createSqlConnector({ config, secret_ref: 'QA_M9_LEGACY_URL' });
  try {
    assert.deepEqual((await scoped.readRows({ afterTs: null, afterKey: '', limit: 10 })).map((r) => r.sourceKey), ['1', '3']);
    assert.deepEqual((await scoped.readRows({ afterTs: null, afterKey: '', upTo: { ts: '2026-10-27T01:00:00.000000Z', key: '9' }, limit: 10 })).map((r) => r.sourceKey), ['1'], 'com limite superior');
    assert.deepEqual((await scoped.readAllRows({ afterKey: '', limit: 10 })).map((r) => r.sourceKey), ['1', '3']);
    assert.deepEqual((await scoped.readEvents({ after: '0', limit: 10 })).map((e) => e.sourceKey), ['1', '3']);
    assert.deepEqual(await scoped.listKeys(), ['1', '3']);
    assert.equal(await scoped.countRows(), 2);
    assert.equal(await open.countRows(), 3, 'sem filtro (legado de uma empresa só) lê tudo');
    assert.deepEqual(await open.listKeys(), ['1', '2', '3']);
  } finally {
    await scoped.close(); await open.close();
  }
  delete process.env.QA_M9_LEGACY_URL;
  await env.adminQuery(`DROP SCHEMA ${schema} CASCADE`);
});

test('m9d900 resolveScope lê os parâmetros da empresa e falha fechada', { skip: skip() }, async () => {
  assert.equal(await scopeOf(), null, 'padrão: desligado, grupo de uma empresa');
  await setSetting(K.filter, true);
  assert.equal(await codeOf(scopeOf()), 'GOV_MIG_LEGACY_SCOPE_INVALID', 'ligado sem trocar o código A_DEFINIR');
  await setSetting(K.value, 'E1');
  await setSetting(K.column, 'cod_filial');
  assert.deepEqual(await scopeOf(), { column: 'cod_filial', value: 'E1' });
});

test('m9d900 grupo com mais de uma empresa e sem filtro é recusado; com o filtro ou o parâmetro desligado passa', { skip: skip() }, async () => {
  const extra = randomUUID();
  await env.adminQuery('INSERT INTO core.companies (id, group_id, name) VALUES ($1, $2, $3)', [extra, A().groupId, `QA-M9 D900 ${extra.slice(0, 6)}`]);
  try {
    assert.equal(await codeOf(scopeOf()), 'GOV_MIG_LEGACY_SCOPE_REQUIRED');
    const legacy = await env.installSource(A(), { mode: 'CDC' });
    assert.equal(await codeOf(env.openTenantTx(A(), (tx) => runsService.createRun(A(), { userId: A().userId }, { sourceSystem: legacy.system }, tx))), 'GOV_MIG_LEGACY_SCOPE_REQUIRED', 'POST /migration/runs recusa antes de enfileirar');
    legacy.dispose();
    const sql = { id: 'x', group_id: A().groupId, company_id: A().companyId, secret_ref: 'QA_M9_NAO_EXISTE', config: {} };
    assert.equal(await codeOf(connectors.open(sql)), 'GOV_MIG_LEGACY_SCOPE_REQUIRED', 'o conector também recusa (falha fechada), antes de ler a credencial');
    await setSetting(K.filter, true);
    await setSetting(K.value, 'E1');
    assert.deepEqual(await scopeOf(), { column: 'empresa_id', value: 'E1' });
    await setSetting(K.filter, false);
    await setSetting(K.require, false);
    assert.equal(await scopeOf(), null, 'o administrador pode desligar a exigência');
  } finally {
    await env.adminQuery('DELETE FROM core.companies WHERE id = $1', [extra]);
  }
});

test('m9d900 os parâmetros do legado rejeitam valor inválido', { skip: skip() }, async () => {
  assert.equal(await codeOf(setSetting(K.column, 'empresa; DROP TABLE x')), 'VALIDATION_ERROR');
  assert.equal(await codeOf(setSetting(K.value, 'x'.repeat(121))), 'VALIDATION_ERROR');
  assert.equal(await codeOf(setSetting(K.filter, 'sim')), 'SETTING_INVALID_VALUE');
});
