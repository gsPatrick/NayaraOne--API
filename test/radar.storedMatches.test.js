'use strict';

/**
 * Marco 3 §13 ("Match guarda score, critérios atendidos/falhos e rule/version quando aplicável"), Guia §9 ("Salvar radar_match
 * com criteria_version/fingerprint para idempotência") e §17 (evento mínimo crm.radar.match.created): crm.radar_matches.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const radarService = require('../src/features/radar/radar.service');
const { processRadar } = require('../src/engines/jobs/radarMatchingJob');
const { criteriaFingerprint } = require('../src/features/radar/radarCriteria');
const { RadarMatch, OutboxEvent } = require('../src/models');
require('../src/features/radar/radarEventConsumers'); // CRMX-007: o matching da oferta roda no despacho do evento
const { despacharNaTransacao } = require('./helpers/outboxEmTransacao');

let tenant;
let otherCompanyId;
before(async () => {
  tenant = await getSeedTenant();
  otherCompanyId = (await outraEmpresa()).companyId;
});
after(async () => { await sequelize.close(); });

// Empresa de OUTRO grupo (core.groups não tem RLS; core.companies só aparece com o grupo no contexto).
async function outraEmpresa() {
  const [groups] = await sequelize.query('SELECT id FROM core.groups WHERE id != :g ORDER BY created_at LIMIT 5', { replacements: { g: tenant.groupId } });
  for (const g of groups) {
    const companyId = await sequelize.transaction(async (t) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: g.id }, transaction: t });
      const [[c]] = await sequelize.query('SELECT id FROM core.companies LIMIT 1', { transaction: t });
      return c && c.id;
    });
    if (companyId) return { groupId: g.id, companyId };
  }
  throw new Error('Nenhuma outra empresa no banco: rode o seed-ci-two-tenants.');
}

async function cenario(t, criteria) {
  const suffix = uniqueSuffix();
  const city = `RadarGrava${suffix}`;
  const person = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Radar Grava ${suffix}` }, tenant.userId, t);
  const property = await propertiesService.createProperty({ groupId: tenant.groupId, companyId: tenant.companyId, title: `Grava ${suffix}`, internalCode: `RG-${suffix}`, propertyType: 'RESIDENTIAL', city, bedrooms: 3 }, tenant.userId, t);
  // Radar criado ANTES da oferta: o evento da oferta, no despacho, grava; o job depois só reprocessa.
  const { radar } = await radarService.createRadar({ groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, criteriaJson: { offerType: 'SALE', city, ...criteria } }, tenant.userId, t);
  return { radar, property, city };
}

/** Oferta ACTIVE + despacho do evento dela (property.offer.created): é o consumidor do Radar que grava o match. */
async function ofertaDespachada(t, property) {
  await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 300000 }, tenant.userId, t);
  await despacharNaTransacao(tenant, t, { eventType: 'property.offer.created', payloadJson: { propertyId: property.id } });
}

const eventos = (t, ids) => OutboxEvent.findAll({ where: { eventType: 'crm.radar.match.created', aggregateType: 'RadarMatch', aggregateId: ids }, transaction: t });

test('radar_matches: oferta ativa grava o match (score, critérios, fingerprint, versão) e publica crm.radar.match.created; o job 2x não duplica', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { radar, property } = await cenario(t, { preferences: [{ code: 'MIN_BEDROOMS', value: 4 }] });
    await ofertaDespachada(t, property);
    let rows = await RadarMatch.findAll({ where: { radarId: radar.id }, transaction: t });
    assert.equal(rows.length, 1, 'o despacho do evento da oferta grava o match');
    const [m] = rows;
    assert.equal(m.propertyId, property.id);
    assert.equal(Number(m.score), 0);
    assert.equal(m.criteriaFingerprint, criteriaFingerprint(radar.criteriaJson));
    assert.equal(m.criteriaVersion, 'radar-scoring-v2');
    assert.ok(m.matchedCriteria.includes('city'));
    assert.deepEqual(m.failedCriteria.map((f) => f.criterion), ['preference:MIN_BEDROOMS']);
    assert.equal(m.explanation.matched, true);

    const r1 = await processRadar(radar, t);
    const r2 = await processRadar(radar, t);
    assert.equal(r1.storedMatches, 0);
    assert.equal(r2.storedMatches, 0);
    rows = await RadarMatch.findAll({ where: { radarId: radar.id }, transaction: t });
    assert.equal(rows.length, 1, 'reprocessar não duplica o match gravado');
    const evs = await eventos(t, rows.map((r) => r.id));
    assert.equal(evs.length, 1, 'um único crm.radar.match.created');
    assert.equal(evs[0].payloadJson.radarId, radar.id);
    assert.equal(evs[0].payloadJson.propertyId, property.id);
    assert.equal(evs[0].idempotencyKey, `crm.radar.match.created:${m.id}`);
  });
});

