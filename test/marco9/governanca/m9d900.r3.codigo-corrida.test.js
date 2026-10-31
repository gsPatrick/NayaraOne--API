'use strict';

// M9-D900 (reabertura R3-L5 da rodada 3): a trava de unicidade do código da empresa no legado vale também contra a corrida. Duas empresas do mesmo grupo que gravam o mesmo código
// ao mesmo tempo (a primeira ainda sem confirmar) não passam as duas: a segunda espera a primeira e é recusada. Banco descartável.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const env = require('../_helpers/m9d900Env');
require('../../../src/features/settings/settings.service'); // registra a trava do código da empresa
const { runSettingGuard } = require('../../../src/features/settings/settingGuards');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const KEY = 'migracao.legado.codigo_empresa';
const extras = [];
const codeOf = (promise) => promise.then(() => null, (err) => err.code);
// A trava e a gravação do valor na mesma transação, como o serviço de parâmetros faz; direto no banco para não auditar a empresa de teste (a auditoria é append-only e impediria apagá-la).
const writeCode = (tenant, value) => env.openTenantTx(tenant, async (tx) => { await runSettingGuard(KEY, value, tenant, tenant.userId, tx); await save(tenant, value, tx); });
const save = (tenant, value, tx) => env.sequelize.query("INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, created_at, updated_at) VALUES (gen_random_uuid(), :groupId, :companyId, :key, to_jsonb(CAST(:value AS text)), now(), now())", { transaction: tx, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, key: KEY, value } });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function addCompany(groupId) {
  const id = randomUUID();
  await env.adminQuery('INSERT INTO core.companies (id, group_id, name) VALUES ($1, $2, $3)', [id, groupId, `QA-M9 D900 R3 ${id.slice(0, 6)}`]);
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

test('m9d900 R3-L5: duas empresas do grupo gravando o mesmo código ao mesmo tempo, só uma grava', { skip: skip() }, async () => {
  const [one, two] = [await addCompany(tenants.A.groupId), await addCompany(tenants.A.groupId)];
  let release; const gate = new Promise((resolve) => { release = resolve; });
  // a primeira passa pela trava e segura a transação aberta (sem confirmar) até a segunda ter tentado
  const first = codeOf(env.openTenantTx(one, async (tx) => { await runSettingGuard(KEY, 'RACE1', one, one.userId, tx); await save(one, 'RACE1', tx); await gate; }));
  await wait(300);
  const second = codeOf(writeCode(two, ' race1 '));
  await wait(500);
  release();
  assert.deepEqual([await first, await second], [null, 'GOV_MIG_LEGACY_CODE_DUPLICATE'], 'a segunda, que esperou a confirmação da primeira, é recusada');
});

test('m9d900 R3-L5: a espera não atrapalha códigos diferentes nem grupos diferentes', { skip: skip() }, async () => {
  const [one, two] = [await addCompany(tenants.A.groupId), await addCompany(tenants.A.groupId)];
  const other = await addCompany(tenants.B.groupId);
  const codes = await Promise.all([
    codeOf(writeCode(one, 'RACE2')),
    codeOf(writeCode(two, 'RACE3')),
    codeOf(writeCode(other, 'RACE2')),
  ]);
  assert.deepEqual(codes, [null, null, null]);
});
