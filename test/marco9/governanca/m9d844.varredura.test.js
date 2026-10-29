'use strict';

// M9-D844 — varredura de rota externa sem scope, catálogo de scopes e tipos de token (sem banco).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Router } = require('express');
const api = require('../../../src/features/core-governance/api-governance/clients');
const externalRouter = require('../../../src/features/core-governance/api-governance/clients/external.routes');
const { signClientToken, verifyAnyToken, scopesOf } = require('../../../src/features/core-governance/api-governance/clients/token');
const { verifyAccessToken, signAccessToken } = require('../../../src/utils/jwt');

test('m9d844 rota externa sem scope declarado reprova na varredura', () => {
  const router = Router();
  router.get('/api-external/com-scope', api.requireScope('properties:read'), (_req, res) => res.end());
  router.post('/api-external/oauth/token', (_req, res) => res.end());
  assert.deepEqual(api.routesWithoutScope(router), [], 'rota com scope e a emissão do token passam');
  router.get('/api-external/esquecida', (_req, res) => res.end());
  router.delete('/api-external/outra', (_req, res) => res.end());
  assert.deepEqual(api.routesWithoutScope(router).sort(), ['DELETE /api-external/outra', 'GET /api-external/esquecida']);
  assert.throws(() => api.assertAllRoutesDeclareScope(router), (err) => err.code === 'GOV_EXTERNAL_ROUTE_WITHOUT_SCOPE' && err.details.routes.length === 2);
});

test('m9d844 todas as rotas externas reais declaram um scope do catálogo inicial', () => {
  assert.deepEqual(api.routesWithoutScope(externalRouter), []);
  const routes = api.describeRoutes(externalRouter);
  const scopes = Object.fromEntries(routes.filter((r) => r.scope).map((r) => [r.key, r.scope]));
  assert.deepEqual(scopes, { 'GET /api-external/properties': 'properties:read', 'GET /api-external/contracts': 'contracts:read', 'POST /api-external/leads': 'leads:write' });
  assert.ok(routes.some((r) => r.key === 'POST /api-external/oauth/token' && !r.scope), 'a emissão do token é a única sem scope');
});

test('m9d844 migration do catálogo semeia os três scopes e o runtime só lê', () => {
  const text = fs.readFileSync(path.join(__dirname, '../../../migrations/20260101000845-create-governance-api-scopes.js'), 'utf8');
  for (const scope of ['properties:read', 'leads:write', 'contracts:read']) assert.ok(text.includes(`'${scope}'`), scope);
  assert.match(text, /GRANT SELECT ON governance\.api_scopes TO nayara_runtime/);
  assert.doesNotMatch(text, /GRANT [A-Z, ]*(INSERT|UPDATE|DELETE)/);
  assert.match(text, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime'\)/);
});

test('m9d844 token de cliente é um JWT typ=client sem usuário, lido por scope separado por espaço', () => {
  const token = signClientToken({ clientId: 'nyc_x', groupId: 'g', companyId: 'c', scopes: ['properties:read', 'leads:write'] }, 900);
  const claims = verifyAnyToken(token);
  assert.deepEqual([claims.typ, claims.client_id, claims.sub, claims.scope], ['client', 'nyc_x', undefined, 'properties:read leads:write']);
  assert.equal(claims.exp - claims.iat, 900);
  assert.deepEqual(scopesOf('a:b   c:d '), ['a:b', 'c:d']);
  assert.deepEqual(scopesOf(undefined), []);
  const user = signAccessToken({ sub: 'u', group_id: 'g', company_id: 'c' });
  assert.equal(verifyAccessToken(user).typ, undefined, 'token de usuário não leva typ=client');
});

test('m9d844 parâmetros declarados têm padrão, validação, catálogo, aba no front e quem os leia', () => {
  const S = require('../../../src/features/core-governance/api-governance/clients/clients.settings');
  const { GOVERNANCE_SETTINGS_SCHEMA, GOVERNANCE_SETTING_DEFAULTS } = require('../../../src/features/core-governance/governance.settings');
  const keys = Object.keys(S.CLIENTS_SETTING_DEFAULTS);
  assert.equal(keys.length, 3);
  const root = path.join(__dirname, '../../../..');
  const csv = fs.readFileSync(path.join(root, 'Maturacao/demandas/parametros.csv'), 'utf8');
  const front = fs.readFileSync(path.join(root, 'NayaraOne--FRONT/app/painel/configuracoes/governancaApiGroups.js'), 'utf8');
  const dir = path.join(__dirname, '../../../src/features/core-governance/api-governance/clients');
  const code = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'clients.settings.js').map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  for (const key of keys) {
    assert.ok(GOVERNANCE_SETTINGS_SCHEMA[key], `${key} no dicionário de configurações`);
    assert.equal(GOVERNANCE_SETTING_DEFAULTS[key], S.CLIENTS_SETTING_DEFAULTS[key]);
    assert.ok(csv.includes(`"${key}"`), `${key} no parametros.csv`);
    assert.ok(front.includes(`"${key}"`), `${key} na aba Governança do front`);
    const constant = Object.entries(S).find(([, value]) => value === key)[0];
    assert.ok(code.includes(`S.${constant}`), `${key} é lido pelo código (${constant})`);
  }
  assert.equal(S.CLIENTS_SETTING_DEFAULTS[S.TOKEN_TTL_KEY], 900, 'padrão do livro: 900 s');
});
