'use strict';

// M9-D903 — parâmetros da comparação paralela: declarados no dicionário de Configurações, no catálogo parametros.csv, lidos por código de produção e validados pela API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cleanMigrationSettings } = require('../_helpers/m9d900Clean');
const env = require('../_helpers/m9d903Env');
const { KEYS, PARALLEL_SETTING_DEFAULTS } = require('../../../src/features/migration-v2/parallel/parallel.settings');
const { SETTINGS_SCHEMA, upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { if (env.DISPOSABLE) await cleanMigrationSettings(); await env.sequelize.close(); });

test('m9d903 os três parâmetros estão no dicionário de Configurações e no catálogo com o padrão do livro', () => {
  const csv = fs.readFileSync(path.resolve(__dirname, '../../../../Maturacao/demandas/parametros.csv'), 'utf8');
  assert.deepEqual(PARALLEL_SETTING_DEFAULTS, { 'migracao.paralelo.intervalo_min': 60, 'migracao.paralelo.fuso': 'America/Sao_Paulo', 'migracao.paralelo.timeout_min': 30 });
  for (const key of Object.values(KEYS)) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} no dicionário`);
    assert.ok(csv.includes(`"${key}"`), `${key} no catálogo parametros.csv`);
  }
  const front = fs.readFileSync(path.resolve(__dirname, '../../../../NayaraOne--FRONT/app/painel/configuracoes/governancaMigracaoGroups.js'), 'utf8');
  for (const key of Object.values(KEYS)) assert.ok(front.includes(`"${key}"`), `${key} na aba Governança`);
});

test('m9d903 toda parametrização declarada é lida por código de produção', () => {
  const root = path.resolve(__dirname, '../../../src/features/migration-v2/parallel');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(read('window.service.js'), /KEYS\.INTERVAL_MIN/, 'intervalo lido na criação da janela');
  assert.match(read('window.service.js'), /KEYS\.TIMEZONE/, 'fuso lido na criação da janela');
  assert.match(read('runner.js'), /KEYS\.TIMEOUT_MIN/, 'prazo da execução lido pelo comparador');
  assert.match(read('runner.js'), /KEYS\.TIMEZONE/, 'fuso lido pelo comparador (regra DATE)');
});

test('m9d903 a API recusa valor fora da faixa e fuso inexistente', { skip: skip() }, async () => {
  const A = tenants.A;
  const save = (key, value) => env.openTenantTx(A, (tx) => upsertSetting(key, value, A, A.userId, tx));
  for (const [key, value] of [[KEYS.INTERVAL_MIN, 0], [KEYS.INTERVAL_MIN, 1441], [KEYS.TIMEOUT_MIN, 0], [KEYS.TIMEZONE, 'Marte/Olimpo']]) {
    const err = await env.fail(save(key, value));
    assert.ok(err, `${key}=${value} devia ser recusado`);
  }
  await save(KEYS.TIMEZONE, 'America/Sao_Paulo');
});

test('m9d903 mudar o intervalo e o fuso padrão muda a janela criada sem intervalo próprio', { skip: skip() }, async () => {
  const A = tenants.A;
  const save = (key, value) => env.openTenantTx(A, (tx) => upsertSetting(key, value, A, A.userId, tx));
  const legacy = await env.installSource(A, { entity: env.ENTITY, columnMap: env.COLUMN_MAP });
  const targets = require('../../../src/features/migration-v2/ingest/targets');
  const restore = targets.overrideTarget(env.ENTITY, { entityType: env.ENTITY, canonical: (r) => r, readCanonical: async () => new Map() });
  const create = (extra) => env.openTenantTx(A, (tx) => env.windowService.createWindow(A, { userId: A.userId }, {
    sourceSystem: legacy.system, entities: [env.ENTITY], startsAt: '2031-01-01T00:00:00', endsAt: '2031-01-02T00:00:00', rules: env.RULES, ...extra,
  }, tx));
  try {
    await save(KEYS.INTERVAL_MIN, 15);
    await save(KEYS.TIMEZONE, 'UTC');
    const utc = await create({});
    assert.equal(utc.intervalMin, 15, 'o padrão do parâmetro vale para a janela sem intervalo');
    assert.equal(new Date(utc.startsAt).toISOString(), '2031-01-01T00:00:00.000Z', 'data sem fuso lida no fuso configurado');
    assert.equal((await create({ intervalMin: 5 })).intervalMin, 5, 'intervalo da janela vence o padrão');
    await save(KEYS.TIMEZONE, 'America/Sao_Paulo');
    assert.equal(new Date((await create({})).startsAt).toISOString(), '2031-01-01T03:00:00.000Z');
  } finally {
    await save(KEYS.INTERVAL_MIN, 60);
    await env.q('DELETE FROM governance.parallel_windows WHERE source_system = $1', [legacy.system]);
    restore();
    legacy.dispose();
  }
});
