'use strict';

// M9-D404 — Templates versionados (MKT-010): ciclo, imutabilidade, variáveis, canal oficial, brand tokens e concorrência.
// Postgres real com a role de runtime (RLS FORCE). Rodar SOMENTE em banco descartável (o .env aponta para a homologação):
//   node scripts/withDisposableDb.js --port <porta> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/m9d404.templates.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const { getSeedTenant, withRollbackTenantTransaction, withTenantTransaction } = require('./testHelpers');
const { upsertSetting } = require('../src/features/settings/settings.service');
const templates = require('../src/modules/marketing/content/template.service');
const { q, uid, sha, templateInput } = require('./helpers/m9d404Fixtures');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1';
let tenant;

before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

const rejectsWith = (promise, status, code) =>
  assert.rejects(promise, (e) => {
    assert.equal(e.statusCode, status, `status ${e.statusCode} / ${e.code}`);
    assert.equal(e.code, code);
    assert.ok(/[a-zà-ú]/i.test(e.message));
    return true;
  });

test('template_publicado_e_imutavel: PUBLISHED e RETIRED não mudam; nova versão nasce em DRAFT com version_no + 1', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const input = templateInput();
    const v1 = await templates.createTemplate(tenant, tenant.userId, input, t);
    assert.equal(v1.versionNo, 1);
    assert.equal(v1.status, 'DRAFT');
    assert.match(v1.contentHash, /^[0-9a-f]{64}$/);
    const pub = await templates.publishTemplate(tenant, tenant.userId, v1.id, t);
    assert.equal(pub.template.status, 'PUBLISHED');

    // O banco recusa mexer em template publicado (defesa em profundidade, qualquer caminho).
    await sequelize.query('SAVEPOINT s1', { transaction: t });
    await assert.rejects(
      () => q(t, "UPDATE marketing.templates SET body = 'outro texto {{bairro}}' WHERE id = :id", { id: v1.id }),
      /MKT_TEMPLATE_IMMUTABLE/
    );
    await sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: t });

    const v2 = await templates.createTemplate(tenant, tenant.userId, { ...input, body: 'Texto novo {{bairro}}' }, t);
    assert.equal(v2.versionNo, 2);
    assert.equal(v2.status, 'DRAFT');
    assert.equal(v2.code, v1.code);
    const [still] = await q(t, 'SELECT body, status FROM marketing.templates WHERE id = :id', { id: v1.id });
    assert.equal(still.body, input.body, 'v1 continua intacta');

    // Publicar v2 aposenta v1; RETIRED não volta a ser publicado nem editado.
    const pub2 = await templates.publishTemplate(tenant, tenant.userId, v2.id, t);
    assert.equal(pub2.retiredVersionNo, 1);
    const [old] = await q(t, 'SELECT status FROM marketing.templates WHERE id = :id', { id: v1.id });
    assert.equal(old.status, 'RETIRED');
    await rejectsWith(templates.publishTemplate(tenant, tenant.userId, v1.id, t), 409, 'MKT_TEMPLATE_IMMUTABLE');
    await sequelize.query('SAVEPOINT s2', { transaction: t });
    await assert.rejects(() => q(t, "UPDATE marketing.templates SET status = 'PUBLISHED' WHERE id = :id", { id: v1.id }), /MKT_TEMPLATE_IMMUTABLE/);
    await sequelize.query('ROLLBACK TO SAVEPOINT s2', { transaction: t });
  });
});

test('publicar duas vezes a mesma versão devolve o mesmo resultado sem efeito (idempotente)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const v1 = await templates.createTemplate(tenant, tenant.userId, templateInput(), t);
    const a = await templates.publishTemplate(tenant, tenant.userId, v1.id, t);
    const b = await templates.publishTemplate(tenant, tenant.userId, v1.id, t);
    assert.equal(a.replay, false);
    assert.equal(b.replay, true);
    assert.equal(b.template.status, 'PUBLISHED');
    const audits = await q(t, "SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_id = :id AND action = 'marketing.template.publish'", { id: v1.id });
    assert.equal(audits[0].n, 1, 'a repetição não gera nova auditoria');
  });
});

