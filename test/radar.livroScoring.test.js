'use strict';

/**
 * Marco 3 §13 (Radar: "Obrigatório / Preferência / Flexível / Exclusão"; "Match guarda score, critérios atendidos/falhos") e
 * Guia §9 ("Radar scoring": obrigatório que falha -> score 0 e REQUIRED_FAILED; preferência atendida soma o peso; score
 * normalizado). Funções puras + matching real no banco (transação com rollback).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const radarService = require('../src/features/radar/radar.service');
const { explainMatch } = require('../src/features/radar/radarMatching.service');
const { criteriaFingerprint } = require('../src/features/radar/radarCriteria');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const activeSale = (price) => [{ status: 'ACTIVE', offerType: 'SALE', askingPrice: price }];
const imovel = (extra = {}) => ({ id: 'p1', propertyType: 'RESIDENTIAL', city: 'Campinas', bedrooms: 3, parkingSpots: 2, attributesJson: { suites: 1, acabamento: 'alto padrão', escada: 'sim' }, latitude: -22.9056, longitude: -47.0608, address: { neighborhood: 'Cambuí' }, offers: activeSale(500000), ...extra });

test('Radar livro: obrigatório que falha tira o imóvel (matched=false, score 0, REQUIRED_FAILED), mesmo com preferências atendidas', () => {
  const radar = { criteriaJson: { offerType: 'SALE', city: 'Campinas', maxPrice: 400000, preferences: [{ code: 'MIN_BEDROOMS', value: 2 }] } };
  const e = explainMatch(radar, imovel());
  assert.equal(e.matched, false);
  assert.equal(e.score, 0);
  assert.deepEqual(e.reasons, ['REQUIRED_FAILED']);
  assert.equal(e.criteria.priceRange.category, 'REQUIRED');
  assert.equal(e.criteria.priceRange.matched, false);
  assert.equal(e.criteria['preference:MIN_BEDROOMS'].matched, true);
});

test('Radar livro: exclusão que bate tira o imóvel com o motivo (tipo e atributo)', () => {
  const porTipo = explainMatch({ criteriaJson: { city: 'Campinas', exclusions: [{ code: 'PROPERTY_TYPE', value: 'residential' }] } }, imovel());
  assert.equal(porTipo.matched, false);
  assert.equal(porTipo.score, 0);
  assert.deepEqual(porTipo.reasons, ['EXCLUDED']);
  assert.match(porTipo.criteria['exclusion:PROPERTY_TYPE:RESIDENTIAL'].reason, /não aceita imóvel do tipo "RESIDENTIAL"/);
  const porAtributo = explainMatch({ criteriaJson: { city: 'Campinas', exclusions: [{ code: 'ATTRIBUTE', key: 'escada', value: 'SIM' }] } }, imovel());
  assert.equal(porAtributo.matched, false);
  assert.equal(porAtributo.criteria['exclusion:ATTRIBUTE:escada'].category, 'EXCLUSION');
  const naoAplica = explainMatch({ criteriaJson: { city: 'Campinas', exclusions: [{ code: 'PROPERTY_TYPE', value: 'LAND' }] } }, imovel());
  assert.equal(naoAplica.matched, true);
  assert.equal(naoAplica.criteria['exclusion:PROPERTY_TYPE:LAND'].matched, true);
});

test('Radar livro: preferências ponderadas somam o peso atendido sobre o total (bairro, quartos, suítes, vagas)', () => {
  const radar = { criteriaJson: { city: 'Campinas', preferences: [
    { code: 'MIN_BEDROOMS', value: 3, weight: 2 },
    { code: 'NEIGHBORHOOD', value: 'Taquaral', weight: 1 },
    { code: 'MIN_SUITES', value: 1, weight: 1 },
    { code: 'MIN_PARKING', value: 3 },
  ] } };
  const e = explainMatch(radar, imovel());
  assert.equal(e.matched, true);
  assert.equal(e.score, 0.6); // (2 + 1) / (2 + 1 + 1 + 1)
  assert.deepEqual(e.reasons, ['MIN_BEDROOMS', 'MIN_SUITES']);
  assert.match(e.criteria['preference:NEIGHBORHOOD'].reason, /Bairro é "Cambuí"/);
  assert.match(e.criteria['preference:MIN_PARKING'].reason, /vagas de garagem: 2/i);
  assert.equal(e.requiredScore, 1);
  // Bairro compara sem acento e sem caixa
  assert.equal(explainMatch({ criteriaJson: { preferences: [{ code: 'NEIGHBORHOOD', value: 'cambui' }] } }, imovel()).criteria['preference:NEIGHBORHOOD'].matched, true);
});

test('Radar livro: critérios flexíveis por atributo (acabamento) e por distância (km, haversine)', () => {
  const radar = { criteriaJson: { flexible: [
    { code: 'ATTRIBUTE', key: 'acabamento', value: 'Alto Padrão', weight: 1 },
    { code: 'MAX_DISTANCE_KM', lat: -22.9099, lng: -47.0626, value: 2, weight: 1 },
  ] } };
  const perto = explainMatch(radar, imovel());
  assert.equal(perto.score, 1);
  assert.ok(perto.criteria['flexible:MAX_DISTANCE_KM'].distanceKm < 2);
  const longe = explainMatch(radar, imovel({ latitude: -23.5505, longitude: -46.6333, attributesJson: { acabamento: 'simples' } }));
  assert.equal(longe.matched, true, 'flexível não elimina: só pontua');
  assert.equal(longe.score, 0);
  assert.match(longe.criteria['flexible:MAX_DISTANCE_KM'].reason, /aceita até 2 km/);
  const semCoord = explainMatch(radar, imovel({ latitude: null }));
  assert.match(semCoord.criteria['flexible:MAX_DISTANCE_KM'].reason, /sem coordenadas/);
});

test('Radar livro: critérios planos de sempre continuam obrigatórios e mesclam com required; fingerprint estável', () => {
  const a = explainMatch({ criteriaJson: { city: 'Campinas', required: { offerType: 'SALE' } } }, imovel());
  assert.equal(a.criteria.city.category, 'REQUIRED');
  assert.equal(a.criteria.offerType.category, 'REQUIRED');
  assert.equal(a.score, 1);
  assert.equal(criteriaFingerprint({ city: 'X', maxPrice: 1 }), criteriaFingerprint({ maxPrice: 1, city: 'X' }));
  assert.equal(criteriaFingerprint({ city: 'X' }), criteriaFingerprint({ required: { city: 'X' } }));
  assert.notEqual(criteriaFingerprint({ city: 'X' }), criteriaFingerprint({ city: 'X', preferences: [{ code: 'MIN_BEDROOMS', value: 2 }] }));
});

test('Radar livro: validação do payload na criação e na edição (código fora da lista, peso inválido, value ausente)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Radar Valida ${uniqueSuffix()}` }, tenant.userId, t);
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id };
    const recusa = (criteriaJson, campo) => assert.rejects(radarService.createRadar({ ...base, criteriaJson }, tenant.userId, t), (err) => {
      assert.equal(err.code, 'RADAR_CRITERIA_INVALID');
      assert.equal(err.statusCode, 422);
      assert.equal(err.details.field, campo);
      return true;
    });
    await recusa({ city: 'X', preferences: [{ code: 'PISCINA', value: true }] }, 'preferences[0].code');
    await recusa({ city: 'X', preferences: [{ code: 'MIN_BEDROOMS', value: 2, weight: -1 }] }, 'preferences[0].weight');
    await recusa({ city: 'X', preferences: [{ code: 'MIN_BEDROOMS', value: 2, weight: 'muito' }] }, 'preferences[0].weight');
    await recusa({ city: 'X', preferences: [{ code: 'NEIGHBORHOOD' }] }, 'preferences[0].value');
    await recusa({ city: 'X', flexible: [{ code: 'MAX_DISTANCE_KM', value: 3, lat: 'a', lng: 1 }] }, 'flexible[0].lat');
    await recusa({ city: 'X', flexible: [{ code: 'ATTRIBUTE', value: 'x' }] }, 'flexible[0].key');
    await recusa({ city: 'X', exclusions: [{ code: 'MIN_BEDROOMS', value: 1 }] }, 'exclusions[0].code');
    await recusa({ city: 'X', preferences: 'bairro bom' }, 'preferences');
    const { radar } = await radarService.createRadar({ ...base, criteriaJson: { city: 'X', preferences: [{ code: 'MIN_BEDROOMS', value: 2 }] } }, tenant.userId, t);
    await assert.rejects(radarService.updateRadar(radar.id, { criteriaJson: { city: 'X', exclusions: [{ code: 'PROPERTY_TYPE' }] } }, tenant.userId, t), (err) => err.code === 'RADAR_CRITERIA_INVALID');
  });
});

test('Radar livro: GET matches (matching real) tira o excluído e ordena por score desc, cada imóvel com a explicação', async () => {
  const suffix = uniqueSuffix();
  const city = `RadarLivro${suffix}`;
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Radar Livro ${suffix}` }, tenant.userId, t);
    const mk = async (code, extra, neighborhood) => {
      const p = await propertiesService.createProperty({ groupId: tenant.groupId, companyId: tenant.companyId, title: `Livro ${code} ${suffix}`, internalCode: `RL-${code}-${suffix}`, propertyType: 'RESIDENTIAL', city, address: { zipCode: '13025000', street: `Rua ${code} ${suffix}`, number: '10', neighborhood, city, state: 'SP' }, ...extra }, tenant.userId, t);
      await offersService.createOffer(p.id, { offerType: 'SALE', askingPrice: 450000 }, tenant.userId, t);
      return p;
    };
    const fraco = await mk('A', { bedrooms: 1 }, 'Centro');
    const forte = await mk('B', { bedrooms: 3 }, 'Cambuí');
    const medio = await mk('C', { bedrooms: 3 }, 'Centro');
    const excluido = await mk('D', { bedrooms: 4, attributesJson: { escada: 'sim' } }, 'Cambuí');
    const { radar } = await radarService.createRadar({ groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, criteriaJson: {
      offerType: 'SALE', city, maxPrice: 500000,
      preferences: [{ code: 'MIN_BEDROOMS', value: 3, weight: 2 }, { code: 'NEIGHBORHOOD', value: 'Cambuí', weight: 1 }],
      exclusions: [{ code: 'ATTRIBUTE', key: 'escada', value: 'sim' }],
    } }, tenant.userId, t);
    const matches = await radarService.getRadarMatches(radar.id, t);
    assert.deepEqual(matches.map((m) => m.id), [forte.id, medio.id, fraco.id]);
    assert.ok(!matches.some((m) => m.id === excluido.id));
    const json = matches.map((m) => m.toJSON());
    assert.deepEqual(json.map((m) => m.radarMatch.score), [1, 0.6667, 0]);
    assert.equal(json[2].radarMatch.matched, true, 'sem preferência atendida ainda é match (obrigatórios ok)');
    const exp = await radarService.explainRadarMatch(radar.id, excluido.id, t);
    assert.equal(exp.matched, false);
    assert.deepEqual(exp.reasons, ['EXCLUDED']);
  });
});
