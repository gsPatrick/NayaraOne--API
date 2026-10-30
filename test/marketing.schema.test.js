'use strict';

// M9-D400 — schema "marketing", parte 1: campaigns, campaign_audiences, campaign_steps, content_items,
// content_versions e templates, com RLS FORCE por grupo e empresa.
//
// Roda com a role de runtime (nayara_runtime, NOBYPASSRLS) em transação com rollback; o teste de idempotência da
// migration precisa de superusuário e só roda no banco descartável (DISPOSABLE_DB=1 + DATABASE_ADMIN_URL).
// Duas empresas: a empresa do seed-dev (grupo A) e a "CI — Empresa Fictícia A" do seed de dois tenants (grupo B para
// este teste), em grupos diferentes.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Sequelize, QueryTypes } = require('sequelize');

const { sequelize, Group, Company } = require('../src/models');
const { getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');

const TABLES = ['campaigns', 'campaign_audiences', 'campaign_steps', 'content_items', 'content_versions', 'templates'];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let tenantA;
let tenantB;

before(async () => {
  tenantA = await getSeedTenant();
  const groupB = await Group.findOne({ where: { name: 'CI — Grupo Fictício A' } });
  assert.ok(groupB, 'o seed de dois tenants precisa ter rodado (scripts/seed-ci-two-tenants.js)');
  const companyB = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: groupB.id }, transaction });
    return Company.findOne({ where: { groupId: groupB.id }, transaction });
  });
  assert.ok(companyB);
  tenantB = { groupId: groupB.id, companyId: companyB.id, userId: tenantA.userId };
});

after(async () => {
  await sequelize.close();
});

async function q(sql, replacements, transaction) {
  return sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
}

async function insertCampaign(t, transaction, over = {}) {
  const v = {
    g: t.groupId, c: t.companyId, code: `QA-${crypto.randomUUID().slice(0, 8)}`, name: 'Lançamento QA-M9',
    objective: 'Gerar leads qualificados do lançamento', metric: 'LEADS', target: 100, budget: 1000, just: null,
    starts: '2026-11-01T00:00:00Z', ends: '2026-11-30T00:00:00Z', owner: t.userId, ...over,
  };
  const rows = await q(
    `INSERT INTO marketing.campaigns (group_id, company_id, code, name, objective, objective_metric, target_value,
        budget_amount, budget_justification, starts_at, ends_at, owner_user_id)
     VALUES (:g, :c, :code, :name, :objective, :metric, :target, :budget, :just, :starts, :ends, :owner) RETURNING id`,
    v, transaction
  );
  return rows[0].id;
}

async function insertTemplate(t, transaction, over = {}) {
  const rows = await q(
    `INSERT INTO marketing.templates (group_id, company_id, code, version_no, kind, channel, status, body, content_hash)
     VALUES (:g, :c, :code, :ver, 'CONTENT', 'SITE', 'DRAFT', 'Olá {{nome}}', :h) RETURNING id`,
    { g: t.groupId, c: t.companyId, code: over.code || `TPL-${crypto.randomUUID().slice(0, 6)}`, ver: over.ver || 1, h: sha('x') },
    transaction
  );
  return rows[0].id;
}

async function insertItem(t, transaction, over = {}) {
  const rows = await q(
    `INSERT INTO marketing.content_items (group_id, company_id, type, title, campaign_id)
     VALUES (:g, :c, 'NEW_PROPERTY', 'Imóvel QA-M9', :camp) RETURNING id`,
    { g: t.groupId, c: t.companyId, camp: over.campaignId || null }, transaction
  );
  return rows[0].id;
}

async function insertVersion(t, transaction, itemId, tplId) {
  const rows = await q(
    `INSERT INTO marketing.content_versions (group_id, company_id, content_item_id, version_no, body_json,
        facts_snapshot_json, template_id, template_version_no, content_hash)
     VALUES (:g, :c, :item, 1, '{"texto":"a"}'::jsonb, '{"preco":1}'::jsonb, :tpl, 1, :h) RETURNING id`,
    { g: t.groupId, c: t.companyId, item: itemId, tpl: tplId, h: sha('a') }, transaction
  );
  return rows[0].id;
}