test('variavel_desconhecida_recusa: placeholder fora de variables_json recusa a publicação com 422', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const bad = await templates.createTemplate(tenant, tenant.userId, templateInput({ body: 'Carro {{cor_do_carro}} em {{bairro}}' }), t);
    await rejectsWith(templates.publishTemplate(tenant, tenant.userId, bad.id, t), 422, 'MKT_TEMPLATE_UNKNOWN_VARIABLE');
    const [row] = await q(t, 'SELECT status FROM marketing.templates WHERE id = :id', { id: bad.id });
    assert.equal(row.status, 'DRAFT');
    const malformed = await templates.createTemplate(tenant, tenant.userId, templateInput({ body: 'Valor {{ preco; drop }}' }), t);
    await rejectsWith(templates.publishTemplate(tenant, tenant.userId, malformed.id, t), 422, 'MKT_TEMPLATE_UNKNOWN_VARIABLE');
    const ok = await templates.createTemplate(tenant, tenant.userId, templateInput({ body: 'Em {{ bairro }} por {{preco}}' }), t);
    assert.equal((await templates.publishTemplate(tenant, tenant.userId, ok.id, t)).template.status, 'PUBLISHED');
  });
});

test('whatsapp_exige_template_oficial: canal WHATSAPP sem official_template_ref não vai a PUBLISHED; a lista de canais é configurável', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const noRef = await templates.createTemplate(tenant, tenant.userId, templateInput({ kind: 'MESSAGE', channel: 'WHATSAPP' }), t);
    await rejectsWith(templates.publishTemplate(tenant, tenant.userId, noRef.id, t), 422, 'MKT_TEMPLATE_OFFICIAL_REF_REQUIRED');
    const withRef = await templates.createTemplate(
      tenant, tenant.userId, templateInput({ kind: 'MESSAGE', channel: 'WHATSAPP', officialTemplateRef: 'hsm_boas_vindas_v1' }), t
    );
    assert.equal((await templates.publishTemplate(tenant, tenant.userId, withRef.id, t)).template.status, 'PUBLISHED');

    // INSTAGRAM não exige por padrão; o administrador pode incluí-lo na lista (parâmetro lido de verdade).
    const insta = await templates.createTemplate(tenant, tenant.userId, templateInput(), t);
    await upsertSetting('marketing.templates.canais_com_template_oficial', 'WHATSAPP, INSTAGRAM', tenant, tenant.userId, t);
    await rejectsWith(templates.publishTemplate(tenant, tenant.userId, insta.id, t), 422, 'MKT_TEMPLATE_OFFICIAL_REF_REQUIRED');
  });
});

test('parâmetro dos canais oficiais recusa canal desconhecido (SETTINGS_SCHEMA fail-closed)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(
      () => upsertSetting('marketing.templates.canais_com_template_oficial', 'WHATSAPP, TELEGRAM', tenant, tenant.userId, t),
      (e) => e.statusCode === 400 && e.code === 'SETTING_INVALID_VALUE'
    );
  });
});

