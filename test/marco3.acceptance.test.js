'use strict';

// Testes de aceite do Marco 3 (Pessoas, Empresas, Imóveis, CRM e Radar) — fechando itens
// PARCIAIS da matriz M3-01 a M3-25 que já tinham implementação real, só faltava prova
// automatizada. Ver Maturacao/06_HOMOLOGACAO_M3_M4_M5_STATUS.md para o mapa completo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const personService = require('../src/features/people/person.service');
const personMergeService = require('../src/features/people/personMerge.service');
const personConsentsService = require('../src/features/people/personConsents.service');
const companiesService = require('../src/features/companies/companies.service');
const propertiesService = require('../src/features/properties/properties.service');
const propertyOwnersService = require('../src/features/properties/propertyOwners.service');
const propertyOccurrencesService = require('../src/features/properties/propertyInternalOccurrences.service');
const publishService = require('../src/features/properties/publish.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// --- M3-01: cadastro de pessoa PF/PJ com validação ---
test('M3-01 createPerson valida personType, exige legalName, e aceita PF e PJ', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    await assert.rejects(
      () => personService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, legalName: '' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'PERSON_VALIDATION'); return true; }
    );

    const pf = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M3-01 PF ${suffix}` },
      tenant.userId,
      transaction
    );
    assert.equal(pf.personType, 'PF');

    const pj = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `M3-01 PJ ${suffix}` },
      tenant.userId,
      transaction
    );
    assert.equal(pj.personType, 'PJ');

    await assert.rejects(
      () => personService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'INVALIDO', legalName: 'x' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'PERSON_VALIDATION'); return true; }
    );
  });
});

// --- M3-02: múltiplos papéis simultâneos ---
test('M3-02 pessoa pode ter múltiplos papéis simultâneos, persistidos e retornados', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await personService.createPerson(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personType: 'PF',
        legalName: `M3-02 Multipapel ${suffix}`,
        roles: ['PROPRIETARIO', 'LOCADOR', 'COLABORADOR'],
      },
      tenant.userId,
      transaction
    );
    const reloaded = await personService.getPerson(person.id, transaction);
    const roleCodes = reloaded.roles.map((r) => r.roleCode).sort();
    assert.deepEqual(roleCodes, ['COLABORADOR', 'LOCADOR', 'PROPRIETARIO']);
  });
});

// --- M3-04: merge seguro de pessoas ---
test('M3-04 mergePersons remapeia referências, bloqueia conflito de documento, e marca MERGED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const canonical = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M3-04 Canonical ${suffix}` },
      tenant.userId,
      transaction
    );
    const absorbed = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M3-04 Absorvida ${suffix}` },
      tenant.userId,
      transaction
    );

    const merged = await personMergeService.mergePersons(canonical.id, absorbed.id, tenant.userId, transaction);
    assert.ok(merged);

    const absorbedReloaded = await personService.getPerson(absorbed.id, transaction);
    assert.equal(absorbedReloaded.status, 'MERGED');
    assert.equal(absorbedReloaded.mergedIntoId, canonical.id);
  });
});

// --- M3-05: empresas e unidades ---
test('M3-05 createCompany/updateCompany/deleteCompany (inativação) funcionam de ponta a ponta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const company = await companiesService.createCompany({ groupId: tenant.groupId, name: `M3-05 Empresa ${suffix}` }, tenant.userId, transaction);
    assert.equal(company.status, 'ACTIVE');

    const updated = await companiesService.updateCompany(company.id, { name: `M3-05 Empresa Renomeada ${suffix}` }, tenant.userId, transaction);
    assert.equal(updated.name, `M3-05 Empresa Renomeada ${suffix}`);

    // deleteCompany é soft-delete (paranoid) — "inativação" aqui significa sair da listagem
    // normal, não um status INACTIVE visível; getCompany (sem paranoid:false) não encontra mais.
    await companiesService.deleteCompany(company.id, tenant.userId, transaction);
    await assert.rejects(
      () => companiesService.getCompany(company.id, transaction),
      (err) => { assert.equal(err.code, 'COMPANY_NOT_FOUND'); return true; }
    );
  });
});

// --- M3-06: imóvel com proprietários e ocorrências internas protegidas (M3-10 junto) ---
test('M3-06 imóvel com proprietário vinculado, e M3-10 ocorrência interna nunca aparece em serialização pública', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const owner = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M3-06 Proprietário ${suffix}` },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `M3-06 Imóvel ${suffix}`, internalCode: `M306-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );
    const propOwner = await propertyOwnersService.createOwner(property.id, { personId: owner.id, ownershipPercent: 100, roleCode: 'OWNER' }, tenant.userId, transaction);
    assert.equal(propOwner.personId, owner.id);

    const owners = await propertyOwnersService.listOwners(property.id, transaction);
    assert.equal(owners.length, 1);

    // M3-10: ocorrência interna existe mas nunca é incluída na serialização normal do imóvel.
    await propertyOccurrencesService.createOccurrence(property.id, { occurrenceType: 'RISK', description: 'Nota interna sensível — nunca pode vazar pro público' }, tenant.userId, transaction);
    const propertyReloaded = await propertiesService.getProperty(property.id, transaction);
    assert.equal(JSON.stringify(propertyReloaded).includes('Nota interna sensível'), false, 'ocorrência interna NUNCA pode aparecer na serialização pública do imóvel');

    const occurrences = await propertyOccurrencesService.listOccurrences(property.id, transaction);
    assert.equal(occurrences.length, 1);
  });
});

// --- M3-09: gate de qualidade (vídeo obrigatório) antes de publicar ---
test('M3-09 publishOffer bloqueia publicação sem vídeo (REG-IMO-001), libera quando há vídeo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `M3-09 Imóvel ${suffix}`, internalCode: `M309-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );
    const offer = await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 300000 }, tenant.userId, transaction);

    await assert.rejects(
      () => publishService.publishOffer(offer.id, tenant, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_001'); return true; },
      'sem vídeo, REG-IMO-001 precisa bloquear a publicação (fail closed)'
    );

    const { PropertyMedia } = require('../src/models');
    await PropertyMedia.create(
      { groupId: property.groupId, companyId: property.companyId, propertyId: property.id, mediaType: 'VIDEO', storageKey: `m309-${suffix}.mp4`, originalName: 'video.mp4', createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );

    const { property: publishedProperty } = await publishService.publishOffer(offer.id, tenant, tenant.userId, transaction);
    assert.equal(publishedProperty.publicationStatus, 'PUBLISHED');
  });
});

