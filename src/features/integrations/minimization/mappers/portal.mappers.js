'use strict';

const { defineMapper } = require('../defineMapper');

/**
 * Portais imobiliários (M9-D219 exemplo): 12 campos públicos do PublicPropertyReadModel (M9-D231), mais 6 que os portais da M9-D232 usam (18). Os nomes são os do read
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
    // M9-D232: campos públicos que alguns portais exigem ou aceitam (banheiros, vagas, área construída, UF, vídeo e características). Continuam sendo só campos do read model público.
    { name: 'bathrooms', classification: 'PUBLIC' },
    { name: 'parking_spots', classification: 'PUBLIC' },
    { name: 'area_built', classification: 'PUBLIC' },
    { name: 'state', classification: 'PUBLIC' },
    { name: 'video_public_url', classification: 'PUBLIC' },
    { name: 'features_public', classification: 'PUBLIC' },
  ],
});

const status = defineMapper({ purpose: 'LISTING_PUBLICATION', fields: [{ name: 'externalResourceId', classification: 'PUBLIC' }] });

module.exports = {
  publishListing: listing(),
  updateListing: listing([{ name: 'externalResourceId', classification: 'PUBLIC', required: true }]),
  unpublishListing: status,
  getListingStatus: status,
};
