'use strict';

// DI-BI2-10 (resposta de 16/11/2026) — papéis de owner dos indicadores do BI. Antes: os padrões de `analytics.owner.*` usavam códigos divergentes para a mesma área
// ("jurídico-gestor" e "juridico-gestor", "locação-gestor", "tecnologia-gestor", "ia-gestor" e "ti-gestor", "Gestor de Estoque" e "Almoxarifado") e NENHUM desses
// papéis existia: nenhuma migration nem semente os criava, e o aceite do owner (acceptance.owner.js) nunca reconhecia o owner padrão. Agora: catálogo único
// (read-models/owner.roles.js), todo owner padrão aponta para um papel do catálogo, a migration 20261116230000 cria os papéis em cada empresa (e corrige os textos
// antigos gravados) e a concessão padrão os cria na empresa nova. Banco descartável; a parte do catálogo de parâmetros lê Maturacao/ (repositório irmão).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bi = require('./marco9/_helpers/biEnv');
const { irmao, testeComIrmaos } = require('./helpers/repoIrmao');
const { SETTINGS_SCHEMA } = require('../src/features/settings/settings.service');
const { OWNER_ROLES, OWNER_ROLE_CODES, ownerText, LEGACY_OWNER_TEXTS, ownerRoleDescription } = require('../src/features/analytics/read-models/owner.roles');
const { roleNamesOf, ownerUserIds } = require('../src/features/analytics/metrics/acceptance.owner');
const { listCriticalityRows } = require('../src/features/analytics/metrics/seed/criticality.table');
const { ensureOwnerRoles } = require('../src/features/analytics/security/ownerRoles.seed');
const migration = require('../migrations/20261116230000-analytics-papeis-owner-dos-indicadores');

const CSV = 'Maturacao/demandas/parametros.csv';
const testCsv = testeComIrmaos([CSV]);
const READ_MODELS_DIR = path.join(__dirname, '..', 'src', 'features', 'analytics', 'read-models');
let env;
let startedAt;

/** Padrão de cada `analytics.owner.*`, lido dos mapas de padrões exportados pelos arquivos de parâmetros do BI. */
function ownerDefaults() {
  const out = {};
  for (const name of fs.readdirSync(READ_MODELS_DIR).filter((n) => n.endsWith('.settings.js'))) {
    for (const value of Object.values(require(path.join(READ_MODELS_DIR, name)))) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const [key, text] of Object.entries(value)) if (key.startsWith('analytics.owner.') && typeof text === 'string') (out[key] = out[key] || new Set()).add(text);
    }
  }
  return out;
}

const codeOf = (text) => (/\(\s*papel\s+([^)]+?)\s*\)/i.exec(text) || [])[1];

