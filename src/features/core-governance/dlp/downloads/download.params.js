'use strict';

const { getSetting } = require('../../../settings/settings.service');
const s = require('./download.settings');
const exportSettings = require('../exports/export.settings');

const read = (key, tenant, transaction, defaults) => getSetting(key, tenant, transaction, defaults[key]);

/** Parâmetros do download da empresa, já convertidos (validade do endereço, tamanho do lote, páginas da marca, modelo do texto da marca, tabela do registro por categoria de upload). */
async function readDownloadParams(tenant, transaction) {
  return {
    urlMinutes: s.intOr(await read(s.URL_MIN_KEY, tenant, transaction, s.DOWNLOAD_SETTING_DEFAULTS), s.URL_MIN_KEY),
    batchMax: s.intOr(await read(s.BATCH_MAX_KEY, tenant, transaction, s.DOWNLOAD_SETTING_DEFAULTS), s.BATCH_MAX_KEY),
    watermarkPages: s.intOr(await read(s.WM_PAGES_KEY, tenant, transaction, s.DOWNLOAD_SETTING_DEFAULTS), s.WM_PAGES_KEY),
    watermarkText: exportSettings.textOr(await read(exportSettings.WM_TEXT_KEY, tenant, transaction, exportSettings.EXPORT_SETTING_DEFAULTS), exportSettings.WM_TEXT_KEY),
    entityMap: s.entityMapOr(await read(s.ENTITY_MAP_KEY, tenant, transaction, s.DOWNLOAD_SETTING_DEFAULTS)),
  };
}

module.exports = { readDownloadParams };
