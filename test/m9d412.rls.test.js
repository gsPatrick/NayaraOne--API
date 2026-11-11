'use strict';

// M9-D412 — tabelas novas do ciclo da campanha: RLS ENABLE + FORCE, isolamento entre empresas, GRANT, CHECK do banco e
// migration idempotente/reversível. Role de runtime (RLS real), transação com rollback; o ciclo da migration só no banco descartável.

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const { sequelize } = require('../src/models');
const { withRollbackTenantTransaction } = require('./testHelpers');
const { tenants, asTenant, makePerson, makeTemplate, q, uid } = require('./helpers/m9d412Fixtures');

const NEW = ['campaign_audience_members', 'campaign_step_deliveries'];
let A; let B;
before(async () => { ({ a: A, b: B } = await tenants()); });
after(async () => { await sequelize.close(); });

test('tabelas_novas_tem_rls_force_politica_e_grant', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    for (const tabela of NEW) {
      const [r] = await q(t, `SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS politicas,
          has_table_privilege('nayara_runtime', c.oid, 'SELECT') AS sel, has_table_privilege('nayara_runtime', c.oid, 'INSERT') AS ins,
          true AS keep
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'marketing' AND c.relname = :t`, { t: tabela });
      assert.equal(r.relrowsecurity, true, `${tabela}: RLS`);
      assert.equal(r.relforcerowsecurity, true, `${tabela}: FORCE RLS`);
      assert.ok(r.politicas >= 1);
      assert.ok(r.sel && r.ins, `${tabela}: SELECT e INSERT`);
    }
  });
});

test('membros_e_disparos_isolados_entre_empresas', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const insertCampaign = async (tenant) => (await q(t, `INSERT INTO marketing.campaigns (group_id, company_id, code, name, objective, owner_user_id)
      VALUES (:g, :c, :code, 'QA-M9', 'objetivo de teste longo', :o) RETURNING id`, { g: tenant.groupId, c: tenant.companyId, code: `QA-${uid().slice(0, 8)}`, o: tenant.userId }))[0].id;
    const populate = async (tenant) => {
      const campaign = await insertCampaign(tenant);
      const person = await makePerson(t, tenant);
      const [aud] = await q(t, `INSERT INTO marketing.campaign_audiences (group_id, company_id, campaign_id, kind, purpose) VALUES (:g, :c, :camp, 'PERSON_LIST', 'X') RETURNING id`,
        { g: tenant.groupId, c: tenant.companyId, camp: campaign });
      await q(t, `INSERT INTO marketing.campaign_audience_members (group_id, company_id, campaign_id, audience_id, person_id) VALUES (:g, :c, :camp, :a, :p) RETURNING id`,
        { g: tenant.groupId, c: tenant.companyId, camp: campaign, a: aud.id, p: person });
      const tpl = await makeTemplate(t, tenant);
      const [step] = await q(t, `INSERT INTO marketing.campaign_steps (group_id, company_id, campaign_id, step_no, channel, template_id) VALUES (:g, :c, :camp, 1, 'EMAIL', :tpl) RETURNING id`,
        { g: tenant.groupId, c: tenant.companyId, camp: campaign, tpl });
      await q(t, `INSERT INTO marketing.campaign_step_deliveries (group_id, company_id, campaign_id, step_id, person_id, action_key, status)
        VALUES (:g, :c, :camp, :s, :p, :k, 'SENT') RETURNING id`, { g: tenant.groupId, c: tenant.companyId, camp: campaign, s: step.id, p: person, k: 'a'.repeat(64) });
      return { campaign, person };
    };
    const mine = await populate(A);
    const theirs = await asTenant(t, A, B, () => populate(B));
    for (const tabela of NEW) {
      const rows = await q(t, `SELECT campaign_id FROM marketing.${tabela}`);
      assert.deepEqual(rows.map((r) => r.campaign_id), [mine.campaign], `${tabela}: só enxerga a própria empresa`);
    }
    assert.notEqual(mine.campaign, theirs.campaign);
    // mesma action_key em outra empresa é permitida (UNIQUE por empresa), na mesma empresa não
    await sequelize.query('SAVEPOINT dup', { transaction: t });
    await assert.rejects(() => q(t, `INSERT INTO marketing.campaign_step_deliveries (group_id, company_id, campaign_id, step_id, person_id, action_key, status)
      SELECT group_id, company_id, campaign_id, step_id, person_id, action_key, 'SENT' FROM marketing.campaign_step_deliveries`), /mkt_campaign_step_deliveries_(action|step_person)_uq/);
    await sequelize.query('ROLLBACK TO SAVEPOINT dup', { transaction: t });
    // INSERT com empresa diferente da sessão é recusado pela RLS
    await assert.rejects(() => q(t, `INSERT INTO marketing.campaign_step_deliveries (group_id, company_id, campaign_id, step_id, person_id, action_key, status)
      VALUES (:g, :c, :camp, gen_random_uuid(), :p, :k, 'SENT')`, { g: B.groupId, c: B.companyId, camp: theirs.campaign, p: theirs.person, k: 'b'.repeat(64) }), /row-level security|violates/);
  });
});

test('campanha_agendada_exige_tudo_no_banco', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const ins = (cols) => q(t, `INSERT INTO marketing.campaigns (group_id, company_id, code, name, objective, owner_user_id, status ${cols.names})
      VALUES (:g, :c, :code, 'QA-M9', 'objetivo de teste longo', :o, :st ${cols.values}) RETURNING id`,
    { g: A.groupId, c: A.companyId, code: `QA-${uid().slice(0, 8)}`, o: A.userId, st: cols.status, ...cols.r });
    assert.ok(await ins({ names: '', values: '', status: 'DRAFT', r: {} }), 'rascunho aceita meta, métrica e orçamento ausentes');
    await sequelize.query('SAVEPOINT s', { transaction: t });
    await assert.rejects(() => ins({ names: '', values: '', status: 'SCHEDULED', r: {} }), /mkt_campaigns_scheduled_complete_chk/);
    await sequelize.query('ROLLBACK TO SAVEPOINT s', { transaction: t });
  });
});

test('migration_754_e_idempotente_e_reversivel', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) { t.skip('só roda no banco descartável'); return; }
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const migration = require(path.resolve(__dirname, '../migrations/20260101000754-marketing-campaign-lifecycle.js'));
  const qi = admin.getQueryInterface();
  const count = async () => (await admin.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'marketing' AND table_name IN (:t)", { replacements: { t: NEW } }))[0][0].n;
  try {
    assert.equal(await count(), 2);
    await migration.up(qi); // segunda vez: sem erro
    const retry = require(path.resolve(__dirname, '../migrations/20260101000757-marketing-campaign-delivery-retry.js'));
    await retry.down(qi); // a 757 (estados abertos da entrega) altera a tabela: sai antes e volta depois, para o banco seguir no esquema atual
    await migration.down(qi);
    assert.equal(await count(), 0);
    await migration.up(qi);
    await retry.up(qi);
    assert.equal(await count(), 2);
  } finally { await admin.close(); }
});
