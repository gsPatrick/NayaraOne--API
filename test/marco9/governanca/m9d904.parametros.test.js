'use strict';

// M9-D904 — parâmetros do canary: declarados no dicionário de Configurações, no catálogo parametros.csv e na aba Governança do Front; lidos por código de produção; validados pela API
// e com efeito real (trocar as etapas muda o avanço). Banco descartável para a parte que grava.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d904Env');
const S = require('../../../src/features/migration-v2/canary/canary.settings');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const KEYS = Object.keys(S.CANARY_SETTING_DEFAULTS);
before(async () => { if (env.DISPOSABLE) { A = (await env.loadTenants()).A; await env.cleanup(A); } });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { await env.sequelize.close(); });

test('m9d904 os oito parâmetros estão no dicionário, no catálogo e na aba Governança, com os padrões do livro', () => {
  assert.equal(KEYS.length, 8);
  assert.equal(S.CANARY_SETTING_DEFAULTS['migracao.canary.etapas'], '5,25,50,100');
  assert.equal(S.CANARY_SETTING_DEFAULTS['migracao.setor.atendimento.entidades'], 'LEAD,VISIT');
  const csv = fs.readFileSync(path.resolve(__dirname, '../../../../Maturacao/demandas/parametros.csv'), 'utf8');
  const front = fs.readFileSync(path.resolve(__dirname, '../../../../NayaraOne--FRONT/app/painel/configuracoes/governancaMigracaoGroups.js'), 'utf8');
  for (const key of KEYS) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} no dicionário`);
    assert.ok(csv.includes(`"${key}"`), `${key} no catálogo parametros.csv`);
    assert.ok(front.includes(`"${key}"`), `${key} na aba Governança`);
  }
});

test('m9d904 todo parâmetro declarado é lido por código de produção', () => {
  const root = path.resolve(__dirname, '../../../src/features/migration-v2/canary');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(read('canary.params.js'), /S\.STAGES_KEY/);
  assert.match(read('canary.params.js'), /S\.REQUIRE_COMPARISON_KEY/);
  assert.match(read('canary.params.js'), /S\.entitiesKey\(sector\)/);
  assert.match(read('canary.service.js'), /params\.readStages/);
  assert.match(read('canary.gate.js'), /params\.readEntities/);
  assert.match(read('canary.gate.js'), /params\.readRequireComparison/);
});

test('m9d904 a API recusa etapas e listas de entidades fora do formato', { skip: skip() }, async () => {
  for (const [key, value] of [['migracao.canary.etapas', '5,25'], ['migracao.canary.etapas', '25,5,100'], ['migracao.canary.etapas', 'a,100'], ['migracao.setor.obras.entidades', ' , '], ['migracao.setor.obras.entidades', 'obra projeto']]) {
    assert.ok(await env.fail(env.setParam(A, key, value)), `${key}=${value} devia ser recusado`);
  }
  await env.setParam(A, 'migracao.canary.etapas', '10,100');
});

test('m9d904 trocar as etapas muda o avanço do setor', { skip: skip() }, async () => {
  await env.addSectorUsers(A, 'OBRAS', 10);
  await env.setEntities(A, 'OBRAS', ['QA904_OBRA']);
  await env.setParam(A, 'migracao.canary.etapas', '10,40,100');
  const seen = [];
  for (let i = 0; i < 3; i += 1) { const out = await env.advance(A, 'OBRAS'); seen.push([out.percent, out.usersInCanary]); }
  assert.deepEqual(seen, [[10, 1], [40, 4], [100, 10]]);
  assert.equal((await env.fail(env.advance(A, 'OBRAS'))).code, 'GOV_CANARY_STEP_INVALID', 'depois da última etapa não há próxima');
  assert.equal((await env.fail(env.advance(A, 'OBRAS', { percent: 25 }))).code, 'GOV_CANARY_STEP_INVALID');
});
