'use strict';

// M9-D244 — integration.purge_expired(): único caminho de expurgo e redação por retenção; o runtime não tem DELETE (banco descartável).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe, conexao, config, criar, forcar, ler, chave, uniqueSuffix } = require('../../integrations/dispatch/dispatchHelpers');
const { receber } = require('../../integrations/inbox/inboxHelpers');
const { purgeExpired, AUDIT_ACTION, ENTITY_TYPE } = require('../../../src/features/integrations/retention');
const { AuditLog } = require('../../../src/models');

let tenant;
let con;
const PROV = `qa-m9-d244-${uniqueSuffix()}`;
const ctx = () => ctxDe(tenant);
const q = (sql, replacements = {}) => comTenant(tenant, async (t) => (await sequelize.query(sql, { replacements, transaction: t }))[0]);

before(async () => { ({ tenant } = await carregarTenants()); con = await conexao(tenant, 'BANK'); });
after(async () => { await sequelize.close(); });

const erroBanco = (codigo) => (e) => (e.parent?.code || e.original?.code) === codigo;
const NEGADO = '42501';

async function saude(janela, dias) {
  await q(`INSERT INTO integration.provider_health (group_id, company_id, connection_id, provider_code, window_start, window_minutes)
           VALUES (:g, :c, :con, :p, now() - make_interval(days => :d), :w) ON CONFLICT DO NOTHING`, { g: tenant.groupId, c: tenant.companyId, con: con.id, p: PROV, d: dias, w: janela });
}
async function erro(dias, status = 'OPEN') {
  const [{ id }] = await q(`INSERT INTO integration.integration_errors (group_id, company_id, provider_code, source, error_class, error_code, severity, message, status, created_at)
    VALUES (:g, :c, :p, 'CONTRACT', 'SECURITY', 'QA_PURGE', 'HIGH', 'Erro de teste de retenção.', :s, now() - make_interval(days => :d)) RETURNING id`, { g: tenant.groupId, c: tenant.companyId, p: PROV, s: status, d: dias });
  return id;
}
const existe = async (tabela, id) => (await q(`SELECT 1 FROM integration.${tabela} WHERE id = :id`, { id })).length === 1;

test('expurgo_somente_pela_funcao_security_definer_e_runtime_sem_delete: DELETE direto falha, a função funciona e audita com as contagens por tabela', async () => {
  // Cenário em quatro tabelas, com os prazos padrão do livro.
  await config(tenant, 'integration.errors.retention_days', 180);
  await saude(60, 45); await saude(60, 29); await saude(0, 100);
  const e181 = await erro(181); const e181r = await erro(181, 'RESOLVED'); const e179 = await erro(179);
  const velhoInbox = `qa-${uniqueSuffix()}`; const novoInbox = `qa-${uniqueSuffix()}`;
  await receber(tenant, PROV, velhoInbox); await receber(tenant, PROV, novoInbox);
  await q("UPDATE integration.webhook_inbox SET status = 'PROCESSED', received_at = now() - interval '91 days' WHERE provider_code = :p AND external_event_id = :e", { p: PROV, e: velhoInbox });
  await q("UPDATE integration.webhook_inbox SET status = 'PROCESSED', received_at = now() - interval '5 days' WHERE provider_code = :p AND external_event_id = :e", { p: PROV, e: novoInbox });
  const dVelho = (await criar(tenant, con.id, chave())).dispatch; const dRedigir = (await criar(tenant, con.id, chave())).dispatch;
  await forcar(tenant, dVelho.id, "status = 'CONFIRMED', confirmed_at = now() - interval '366 days'");
  await forcar(tenant, dRedigir.id, "status = 'CONFIRMED', confirmed_at = now() - interval '91 days'");

  // O runtime não apaga nada diretamente, em nenhuma das quatro tabelas, e não chama as funções parciais.
  for (const tabela of ['provider_health', 'webhook_inbox', 'dispatches', 'integration_errors']) {
    await assert.rejects(q(`DELETE FROM integration.${tabela} WHERE company_id = :c`, { c: tenant.companyId }), erroBanco(NEGADO), `DELETE em ${tabela}`);
  }
  await assert.rejects(q('SELECT integration.purge_provider_health(1)'), erroBanco(NEGADO));
  await assert.rejects(q('SELECT integration.purge_webhook_inbox(1, 1, 1)'), erroBanco(NEGADO));
  await assert.rejects(q('SELECT integration.purge_dispatches(1, 1)'), erroBanco(NEGADO));
  // Sem a empresa da sessão ou com prazo inválido, a função recusa.
  await assert.rejects(sequelize.query("SELECT integration.purge_expired('{\"errors_days\":180}'::jsonb)"), erroBanco(NEGADO));
  for (const ruim of ['{"errors_days":0}', '{"health_days":-5}', '{"errors_days":"30"}', '{"inbox_days":1.5}', '{"qualquer":1}', 'null', '[]']) {
    await assert.rejects(q('SELECT integration.purge_expired(CAST(:p AS jsonb))', { p: ruim }), erroBanco('22023'), ruim);
  }

  // Pela função: cada tabela é expurgada pelo prazo e a execução fica na auditoria com as contagens.
  const contagens = await comTenant(tenant, async (t) => {
    const r = await purgeExpired(ctx(), t);
    const [[{ modo }]] = await sequelize.query("SELECT current_setting('integration.purge_mode', true) AS modo", { transaction: t });
    assert.equal(modo, 'off', 'a marca de redação não vaza para o resto da transação');
    return r;
  });
  assert.ok(contagens.provider_health >= 1 && contagens.integration_errors >= 2);
  assert.ok(contagens.webhook_inbox.deleted >= 1 && contagens.dispatches.deleted >= 1 && contagens.dispatches.redacted >= 1);
  assert.equal((await q('SELECT count(*)::int AS n FROM integration.provider_health WHERE connection_id = :c AND window_minutes = 60', { c: con.id }))[0].n, 1, 'só a janela de 29 dias ficou');
  assert.equal((await q('SELECT count(*)::int AS n FROM integration.provider_health WHERE connection_id = :c AND window_minutes = 0', { c: con.id }))[0].n, 1, 'a linha ATUAL é preservada');
  assert.equal(await existe('integration_errors', e181), false, 'erro com 181 dias sai');
  assert.equal(await existe('integration_errors', e181r), false, 'resolvido ou aberto, vale o prazo');
  assert.equal(await existe('integration_errors', e179), true, 'com 179 dias fica');
  assert.equal((await q('SELECT 1 FROM integration.webhook_inbox WHERE provider_code = :p AND external_event_id = :e', { p: PROV, e: velhoInbox })).length, 0);
  assert.equal((await q('SELECT 1 FROM integration.webhook_inbox WHERE provider_code = :p AND external_event_id = :e', { p: PROV, e: novoInbox })).length, 1);
  assert.equal(await ler(tenant, dVelho.id), undefined, 'envio de 366 dias sai');
  const red = await ler(tenant, dRedigir.id);
  assert.deepEqual(red.payload_snapshot, { redacted: true, hash: red.payload_hash }, 'envio de 91 dias é redigido: só o hash');

  const auditoria = await comTenant(tenant, (t) => AuditLog.findAll({ where: { companyId: tenant.companyId, action: AUDIT_ACTION, entityType: ENTITY_TYPE }, order: [['occurredAt', 'DESC']], limit: 1, transaction: t }));
  assert.equal(auditoria.length, 1, 'toda execução grava auditoria');
  assert.deepEqual(auditoria[0].afterJson.contagens, contagens);
  assert.ok(auditoria[0].beforeJson.prazos.errors_days === 180 && auditoria[0].beforeJson.prazos.dispatch_days === 365, 'a auditoria guarda os prazos usados');
});

