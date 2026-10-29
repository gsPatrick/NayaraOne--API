'use strict';

const { getSetting } = require('../../../settings/settings.service');
const s = require('./export.settings');

const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, s.EXPORT_SETTING_DEFAULTS[key]);

/** Parâmetros da exportação da empresa, já convertidos (formatos aceitos, separador do CSV, modelos da marca d'água, máscara, validade do endereço e dos jobs). */
async function readExportParams(tenant, transaction) {
  return {
    formats: s.parseFormats(await read(s.FORMATS_KEY, tenant, transaction)),
    separator: s.parseSeparator(await read(s.SEPARATOR_KEY, tenant, transaction)),
    watermarkText: s.textOr(await read(s.WM_TEXT_KEY, tenant, transaction), s.WM_TEXT_KEY),
    watermarkCsv: s.textOr(await read(s.WM_CSV_KEY, tenant, transaction), s.WM_CSV_KEY),
    maskText: s.textOr(await read(s.MASK_KEY, tenant, transaction), s.MASK_KEY),
    urlMinutes: s.intOr(await read(s.URL_MINUTES_KEY, tenant, transaction), s.URL_MINUTES_KEY),
    jobMinutes: s.intOr(await read(s.JOB_MINUTES_KEY, tenant, transaction), s.JOB_MINUTES_KEY),
    generationTimeoutMinutes: s.intOr(await read(s.GEN_TIMEOUT_KEY, tenant, transaction), s.GEN_TIMEOUT_KEY),
  };
}

module.exports = { readExportParams };
