'use strict';

// Apoio dos testes M9-D427 (SEO do site): imóvel publicado com endereço e oferta, mudança de situação com data. Não é teste.
const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../src/models');

const uid = () => crypto.randomUUID();
const q = (t, sql, replacements) => sequelize.query(sql, { transaction: t, replacements, type: QueryTypes.SELECT });
const DAY = 24 * 3600 * 1000;

/** Imóvel PUBLISHED na empresa `tenant` com endereço em Jardim Europa (rua e número que NUNCA podem sair em SO_BAIRRO) e oferta de venda. */
async function makeProperty(t, tenant, { policy, status = 'PUBLISHED', offer = 'SALE', price = 780000, bedrooms = 3, attrs = {} } = {}) {
  const [{ id: addressId }] = await q(t, `INSERT INTO real_estate.property_addresses (id, zip_code, street, number, neighborhood, city, state)
    VALUES (gen_random_uuid(), '01310-100', 'Rua das Acácias', '120', 'Jardim Europa', 'São Paulo', 'SP') RETURNING id`);
  const [row] = await q(t, `INSERT INTO real_estate.properties (id, group_id, company_id, title, internal_code, property_type, address_id, bedrooms,
      parking_spots, area_total_m2, attributes_json, publication_status${policy ? ', public_address_policy' : ''})
    VALUES (gen_random_uuid(), :g, :c, 'Apto 42 Rua das Acácias 120', :code, 'RESIDENTIAL', :addr, :bed, 2, 120, CAST(:attrs AS jsonb), :status${policy ? ', :policy' : ''})
    RETURNING id, public_id`, { g: tenant.groupId, c: tenant.companyId, code: `QA-M9-${uid().slice(0, 8)}`, addr: addressId, bed: bedrooms, attrs: JSON.stringify({ pool: true, ...attrs }), status, policy });
  if (offer) {
    await q(t, `INSERT INTO real_estate.property_offers (id, group_id, company_id, property_id, offer_type, asking_price, status)
      VALUES (gen_random_uuid(), :g, :c, :p, :type, :price, 'ACTIVE') RETURNING id`, { g: tenant.groupId, c: tenant.companyId, p: row.id, type: offer, price });
  }
  return row;
}

/** Muda a situação do imóvel e fixa o instante da mudança (o gatilho grava "agora"; o teste recua para provar o ciclo com datas). */
async function changeState(t, propertyId, { availability, publication, at }) {
  if (availability) await q(t, 'UPDATE real_estate.properties SET availability_status = :a WHERE id = :id RETURNING id', { a: availability, id: propertyId });
  if (publication) await q(t, 'UPDATE real_estate.properties SET publication_status = :p WHERE id = :id RETURNING id', { p: publication, id: propertyId });
  if (at) await q(t, 'UPDATE real_estate.properties SET lifecycle_changed_at = :at WHERE id = :id RETURNING id', { at, id: propertyId });
}

module.exports = { uid, q, DAY, makeProperty, changeState };