test('expurgo_prazos_vem_dos_parametros_da_empresa: errors.retention_days e health.history_retention_days mudam o que sai', async () => {
  const id = await erro(10);
  await saude(5, 20);
  await config(tenant, 'integration.errors.retention_days', 5);
  await config(tenant, 'integration.health.history_retention_days', 7);
  const r = await comTenant(tenant, (t) => purgeExpired(ctx(), t, { areas: ['errors', 'health'] }));
  assert.equal(await existe('integration_errors', id), false, 'com prazo de 5 dias, o erro de 10 dias sai');
  assert.ok(r.integration_errors >= 1 && r.provider_health >= 1);
  assert.equal(r.dispatches, undefined, 'área não pedida não roda');
  await config(tenant, 'integration.errors.retention_days', 180);
  await config(tenant, 'integration.health.history_retention_days', 30);
});

test('privilegio_runtime_sem_delete_nas_tabelas_de_integracao: sem DELETE, sem DDL, só purge_expired executável e as quatro permissões separadas existem', async () => {
  const [p] = await q(`SELECT
      has_table_privilege(current_user, 'integration.provider_health', 'DELETE') AS d1,
      has_table_privilege(current_user, 'integration.webhook_inbox', 'DELETE') AS d2,
      has_table_privilege(current_user, 'integration.dispatches', 'DELETE') AS d3,
      has_table_privilege(current_user, 'integration.integration_errors', 'DELETE') AS d4,
      has_schema_privilege(current_user, 'integration', 'CREATE') AS ddl,
      has_function_privilege(current_user, 'integration.purge_expired(jsonb)', 'EXECUTE') AS purge,
      has_function_privilege(current_user, 'integration.purge_provider_health(integer)', 'EXECUTE') AS p1,
      has_function_privilege(current_user, 'integration.purge_webhook_inbox(integer, integer, integer)', 'EXECUTE') AS p2,
      has_function_privilege(current_user, 'integration.purge_dispatches(integer, integer)', 'EXECUTE') AS p3,
      (SELECT rolsuper OR rolbypassrls OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS poderoso`);
  assert.deepEqual(p, { d1: false, d2: false, d3: false, d4: false, ddl: false, purge: true, p1: false, p2: false, p3: false, poderoso: false });
  const codes = await q("SELECT p.code FROM core.permissions p WHERE p.code IN ('integration:read','integration:manage','integration:retry','integration:test') ORDER BY 1");
  assert.deepEqual(codes.map((c) => c.code), ['integration:manage', 'integration:read', 'integration:retry', 'integration:test']);
  // As rotas administrativas usam permissões separadas por ação.
  const fs = require('node:fs'); const path = require('node:path');
  const rota = (arq) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src/features/integrations', arq), 'utf8');
  assert.match(rota('registry/registry.routes.js'), /\.get\([^\n]*requirePermission\('integration:read'\)/);
  assert.match(rota('registry/registry.routes.js'), /\.post\([^\n]*requirePermission\('integration:manage'\)/);
  assert.match(rota('errors/errors.routes.js'), /resolve', requirePermission\('integration:retry'\)/);
});
