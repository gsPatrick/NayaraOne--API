'use strict';

// M9-D850 — o parâmetro do padrão de estados de UI existe, tem padrão do livro, está no catálogo, na aba Governança e é lido pelo Front (sem banco).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../../../src/features/core-governance/ui-standards/ui.settings');
const { GOVERNANCE_SETTINGS_SCHEMA, GOVERNANCE_SETTING_DEFAULTS } = require('../../../src/features/core-governance/governance.settings');

const ROOT = path.join(__dirname, '../../../..');

test('m9d850 governanca.ui.cache_fresco_s tem padrão 60, validação, catálogo, aba no front e quem o leia', () => {
  const key = S.CACHE_FRESH_KEY;
  assert.equal(key, 'governanca.ui.cache_fresco_s');
  assert.equal(S.UI_SETTING_DEFAULTS[key], 60, 'padrão do livro: 60 s');
  assert.deepEqual(GOVERNANCE_SETTINGS_SCHEMA[key], { type: 'integer', min: 1, max: 86400 });
  assert.equal(GOVERNANCE_SETTING_DEFAULTS[key], 60);
  assert.ok(fs.readFileSync(path.join(ROOT, 'Maturacao/demandas/parametros.csv'), 'utf8').includes(`"${key}"`), 'no parametros.csv');
  assert.ok(fs.readFileSync(path.join(ROOT, 'NayaraOne--FRONT/app/painel/configuracoes/governancaApiGroups.js'), 'utf8').includes(`"${key}"`), 'na aba Governança do front');
  const reader = fs.readFileSync(path.join(ROOT, 'NayaraOne--FRONT/lib/asyncState/freshness.js'), 'utf8');
  assert.ok(reader.includes(key) && /getSetting\(FRESH_SETTING_KEY\)/.test(reader), 'o Front lê o parâmetro por GET /settings/:key');
  assert.ok(fs.readFileSync(path.join(ROOT, 'NayaraOne--FRONT/lib/asyncState/controller.js'), 'utf8').includes('getFreshSeconds'), 'e o usa para marcar "desatualizado"');
});
