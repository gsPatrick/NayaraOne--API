'use strict';

// M9-D900 — destinos da carga (PERSON, SUPPLIER, PROPERTY), parâmetros da migração no dicionário de configurações e a coerência das sementes das fontes. Banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d900Env');
const { SETTINGS_SCHEMA, getSetting } = require('../../../src/features/settings/settings.service');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('../../../src/features/migration-v2/ingest/ingest.settings');
const { SOURCE_SEEDS } = require('../../../src/features/migration-v2/seeds/sources.seed');
const { ENTITIES } = require('../../../src/features/migration-v2/ingest/targets');
const fs = require('node:fs');
const path = require('node:path');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;

test('m9d900 os parâmetros da migração (quatro da D900 e a janela do ETA da D901) estão no dicionário, com o padrão do livro, e o administrador consegue lê-los', { skip: skip() }, async () => {
  assert.deepEqual(INGEST_SETTING_DEFAULTS, { 'migracao.watermark.sobreposicao_s': 120, 'migracao.lote.tamanho': 2000, 'migracao.lote.max_tentativas': 3, 'migracao.lote.timeout_min': 30, 'migracao.eta.janela_lotes': 5 });
  for (const key of Object.values(KEYS)) assert.ok(SETTINGS_SCHEMA[key], `${key} no SETTINGS_SCHEMA`);
  for (const key of Object.values(KEYS)) {
     
    const value = await env.openTenantTx(A(), (tx) => getSetting(key, A(), tx, INGEST_SETTING_DEFAULTS[key]));
    assert.equal(Number(value), INGEST_SETTING_DEFAULTS[key], key);
  }
  const csv = fs.readFileSync(path.resolve(__dirname, '../../../../Maturacao/demandas/parametros.csv'), 'utf8');
  for (const key of Object.values(KEYS)) assert.ok(csv.includes(`"${key}"`), `${key} no catálogo parametros.csv`);
});

test('m9d900 toda parametrização declarada é lida por código de produção', () => {
  const root = path.resolve(__dirname, '../../../src/features/migration-v2');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const runner = read('ingest/batch.runner.js');
  for (const name of ['OVERLAP_S', 'BATCH_SIZE', 'MAX_ATTEMPTS', 'BATCH_TIMEOUT_MIN']) assert.match(runner, new RegExp(`KEYS\\.${name}`), `KEYS.${name} lido pelo executor`);
  assert.match(read('control/eta.service.js'), /KEYS\.ETA_WINDOW/, 'KEYS.ETA_WINDOW lido pela Torre de controle');
});

test('m9d900 toda fonte semeada tem destino, modo válido e motivo da escolha', () => {
  const targets = ENTITIES();
  assert.ok(SOURCE_SEEDS.length >= 3);
  for (const seed of SOURCE_SEEDS) {
    assert.ok(targets.includes(seed.entity), `destino de ${seed.entity}`);
    assert.ok(['CDC', 'WATERMARK', 'FULL_DIFF'].includes(seed.mode));
    assert.ok(seed.modeReason.length > 20, 'mode_reason registrado');
    assert.equal(JSON.stringify(seed.config).match(/postgres:|password|secret|token/i), null, 'config sem segredo');
  }
});

test('m9d900 SUPPLIER entra como pessoa com o papel de fornecedor e PROPERTY como imóvel', { skip: skip() }, async () => {
  const supplier = await env.installSource(A(), { mode: 'CDC', entity: 'SUPPLIER' });
  supplier.fake.event('F1', 'I', 1, env.personRecord({ personType: 'PJ', taxId: env.cnpj(), legalName: 'QA-M9 Fornecedor Legado' }));
  const property = await env.installSource(A(), { mode: 'CDC', entity: 'PROPERTY' });
  property.fake.event('I-100', 'I', 1, { internalCode: `LEG-${env.suffix()}`, title: 'QA-M9 Casa do legado', propertyType: 'RESIDENTIAL', city: 'Curitiba', areaTotalM2: '120.5' });
  property.fake.event('I-101', 'I', 2, { internalCode: '', title: 'sem código' });
  const a = await env.run(A(), { sourceSystem: supplier.system });
  const b = await env.run(A(), { sourceSystem: property.system });
  assert.equal(a.result.status, 'SUCCEEDED');
  assert.equal(b.result.status, 'SUCCEEDED');
  const [rec] = await env.recordsOf(supplier.system);
  assert.equal(rec.state, 'MIGRATED');
  const [role] = await env.q("SELECT role_code FROM people.person_roles WHERE person_id = $1", [rec.target_entity_id]);
  assert.equal(role.role_code, 'SUPPLIER');
  const states = Object.fromEntries((await env.recordsOf(property.system)).map((r) => [r.source_key, r.state]));
  assert.deepEqual(states, { 'I-100': 'MIGRATED', 'I-101': 'QUARANTINED' });
  const [prop] = await env.q('SELECT title, city, source_deleted FROM real_estate.properties WHERE id = $1', [(await env.recordsOf(property.system)).find((r) => r.source_key === 'I-100').target_entity_id]);
  assert.deepEqual([prop.title, prop.city, prop.source_deleted], ['QA-M9 Casa do legado', 'Curitiba', false]);
  property.fake.event('I-100', 'D', 3);
  await env.run(A(), { sourceSystem: property.system });
  const [gone] = await env.q('SELECT source_deleted FROM real_estate.properties WHERE id = $1', [(await env.recordsOf(property.system)).find((r) => r.source_key === 'I-100').target_entity_id]);
  assert.equal(gone.source_deleted, true);
  supplier.dispose(); property.dispose();
});
