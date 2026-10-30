'use strict';

// M9-D425 — migration 756 (marketing.kill_switch_log): RLS + FORCE por grupo e empresa, GRANT só de leitura e inserção ao runtime, histórico imutável, idempotente e reversível
// (o down recusa apagar histórico). Só no banco descartável (usa DATABASE_ADMIN_URL).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Sequelize } = require('sequelize');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');

const skip = DISPOSABLE ? false : SKIP_DISPOSABLE;
const migration = require(path.resolve(__dirname, '../../../migrations/20260101000756-marketing-kill-switch-log.js'));
let admin;
const adminSequelize = () => { admin = admin || new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false }); return admin; };
after(() => admin && admin.close());

test('migration_cria_a_tabela_com_rls_force_grants_e_gatilho_de_imutabilidade', { skip }, async () => {
  const [{ rows: [t] }, { rows: policies }, { rows: [priv] }, { rows: triggers }, { rows: [identity] }] = await Promise.all([
    adminQuery("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'marketing.kill_switch_log'::regclass"),
    adminQuery("SELECT polname FROM pg_policy WHERE polrelid = 'marketing.kill_switch_log'::regclass"),
    adminQuery("SELECT has_table_privilege('nayara_runtime', 'marketing.kill_switch_log', 'SELECT') AS sel, has_table_privilege('nayara_runtime', 'marketing.kill_switch_log', 'INSERT') AS ins"),
    adminQuery("SELECT tgname FROM pg_trigger WHERE tgrelid = 'marketing.kill_switch_log'::regclass AND NOT tgisinternal"),
    adminQuery("SELECT is_identity FROM information_schema.columns WHERE table_schema = 'marketing' AND table_name = 'kill_switch_log' AND column_name = 'seq'"),
  ]);
  assert.deepEqual([t.relrowsecurity, t.relforcerowsecurity, policies.map((p) => p.polname)], [true, true, ['tenant_isolation']]);
  // o banco descartável concede tudo ao runtime em bloco (withDisposableDb); a imutabilidade vale pelo gatilho, que recusa até o dono
  assert.deepEqual([priv.sel, priv.ins], [true, true]);
  assert.match(require('node:fs').readFileSync(path.resolve(__dirname, '../../../migrations/20260101000756-marketing-kill-switch-log.js'), 'utf8'), /GRANT SELECT, INSERT ON marketing\.kill_switch_log TO nayara_runtime/, 'a migration concede só leitura e inserção');
  assert.deepEqual(triggers.map((r) => r.tgname), ['kill_switch_log_guard']);
  assert.equal(identity.is_identity, 'YES', 'seq dá a ordem exata mesmo dentro da mesma transação');
});

test('migration_e_idempotente_e_o_down_nao_apaga_historico', { skip }, async () => {
  const qi = adminSequelize().getQueryInterface();
  const { A } = await loadTenants();
  const exists = async () => (await adminQuery("SELECT to_regclass('marketing.kill_switch_log') AS reg")).rows[0].reg !== null;
  try {
    await migration.up(qi); // segunda vez: sem erro
    assert.equal(await exists(), true);
    await adminQuery("INSERT INTO marketing.kill_switch_log (group_id, company_id, scope, action, reason, active_before, active_after) VALUES ($1, $2, 'GLOBAL', 'ACTIVATE', 'QA-M9 teste da migration', false, true)", [A.groupId, A.companyId]);
    await assert.rejects(() => migration.down(qi), /MKT_MIGRATION_DOWN_NOT_EMPTY/);
    assert.equal(await exists(), true, 'com histórico o down recusa e nada some');
    await adminQuery('ALTER TABLE marketing.kill_switch_log DISABLE TRIGGER kill_switch_log_guard');
    await adminQuery("DELETE FROM marketing.kill_switch_log WHERE reason = 'QA-M9 teste da migration'");
    await adminQuery('ALTER TABLE marketing.kill_switch_log ENABLE TRIGGER kill_switch_log_guard');
    await migration.down(qi);
    assert.equal(await exists(), false);
  } finally {
    await migration.up(qi); // recompõe o banco para os outros testes
  }
  assert.equal(await exists(), true);
});