before(async () => {
  env = await bi.setup();
  [[{ now: startedAt }]] = await env.admin.query('SELECT clock_timestamp() AS now');
});
after(async () => {
  const ids = [env.cX.companyId, env.cY.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const created = "SELECT id FROM core.roles WHERE name = ANY(ARRAY[:codes]) AND created_at >= :startedAt";
    await env.admin.query(`DELETE FROM core.user_memberships WHERE role_id IN (${created})`, { replacements: { codes: OWNER_ROLE_CODES, startedAt }, transaction });
    await env.admin.query(`DELETE FROM core.role_permissions WHERE role_id IN (${created})`, { replacements: { codes: OWNER_ROLE_CODES, startedAt }, transaction });
    await env.admin.query(created.replace('SELECT id FROM', 'DELETE FROM'), { replacements: { codes: OWNER_ROLE_CODES, startedAt }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
  });
  await bi.teardown(env);
});

test('DI-BI2-10 todo owner padrão do BI (as 90 chaves do dicionário) é "Área (papel código)" do catálogo único', () => {
  const keys = Object.keys(SETTINGS_SCHEMA).filter((k) => k.startsWith('analytics.owner.'));
  assert.ok(keys.length >= 90, `owners no dicionário: ${keys.length}`);
  const defaults = ownerDefaults();
  const problems = [];
  for (const key of keys) {
    const texts = [...(defaults[key] || [])];
    if (texts.length !== 1) { problems.push(`${key}: ${texts.length} padrões`); continue; }
    const code = codeOf(texts[0]);
    if (!OWNER_ROLE_CODES.includes(code) || texts[0] !== ownerText(code)) problems.push(`${key}: ${texts[0]}`);
    else if (!roleNamesOf(texts[0]).includes(code)) problems.push(`${key}: o aceite não acha o papel ${code}`);
  }
  assert.deepEqual(problems, [], 'antes: jurídico-gestor, locação-gestor, Gestor de Estoque, tecnologia-gestor e ia-gestor');
  assert.deepEqual(OWNER_ROLE_CODES.filter((c) => /[^a-z-]/.test(c)), [], 'códigos sem acento: o papel é procurado pelo nome sem diferenciar maiúsculas, mas diferenciando acentos');
});

test('DI-BI2-10 a tabela de criticidade (catálogo global) usa os mesmos códigos', () => {
  const wrong = listCriticalityRows().filter((r) => !OWNER_ROLE_CODES.includes(r.ownerRole)).map((r) => `${r.code}: ${r.ownerRole}`);
  assert.deepEqual(wrong, [], 'antes: tecnologia-gestor e ia-gestor');
});

testCsv('DI-BI2-10 o catálogo de parâmetros traz o mesmo padrão do código para cada owner', () => {
  const text = fs.readFileSync(irmao(...CSV.split('/')), 'utf8');
  const rows = text.split('\n').filter((l) => l.startsWith('"analytics.owner.')).map((l) => l.match(/"((?:[^"]|"")*)"/g).map((c) => c.slice(1, -1)));
  const defaults = ownerDefaults();
  const differ = rows.filter((r) => defaults[r[0]] && !defaults[r[0]].has(r[4])).map((r) => `${r[0]}: catálogo ${r[4]}, código ${[...defaults[r[0]]].join(' | ')}`);
  assert.deepEqual(differ, []);
  assert.ok(rows.length >= 90);
});

test('DI-BI2-10 a migration cria os 10 papéis em cada empresa (com ver e aceitar), corrige os textos antigos gravados e é idempotente', async () => {
  const t = env.cX;
  await bi.setSetting(env, t, 'analytics.owner.legal.deadlines', 'Jurídico (papel jurídico-gestor)');
  await bi.setSetting(env, t, 'analytics.owner.rent.vacancy', 'Locação da Ana (papel ana)'); // escolha do administrador: fica
  await env.admin.query("INSERT INTO analytics.metric_definitions (company_id, group_id, metric_code, name, domain, status, criticality, drilldown_enabled, owner_role) VALUES (:c, :g, 'tec.rule_approvals_pending', 'Aprovações', 'TECH_AI', 'DRAFT', 'CRITICAL', true, 'Tecnologia (papel tecnologia-gestor)')",
    { replacements: { c: t.companyId, g: t.groupId } });
  await migration.up(env.admin.getQueryInterface());
  await migration.up(env.admin.getQueryInterface());

  const [missing] = await env.admin.query(
    `SELECT c.id, x.code FROM core.companies c CROSS JOIN unnest(ARRAY[:codes]) AS x(code)
      WHERE NOT EXISTS (SELECT 1 FROM core.roles r WHERE r.company_id = c.id AND r.deleted_at IS NULL AND upper(r.name) = upper(x.code))`,
    { replacements: { codes: OWNER_ROLE_CODES } }
  );
  assert.deepEqual(missing, [], 'todo papel de owner existe em toda empresa');
  const [[dup]] = await env.admin.query('SELECT count(*)::int AS n FROM core.roles WHERE company_id = :c AND name = ANY(ARRAY[:codes])', { replacements: { c: t.companyId, codes: OWNER_ROLE_CODES } });
  assert.equal(dup.n, OWNER_ROLE_CODES.length, 'a segunda execução não duplica');
  const [perms] = await env.admin.query(
    `SELECT p.code FROM core.roles r JOIN core.role_permissions rp ON rp.role_id = r.id JOIN core.permissions p ON p.id = rp.permission_id
      WHERE r.company_id = :c AND r.name = 'financeiro-gestor' ORDER BY p.code`, { replacements: { c: t.companyId } });
  assert.deepEqual(perms.map((p) => p.code), ['analytics:accept', 'analytics:read']);
  const [[role]] = await env.admin.query("SELECT description FROM core.roles WHERE company_id = :c AND name = 'ti-gestor'", { replacements: { c: t.companyId } });
  assert.equal(role.description, ownerRoleDescription('ti-gestor'));

  const [settings] = await env.admin.query("SELECT key, value FROM core.tenant_settings WHERE company_id = :c AND key LIKE 'analytics.owner.%' ORDER BY key", { replacements: { c: t.companyId } });
  assert.deepEqual(settings.map((s) => [s.key, s.value]), [['analytics.owner.legal.deadlines', ownerText('juridico-gestor')], ['analytics.owner.rent.vacancy', 'Locação da Ana (papel ana)']]);
  const [[def]] = await env.admin.query("SELECT owner_role FROM analytics.metric_definitions WHERE company_id = :c AND metric_code = 'tec.rule_approvals_pending'", { replacements: { c: t.companyId } });
  assert.equal(def.owner_role, ownerText('ti-gestor'));
  const [globals] = await env.admin.query("SELECT metric_code, owner_role FROM analytics.metric_definitions WHERE company_id IS NULL AND metric_code IN ('tec.rule_approvals_pending', 'ai.proposals_pending') ORDER BY 1");
  for (const g of globals) assert.equal(g.owner_role, 'ti-gestor', `${g.metric_code} no catálogo global`);
  assert.deepEqual(Object.keys(LEGACY_OWNER_TEXTS).sort(), ['Gerência de Locação (papel locação-gestor)', 'Gestor de Estoque (papel estoque-gestor)', 'Jurídico (papel jurídico-gestor)', 'Tecnologia (papel tecnologia-gestor)', 'Tecnologia/IA (papel ia-gestor)']);
});

