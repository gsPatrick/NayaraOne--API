'use strict';

/**
 * Marco 3 — gate de publicação que não se contorna (verificação independente de 11/11/2026: M3-09, CRMX-012, CAD-07 e o
 * requisito §7 "campos obrigatórios"). HTTP real (auth JWT + tenant + rotas). Grava de verdade: só em banco descartável.
 *  - POST /properties com PUBLISHED passa pelo gate (antes nascia publicado sem vídeo, foto nem documento);
 *  - vídeo REJEITADO ou PENDENTE não conta; mídia sem arquivo não conta;
 *  - documentos exigidos e campos obrigatórios vêm dos parâmetros da empresa e são conferidos;
 *  - PATCH, POST /offers/:id/publish e POST /properties caem no mesmo gate; importação e alteração em massa não gravam
 *    publicação; só o gate grava PUBLISHED no código;
 *  - imóvel publicado que perde o vídeo (apagado ou recusado) sai do ar, auditado.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.PORT = process.env.M3IM_GATE_HTTP_PORT || '36101';

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { AuditLog, OutboxEvent, Property, PropertyMedia } = require('../src/models');
const { tornarPublicavel, ENDERECO } = require('./helpers/m3imPublicavel');

let tenant;
let baseUrl;
let token;
const PERMS = ['properties:create', 'properties:read', 'properties:update', 'properties:internal', 'settings:read', 'settings:update'];

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions: PERMS });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, p, body) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function imovel(extra = {}) {
  const s = uniqueSuffix();
  const r = await http('POST', '/properties', { title: `Gate ${s}`, internalCode: `GT-${s}`, propertyType: 'RESIDENTIAL', ...ENDERECO, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

const completar = (property, opcoes) => withTenantTransaction(tenant, (t) => tornarPublicavel(tenant, t, property, opcoes));
const statusDe = async (id) => (await withTenantTransaction(tenant, (t) => Property.findByPk(id, { transaction: t }))).publicationStatus;

test('POST /properties com PUBLISHED passa pelo gate: sem oferta, vídeo, fotos e documentos não cria nada e não emite property.published', async () => {
  const s = uniqueSuffix();
  const r = await http('POST', '/properties', { title: `Já publicado ${s}`, internalCode: `PUB-${s}`, propertyType: 'RESIDENTIAL', ...ENDERECO, publicationStatus: 'PUBLISHED' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'PROPERTY_PUBLISH_REQUIRES_ACTIVE_OFFER');
  const criado = await withTenantTransaction(tenant, (t) => Property.findOne({ where: { internalCode: `PUB-${s}` }, transaction: t }));
  assert.equal(criado, null, 'nada foi gravado');
});

test('vídeo REJEITADO ou PENDENTE não conta; com o vídeo aprovado publica pelo POST /offers/:id/publish e audita os fatos', async () => {
  const casa = await imovel();
  const { offer } = await completar(casa, { video: 'REJECTED' });
  const rejeitado = await http('POST', `/offers/${offer.id}/publish`, {});
  assert.equal(rejeitado.status, 422, JSON.stringify(rejeitado.body));
  assert.equal(rejeitado.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_001');

  const outra = await imovel();
  const { offer: o2 } = await completar(outra, { video: 'PENDING' });
  assert.equal((await http('POST', `/offers/${o2.id}/publish`, {})).body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_001');

  const boa = await imovel();
  const { offer: o3 } = await completar(boa);
  const ok = await http('POST', `/offers/${o3.id}/publish`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await statusDe(boa.id), 'PUBLISHED');
  const aud = await withTenantTransaction(tenant, (t) => AuditLog.findOne({ where: { entityId: boa.id, action: 'property.publish' }, transaction: t }));
  assert.equal(aud.beforeJson.publicationStatus, 'DRAFT');
  assert.equal(aud.afterJson.publicationStatus, 'PUBLISHED');
  assert.equal(aud.afterJson.publicationFacts.media.hasVideo, true);
  const ev = await withTenantTransaction(tenant, (t) => OutboxEvent.findAll({ where: { aggregateId: boa.id, eventType: 'property.published' }, transaction: t }));
  assert.equal(ev.length, 1);
});

test('mídia sem arquivo não conta para o gate (registro antigo só com storage_key)', async () => {
  const casa = await imovel();
  const { offer } = await completar(casa, { video: false });
  await withTenantTransaction(tenant, (t) => PropertyMedia.create({ groupId: tenant.groupId, companyId: tenant.companyId, propertyId: casa.id, mediaType: 'VIDEO', storageKey: `legado/${uniqueSuffix()}.mp4`, qualityStatus: 'APPROVED' }, { transaction: t }));
  const r = await http('POST', `/offers/${offer.id}/publish`, {});
  assert.equal(r.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_001');
});

test('documentos exigidos vêm do parâmetro da empresa (padrão REGISTRY e IPTU) e só contam com arquivo', async () => {
  const chave = 'real_estate.publication.required_document_types';
  const casa = await imovel();
  const { offer } = await completar(casa, { documentos: ['REGISTRY'] });
  const falta = await http('POST', `/offers/${offer.id}/publish`, {});
  assert.equal(falta.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_DOCS_001');
  assert.deepEqual(falta.body.error.details.missingDocTypes, ['IPTU']);
  try {
    const invalido = await http('PUT', `/settings/${chave}`, { value: 'REGISTRY,FOTO_DA_FACHADA' });
    assert.equal(invalido.status, 400);
    assert.equal((await http('PUT', `/settings/${chave}`, { value: 'REGISTRY' })).status, 200);
    const agora = await http('POST', `/offers/${offer.id}/publish`, {});
    assert.equal(agora.status, 200, JSON.stringify(agora.body));

    const outra = await imovel();
    const { offer: o2 } = await completar(outra);
    assert.equal((await http('PUT', `/settings/${chave}`, { value: 'REGISTRY,IPTU,CONDO_FEE' })).status, 200);
    const condominio = await http('POST', `/offers/${o2.id}/publish`, {});
    assert.equal(condominio.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_DOCS_001');
    assert.deepEqual(condominio.body.error.details.missingDocTypes, ['CONDO_FEE']);
  } finally {
    await http('PUT', `/settings/${chave}`, { value: 'REGISTRY,IPTU' });
  }
});

test('§7 campos obrigatórios: padrão exige endereço e proprietário; o parâmetro acrescenta campos e o Motor de Regras decide (REG-IMO-FIELDS-001)', async () => {
  const chave = 'real_estate.publication.required_fields';
  const semDono = await imovel();
  const { offer } = await completar(semDono, { comProprietario: false });
  const r = await http('POST', `/offers/${offer.id}/publish`, {});
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_FIELDS_001');
  assert.deepEqual(r.body.error.details.missingFields, ['owner']);

  const s = uniqueSuffix();
  const semEndereco = await http('POST', '/properties', { title: `Sem endereço ${s}`, internalCode: `SE-${s}`, propertyType: 'RESIDENTIAL', city: 'Campinas' });
  const { offer: o2 } = await completar(semEndereco.body.data);
  assert.deepEqual((await http('POST', `/offers/${o2.id}/publish`, {})).body.error.details.missingFields, ['address']);

  try {
    assert.equal((await http('PUT', `/settings/${chave}`, { value: 'title,address,owner,description,areaTotalM2' })).status, 200);
    const casa = await imovel();
    const { offer: o3 } = await completar(casa);
    const falta = await http('POST', `/offers/${o3.id}/publish`, {});
    assert.equal(falta.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_FIELDS_001');
    assert.deepEqual(falta.body.error.details.missingFields, ['description', 'areaTotalM2']);
    // PATCH que preenche os campos e pede PUBLISHED: o gate confere o imóvel como ele vai ficar.
    const patch = await http('PATCH', `/properties/${casa.id}`, { description: 'Casa ampla', areaTotalM2: 180, publicationStatus: 'PUBLISHED' });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.equal(patch.body.data.publicationStatus, 'PUBLISHED');
  } finally {
    await http('PUT', `/settings/${chave}`, { value: 'title,internalCode,propertyType,address,owner' });
  }
});

test('PATCH PUBLISHED cai no mesmo gate e não grava nada quando bloqueia', async () => {
  const casa = await imovel();
  await completar(casa, { fotos: 1 });
  const r = await http('PATCH', `/properties/${casa.id}`, { title: 'Título novo', publicationStatus: 'PUBLISHED' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_PHOTO_MIN');
  const depois = await withTenantTransaction(tenant, (t) => Property.findByPk(casa.id, { transaction: t }));
  assert.equal(depois.publicationStatus, 'DRAFT');
  assert.equal(depois.title, casa.title, 'a transação inteira voltou');
});

test('imóvel publicado que perde o vídeo (apagado) ou tem o vídeo recusado sai do ar, auditado', async () => {
  const casa = await imovel();
  const { offer } = await completar(casa);
  assert.equal((await http('POST', `/offers/${offer.id}/publish`, {})).status, 200);
  const video = await withTenantTransaction(tenant, (t) => PropertyMedia.findOne({ where: { propertyId: casa.id, mediaType: 'VIDEO' }, transaction: t }));
  const apagado = await http('DELETE', `/properties/${casa.id}/media/${video.id}`);
  assert.equal(apagado.status, 200, JSON.stringify(apagado.body));
  assert.equal(apagado.body.data.unpublished, true);
  assert.equal(await statusDe(casa.id), 'INACTIVE');
  const aud = await withTenantTransaction(tenant, (t) => AuditLog.findOne({ where: { entityId: casa.id, action: 'property.auto_unpublish' }, transaction: t }));
  assert.equal(aud.beforeJson.publicationStatus, 'PUBLISHED');
  assert.equal(aud.afterJson.publicationStatus, 'INACTIVE');
  assert.equal(aud.afterJson.gateCode, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_001');

  const outra = await imovel();
  const { offer: o2 } = await completar(outra);
  assert.equal((await http('POST', `/offers/${o2.id}/publish`, {})).status, 200);
  const v2 = await withTenantTransaction(tenant, (t) => PropertyMedia.findOne({ where: { propertyId: outra.id, mediaType: 'VIDEO' }, transaction: t }));
  const recusa = await http('PATCH', `/properties/${outra.id}/media/${v2.id}/quality`, { qualityStatus: 'REJECTED', reason: 'Vídeo mostra placa de carro' });
  assert.equal(recusa.status, 200);
  assert.equal(await statusDe(outra.id), 'INACTIVE');
});

test('nenhuma outra rota grava publicação: importação e alteração em massa não têm o campo; só o gate grava PUBLISHED no código', () => {
  const { FIELDS } = require('../src/features/core-governance/data-quality/bulk.fields');
  assert.equal(FIELDS.PROPERTY.patch.publicationStatus, undefined, 'alteração em massa não muda publicação');
  const target = require('../src/features/migration-v2/ingest/targets/property.target');
  assert.equal('publicationStatus' in target.canonical({ internalCode: 'X', title: 'Y', publicationStatus: 'PUBLISHED' }), false, 'importação não grava publicação');

  const raiz = path.join(__dirname, '..', 'src');
  const achados = [];
  const varrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        // Atribuição em JS (publicationStatus = / : 'PUBLISHED') ou UPDATE ... SET publication_status = 'PUBLISHED' em SQL.
        const js = /\bpublicationStatus\s*(=(?!=)|:)\s*['"]PUBLISHED['"]/.test(src);
        const sql = /\bSET\b[^;`]*\bpublication_status\s*=\s*'PUBLISHED'/i.test(src);
        if (js || sql) achados.push(path.relative(raiz, p));
      }
    }
  };
  varrer(raiz);
  assert.deepEqual(achados, ['features/properties/publicationGate.service.js']);
});
