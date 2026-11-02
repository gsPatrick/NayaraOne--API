'use strict';

// Marco 9, M9-D203 (reabertura da compatibilidade com a API antiga) — o gatilho de somente leitura de correspondent.webhook_inbox nasce na 9964 (a última):
// antes dela a API antiga grava no legado sem a marca de sessão, e a cópia para integration.webhook_inbox (migration 658) pega essa linha e é idempotente.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const migracao = require('../../../migrations/20260101009964-fecha-o-legado-com-gatilhos-somente-leitura');
const { BACKFILL_SQL } = require('../../../migrations/20260101000658-create-integration-webhook-inbox');

const sequelize = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
after(async () => { await sequelize.close(); });

const qi = (t) => ({ sequelize: { query: (sql) => sequelize.query(sql, { transaction: t }) } });
async function emTransacao(fn) {
  const t = await sequelize.transaction();
  try { await fn(t); } finally { await t.rollback(); }
}
const q = (t, sql, replacements) => sequelize.query(sql, { replacements, transaction: t, type: Sequelize.QueryTypes.SELECT });

test('inbox_legado_api_antiga_grava_sem_a_9964_e_a_copia_pega_a_linha', async () => {
  await emTransacao(async (t) => {
    const [emp] = await q(t, `SELECT id, group_id FROM core.companies ORDER BY created_at LIMIT 1`);
    const caso = '00000000-0000-4000-8000-0000000d2031';
    const evento = `qa-m9-d203-antiga-${Date.now()}`;
    const grava = () => sequelize.query(
      `INSERT INTO correspondent.webhook_inbox (id, group_id, company_id, financing_case_id, provider_code, external_event_id, payload, received_at)
       VALUES (gen_random_uuid(), :g, :c, :fc, 'SANDBOX-QA', :e, '{"status":"ANALYSIS"}'::jsonb, now())`,
      { replacements: { g: emp.group_id, c: emp.id, fc: caso, e: evento }, transaction: t }
    );
    await sequelize.query("SELECT set_config('app.integration_legacy_write', 'off', true)", { transaction: t });
    await sequelize.query('SAVEPOINT a', { transaction: t });
    await assert.rejects(grava(), /legado somente leitura/, 'com a 9964 a escrita sem a marca é recusada');
    await sequelize.query('ROLLBACK TO SAVEPOINT a', { transaction: t });

    await migracao.down(qi(t));
    // O caso de financiamento não existe no seed: o modo réplica só dispensa a chave estrangeira (o gatilho de legado já foi removido pelo down).
    await sequelize.query("SET LOCAL session_replication_role = 'replica'", { transaction: t });
    await grava();
    await sequelize.query(BACKFILL_SQL, { transaction: t });
    await sequelize.query(BACKFILL_SQL, { transaction: t });
    const linhas = await q(t, `SELECT status, headers_json FROM integration.webhook_inbox WHERE external_event_id = :e`, { e: evento });
    assert.equal(linhas.length, 1, 'copiada uma vez, mesmo rodando a cópia duas vezes');
    assert.equal(linhas[0].status, 'PROCESSED');
  });
});