// Executa um comando que deve falhar sem abortar a transação externa.
async function expectDbError(transaction, sql, replacements, matcher) {
  await sequelize.query('SAVEPOINT s1', { transaction });
  let err = null;
  try {
    await sequelize.query(sql, { replacements, transaction });
  } catch (e) {
    err = e;
  }
  await sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction });
  assert.ok(err, 'o banco deveria ter recusado o comando');
  if (matcher) assert.match(`${err.parent?.constraint || ''} ${err.parent?.message || err.message}`, matcher);
  return err;
}

test('migration_cria_schema_marketing_e_6_tabelas', async () => {
  const tabelas = await q("SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'marketing' AND c.relkind = 'r' ORDER BY 1");
  assert.deepEqual(tabelas.map((r) => r.table_name).filter((n) => TABLES.includes(n)).sort(), [...TABLES].sort());

  for (const tabela of TABLES) {
    const cols = (await q(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'marketing' AND table_name = :t",
      { t: tabela }
    ));
    const nomes = cols.map((c) => c.column_name);
    for (const base of ['id', 'group_id', 'company_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at']) {
      assert.ok(nomes.includes(base), `${tabela} sem a coluna ${base}`);
    }
    for (const nn of ['group_id', 'company_id']) {
      assert.equal(cols.find((c) => c.column_name === nn).is_nullable, 'NO', `${tabela}.${nn} deve ser NOT NULL`);
    }
    const idx = await q("SELECT indexname FROM pg_indexes WHERE schemaname = 'marketing' AND tablename = :t", { t: tabela });
    assert.ok(idx.length >= 2, `${tabela} precisa de índices além da PK`);
  }

  const esperadas = {
    campaigns: ['code', 'name', 'objective', 'objective_metric', 'target_value', 'budget_amount', 'budget_justification', 'cost_actual',
      'channels', 'status', 'result_value', 'starts_at', 'ends_at', 'owner_user_id', 'kill_switch_active', 'kill_switch_at', 'kill_switch_by', 'kill_switch_reason'],
    campaign_audiences: ['campaign_id', 'kind', 'filter_json', 'purpose', 'size_frozen', 'frozen_at'],
    campaign_steps: ['campaign_id', 'step_no', 'channel', 'template_id', 'content_item_id', 'offset_minutes', 'status'],
    content_items: ['type', 'title', 'status', 'source_entity_type', 'source_entity_id', 'source_version', 'current_version_id', 'nay_run_id',
      'autopublish_class', 'campaign_id', 'updates_content_item_id', 'superseded_by'],
    content_versions: ['content_item_id', 'version_no', 'body_json', 'facts_snapshot_json', 'facts_hash', 'template_id', 'template_version_no',
      'model_name', 'nay_run_id', 'checks_json', 'content_hash', 'approved_by', 'approved_at', 'approved_hash'],
    templates: ['code', 'version_no', 'kind', 'channel', 'status', 'body', 'variables_json', 'brand_tokens_json', 'official_template_ref', 'content_hash'],
  };
  for (const [tabela, colunas] of Object.entries(esperadas)) {
    const nomes = (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = 'marketing' AND table_name = :t", { t: tabela })).map((c) => c.column_name);
    for (const c of colunas) assert.ok(nomes.includes(c), `${tabela} sem a coluna ${c}`);
  }

  // RLS + FORCE + política; GRANT ao runtime.
  for (const tabela of TABLES) {
    const [r] = await q(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS politicas,
              has_table_privilege('nayara_runtime', c.oid, 'SELECT') AS sel,
              has_table_privilege('nayara_runtime', c.oid, 'INSERT') AS ins,
              has_table_privilege('nayara_runtime', c.oid, 'UPDATE') AS upd
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'marketing' AND c.relname = :t`,
      { t: tabela }
    );
    assert.equal(r.relrowsecurity, true, `${tabela}: RLS`);
    assert.equal(r.relforcerowsecurity, true, `${tabela}: FORCE RLS`);
    assert.ok(r.politicas >= 1, `${tabela}: política`);
    assert.ok(r.sel && r.ins && r.upd, `${tabela}: GRANT ao nayara_runtime`);
  }
});

test('rls_isola_campanhas_entre_empresas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const campA = await insertCampaign(tenantA, tx);
    const tplA = await insertTemplate(tenantA, tx);
    const itemA = await insertItem(tenantA, tx, { campaignId: campA });
    const verA = await insertVersion(tenantA, tx, itemA, tplA);
    await q(
      `INSERT INTO marketing.campaign_audiences (group_id, company_id, campaign_id, kind, purpose) VALUES (:g, :c, :camp, 'SEGMENT', 'MARKETING')`,
      { g: tenantA.groupId, c: tenantA.companyId, camp: campA }, tx
    );
    await q(
      `INSERT INTO marketing.campaign_steps (group_id, company_id, campaign_id, step_no, channel, template_id) VALUES (:g, :c, :camp, 1, 'EMAIL', :tpl)`,
      { g: tenantA.groupId, c: tenantA.companyId, camp: campA, tpl: tplA }, tx
    );
    assert.ok(verA);
    for (const tabela of TABLES) {
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM marketing.${tabela}`, {}, tx);
      assert.ok(n >= 1, `empresa A deve ver as suas linhas em ${tabela}`);
    }

    // Troca para a empresa B (outro grupo) na mesma transação.
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: tx });
    for (const tabela of TABLES) {
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM marketing.${tabela}`, {}, tx);
      assert.equal(n, 0, `empresa B não pode ver nada de ${tabela}`);
    }
    const [, upd] = await sequelize.query('UPDATE marketing.campaigns SET name = :n', { replacements: { n: 'hack' }, transaction: tx });
    assert.equal(upd.rowCount, 0);
    // Gravar linha de A estando em B: recusado pela política.
    await expectDbError(tx, `INSERT INTO marketing.templates (group_id, company_id, code, version_no, kind, status, body, content_hash)
      VALUES (:g, :c, 'X', 1, 'CONTENT', 'DRAFT', 'x', :h)`, { g: tenantA.groupId, c: tenantA.companyId, h: sha('x') }, /row-level security/i);
  });
});

test('runtime_sem_contexto_nao_le_nada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await insertCampaign(tenantA, tx);
    await sequelize.query("SELECT set_config('app.group_id', '', true), set_config('app.company_id', '', true)", { transaction: tx });
    for (const tabela of TABLES) {
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM marketing.${tabela}`, {}, tx);
      assert.equal(n, 0, `${tabela} sem contexto deve ser vazia`);
    }
    await expectDbError(tx, `INSERT INTO marketing.templates (group_id, company_id, code, version_no, kind, status, body, content_hash)
      VALUES (:g, :c, 'X', 1, 'CONTENT', 'DRAFT', 'x', :h)`, { g: tenantA.groupId, c: tenantA.companyId, h: sha('x') }, /row-level security/i);
  });
});

