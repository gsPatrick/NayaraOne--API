'use strict';

// M9-D613 / M9-D701 — API pública da camada exports do BI: pedido, worker, limpeza, download e parâmetros da exportação.
const settings = require('./export.settings');

module.exports = {
  camada: 'exports',
  requestExport: require('./export.request').requestExport,
  runExportWorker: require('./export.worker').runExportWorker,
  runExportCleanup: require('./export.cleanup').runExportCleanup,
  forEachCompany: require('./export.companies').forEachCompany,
  issueDownload: require('./export.download').issueDownload,
  serveFile: require('./export.download').serveFile,
  registerExportRoutes: require('./export.routes').registerExportRoutes,
  EXPORT_SETTINGS_SCHEMA: settings.EXPORT_SETTINGS_SCHEMA, EXPORT_DEFAULTS: settings.DEFAULTS, EXPORT_KEYS: settings.KEYS, readExportParams: settings.readExportParams,
};
