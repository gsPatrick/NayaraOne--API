'use strict';

// M9-D900 (reabertura, LEVE-D da reauditoria rodada 2): o código da empresa no legado é único no grupo (a trava vale para qualquer caminho que grave o parâmetro e o filtro
// confere de novo na leitura), e a carga sem filtro num grupo com várias empresas, quando o administrador desliga a exigência, fica auditada. Banco descartável.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const env = require('../_helpers/m9d900Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { resolveScope } = require('../../../src/features/migration-v2/ingest/connectors/company.scope');
const runsService = require('../../../src/features/migration-v2/ingest/runs.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const A = () => tenants.A;
const K = { filter: 'migracao.legado.filtrar_por_empresa', value: 'migracao.legado.codigo_empresa', require: 'migracao.legado.exigir_filtro_multiempresa' };
const setSetting = (key, value) => env.openTenantTx(A(), (tx) => upsertSetting(key, value, A(), A().userId, tx));
const codeOf = (promise) => promise.then(() => null, (err) => err.code);
const extras = [];

async function addCompany(groupId, code) {
  const id = randomUUID();
  await env.adminQuery('INSERT INTO core.companies (id, group_id, name) VALUES ($1, $2, $3)', [id, groupId, `QA-M9 D900 ${id.slice(0, 6)}`]);
  extras.push(id);
  // direto no banco (como superusuário): gravar pelo serviço auditaria a empresa de teste e impediria apagá-la depois
  if (code) await env.adminQuery("INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, to_jsonb($4::text), now(), now())", [groupId, id, K.value, code]);
  return { groupId, companyId: id, userId: A().userId };
}

before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => {
  if (!env.DISPOSABLE) return;
  await setSetting(K.filter, false);
  await setSetting(K.value, 'A_DEFINIR');
  await setSetting(K.require, true);
  while (extras.length) {
    const id = extras.pop();
    await env.adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1', [id]);
    await env.adminQuery('DELETE FROM core.companies WHERE id = $1', [id]);
  }
});
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });

test('m9d900 dois códigos de empresa iguais no mesmo grupo são recusados ao gravar, com ou sem caixa e espaço', { skip: skip() }, async () => {
  await addCompany(A().groupId, 'E1');
  assert.equal(await codeOf(setSetting(K.value, 'E1')), 'GOV_MIG_LEGACY_CODE_DUPLICATE');
  assert.equal(await codeOf(setSetting(K.value, '  e1 ')), 'GOV_MIG_LEGACY_CODE_DUPLICATE', 'espaço e caixa não escapam da trava');
  assert.equal(await codeOf(setSetting(K.value, 'E2')), null, 'código diferente passa');
  assert.equal(await codeOf(setSetting(K.value, 'E2')), null, 'regravar o próprio valor passa');
});

test('m9d900 o mesmo código em outro grupo não conflita, e o padrão A_DEFINIR nunca conflita', { skip: skip() }, async () => {
  await addCompany(tenants.B.groupId, 'E1');
  assert.equal(await codeOf(setSetting(K.value, 'E1')), null, 'o legado é de um grupo só: outro grupo pode repetir');
  await addCompany(A().groupId, 'A_DEFINIR');
  assert.equal(await codeOf(setSetting(K.value, 'A_DEFINIR')), null, 'o padrão (que recusa a carga) não é código');
});

test('m9d900 duplicidade que escapou da trava (gravada direto) é recusada na leitura do legado', { skip: skip() }, async () => {
  const other = await addCompany(A().groupId, 'E7');
  await setSetting(K.value, 'E8');
  await setSetting(K.filter, true);
  await env.adminQuery("UPDATE core.tenant_settings SET value = to_jsonb(CAST('E8' AS text)) WHERE company_id = $1 AND key = $2", [other.companyId, K.value]);
  assert.equal(await codeOf(env.openTenantTx(A(), (tx) => resolveScope(A(), tx))), 'GOV_MIG_LEGACY_CODE_DUPLICATE');
});

test('m9d900 carga sem filtro em grupo com várias empresas (exigência desligada pelo administrador) é auditada', { skip: skip() }, async () => {
  await addCompany(A().groupId);
  await setSetting(K.require, false);
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  const { runId } = await env.openTenantTx(A(), (tx) => runsService.createRun(A(), { userId: A().userId }, { sourceSystem: legacy.system }, tx));
  const [audit] = await env.q("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = $1 AND action = 'migration.legacy.unfiltered' AND entity_id = $2", [A().companyId, runId]);
  assert.equal(audit.n, 1, 'a decisão de ler o legado inteiro fica registrada na execução');
  legacy.dispose();
});

test('m9d900 carga com filtro ou em grupo de uma empresa não gera o registro de legado sem filtro', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  const { runId } = await env.openTenantTx(A(), (tx) => runsService.createRun(A(), { userId: A().userId }, { sourceSystem: legacy.system }, tx));
  const [audit] = await env.q("SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'migration.legacy.unfiltered' AND entity_id = $1", [runId]);
  assert.equal(audit.n, 0);
  legacy.dispose();
});