test('DI-BI2-10 o owner padrão é reconhecido pelo aceite: o usuário do papel criado é o owner do indicador', async () => {
  const t = env.cX;
  const [[role]] = await env.admin.query("SELECT id FROM core.roles WHERE company_id = :c AND name = 'estoque-gestor'", { replacements: { c: t.companyId } });
  await env.admin.query("INSERT INTO core.user_memberships (id, group_id, company_id, user_id, status, role_id) VALUES (gen_random_uuid(), :g, :c, :u, 'ACTIVE', :r)",
    { replacements: { g: t.groupId, c: t.companyId, u: t.userId, r: role.id } });
  for (const text of [ownerText('estoque-gestor'), 'Gestor de Estoque (papel estoque-gestor)']) {
    const ids = await bi.inTx(t, {}, (tx) => ownerUserIds({ owner_role: text }, t.companyId, tx));
    assert.deepEqual(ids, [t.userId], text);
  }
  const nobody = await bi.inTx(t, {}, (tx) => ownerUserIds({ owner_role: 'Tecnologia (papel tecnologia-gestor)' }, t.companyId, tx));
  assert.deepEqual(nobody, [], 'o código antigo não é papel de ninguém');
});

test('DI-BI2-10 a concessão padrão cria os papéis na empresa criada depois da migration, uma vez só', async () => {
  const t = env.cY;
  await env.admin.query('DELETE FROM core.role_permissions WHERE role_id IN (SELECT id FROM core.roles WHERE company_id = :c AND name = ANY(ARRAY[:codes]))', { replacements: { c: t.companyId, codes: OWNER_ROLE_CODES } });
  await env.admin.query('DELETE FROM core.roles WHERE company_id = :c AND name = ANY(ARRAY[:codes])', { replacements: { c: t.companyId, codes: OWNER_ROLE_CODES } });
  const first = await bi.inTx(t, { commit: true }, (tx) => ensureOwnerRoles(t, t.userId, tx));
  assert.deepEqual(first, { papeis: 10, criados: OWNER_ROLE_CODES });
  const second = await bi.inTx(t, { commit: true }, (tx) => ensureOwnerRoles(t, t.userId, tx));
  assert.deepEqual(second.criados, []);
  assert.equal(Object.keys(OWNER_ROLES).length, 10);
});
