'use strict';

/** Constantes da publicação de páginas do site (Marco 9, M9-D259). */
module.exports = Object.freeze({
  AGGREGATE: 'SitePage',
  PUBLISH: 'publishPage',
  UNPUBLISH: 'unpublishPage',
  PAGE_STATUS: Object.freeze({ PENDING: 'PENDING', PUBLISHED: 'PUBLISHED', UNPUBLISHING: 'UNPUBLISHING', UNPUBLISHED: 'UNPUBLISHED' }),
  SYNC: Object.freeze({ SYNCED: 'SYNCED', PENDING_SYNC: 'PENDING_SYNC', FAILED: 'FAILED' }),
  /** Envios que ainda não saíram ou esperam nova tentativa (o site ainda não respondeu). */
  OPEN_DISPATCH: Object.freeze(['PENDING', 'RETRY_WAIT', 'SENDING', 'SUBMITTED', 'UNKNOWN']),
});