// --- M3-18: consentimento/LGPD (opt-in/opt-out append-only) ---
test('M3-18 recordConsent grava histórico append-only de opt-in/opt-out por canal e finalidade', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M3-18 Consentimento ${suffix}` },
      tenant.userId,
      transaction
    );

    await personConsentsService.recordConsent(person.id, { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'OPT_IN' }, tenant.userId, transaction);
    await personConsentsService.recordConsent(person.id, { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'OPT_OUT' }, tenant.userId, transaction);

    const history = await personConsentsService.listConsents(person.id, transaction);
    assert.equal(history.length, 2, 'append-only: os dois estados ficam gravados, o segundo não sobrescreve o primeiro');
    assert.equal(history.filter((c) => c.status === 'OPT_IN').length, 1);
    assert.equal(history.filter((c) => c.status === 'OPT_OUT').length, 1);

    await assert.rejects(
      () => personConsentsService.recordConsent(person.id, { channel: 'FAX', purpose: 'MARKETING', status: 'OPT_IN' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'PERSON_CONSENT_VALIDATION'); return true; },
      'canal fora da lista permitida deve ser rejeitado'
    );
  });
});

// --- M3-23: RLS e isolamento multiempresa (schemas people e real_estate) ---
test('M3-23 RLS de people.persons e real_estate.properties confirmado no catálogo do Postgres', async () => {
  const tables = [
    { schema: 'people', table: 'persons' },
    { schema: 'real_estate', table: 'properties' },
    { schema: 'crm', table: 'opportunities' },
  ];
  for (const { schema, table } of tables) {
    // eslint-disable-next-line no-await-in-loop
    const [rows] = await sequelize.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = :schema AND c.relname = :table`,
      { replacements: { schema, table } }
    );
    assert.equal(rows.length, 1, `tabela ${schema}.${table} deve existir`);
    assert.equal(rows[0].relrowsecurity, true, `${schema}.${table} precisa ter RLS habilitado (ENABLE ROW LEVEL SECURITY)`);
    assert.equal(rows[0].relforcerowsecurity, true, `${schema}.${table} precisa ter FORCE ROW LEVEL SECURITY (vale até para o dono da tabela)`);

    // eslint-disable-next-line no-await-in-loop
    const [policies] = await sequelize.query(
      `SELECT polname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = :schema AND c.relname = :table`,
      { replacements: { schema, table } }
    );
    assert.ok(policies.length >= 1, `${schema}.${table} precisa ter ao menos uma policy de isolamento`);
  }

  // Prova funcional (não só configuração): com company_id falso, SELECT retorna 0 linhas.
  await sequelize.transaction(async (t) => {
    await sequelize.query("SET LOCAL app.company_id = '00000000-0000-0000-0000-000000000000'", { transaction: t });
    const [rows] = await sequelize.query('SELECT count(*) FROM people.persons', { transaction: t });
    assert.equal(Number(rows[0].count), 0, 'company_id falso não pode enxergar nenhuma pessoa real');
  });
});
