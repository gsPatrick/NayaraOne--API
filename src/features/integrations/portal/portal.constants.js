'use strict';

/** Anúncios de imóvel nos portais (Marco 9, M9-D232 e M9-D233): constantes compartilhadas. */
const LISTING_STATUSES = Object.freeze(['PENDING_SYNC', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'UNPUBLISHING', 'UNPUBLISHED', 'ERROR']);
const STREAM = 'portal.listing_status';
const LISTING_AGGREGATE = 'PortalListing';
const EVENT_STATUS_CHANGED = 'properties.portal_listing.status_changed';
/** Estados que o sync de status acompanha no portal. */
const SYNCABLE = Object.freeze(['PENDING_SYNC', 'PUBLISHING', 'PUBLISHED', 'UNPUBLISHING']);
const REQUIRED_MISSING_CODE = 'INTEGRATION_PORTAL_REQUIRED_FIELD_MISSING';
const REQUIRED_MISSING_MESSAGE = 'Faltam dados exigidos pelo portal: complete o cadastro do imóvel.';

module.exports = { LISTING_STATUSES, STREAM, LISTING_AGGREGATE, EVENT_STATUS_CHANGED, SYNCABLE, REQUIRED_MISSING_CODE, REQUIRED_MISSING_MESSAGE };
