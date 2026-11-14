'use strict';

/**
 * Radar do livro (Marco 3 §13 / Guia §9 / §17) por HTTP real contra o app (JWT + tenant + rotas reais): POST /radar com
 * obrigatórios, preferências ponderadas e exclusões; GET /radar/:id/matches ordenado por score com a explicação;
 * GET /radar/:id/matches/:propertyId/explain do excluído; GET /radar/:id/match-history (matches gravados); recusa de
 * critério inválido; isolamento entre empresas. Grava de verdade: rodar só em banco descartável (scripts/withDisposableDb.js).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.RADAR_HTTP_TEST_PORT || '21647';

require('../app');
const { getSeedTenant, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { dispatchPendingEventsForCompany } = require('../src/engines/events/outbox-dispatcher');

const PERMS = ['people:create', 'people:read', 'properties:create', 'properties:read', 'properties:update', 'radar:create', 'radar:read', 'radar:update'];
let tenant;
let baseUrl;
let token;
let tokenOutra;

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions: PERMS });
  // Empresa de OUTRO grupo (core.groups não tem RLS; core.companies só aparece com o grupo no contexto).
  const [groups] = await sequelize.query('SELECT id FROM core.groups WHERE id != :g ORDER BY created_at LIMIT 5', { replacements: { g: tenant.groupId } });
  let outra = null;
  for (const g of groups) {
    const c = await sequelize.transaction(async (t) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: g.id }, transaction: t });
      const [[row]] = await sequelize.query('SELECT id FROM core.companies LIMIT 1', { transaction: t });
      return row;
    });
    if (c) { outra = { groupId: g.id, companyId: c.id }; break; }
  }
  assert.ok(outra, 'precisa de outra empresa (seed-ci-two-tenants)');
  tokenOutra = signAccessToken({ sub: tenant.userId, group_id: outra.groupId, company_id: outra.companyId, roles: ['admin'], permissions: PERMS });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, path, body, tk = token) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('ROTA Radar livro: obrigatórios + preferências ponderadas + exclusão, matches ordenados por score, explicação, histórico gravado e isolamento', async () => {
  const suffix = uniqueSuffix();
  const city = `RadarHttp${suffix}`;
  const p = await http('POST', '/people', { personType: 'PF', legalName: `Cliente Radar HTTP ${suffix}`, allowDuplicate: true });
  assert.equal(p.status, 201, JSON.stringify(p.body));

  const criteriaJson = {
    offerType: 'SALE', city, maxPrice: 600000,
    preferences: [{ code: 'MIN_BEDROOMS', value: 3, weight: 2 }, { code: 'NEIGHBORHOOD', value: 'Cambuí', weight: 1 }],
    exclusions: [{ code: 'ATTRIBUTE', key: 'escada', value: 'sim' }],
  };
  const invalido = await http('POST', '/radar', { personId: p.body.data.id, criteriaJson: { city, preferences: [{ code: 'PISCINA', value: true }] } });
  assert.equal(invalido.status, 422);
  assert.equal(invalido.body.error.code, 'RADAR_CRITERIA_INVALID');

  const radar = await http('POST', '/radar', { personId: p.body.data.id, criteriaJson });
  assert.equal(radar.status, 201, JSON.stringify(radar.body));
  const radarId = radar.body.data.id;

  const imovel = async (code, extra, neighborhood) => {
    const r = await http('POST', '/properties', { title: `Radar HTTP ${code} ${suffix}`, internalCode: `RH-${code}-${suffix}`, propertyType: 'RESIDENTIAL', city, address: { zipCode: '13025000', street: `Rua ${code} ${suffix}`, number: '1', neighborhood, city, state: 'SP' }, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = await http('POST', `/properties/${r.body.data.id}/offers`, { offerType: 'SALE', askingPrice: 500000 });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    return r.body.data.id;
  };
  const medio = await imovel('M', { bedrooms: 3 }, 'Centro');
  const forte = await imovel('F', { bedrooms: 4 }, 'Cambuí');
  const excluido = await imovel('X', { bedrooms: 4, attributesJson: { escada: 'sim' } }, 'Cambuí');

  const matches = await http('GET', `/radar/${radarId}/matches`);
  assert.equal(matches.status, 200);
  assert.deepEqual(matches.body.data.map((m) => m.id), [forte, medio]);
  assert.deepEqual(matches.body.data.map((m) => m.radarMatch.score), [1, 0.6667]);
  assert.equal(matches.body.data[1].radarMatch.criteria['preference:NEIGHBORHOOD'].matched, false);

  const exp = await http('GET', `/radar/${radarId}/matches/${excluido}/explain`);
  assert.equal(exp.status, 200);
  assert.equal(exp.body.data.matched, false);
  assert.deepEqual(exp.body.data.reasons, ['EXCLUDED']);

  // CRMX-007: o match é gravado no despacho do outbox (consumidor do Radar), o mesmo que o job do despachante roda a cada 30 s.
  await dispatchPendingEventsForCompany({ id: tenant.groupId }, { id: tenant.companyId }, { limit: 1000 });
  const hist = await http('GET', `/radar/${radarId}/match-history`);
  assert.equal(hist.status, 200, JSON.stringify(hist.body));
  assert.deepEqual(hist.body.data.map((h) => h.propertyId).sort(), [forte, medio].sort(), 'o despacho dos eventos das ofertas gravou os dois matches; o excluído não');
  for (const h of hist.body.data) {
    assert.equal(h.criteriaVersion, 'radar-scoring-v2');
    assert.match(h.criteriaFingerprint, /^[0-9a-f]{64}$/);
  }

  const outra = await http('GET', `/radar/${radarId}/match-history`, undefined, tokenOutra);
  assert.equal(outra.status, 404);
  assert.equal(outra.body.error.code, 'RADAR_NOT_FOUND');
});
