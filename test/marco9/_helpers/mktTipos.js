'use strict';

// Apoio dos testes M9-D409 (10 tipos de conteúdo): imóvel ativo com foto e histórico de preço, pessoa com data de nascimento ou entrega
// de chaves, obra com etapa pública e eventos do outbox em formato de consumidor. Tudo dentro da transação do teste. Não é teste.
const fx = require('../../helpers/m9d405Fixtures');
const env = require('./mktPolicyEnv');
const contractsService = require('../../../src/modules/legal/contracts/application/contract.service');

const { uid, q } = fx;
const base = (tenant) => ({ g: tenant.groupId, c: tenant.companyId });

async function addPhoto(t, tenant, propertyId, quality = 'APPROVED') {
  await q(t, `INSERT INTO real_estate.property_media (id, group_id, company_id, property_id, media_type, storage_key, position, quality_status)
    VALUES (gen_random_uuid(), :g, :c, :p, 'PHOTO', :k, 1, :qs)`, { ...base(tenant), p: propertyId, k: `qa-m9/${uid()}`, qs: quality });
}

/** Imóvel PUBLISHED/AVAILABLE com oferta de venda e (por padrão) uma foto autorizada. */
async function activeProperty(t, tenant, { price = 780000, photos = 1 } = {}) {
  const prop = await fx.makeProperty(t, tenant);
  const offerId = await fx.makeSaleOffer(t, tenant, prop.id, price);
  for (let i = 0; i < photos; i += 1) await addPhoto(t, tenant, prop.id);
  return { propertyId: prop.id, offerId };
}

/** Registra a mudança de preço da oferta (histórico) e a aplica na oferta. */
async function changePrice(t, tenant, offerId, oldPrice, newPrice) {
  await q(t, `INSERT INTO real_estate.property_price_history (id, group_id, company_id, offer_id, old_price, new_price, changed_at, changed_by, reason_code)
    VALUES (gen_random_uuid(), :g, :c, :o, :old, :new, now(), :u, 'ADJUSTMENT')`, { ...base(tenant), o: offerId, old: oldPrice, new: newPrice, u: tenant.userId });
  await fx.changeOfferPrice(t, offerId, newPrice);
}

const setAvailability = (t, propertyId, status) => q(t, 'UPDATE real_estate.properties SET availability_status = :s WHERE id = :id', { id: propertyId, s: status });
const setPublication = (t, propertyId, status) => q(t, 'UPDATE real_estate.properties SET publication_status = :s WHERE id = :id', { id: propertyId, s: status });

async function personWithBirthday(t, tenant, { name = 'Maria Aparecida da Silva', birth = '1990-03-14' } = {}) {
  const id = await env.makePerson(t, tenant, { name });
  await q(t, 'UPDATE people.persons SET birth_or_foundation_date = :b WHERE id = :id', { id, b: birth });
  return id;
}

/** Entrega de chaves RELEASED ao cliente (contrato real pelo serviço, linha de entrega direta). Opt-in de pós-venda opcional. */
async function keyDelivery(t, tenant, { personId, deliveredAt = '2026-10-20T12:00:00Z' } = {}) {
  const property = await fx.makeProperty(t, tenant);
  const contract = await contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'SALE', propertyId: property.id, totalValue: 1000 }, tenant.userId, t);
  const [row] = await q(t, `INSERT INTO legal.key_deliveries (id, group_id, company_id, contract_id, delivered_to_person_id, status, delivered_at)
    VALUES (gen_random_uuid(), :g, :c, :k, :p, 'RELEASED', :at) RETURNING id`, { ...base(tenant), k: contract.id, p: personId, at: deliveredAt });
  return row.id;
}

/** Obra com etapa pública (com a foto do imóvel da obra, por padrão). */
async function publicConstruction(t, tenant, { name = 'Residencial Aurora', stage = 'Estrutura', photo = true } = {}) {
  const prop = await fx.makeProperty(t, tenant);
  if (photo) await addPhoto(t, tenant, prop.id);
  const [project] = await q(t, `INSERT INTO construction.projects (id, group_id, company_id, name, status, property_id) VALUES (gen_random_uuid(), :g, :c, :n, 'ACTIVE', :p) RETURNING id`,
    { ...base(tenant), n: name, p: prop.id });
  await q(t, `INSERT INTO construction.project_stages (id, group_id, company_id, project_id, name, sequence, status, public_visible)
    VALUES (gen_random_uuid(), :g, :c, :pr, :n, 1, 'IN_PROGRESS', true)`, { ...base(tenant), pr: project.id, n: stage });
  return project.id;
}

async function campaign(t, tenant) {
  const [row] = await q(t, `INSERT INTO marketing.campaigns (group_id, company_id, code, name, objective, owner_user_id)
    VALUES (:g, :c, :code, 'QA-M9 campanha', 'objetivo de teste longo', :o) RETURNING id`, { ...base(tenant), code: `QA-${uid().slice(0, 8)}`, o: tenant.userId });
  return row.id;
}

/** Evento do outbox no formato que o consumidor recebe. */
const outboxEvent = (tenant, eventType, aggregateId, payload = {}) => ({
  id: uid(), eventType, aggregateId, groupId: tenant.groupId, companyId: tenant.companyId, payloadJson: payload,
});

const itemsOfType = (t, tenant, type) => q(t, 'SELECT * FROM marketing.content_items WHERE company_id = :c AND type = :ty ORDER BY created_at, id', { c: tenant.companyId, ty: type });
const bodyOf = async (t, itemId) => (await q(t, `SELECT v.body_json, v.facts_snapshot_json FROM marketing.content_versions v WHERE v.content_item_id = :id ORDER BY version_no LIMIT 1`, { id: itemId }))[0];

module.exports = {
  ...env, activeProperty, changePrice, setAvailability, setPublication, personWithBirthday, keyDelivery, publicConstruction, campaign,
  outboxEvent, itemsOfType, bodyOf, addPhoto,
};
