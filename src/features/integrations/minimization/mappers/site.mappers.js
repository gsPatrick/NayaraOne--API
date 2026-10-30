'use strict';

const { defineMapper } = require('../defineMapper');

/** Site (M9-D219/M9-D231): página pública montada só com campos PUBLIC do PublicPropertyReadModel. */
module.exports = {
  publishPage: defineMapper({
    purpose: 'SITE_PUBLICATION',
    fields: [
      { name: 'pageKey', classification: 'PUBLIC', required: true },
      { name: 'slug', classification: 'PUBLIC', required: true },
      { name: 'locale', classification: 'PUBLIC' },
      { name: 'contentRef', classification: 'PUBLIC' },
      { name: 'contentHash', classification: 'PUBLIC' },
      { name: 'public_code', classification: 'PUBLIC', required: true },
      { name: 'title', classification: 'PUBLIC', freeText: true },
      { name: 'description_public', classification: 'PUBLIC', freeText: true },
      { name: 'purpose', classification: 'PUBLIC' },
      { name: 'type', classification: 'PUBLIC' },
      { name: 'price_public', classification: 'PUBLIC' },
      { name: 'condo_fee_public', classification: 'PUBLIC' },
      { name: 'iptu_public', classification: 'PUBLIC' },
      { name: 'area_total', classification: 'PUBLIC' },
      { name: 'area_built', classification: 'PUBLIC' },
      { name: 'bedrooms', classification: 'PUBLIC' },
      { name: 'bathrooms', classification: 'PUBLIC' },
      { name: 'parking_spots', classification: 'PUBLIC' },
      { name: 'neighborhood', classification: 'PUBLIC' },
      { name: 'city', classification: 'PUBLIC' },
      { name: 'state', classification: 'PUBLIC' },
      { name: 'lat_lng_public', classification: 'PUBLIC' },
      { name: 'photos_public', classification: 'PUBLIC' },
      { name: 'video_public_url', classification: 'PUBLIC' },
      { name: 'features_public', classification: 'PUBLIC' },
      { name: 'published_at', classification: 'PUBLIC' },
    ],
  }),
  unpublishPage: defineMapper({ purpose: 'SITE_PUBLICATION', fields: [{ name: 'pageKey', classification: 'PUBLIC', required: true }, { name: 'slug', classification: 'PUBLIC' }] }),
};
