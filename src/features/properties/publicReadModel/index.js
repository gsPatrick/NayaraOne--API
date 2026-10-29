'use strict';

/** PublicPropertyReadModel (Marco 9, M9-D231): visão pública, reduzida e sanitizada do imóvel. Fachada da API pública. */
require('./consumers');
const { syncPublicPropertyReadModel } = require('./readModel.sync');
const { loadPublicPropertyReadModel, notPublishable } = require('./readModel.read');
const { publishability } = require('./eligibility');
const { PUBLIC_FIELDS, CONTROL_COLUMNS, ADDRESS_VISIBILITIES } = require('./constants');
const { PUBLICATION_SETTINGS_SCHEMA } = require('./publicReadModel.settings');

module.exports = { syncPublicPropertyReadModel, loadPublicPropertyReadModel, notPublishable, publishability, PUBLIC_FIELDS, CONTROL_COLUMNS, ADDRESS_VISIBILITIES, PUBLICATION_SETTINGS_SCHEMA };
