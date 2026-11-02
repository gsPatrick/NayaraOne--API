'use strict';

// Marco 9, M9-D240 (reabertura da compatibilidade com a API antiga) — o gatilho de somente leitura de correspondent.provider_accounts nasce na 9964 (a última):
// antes dela a API antiga cria e edita contas no legado sem a marca de sessão, e a cópia para integration.connections (migration 650) pega a conta e é idempotente.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const migracao = require('../../../migrations/20260101009964-fecha-o-legado-com-gatilhos-somente-leitura');
const { BACKFILL_SQL } = require('../../../migrations/20260101000650-integration-providers-and-connections');

const sequelize = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
after(async () => { await sequelize.close(); });

const qi = (t) => ({ sequelize: { query: (sql) => sequelize.query(sql, { transaction: t }) } });
async function emTransacao(fn) {
  const t = await sequelize.transaction();
  try { await fn(t); } finally { await t.rollback(); }
}
const q = (t, sql, replacements) => sequelize.query(sql, { replacements, transaction: t, type: Sequelize.QueryTypes.SELECT });

test('conta_do_provider_legado_api_antiga_grava_sem_a_9964_e_a_copia_pega_a_conta', async () => {
  await emTransacao(async (t) => {
    const [emp] = await q(t, `SELECT id, group_id FROM core.companies ORDER BY created_at LIMIT 1`);
    const rotulo = `QA-M9 conta antiga ${Date.now()}`;
    const grava = () => sequelize.query(
      `INSERT INTO correspondent.provider_accounts (id, group_id, company_id, provider_code, label, secret_ref, active, created_at, updated_at)
       VALUES (gen_random_uuid(), :g, :c, 'manual', :l, 'vault:nayara/fin/manual', false, now(), now())`,
      { replacements: { g: emp.group_id, c: emp.id, l: rotulo }, transaction: t }
    );
    await sequelize.query("SELECT set_config('app.integration_legacy_write', 'off', true)", { transaction: t });
    await sequelize.query('SAVEPOINT a', { transaction: t });
    await assert.rejects(grava(), /legado somente leitura/, 'com a 9964 a escrita sem a marca é recusada');
    await sequelize.query('ROLLBACK TO SAVEPOINT a', { transaction: t });

    await migracao.down(qi(t));
    await grava();
    // No deploy a cópia da 650 roda ANTES da 652 (que renomeia 'manual' para 'financing-manual'); aqui, depois da 652, o provider da época é reposto na transação.
    await sequelize.query(`INSERT INTO integration.providers (code, display_name, domain, capabilities, supported_versions, criticality, status, sandbox_available)
      VALUES ('manual', 'Financiamento (fluxo manual assistido)', 'FINANCING', '[]'::jsonb, '["v1"]'::jsonb, 'LOW', 'ACTIVE', false) ON CONFLICT (code) DO NOTHING`, { transaction: t });
    await sequelize.query(BACKFILL_SQL, { transaction: t });
    await sequelize.query(BACKFILL_SQL, { transaction: t });
    const linhas = await q(t, `SELECT c.status, p.domain FROM integration.connections c JOIN integration.providers p ON p.code = c.provider_code WHERE c.label = :l`, { l: rotulo });
    assert.equal(linhas.length, 1, 'copiada uma vez, mesmo rodando a cópia duas vezes');
    assert.equal(linhas[0].domain, 'FINANCING');
  });
});