test('brand tokens versionados: cores hex, fontes, margens, proporções por canal e logo com SHA-256 são validados e entram no hash', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const base = templateInput();
    const bad = [
      { colors: { primary: 'azul' } },
      { colors: { primary: '#12345' } },
      { fonts: 'Inter' },
      { logo: { fileId: 'nao-uuid', sha256: sha('x') } },
      { logo: { fileId: uid(), sha256: 'abc' } },
      { margins: { top: -1 } },
      { proportions: { TELEGRAM: { width: 10, height: 10 } } },
      { proportions: { INSTAGRAM: { width: 0, height: 10 } } },
      { cores: { a: '#fff' } },
    ];
    for (const tokens of bad) {
      await rejectsWith(templates.createTemplate(tenant, tenant.userId, { ...base, brandTokens: tokens }, t), 422, 'MKT_TEMPLATE_BRAND_TOKENS_INVALID');
    }
    const a = await templates.createTemplate(tenant, tenant.userId, { ...base, brandTokens: { colors: { primary: '#0A3D62' } } }, t);
    const b = await templates.createTemplate(tenant, tenant.userId, { ...base, brandTokens: { colors: { primary: '#0A3D63' } } }, t);
    assert.notEqual(a.contentHash, b.contentHash, 'o conjunto de tokens faz parte do hash do template');
    assert.deepEqual(a.brandTokens, { colors: { primary: '#0A3D62' } });
  });
});

test('logo por hash: o arquivo precisa existir na empresa e o SHA-256 informado precisa bater com o do módulo de arquivos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const logo = { fileId: uid(), sha256: sha('logo-que-nao-existe') };
    await rejectsWith(
      templates.createTemplate(tenant, tenant.userId, templateInput({ brandTokens: { logo } }), t),
      422, 'MKT_TEMPLATE_BRAND_TOKENS_INVALID'
    );
    const digest = sha('conteudo-do-logo');
    const [file] = await q(
      t,
      `INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, mime_type, size_bytes, checksum_sha256)
       VALUES (gen_random_uuid(), :g, :c, :k, 'logo.png', 'image/png', 10, :h) RETURNING id`,
      { g: tenant.groupId, c: tenant.companyId, k: `qa-m9/${uid()}`, h: digest }
    );
    await rejectsWith(
      templates.createTemplate(tenant, tenant.userId, templateInput({ brandTokens: { logo: { fileId: file.id, sha256: sha('outro') } } }), t),
      422, 'MKT_TEMPLATE_BRAND_TOKENS_INVALID'
    );
    const ok = await templates.createTemplate(tenant, tenant.userId, templateInput({ brandTokens: { logo: { fileId: file.id, sha256: digest } } }), t);
    assert.equal(ok.brandTokens.logo.sha256, digest);
  });
});

test('criação valida o formato: corpo, tipo, canal e variáveis; auditoria com antes/depois', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await rejectsWith(templates.createTemplate(tenant, tenant.userId, templateInput({ body: '   ' }), t), 400, 'VALIDATION_ERROR');
    await rejectsWith(templates.createTemplate(tenant, tenant.userId, templateInput({ kind: 'X' }), t), 400, 'VALIDATION_ERROR');
    await rejectsWith(templates.createTemplate(tenant, tenant.userId, templateInput({ channel: 'TELEGRAM' }), t), 400, 'VALIDATION_ERROR');
    await rejectsWith(templates.createTemplate(tenant, tenant.userId, templateInput({ code: '' }), t), 400, 'VALIDATION_ERROR');
    await rejectsWith(templates.createTemplate(tenant, tenant.userId, templateInput({ variables: [{ name: 'a b', type: 'text' }] }), t), 400, 'VALIDATION_ERROR');
    await rejectsWith(templates.createTemplate(tenant, tenant.userId, templateInput({ variables: [{ name: 'a', type: 'zzz' }] }), t), 400, 'VALIDATION_ERROR');
    await rejectsWith(templates.createTemplate(tenant, tenant.userId, templateInput({ variables: [{ name: 'a', type: 'text' }, { name: 'a', type: 'text' }] }), t), 400, 'VALIDATION_ERROR');
    const v1 = await templates.createTemplate(tenant, tenant.userId, templateInput(), t);
    const [log] = await q(t, "SELECT after_json, user_id FROM audit.audit_log WHERE entity_id = :id AND action = 'marketing.template.create'", { id: v1.id });
    assert.equal(log.user_id, tenant.userId);
    assert.equal(log.after_json.versionNo, 1);
  });
});

