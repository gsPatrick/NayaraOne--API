'use strict';

const { defineMapper } = require('../defineMapper');

/**
 * Portais imobiliários (M9-D219 exemplo): 12 campos públicos do PublicPropertyReadModel (M9-D231). Os nomes são os do read
 * model. Tudo que não está aqui (ocorrência interna, proprietário, margem, endereço restrito, observações) é descartado.
 */
const listing = (extra = []) => defineMapper({
  purpose: 'LISTING_PUBLICATION',
  fields: [
    ...extra,
    { name: 'listingRef', from: 'public_code', classification: 'PUBLIC', required: true },
    { name: 'title', classification: 'PUBLIC', freeText: true },
    { name: 'description_public', classification: 'PUBLIC', freeText: true },
    { name: 'purpose', classification: 'PUBLIC' },
    { name: 'type', classification: 'PUBLIC' },
    { name: 'price_public', classification: 'PUBLIC' },
    { name: 'condo_fee_public', classification: 'PUBLIC' },
    { name: 'area_total', classification: 'PUBLIC' },
    { name: 'bedrooms', classification: 'PUBLIC' },
    { name: 'neighborhood', classification: 'PUBLIC' },
    { name: 'city', classification: 'PUBLIC' },
    { name: 'photos_public', classification: 'PUBLIC' },
  ],
});

const status = defineMapper({ purpose: 'LISTING_PUBLICATION', fields: [{ name: 'externalResourceId', classification: 'INTERNAL' }] });

module.exports = {
  publishListing: listing(),
  updateListing: listing([{ name: 'externalResourceId', classification: 'INTERNAL', required: true }]),
  unpublishListing: status,
  getListingStatus: status,
};