test('radar_matches: mudar o critério gera novo registro com novo fingerprint e novo evento; o anterior fica no histórico', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { radar, property, city } = await cenario(t, {});
    await ofertaDespachada(t, property);
    const { radar: editado } = await radarService.updateRadar(radar.id, { criteriaJson: { offerType: 'SALE', city, preferences: [{ code: 'MIN_BEDROOMS', value: 3 }] } }, tenant.userId, t);
    const run = await processRadar(editado, t);
    assert.equal(run.storedMatches, 1);
    const rows = await radarService.getStoredRadarMatches(radar.id, t);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].criteriaFingerprint, rows[1].criteriaFingerprint);
    assert.equal(Number(rows[0].score), 1, 'o mais recente vem primeiro, com a preferência atendida');
    assert.equal((await eventos(t, rows.map((r) => r.id))).length, 2);
    assert.equal((await processRadar(editado, t)).storedMatches, 0);
  });
});

test('radar_matches: histórico imutável (UPDATE recusado pelo gatilho e DELETE sem permissão para o runtime)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { radar, property } = await cenario(t, {});
    await ofertaDespachada(t, property);
    const [m] = await RadarMatch.findAll({ where: { radarId: radar.id }, transaction: t });
    await sequelize.query('SAVEPOINT sp_upd', { transaction: t });
    await assert.rejects(sequelize.query('UPDATE crm.radar_matches SET score = 0.5 WHERE id = :id', { replacements: { id: m.id }, transaction: t }), /histórico imutável/);
    await sequelize.query('ROLLBACK TO SAVEPOINT sp_upd', { transaction: t });
    await assert.rejects(sequelize.query('DELETE FROM crm.radar_matches WHERE id = :id', { replacements: { id: m.id }, transaction: t }), /permission denied/);
    await sequelize.query('ROLLBACK TO SAVEPOINT sp_upd', { transaction: t });
    assert.equal(await RadarMatch.count({ where: { radarId: radar.id }, transaction: t }), 1);
  });
});

test('radar_matches: RLS — outra empresa não lê nem grava match da empresa A', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { radar, property } = await cenario(t, {});
    await ofertaDespachada(t, property);
    assert.equal(await RadarMatch.count({ where: { radarId: radar.id }, transaction: t }), 1);
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: otherCompanyId }, transaction: t });
    const [visto] = await sequelize.query('SELECT id FROM crm.radar_matches WHERE radar_id = :r', { replacements: { r: radar.id }, transaction: t });
    assert.equal(visto.length, 0, 'empresa B não enxerga o match da A');
    await sequelize.query('SAVEPOINT sp_rls', { transaction: t });
    await assert.rejects(sequelize.query(
      `INSERT INTO crm.radar_matches (group_id, company_id, radar_id, property_id, score, explanation, criteria_fingerprint, criteria_version)
       VALUES (:g, :c, :r, :p, 1, '{}'::jsonb, 'x', 'radar-scoring-v2')`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, r: radar.id, p: property.id }, transaction: t }
    ), /row-level security|violates/i);
    await sequelize.query('ROLLBACK TO SAVEPOINT sp_rls', { transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
  });
});
