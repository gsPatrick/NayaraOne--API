'use strict';

// M9-D405 — apoio dos testes de fonte/versão/atualização do conteúdo: imóvel, oferta, item publicado e consultas.

const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../src/models');

const uid = () => crypto.randomUUID();
const q = (t, sql, replacements) => sequelize.query(sql, { transaction: t, replacements, type: QueryTypes.SELECT });

async function makeProperty(t, tenant) {
  const [{ id: addressId }] = await q(t,
    `INSERT INTO real_estate.property_addresses (id, zip_code, street, number, neighborhood, city, state)
     VALUES (gen_random_uuid(), '01310-100', 'Rua das Acácias', '120', 'Jardim Europa', 'São Paulo', 'SP') RETURNING id`);
  const [row] = await q(t,
    `INSERT INTO real_estate.properties (id, group_id, company_id, title, internal_code, property_type, address_id, bedrooms,
        parking_spots, area_total_m2, attributes_json, publication_status)
     VALUES (gen_random_uuid(), :g, :c, 'QA-M9 Apto D405', :code, 'RESIDENTIAL', :addr, 3, 2, 120, '{}'::jsonb, 'PUBLISHED')
     RETURNING id, public_id`,
    { g: tenant.groupId, c: tenant.companyId, code: `QA-M9-${uid().slice(0, 8)}`, addr: addressId });
  return row;
}

async function makeSaleOffer(t, tenant, propertyId, price) {
  const [row] = await q(t,
    `INSERT INTO real_estate.property_offers (id, group_id, company_id, property_id, offer_type, asking_price, status)
     VALUES (gen_random_uuid(), :g, :c, :p, 'SALE', :price, 'ACTIVE') RETURNING id`,
    { g: tenant.groupId, c: tenant.companyId, p: propertyId, price });
  return row.id;
}

const changeOfferPrice = (t, offerId, price) => q(t, 'UPDATE real_estate.property_offers SET asking_price = :price WHERE id = :id', { id: offerId, price });
const setStatus = (t, itemId, status) => q(t, 'UPDATE marketing.content_items SET status = :status WHERE id = :id', { id: itemId, status });
const loadItem = async (t, id) => (await q(t, 'SELECT * FROM marketing.content_items WHERE id = :id', { id }))[0];
const itemsOfSource = (t, entityId) => q(t, 'SELECT * FROM marketing.content_items WHERE source_entity_id = :entityId ORDER BY created_at, id', { entityId });
const versionsOf = (t, itemId) => q(t, 'SELECT * FROM marketing.content_versions WHERE content_item_id = :itemId ORDER BY version_no', { itemId });

async function makeJob(t, tenant, versionId, status = 'PENDING') {
  const [row] = await q(t,
    `INSERT INTO marketing.publication_jobs (group_id, company_id, content_version_id, channel, adapter_code, status, idempotency_key, scheduled_at)
     VALUES (:g, :c, :v, 'SITE', 'site-cms', :s, :k, now() + interval '1 day') RETURNING id`,
    { g: tenant.groupId, c: tenant.companyId, v: versionId, s: status, k: `pub:${versionId}:SITE:2026-11-01T12:00:00.000Z` });
  return row.id;
}

module.exports = { uid, q, makeProperty, makeSaleOffer, changeOfferPrice, setStatus, loadItem, itemsOfSource, versionsOf, makeJob };
