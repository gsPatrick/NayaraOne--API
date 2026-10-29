'use strict';

const { getSetting } = require('../../../settings/settings.service');
const settings = require('../dlp.settings');
const { listEntries } = require('./exports.catalog');
const { readExportParams } = require('./export.params');

const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, settings.DLP_SETTING_DEFAULTS[key]);

/**
 * GET /exports/catalog: o que a tela de exportação precisa para montar o pedido — recursos com formatos e colunas (com a classe de cada uma), só os que a pessoa pode pedir
 * (permissão do módulo de origem), as finalidades aceitas, o mínimo da justificativa e os formatos que a empresa liga.
 */
async function getExportCatalog({ tenant, permissions, transaction }) {
  const params = await readExportParams(tenant, transaction);
  const resources = listEntries().filter((entry) => (permissions || []).includes(entry.permission)).map((entry) => ({ ...entry, formats: entry.formats.filter((f) => params.formats.includes(f)) }));
  return {
    resources,
    purposes: settings.parsePurposes(await read(settings.PURPOSES_KEY, tenant, transaction)),
    justificationMin: settings.parseJustificationMin(await read(settings.JUSTIFICATION_MIN_KEY, tenant, transaction)),
    formats: params.formats,
  };
}

module.exports = { getExportCatalog };