test('versao_de_conteudo_e_imutavel', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const tpl = await insertTemplate(tenantA, tx);
    const item = await insertItem(tenantA, tx);
    const ver = await insertVersion(tenantA, tx, item, tpl);
    for (const set of ["body_json = '{\"texto\":\"b\"}'::jsonb", "facts_snapshot_json = '{}'::jsonb", `content_hash = '${sha('b')}'`]) {
      const err = await expectDbError(tx, `UPDATE marketing.content_versions SET ${set} WHERE id = :id`, { id: ver }, /MKT_CONTENT_VERSION_IMMUTABLE/);
      assert.equal(err.parent.code, 'MK001');
    }
    // Campos de aprovação continuam graváveis.
    await q("UPDATE marketing.content_versions SET approved_by = 'SYSTEM_AUTOPUBLISH:classe-1', approved_at = now(), approved_hash = content_hash WHERE id = :id", { id: ver }, tx);
    const [{ approved_by: ab }] = await q('SELECT approved_by FROM marketing.content_versions WHERE id = :id', { id: ver }, tx);
    assert.equal(ab, 'SYSTEM_AUTOPUBLISH:classe-1');
    // Item aponta para a versão corrente.
    await q('UPDATE marketing.content_items SET current_version_id = :v WHERE id = :i', { v: ver, i: item }, tx);
    // Versão repetida do mesmo item.
    await expectDbError(tx, `INSERT INTO marketing.content_versions (group_id, company_id, content_item_id, version_no, body_json, template_id, template_version_no, content_hash)
      VALUES (:g, :c, :i, 1, '{}'::jsonb, :t, 1, :h)`, { g: tenantA.groupId, c: tenantA.companyId, i: item, t: tpl, h: sha('z') }, /content_versions/);
  });
});

