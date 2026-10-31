'use strict';

const { getSetting } = require('../../../settings/settings.service');
const s = require('./print.settings');
const exportSettings = require('../exports/export.settings');

const read = (key, tenant, transaction, defaults) => getSetting(key, tenant, transaction, defaults[key]);

/** Parâmetros da impressão da empresa: validade do endereço, modelo do rodapé, fuso, modelo da marca d'água (o da exportação, M9-D822) e o texto da máscara. */
async function readPrintParams(tenant, transaction) {
  return {
    urlMinutes: s.intOr(await read(s.URL_MIN_KEY, tenant, transaction, s.PRINT_SETTING_DEFAULTS)),
    footer: s.footerOr(await read(s.FOOTER_KEY, tenant, transaction, s.PRINT_SETTING_DEFAULTS)),
    timeZone: s.zoneOr(await read(s.TZ_KEY, tenant, transaction, s.PRINT_SETTING_DEFAULTS)),
    watermarkText: exportSettings.textOr(await read(exportSettings.WM_TEXT_KEY, tenant, transaction, exportSettings.EXPORT_SETTING_DEFAULTS), exportSettings.WM_TEXT_KEY),
    maskText: exportSettings.textOr(await read(exportSettings.MASK_KEY, tenant, transaction, exportSettings.EXPORT_SETTING_DEFAULTS), exportSettings.MASK_KEY),
  };
}

module.exports = { readPrintParams };
