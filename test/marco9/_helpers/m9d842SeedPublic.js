'use strict';

// Dados de partida da página pública de imóvel para o contract test (M9-D842, não é teste): um imóvel publicado com oferta ativa. Banco descartável.
const exportsEnv = require('./exportsEnv');

const suffix = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

/** Imóvel publicado da empresa A; devolve o publicId que o exemplo usa na rota pública sem login. */
async function publishedProperty(_vars, { tenants }) {
  const A = tenants.A;
  const { rows: [address] } = await exportsEnv.adminQuery(
    `INSERT INTO real_estate.property_addresses (id, zip_code, street, number, neighborhood, city, state)
     VALUES (gen_random_uuid(), '01310-842', 'Rua Contrato', '842', 'Jardim Contrato', 'São Paulo', 'SP') RETURNING id`
  );
  const { rows: [property] } = await exportsEnv.adminQuery(
    `INSERT INTO real_estate.properties (id, group_id, company_id, title, internal_code, property_type, address_id, bedrooms, parking_spots, area_total_m2, publication_status)
     VALUES (gen_random_uuid(), $1, $2, 'QA-M9 Imóvel público', $3, 'RESIDENTIAL', $4, 2, 1, 80, 'PUBLISHED') RETURNING id, public_id`,
    [A.groupId, A.companyId, `M9D842-PUB-${suffix()}`, address.id]
  );
  await exportsEnv.adminQuery(
    `INSERT INTO real_estate.property_offers (id, group_id, company_id, property_id, offer_type, asking_price, status)
     VALUES (gen_random_uuid(), $1, $2, $3, 'SALE', 500000, 'ACTIVE')`, [A.groupId, A.companyId, property.id]
  );
  return { publicPropertyId: property.public_id };
}

module.exports = { publishedProperty };
