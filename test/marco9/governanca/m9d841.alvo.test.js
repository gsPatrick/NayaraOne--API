'use strict';

// M9-D841 — alvo, datas e parâmetros (sem banco): formato ROUTE/MAJOR, casador de caminho, dias até o desligamento e parâmetros declarados e lidos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseTarget, pathMatcher, splitVersioned, routeKeyOfRoutedRequest } = require('../../../src/features/core-governance/api-governance/consumers/target');
const { daysToSunset, parseMoment } = require('../../../src/features/core-governance/api-governance/consumers/days');
const S = require('../../../src/features/core-governance/api-governance/consumers/consumers.settings');
const { GOVERNANCE_SETTINGS_SCHEMA, GOVERNANCE_SETTING_DEFAULTS } = require('../../../src/features/core-governance/governance.settings');

test('m9d841 alvo ROUTE e MAJOR são normalizados', () => {
  assert.deepEqual(parseTarget('ROUTE:get /people/:id'), { kind: 'ROUTE', key: 'ROUTE:GET /people/{id}', method: 'GET', path: '/people/{id}' });
  assert.equal(parseTarget('ROUTE:GET /api/v1/people/{id}/').key, 'ROUTE:GET /people/{id}', 'prefixo /api/v1 e barra final saem');
  assert.equal(parseTarget('MAJOR:1').key, 'MAJOR:1');
  for (const bad of ['MAJOR:0', 'MAJOR:x', 'ROUTE:FETCH /x', 'ROUTE:GET people', 'GET /x', '', null, 7]) assert.equal(parseTarget(bad), null, String(bad));
});

test('m9d841 caminho com parâmetro casa só o segmento', () => {
  const re = pathMatcher('/people/{id}');
  assert.ok(re.test('/people/abc-123') && re.test('/People/9/'));
  assert.ok(!re.test('/people') && !re.test('/people/1/contracts'));
  assert.deepEqual(splitVersioned('/v1/people/9'), { major: 1, path: '/people/9' });
  assert.equal(splitVersioned('/health'), null);
  assert.equal(routeKeyOfRoutedRequest({ method: 'HEAD', baseUrl: '/api/v1/people', route: { path: '/:id' } }), 'ROUTE:GET /people/{id}', 'o padrão do Express sai como {id}; HEAD conta como GET');
  assert.equal(routeKeyOfRoutedRequest({ method: 'GET', baseUrl: '', route: { path: /x/ } }), null, 'rota por expressão regular não é rastreada');
});

test('m9d841 dias até o desligamento contam o calendário de Brasília', () => {
  const now = new Date('2026-10-20T15:00:00Z');
  assert.equal(daysToSunset(new Date('2026-11-19T23:59:59-03:00'), now), 30);
  assert.equal(daysToSunset(new Date('2026-10-20T23:59:59-03:00'), now), 0);
  assert.equal(daysToSunset(new Date('2026-10-01T00:00:00Z'), now), 0, 'já passou: 0');
  assert.equal(parseMoment('2026-10-27').toISOString(), '2026-10-27T03:00:00.000Z', 'anúncio só com data = início do dia');
  assert.equal(parseMoment('2026-10-20', { endOfDay: true }).toISOString(), '2026-10-21T02:59:59.000Z', 'desligamento só com data = fim do dia');
  for (const bad of ['', 'amanhã', '2026-13-40', '27/10/2026', null]) assert.equal(parseMoment(bad), null, String(bad));
});

test('m9d841 parâmetros declarados têm padrão, validação, catálogo e quem os leia', () => {
  const keys = Object.keys(S.CONSUMERS_SETTING_DEFAULTS);
  assert.equal(keys.length, 6);
  const csv = fs.readFileSync(path.join(__dirname, '../../../../Maturacao/demandas/parametros.csv'), 'utf8');
  const dir = path.join(__dirname, '../../../src/features/core-governance/api-governance/consumers');
  const code = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'consumers.settings.js').map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .concat(fs.readFileSync(path.join(__dirname, '../../../src/engines/jobs/apiDeprecationJob.js'), 'utf8')).join('\n');
  for (const key of keys) {
    assert.ok(GOVERNANCE_SETTINGS_SCHEMA[key], `${key} no dicionário de configurações`);
    assert.equal(GOVERNANCE_SETTING_DEFAULTS[key], S.CONSUMERS_SETTING_DEFAULTS[key]);
    assert.ok(csv.includes(`"${key}"`), `${key} no parametros.csv`);
    const constant = Object.entries(S).find(([, value]) => value === key)[0];
    assert.ok(code.includes(`S.${constant}`), `${key} é lido pelo código (${constant})`);
  }
  assert.equal(S.CONSUMERS_SETTING_DEFAULTS[S.AVISO_DIAS_KEY], 30, 'padrão do livro: 30 dias');
});