test('campanha_exige_objetivo_e_periodo_valido', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const base = (over) => ({ g: tenantA.groupId, c: tenantA.companyId, o: tenantA.userId, code: `QA-${crypto.randomUUID().slice(0, 8)}`,
      obj: 'Gerar leads qualificados', metric: 'LEADS', target: 10, budget: 10, starts: '2026-11-01', ends: '2026-11-30', status: 'DRAFT', ...over });
    const sql = `INSERT INTO marketing.campaigns (group_id, company_id, code, name, objective, objective_metric, target_value, budget_amount, starts_at, ends_at, status, owner_user_id)
      VALUES (:g, :c, :code, 'n', :obj, :metric, :target, :budget, :starts, :ends, :status, :o)`;
    await expectDbError(tx, sql, base({ obj: '' }), /objective/i);
    await expectDbError(tx, sql, base({ obj: 'curto' }), /objective/i);
    await expectDbError(tx, sql, base({ obj: '          ' }), /objective/i);
    await expectDbError(tx, sql, base({ starts: '2026-11-10', ends: '2026-11-05' }), /period|ends/i);
    await expectDbError(tx, sql, base({ metric: 'AWARENESS' }), /metric/i);
    await expectDbError(tx, sql, base({ metric: 'REVIEWS' }), /metric/i);
    await expectDbError(tx, sql, base({ status: 'PAUSED' }), /status/i);
    await expectDbError(tx, sql, base({ target: 0 }), /target/i);
    await expectDbError(tx, sql, base({ budget: -1 }), /budget/i);
    await q(sql, base({}), tx);
    for (const m of ['LEADS', 'VISITS', 'PROPOSALS', 'SALES']) await q(sql, base({ metric: m }), tx);
    // Canal fora do enum e código repetido na mesma empresa.
    await expectDbError(tx, "UPDATE marketing.campaigns SET channels = ARRAY['TELEGRAM']", {}, /channels/i);
    const code = `QA-DUP-${crypto.randomUUID().slice(0, 4)}`;
    await q(sql, base({ code }), tx);
    await expectDbError(tx, sql, base({ code }), /code|unique|duplicate/i);
  });
});

