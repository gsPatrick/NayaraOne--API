'use strict';

const { getSetting } = require('../../settings/settings.service');
const scale = require('../../../shared/data-classification/scale');
const repository = require('./classification.repository');
const { ensureRegistry } = require('./classification.seed');
const settings = require('./fieldAccess.settings');
const rules = require('./fieldAccess.rules');
const { applyMasking } = require('./fieldAccess.mask');
const { normalizeKey } = require('../dlp/view.fields');

/**
 * Ligação da tela e da API ao registro de classificação (M9-D915 §3.2). A política de VIEW (M9-D825) varre a resposta atrás dos campos HIGH e RESTRICTED do tipo de recurso;
 * aqui o registro passa a ser a fonte desses campos (as tabelas de cada tipo vêm de `governanca.dlp.view.tabelas`) e a dona da MÁSCARA de cada campo.
 */
async function rowsOf(tenant, resourceType, transaction) {
  const text = await getSetting(settings.VIEW_TABLES_KEY, tenant, transaction, settings.FIELD_ACCESS_SETTING_DEFAULTS[settings.VIEW_TABLES_KEY]);
  const tables = settings.tablesOf(text)[resourceType] || [];
  const rows = await repository.ofTables(tenant, tables, transaction);
  if (rows.length || !tables.length) return rows;
  // Empresa que ainda não teve o registro criado (ele nasce no primeiro uso): cria agora, para a tela não sair sem a máscara do registro.
  await ensureRegistry(tenant, transaction);
  return repository.ofTables(tenant, tables, transaction);
}

/** { campo: classe } dos campos HIGH e RESTRICTED do tipo, na chave do registro (snake_case; a comparação ignora maiúsculas e `_`). */
async function registryFields(tenant, resourceType, transaction) {
  const out = {};
  for (const row of await rowsOf(tenant, resourceType, transaction)) {
    if (rules.isSensitive(row.classification)) out[row.column] = scale.highest([out[row.column], row.classification]);
  }
  return out;
}

/** { specs: { chaveNormalizada: { masking, maskPattern, classification, column } }, maskText } dos campos sensíveis do tipo. */
async function maskSpecs(tenant, resourceType, transaction) {
  const specs = {};
  for (const row of await rowsOf(tenant, resourceType, transaction)) {
    if (rules.isSensitive(row.classification)) specs[normalizeKey(row.column)] = { masking: rules.effectiveMasking(row, 'SCREEN'), maskPattern: row.maskPattern, classification: row.classification, column: row.column };
  }
  const text = await getSetting(settings.MASK_TEXT_KEY, tenant, transaction, settings.FIELD_ACCESS_SETTING_DEFAULTS[settings.MASK_TEXT_KEY]);
  return { specs, maskText: settings.maskTextOf(text) };
}

/** Valor mascarado conforme o registro; campo sem linha no registro (só listado no parâmetro de campos) vale a máscara parcial padrão. */
function maskByRegistry(value, spec, ctx) {
  const used = spec || { masking: 'PARTIAL', maskPattern: null, column: ctx.key };
  return applyMasking(value, used.masking, { field: used.column, maskPattern: used.maskPattern, companyId: ctx.companyId, maskText: ctx.maskText });
}

module.exports = { registryFields, maskSpecs, maskByRegistry };
