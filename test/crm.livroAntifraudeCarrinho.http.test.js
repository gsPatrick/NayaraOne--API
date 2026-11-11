'use strict';

/**
 * Livro do Marco 3 pela ROTA (HTTP real): §18 troca de responsável em massa (permissão específica + audit) e interação que
 * não se apaga; §14 carrinho (link com expiração, sem dado interno nem endereço, versionado, view/click); §9 accepts_financing
 * na oferta; §7 só foto APROVADA conta para publicar e a foto original fica intacta.
 * Grava de verdade: rodar só em banco descartável (scripts/withDisposableDb.js).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M3_LIVRO_ANTIFRAUDE_HTTP_PORT || '21615';

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { createMember } = require('./helpers/m3caCrm');
const { signAccessToken } = require('../src/utils/jwt');
const { AuditLog, OutboxEvent, PropertyMedia } = require('../src/models');

let tenant;
let baseUrl;
let tokenGestor;
let tokenSemPermissao;
const FUTURE = () => new Date(Date.now() + 2 * 86400000).toISOString();
const BASE_PERMS = [
  'people:create', 'people:read', 'crm:opportunities:create', 'crm:opportunities:read', 'crm:opportunities:update',
  'crm:messages:create', 'crm:messages:read', 'properties:create', 'properties:read', 'properties:update', 'properties:internal',
];

before(async () => {
  tenant = await getSeedTenant();
  const claims = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'] };
  tokenGestor = signAccessToken({ ...claims, permissions: [...BASE_PERMS, 'crm:opportunities:reassign'] });
  tokenSemPermissao = signAccessToken({ ...claims, permissions: BASE_PERMS });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, path, body, token = tokenGestor, extra = {}) {
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function pessoa(label) {
  const p = await http('POST', '/people', { personType: 'PF', legalName: `${label} ${uniqueSuffix()}`, allowDuplicate: true });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  return p.body.data.id;
}
async function oportunidade(personId, extra = {}) {
  const o = await http('POST', '/opportunities', { personId, stage: 'NEW', nextAction: 'Retornar contato', nextActionDueAt: FUTURE(), ...extra });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  return o.body.data;
}
async function imovel(extra = {}) {
  const s = uniqueSuffix();
  const r = await http('POST', '/properties', { title: `Imóvel ${s}`, internalCode: `AF-${s}`, propertyType: 'RESIDENTIAL', city: 'Campinas', state: 'SP', addressLine: `Rua Sigilosa, ${s.slice(-4)}`, zipCode: '13010-000', registryNumber: `MAT-${s}`, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

test('§18: troca de responsável em massa exige permissão específica, motivo e membro ativo; audita cada oportunidade', async () => {
  const personId = await pessoa('Carteira');
  const a = await oportunidade(personId);
  const b = await oportunidade(personId);
  const corpo = { opportunityIds: [a.id, b.id], toUserId: tenant.userId, reason: 'Corretor saiu da equipe' };
  const negado = await http('POST', '/crm/opportunities/reassign', corpo, tokenSemPermissao);
  assert.equal(negado.status, 403);
  const semMotivo = await http('POST', '/crm/opportunities/reassign', { ...corpo, reason: '' });
  assert.equal(semMotivo.status, 400);
  assert.equal(semMotivo.body.error.code, 'OPPORTUNITY_REASSIGN_REASON_REQUIRED');
  const estranho = await http('POST', '/crm/opportunities/reassign', { ...corpo, toUserId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(estranho.status, 422);
  assert.equal(estranho.body.error.code, 'OPPORTUNITY_REASSIGN_INVALID_OWNER');
  const inexistente = await http('POST', '/crm/opportunities/reassign', { ...corpo, opportunityIds: [a.id, '00000000-0000-4000-8000-000000000000'] });
  assert.equal(inexistente.status, 404);
  const ok = await http('POST', '/crm/opportunities/reassign', corpo);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.requested, 2);
  const auds = await withTenantTransaction(tenant, (t) => AuditLog.findAll({ where: { action: 'opportunity.bulk_reassign', entityId: [a.id, b.id] }, transaction: t }));
  assert.equal(auds.length, ok.body.data.changed);
  for (const aud of auds) {
    assert.equal(aud.afterJson.ownerUserId, tenant.userId);
    assert.match(aud.reason, /Corretor saiu da equipe/);
  }
});

test('§18: interação não se apaga pela API (não existe rota de exclusão) e continua consultável', async () => {
  const personId = await pessoa('Interação');
  const op = await oportunidade(personId);
  const m = await http('POST', '/messages', { personId, opportunityId: op.id, direction: 'INBOUND', authorType: 'CLIENT', channel: 'WHATSAPP', body: 'Reclamação registrada na conversa.' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const del = await http('DELETE', `/messages/${m.body.data.id}`);
  assert.equal(del.status, 404);
  const ainda = await http('GET', `/messages/${m.body.data.id}`);
  assert.equal(ainda.status, 200);
  assert.equal(ainda.body.data.body, 'Reclamação registrada na conversa.');
});

test('§9 e §14: oferta com accepts_financing; carrinho versionado, sem dado interno nem endereço, com view/click e link que expira', async () => {
  const personId = await pessoa('Carrinho');
  const op = await oportunidade(personId);
  const casa = await imovel();
  const oferta = await http('POST', `/properties/${casa.id}/offers`, { offerType: 'SALE', askingPrice: 750000, acceptsFinancing: true });
  assert.equal(oferta.status, 201, JSON.stringify(oferta.body));
  assert.equal(oferta.body.data.acceptsFinancing, true);
  const lista = await http('GET', `/properties/${casa.id}/offers`);
  assert.equal(lista.body.data.find((o) => o.id === oferta.body.data.id).acceptsFinancing, true);
  const oc = await http('POST', `/properties/${casa.id}/occurrences`, { occurrenceType: 'SPECIFIC_NEGOTIATION', description: 'SEGREDO-INTERNO proprietário aceita 10% a menos' });
  assert.ok([200, 201].includes(oc.status), JSON.stringify(oc.body));
  const outra = await imovel();

  const cart = await http('POST', `/opportunities/${op.id}/carts`, { propertyIds: [casa.id] });
  assert.equal(cart.status, 201, JSON.stringify(cart.body));
  const cartId = cart.body.data.id || cart.body.data.cart.id;
  const v2 = await http('PATCH', `/carts/${cartId}/items`, { propertyIds: [casa.id, outra.id] });
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  const link = await http('POST', `/carts/${cartId}/share-link`);
  assert.ok([200, 201].includes(link.status), JSON.stringify(link.body));
  const publico = `${baseUrl}/crm/carts/public/${link.body.data.token}`;
  const visto = await http('GET', publico, undefined, null);
  assert.equal(visto.status, 200, JSON.stringify(visto.body));
  assert.equal(visto.body.data.version, 2, 'mostra a versão atual do que foi enviado');
  const texto = JSON.stringify(visto.body);
  assert.doesNotMatch(texto, /SEGREDO-INTERNO|Rua Sigilosa|13010-000|MAT-|registryNumber|addressLine|zipCode|confidential/);
  assert.equal(visto.body.data.properties.find((p) => p.id === casa.id).offer.acceptsFinancing, true);
  const clique = await http('POST', `${publico}/properties/${casa.id}/click`, undefined, null);
  assert.ok([200, 201, 204].includes(clique.status), JSON.stringify(clique.body));
  const eventos = await withTenantTransaction(tenant, (t) => OutboxEvent.findAll({ where: { aggregateId: cartId }, transaction: t }));
  assert.ok(eventos.some((e) => e.eventType === 'crm.cart.viewed'));
  assert.ok(eventos.some((e) => e.eventType === 'crm.cart.property_clicked'));

  await withTenantTransaction(tenant, (t) => sequelize.query("UPDATE crm.carts SET expires_at = now() - interval '1 hour' WHERE id = :id", { replacements: { id: cartId }, transaction: t }));
  const expirado = await http('GET', publico, undefined, null);
  assert.equal(expirado.status, 422);
  assert.equal(expirado.body.error.code, 'CART_SHARE_LINK_EXPIRED');
});

test('§7: foto enviada pela tela (IMAGE) só conta para publicar depois de APROVADA na revisão; recusa exige motivo; a foto original não muda', async () => {
  const casa = await imovel();
  const oferta = await http('POST', `/properties/${casa.id}/offers`, { offerType: 'RENT', askingPrice: 3500 });
  assert.equal(oferta.status, 201);
  const video = await http('POST', `/properties/${casa.id}/media`, { mediaType: 'VIDEO', storageKey: `videos/tour-${uniqueSuffix()}.mp4`, mimeType: 'video/mp4' });
  assert.equal(video.status, 201, JSON.stringify(video.body));
  await http('PATCH', `/properties/${casa.id}/media/${video.body.data.id}/quality`, { qualityStatus: 'APPROVED' });
  const fotos = [];
  for (let i = 0; i < 5; i += 1) {
    const f = await http('POST', `/properties/${casa.id}/media`, { mediaType: 'IMAGE', storageKey: `fotos/original-${i}-${uniqueSuffix()}.jpg`, originalName: `foto-${i}.jpg`, mimeType: 'image/jpeg' });
    assert.equal(f.status, 201, JSON.stringify(f.body));
    assert.equal(f.body.data.qualityStatus, 'PENDING', 'foto nasce pendente de revisão');
    fotos.push(f.body.data);
  }
  const semAprovar = await http('POST', `/offers/${oferta.body.data.id}/publish`, {});
  assert.equal(semAprovar.status, 422, JSON.stringify(semAprovar.body));
  assert.equal(semAprovar.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_PHOTO_MIN');
  const recusaSemMotivo = await http('PATCH', `/properties/${casa.id}/media/${fotos[4].id}/quality`, { qualityStatus: 'REJECTED' });
  assert.equal(recusaSemMotivo.status, 400);
  assert.equal(recusaSemMotivo.body.error.code, 'PROPERTY_MEDIA_REJECTION_REASON_REQUIRED');
  const recusa = await http('PATCH', `/properties/${casa.id}/media/${fotos[4].id}/quality`, { qualityStatus: 'REJECTED', reason: 'Pessoa aparece na foto' });
  assert.equal(recusa.status, 200, JSON.stringify(recusa.body));
  for (const f of fotos.slice(0, 2)) assert.equal((await http('PATCH', `/properties/${casa.id}/media/${f.id}/quality`, { qualityStatus: 'APPROVED' })).status, 200);
  const duas = await http('POST', `/offers/${oferta.body.data.id}/publish`, {});
  assert.equal(duas.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_PHOTO_MIN', '2 aprovadas + 1 recusada + 2 pendentes não bastam');
  assert.equal(duas.body.error.details.approvedPhotoCount, 2);
  await http('PATCH', `/properties/${casa.id}/media/${fotos[2].id}/quality`, { qualityStatus: 'APPROVED' });
  const tres = await http('POST', `/offers/${oferta.body.data.id}/publish`, {});
  assert.equal(tres.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_DOCS_001', 'com 3 fotos aprovadas o gate de fotos passa e o próximo é o de documentos');
  for (const documentType of ['REGISTRY', 'IPTU']) {
    const d = await http('POST', `/properties/${casa.id}/documents`, { documentType, label: documentType, status: 'REGULARIZADO' });
    assert.equal(d.status, 201, JSON.stringify(d.body));
  }
  const publicado = await http('POST', `/offers/${oferta.body.data.id}/publish`, {});
  assert.equal(publicado.status, 200, JSON.stringify(publicado.body));
  const depois = await withTenantTransaction(tenant, (t) => PropertyMedia.findAll({ where: { propertyId: casa.id, mediaType: 'IMAGE' }, transaction: t }));
  for (const f of fotos) {
    const atual = depois.find((d) => d.id === f.id);
    assert.equal(atual.storageKey, f.storageKey, 'arquivo original preservado');
    assert.equal(atual.originalName, f.originalName);
  }
  const aud = await withTenantTransaction(tenant, (t) => AuditLog.findOne({ where: { entityId: fotos[4].id, action: 'property.media.quality_review' }, transaction: t }));
  assert.equal(aud.beforeJson.qualityStatus, 'PENDING');
  assert.equal(aud.afterJson.qualityStatus, 'REJECTED');
  assert.match(aud.reason, /Pessoa aparece/);
});

test('§18/CRM-TS-013: exportar as oportunidades (base de clientes) exige a permissão dedicada e MFA recente pela rota POST /exports', async () => {
  const claims = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'] };
  const comExport = signAccessToken({ ...claims, permissions: [...BASE_PERMS, 'governance:dlp:export', 'crm:opportunities:export'] });
  const semPermissaoDoModulo = signAccessToken({ ...claims, permissions: [...BASE_PERMS, 'governance:dlp:export'] });
  const corpo = { resourceType: 'crm.opportunities', format: 'CSV', purpose: 'OPERACAO', justification: 'Relatório da reunião semanal de vendas da equipe comercial' };
  const semMfa = await http('POST', '/exports', corpo, comExport, { 'Idempotency-Key': `m3-export-${uniqueSuffix()}` });
  assert.equal(semMfa.status, 403, JSON.stringify(semMfa.body));
  assert.equal(semMfa.body.error.code, 'MFA_STEP_UP_REQUIRED');
  const semModulo = await http('POST', '/exports', corpo, semPermissaoDoModulo, { 'Idempotency-Key': `m3-export-${uniqueSuffix()}` });
  assert.equal(semModulo.status, 403, JSON.stringify(semModulo.body));
  const [[job]] = await withTenantTransaction(tenant, (t) => sequelize.query("SELECT status, classification FROM governance.export_jobs WHERE resource_type = 'crm.opportunities' AND actor_user_id = :u ORDER BY created_at DESC LIMIT 1", { replacements: { u: tenant.userId }, transaction: t }));
  assert.equal(job.classification, 'HIGH');
  assert.equal(job.status, 'BLOCKED');
});

test('§18/CRM-TS-012: corretor (escopo próprio) não abre, não edita nem vê a linha do tempo de oportunidade de outra carteira pelo id', async () => {
  const claims = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['corretor'] };
  const corretor = signAccessToken({ ...claims, permissions: ['people:create', 'people:read', 'crm:opportunities:create', 'crm:opportunities:read', 'crm:opportunities:read:own', 'crm:opportunities:update', 'crm:messages:create'] });
  const personId = await pessoa('Carteira escopo');
  const minha = await oportunidade(personId, { ownerUserId: tenant.userId });
  // CRMX-006 (DI-M3CA-1): toda oportunidade tem responsável; a "alheia" é de outro corretor ativo da empresa.
  const outroCorretor = await withTenantTransaction(tenant, (t) => createMember(tenant, t, { label: 'outro-corretor' }));
  const alheia = await oportunidade(personId, { ownerUserId: outroCorretor });
  assert.equal((await http('GET', `/opportunities/${minha.id}`, undefined, corretor)).status, 200);
  for (const [metodo, rota, corpo] of [['GET', `/opportunities/${alheia.id}`], ['PATCH', `/opportunities/${alheia.id}`, { nextAction: 'x' }], ['GET', `/opportunities/${alheia.id}/timeline`], ['POST', `/crm/opportunities/${alheia.id}/interactions`, { channel: 'PHONE', direction: 'OUT', summary: 'x' }]]) {
    const r = await http(metodo, rota, corpo, corretor);
    assert.equal(r.status, 404, `${metodo} ${rota}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'OPPORTUNITY_NOT_FOUND');
  }
  const lista = await http('GET', '/opportunities', undefined, corretor);
  assert.ok(lista.body.data.some((o) => o.id === minha.id));
  assert.ok(!lista.body.data.some((o) => o.id === alheia.id));
  assert.equal((await http('GET', `/opportunities/${alheia.id}`)).status, 200, 'gestor continua vendo tudo');
});