test('orcamento_zero_exige_justificativa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const sql = `INSERT INTO marketing.campaigns (group_id, company_id, code, name, objective, objective_metric, target_value, budget_amount, budget_justification, owner_user_id)
      VALUES (:g, :c, :code, 'n', 'Objetivo com mais de dez caracteres', 'SALES', 5, 0, :j, :o)`;
    const r = (j) => ({ g: tenantA.groupId, c: tenantA.companyId, o: tenantA.userId, code: `QA-${crypto.randomUUID().slice(0, 8)}`, j });
    await expectDbError(tx, sql, r(null), /budget_justification|budget/i);
    await expectDbError(tx, sql, r('   '), /budget_justification|budget/i);
    await q(sql, r('Campanha orgânica, sem verba de mídia'), tx);
    const metricas = await q(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'marketing.campaigns'::regclass AND contype = 'c' AND conname = 'mkt_campaigns_objective_metric_chk'"
    );
    assert.equal(metricas.length, 1);
    for (const m of ['LEADS', 'VISITS', 'PROPOSALS', 'SALES']) assert.match(metricas[0].def, new RegExp(m));
    assert.doesNotMatch(metricas[0].def, /REVIEWS|AWARENESS/);
  });
});

test('audiencia_e_etapa_so_referenciam_campanha_da_mesma_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const campA = await insertCampaign(tenantA, tx);
    // Registro de B apontando para campanha de A: a FK composta (id, company_id) recusa.
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: tx });
    await expectDbError(tx, `INSERT INTO marketing.campaign_audiences (group_id, company_id, campaign_id, kind, purpose) VALUES (:g, :c, :camp, 'SEGMENT', 'MARKETING')`,
      { g: tenantB.groupId, c: tenantB.companyId, camp: campA }, /campaign/i);
  });
});

const POSTERIORES = [
  '20260101000752-marketing-template-immutability.js', '20260101000758-marketing-automation-definition.js', '20260101000759-marketing-attribution.js',
  '20260101000761-marketing-campaign-cost.js', '20260101000765-marketing-public-read-models.js', '20260101000775-marketing-content-types-trigger.js',
  '20260101000771-marketing-publication-jobs-one-active-per-version-channel.js', '20260101000772-marketing-automation-action-receipts.js', // M9-D410 e M9-D414
];

test('migration_e_idempotente_e_reversivel', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) {
    t.skip('só roda no banco descartável (DISPOSABLE_DB=1 e DATABASE_ADMIN_URL)');
    return;
  }
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const migration = require(path.resolve(__dirname, '../migrations/20260101000750-marketing-schema-parte-1.js'));
  const parte2 = require(path.resolve(__dirname, '../migrations/20260101000751-marketing-schema-parte-2.js'));
  const parte3 = require(path.resolve(__dirname, '../migrations/20260101000754-marketing-campaign-lifecycle.js')); // M9-D412
  const qi = admin.getQueryInterface();
  const contagem = async () => (await admin.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'marketing' AND table_name IN (:t)", { replacements: { t: TABLES } }))[0][0].n;
  const partes = [parte2, parte3];
  try {
    const inicial = await contagem();
    assert.equal(inicial, 6);
    await migration.up(qi); // segunda vez: sem erro e sem alteração
    // As tabelas da parte 2 (M9-D401) apontam para as da parte 1: o down da parte 1 só roda depois do down da parte 2.
    await require(path.resolve(__dirname, '../migrations/20260101000772-marketing-automation-action-receipts.js')).down(qi); // M9-D414: o recibo das ações aponta para automation_runs
    await parte3.down(qi); // M9-D412: as tabelas do ciclo da campanha apontam para campaigns
    await parte2.down(qi);
    assert.equal(await contagem(), inicial);
    // down recusa com dados.
    await admin.query(`INSERT INTO marketing.templates (group_id, company_id, code, version_no, kind, status, body, content_hash)
      VALUES (:g, :c, 'DOWN-TEST', 1, 'CONTENT', 'DRAFT', 'x', :h)`, { replacements: { g: tenantA.groupId, c: tenantA.companyId, h: sha('d') } });
    await assert.rejects(() => migration.down(qi), /MKT_MIGRATION_DOWN_NOT_EMPTY|não está vazi/i);
    assert.equal(await contagem(), inicial);
    await admin.query("DELETE FROM marketing.templates WHERE code = 'DOWN-TEST'");
    await migration.down(qi);
    assert.equal(await contagem(), 0);
    await migration.up(qi);
    assert.equal(await contagem(), inicial);
  } finally {
    // Recompõe o banco na ordem MESMO se uma asserção falhar: o down da parte 1 derruba as tabelas com tudo que as migrations
    // posteriores acrescentaram (colunas, gatilhos, funções); sem isso um defeito aqui deixaria o schema pela metade para os outros testes.
    await migration.up(qi);
    for (const parte of partes) await parte.up(qi);
    for (const file of POSTERIORES) await require(path.resolve(__dirname, '../migrations', file)).up(qi);
    await admin.close();
  }
});

test('erros_do_schema_viram_codigos_mkt_em_portugues', async () => {
  const errorHandler = require('../src/middlewares/errorHandler');
  const chamar = (parent) => {
    const out = {};
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }, getHeader() { return undefined; } };
    errorHandler(Object.assign(new Error('x'), { name: 'SequelizeDatabaseError', parent }), { method: 'POST', originalUrl: '/x' }, res, () => {});
    return out;
  };
  const imut = chamar({ code: 'MK001', message: 'MKT_CONTENT_VERSION_IMMUTABLE' });
  assert.equal(imut.status, 409);
  assert.equal(imut.body.error.code, 'MKT_CONTENT_VERSION_IMMUTABLE');
  const obj = chamar({ code: '23514', constraint: 'mkt_campaigns_objective_chk' });
  assert.equal(obj.status, 400);
  assert.equal(obj.body.error.code, 'MKT_CAMPAIGN_VALIDATION');
  assert.equal(obj.body.error.message, 'Informe o objetivo da campanha (mínimo 10 caracteres).');
  const tenant = chamar({ code: '23502', schema: 'marketing', column: 'company_id' });
  assert.equal(tenant.body.error.code, 'MKT_TENANT_REQUIRED');
  assert.equal(tenant.status, 400);
});

test('models_sequelize_do_marketing_gravam_e_leem_sob_rls', async () => {
  const { MarketingCampaign, MarketingTemplate, MarketingContentItem, MarketingContentVersion, MarketingCampaignAudience, MarketingCampaignStep } = require('../src/models');
  await withRollbackTenantTransaction(tenantA, async (transaction) => {
    const base = { groupId: tenantA.groupId, companyId: tenantA.companyId };
    const camp = await MarketingCampaign.create({ ...base, code: `QA-M9-${crypto.randomUUID().slice(0, 6)}`, name: 'Campanha QA-M9', objective: 'Gerar leads do lançamento QA-M9', objectiveMetric: 'LEADS', targetValue: 50, budgetAmount: 0, budgetJustification: 'Orgânica', ownerUserId: tenantA.userId, channels: ['EMAIL'] }, { transaction });
    const tpl = await MarketingTemplate.create({ ...base, code: 'QA-M9-T', versionNo: 1, kind: 'MESSAGE', channel: 'EMAIL', body: 'Olá', contentHash: sha('t') }, { transaction });
    const item = await MarketingContentItem.create({ ...base, type: 'INSTITUTIONAL', title: 'QA-M9', campaignId: camp.id }, { transaction });
    const ver = await MarketingContentVersion.create({ ...base, contentItemId: item.id, versionNo: 1, bodyJson: { a: 1 }, contentHash: sha('v'), templateId: tpl.id, templateVersionNo: 1 }, { transaction });
    await MarketingCampaignAudience.create({ ...base, campaignId: camp.id, kind: 'SEGMENT', purpose: 'MARKETING' }, { transaction });
    await MarketingCampaignStep.create({ ...base, campaignId: camp.id, stepNo: 1, channel: 'EMAIL', templateId: tpl.id }, { transaction });
    await item.update({ currentVersionId: ver.id }, { transaction });
    const lida = await MarketingCampaign.findByPk(camp.id, { transaction });
    assert.equal(lida.objectiveMetric, 'LEADS');
    assert.deepEqual(lida.channels, ['EMAIL']);
  });
});
