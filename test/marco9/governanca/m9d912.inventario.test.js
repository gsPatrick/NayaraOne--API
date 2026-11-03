'use strict';

// M9-D912 — nenhum caminho de código apaga ou anonimiza registro em hold: o inventário fechado (docs/governance/legal-hold-disposal.json) bate com as rotas DELETE reais
// e com o código; a ação de liberar é a linha 11 da M9-D852; os parâmetros declarados são lidos por código. Carrega as rotas (sem abrir conexão); banco descartável por segurança.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE } = require('../../m9d801.helpers');
const { testeComIrmaos } = require('../../helpers/repoIrmao');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'segredo-de-teste-m9d912';
const skip = DISPOSABLE ? false : SKIP_DISPOSABLE;
const ROOT = path.join(__dirname, '../../..');
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/governance/legal-hold-disposal.json'), 'utf8'));
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('m9d912 toda rota DELETE da API está no inventário: guardada pela trava jurídica ou isenta com motivo', { skip }, () => {
  const { allRoutes } = require('../_helpers/m9d852Rotas');
  const real = allRoutes().filter((r) => r.methods.includes('DELETE')).map((r) => `DELETE ${r.path}`).sort();
  assert.ok(real.length >= 20, 'a varredura enxerga as rotas (não é um passe vazio)');
  assert.deepEqual(inventory.rotas.map((r) => r.route).sort(), real, 'rota DELETE nova ou removida: classifique no inventário (guardada ou isenta com motivo)');
  for (const entry of inventory.rotas) {
    if (entry.guard === 'exempt') assert.ok(entry.reason && entry.reason.length > 20, `${entry.route}: isenção sem motivo`);
  }
});

test('m9d912 cada entrada guardada chama a trava no arquivo do serviço e os caminhos que não são rota também', { skip }, () => {
  for (const entry of inventory.rotas.filter((r) => r.guard === 'guarded')) assert.ok(source(entry.file).includes(entry.call), `${entry.route}: ${entry.file} não chama ${entry.call}`);
  for (const entry of inventory.caminhos) assert.ok(source(entry.file).includes(entry.call), `${entry.path}: ${entry.file} não chama ${entry.call}`);
  // a trava não tem exceção por papel nem parâmetro que a desligue: o código do guarda não lê configuração nem papel
  const guard = source('src/features/core-governance/data-quality/legalHold.guard.js');
  assert.equal(/getSetting|roles|isAdmin|permission/i.test(guard), false, 'o guarda não consulta parâmetro, papel nem permissão');
});

test('m9d912 não existe rota de exclusão de arquivo e o inventário da M9-D852 registra a linha 5 sem rota; a liberação (linha 11) está ligada ao guarda e ao MFA', { skip }, () => {
  const { allRoutes, find } = require('../_helpers/m9d852Rotas');
  const D = require('../../../src/shared/destructive-actions');
  const routes = allRoutes();
  assert.equal(routes.filter((r) => r.methods.includes('DELETE') && /\/files?\b/.test(r.path)).length, 0, 'nenhuma rota DELETE de arquivo');
  assert.equal(D.inventory.get('file.delete').wired, false);
  const release = D.inventory.get('legal_hold.release');
  assert.deepEqual([release.wired, release.level, release.mfa, release.permission, release.route], [true, 3, 'sim', 'governance:legal-hold:manage', '/legal-holds/:id/release']);
  assert.ok(find(routes, 'POST', '/legal-holds/:id/release').some((r) => r.guards.includes('legal_hold.release') && r.mfa));
  assert.ok(find(routes, 'GET', '/legal-holds/:id/impact').some((r) => r.impacts.includes('legal_hold.release')));
  assert.ok(D.registry.registeredKeys().includes('legal_hold.release'));
});

testeComIrmaos(['Maturacao/demandas/parametros.csv'])('m9d912 os parâmetros da retenção legal estão no esquema, no catálogo e são lidos pelo código', () => {
  const settings = require('../../../src/features/core-governance/data-quality/legalHold.settings');
  const { DATA_QUALITY_SETTING_DEFAULTS, DATA_QUALITY_SETTINGS_SCHEMA } = require('../../../src/features/core-governance/data-quality/data-quality.settings');
  const csv = fs.readFileSync(path.join(ROOT, '../Maturacao/demandas/parametros.csv'), 'utf8');
  const service = source('src/features/core-governance/data-quality/legalHold.service.js');
  for (const key of Object.values(settings.KEYS)) {
    assert.ok(DATA_QUALITY_SETTINGS_SCHEMA[key], `${key} no esquema`);
    assert.equal(DATA_QUALITY_SETTING_DEFAULTS[key], settings.LEGAL_HOLD_SETTING_DEFAULTS[key]);
    assert.ok(csv.includes(`"${key}"`), `${key} no catálogo de parâmetros`);
  }
  assert.ok(service.includes('settings.KEYS.PAGINA') && service.includes('settings.KEYS.ESCOPO_MAX'), 'o serviço lê os dois parâmetros');
});