test('publicar versão mais antiga que a vigente é recusado (409 MKT_TEMPLATE_VERSION_OUTDATED)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const input = templateInput();
    const v1 = await templates.createTemplate(tenant, tenant.userId, input, t);
    const v2 = await templates.createTemplate(tenant, tenant.userId, input, t);
    await templates.publishTemplate(tenant, tenant.userId, v2.id, t);
    await rejectsWith(templates.publishTemplate(tenant, tenant.userId, v1.id, t), 409, 'MKT_TEMPLATE_VERSION_OUTDATED');
  });
});

test('listagem traz o histórico de versões por código, paginada e filtrável; outra empresa não enxerga', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const input = templateInput();
    const v1 = await templates.createTemplate(tenant, tenant.userId, input, t);
    await templates.publishTemplate(tenant, tenant.userId, v1.id, t);
    const v2 = await templates.createTemplate(tenant, tenant.userId, input, t);
    await templates.publishTemplate(tenant, tenant.userId, v2.id, t);
    await templates.createTemplate(tenant, tenant.userId, input, t);
    const list = await templates.listTemplates(tenant, { code: input.code }, t);
    assert.equal(list.total, 1);
    assert.equal(list.items[0].code, input.code);
    assert.deepEqual(list.items[0].versions.map((v) => [v.versionNo, v.status]), [[3, 'DRAFT'], [2, 'PUBLISHED'], [1, 'RETIRED']]);
    assert.equal(list.items[0].currentPublished.versionNo, 2);
    const filtered = await templates.listTemplates(tenant, { code: input.code, status: 'RETIRED' }, t);
    assert.deepEqual(filtered.items[0].versions.map((v) => v.versionNo), [1]);
    const page = await templates.listTemplates(tenant, { page: 1, pageSize: 1 }, t);
    assert.equal(page.items.length, 1);
    assert.equal(page.pageSize, 1);
    const other = { ...tenant, companyId: uid() };
    await withRollbackTenantTransaction(other, async (t2) => {
      assert.equal((await templates.listTemplates(other, { code: input.code }, t2)).total, 0);
      await rejectsWith(templates.publishTemplate(other, tenant.userId, v1.id, t2), 404, 'MKT_NOT_FOUND');
    });
  });
});

test('publicacao_simultanea_de_versao_uma_vence: duas publicações da mesma versão e de versões diferentes terminam coerentes', { skip: !DISPOSABLE && 'precisa do banco descartável (transações concorrentes COMMITAM)' }, async () => {
  const input = templateInput();
  const make = (body) => withTenantTransaction(tenant, (t) => templates.createTemplate(tenant, tenant.userId, { ...input, body }, t));
  const v1 = await make('Texto 1 {{bairro}}');
  const v2 = await make('Texto 2 {{bairro}}');
  const run = (id) => withTenantTransaction(tenant, (t) => templates.publishTemplate(tenant, tenant.userId, id, t));
  try {
    // Mesma versão em paralelo: uma publica, a outra é replay; nunca erro.
    const same = await Promise.all([run(v1.id), run(v1.id), run(v1.id)]);
    assert.equal(same.filter((r) => r.replay === false).length, 1);
    assert.equal(same.filter((r) => r.replay === true).length, 2);
    // Versões diferentes em paralelo: ao final só UMA publicada (a maior) e a outra aposentada.
    const diff = await Promise.allSettled([run(v1.id), run(v2.id)]);
    assert.ok(diff.every((r) => r.status === 'fulfilled' || r.reason.code === 'MKT_TEMPLATE_VERSION_OUTDATED'));
    const rows = await withTenantTransaction(tenant, (t) => q(t, 'SELECT version_no, status FROM marketing.templates WHERE code = :c ORDER BY version_no', { c: input.code }));
    assert.deepEqual(rows.map((r) => r.status), ['RETIRED', 'PUBLISHED']);
  } finally {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    await admin.connect();
    await admin.query('DELETE FROM marketing.templates WHERE code = $1', [input.code]);
    await admin.end();
  }
});
