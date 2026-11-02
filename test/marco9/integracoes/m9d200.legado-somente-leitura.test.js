'use strict';

// Marco 9, M9-D200 (reabertura da compatibilidade com a API antiga) — os gatilhos de somente leitura do legado nascem só na migration 9964 (a última).
const fs = require('node:fs');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const migracao = require('../../../migrations/20260101009964-fecha-o-legado-com-gatilhos-somente-leitura');

// DDL e gatilho exigem o dono das tabelas: conexão de administração do banco descartável (DATABASE_ADMIN_URL, injetada pelo withDisposableDb).
const sequelize = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });

after(async () => { await sequelize.close(); });

const NOMES = ['provider_accounts_read_only', 'integration_errors_read_only', 'webhook_inbox_read_only'];
const DIR = path.join(__dirname, '../../../migrations');

const qi = (t) => ({ sequelize: { query: (sql) => sequelize.query(sql, { transaction: t }) } });
async function gatilhos(t) {
  const [rows] = await sequelize.query(
    `SELECT tgname FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'correspondent' AND NOT tg.tgisinternal AND tgname IN (:n) ORDER BY tgname`,
    { replacements: { n: NOMES }, transaction: t }
  );
  return rows.map((r) => r.tgname).sort();
}
async function emTransacao(fn) {
  const t = await sequelize.transaction();
  try { await fn(t); } finally { await t.rollback(); }
}

test('legado_9964_cria_os_tres_gatilhos_e_o_down_remove', async () => {
  await emTransacao(async (t) => {
    assert.deepEqual(await gatilhos(t), [...NOMES].sort(), 'com todas as migrations aplicadas os três existem');
    await migracao.down(qi(t));
    assert.deepEqual(await gatilhos(t), [], 'o down remove os três');
    await migracao.up(qi(t));
    assert.deepEqual(await gatilhos(t), [...NOMES].sort(), 'o up recria os três');
    await migracao.up(qi(t));
    assert.deepEqual(await gatilhos(t), [...NOMES].sort(), 'idempotente: rodar de novo não falha nem duplica');
  });
});

test('legado_grava_so_com_a_marca_de_sessao_e_a_api_antiga_grava_sem_a_9964', async () => {
  const insere = (t) => sequelize.query('INSERT INTO "correspondent"."webhook_inbox" DEFAULT VALUES', { transaction: t });
  await emTransacao(async (t) => {
    await sequelize.query('SAVEPOINT a', { transaction: t });
    await assert.rejects(insere(t), /legado somente leitura/, 'com a 9964 e sem a marca o gatilho recusa');
    await sequelize.query('ROLLBACK TO SAVEPOINT a', { transaction: t });
    await sequelize.query("SELECT set_config('app.integration_legacy_write', 'on', true)", { transaction: t });
    await assert.rejects(insere(t), (e) => !/legado somente leitura/.test(e.message), 'com a marca o gatilho libera (a falha é outra, de coluna obrigatória)');
    await sequelize.query('ROLLBACK TO SAVEPOINT a', { transaction: t });
    await migracao.down(qi(t));
    await sequelize.query("SELECT set_config('app.integration_legacy_write', 'off', true)", { transaction: t });
    await assert.rejects(insere(t), (e) => !/legado somente leitura/.test(e.message), 'sem a 9964 a API antiga não esbarra no legado');
  });
});

test('legado_nenhuma_das_migrations_650_656_658_cria_gatilho_de_somente_leitura', () => {
  for (const f of ['20260101000650-integration-providers-and-connections.js', '20260101000656-create-integration-errors.js', '20260101000658-create-integration-webhook-inbox.js']) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const n of NOMES) assert.ok(!new RegExp(`CREATE (TRIGGER|FUNCTION)[^;]*${n}`).test(src), `${f} não pode criar ${n}`);
  }
});

test('legado_9964_e_a_ultima_migration', () => {
  const todas = fs.readdirSync(DIR).filter((f) => /^\d{14}-.*\.js$/.test(f)).sort();
  assert.match(todas[todas.length - 1], /^20260101009964-/);
});
