'use strict';

const AppError = require('../../utils/AppError');

/**
 * Parâmetros da exportação de oportunidades do CRM (DEC-049 / X45-D018, Maturacao/demandas/parametros.csv; livro do Marco 3 §18 "Exportar
 * base de clientes — Permissão, MFA, volume limit, audit"; M3-21, CRM-TS-013), lidos pelo catálogo `crm.opportunities` do DLP
 * (core-governance/dlp/exports/catalog/crmOpportunities.js):
 *   - `exportacao.crm.linhas_maximo` (padrão 5000, 1 a 100.000): teto de linhas da exportação de oportunidades. Vale junto com o teto da
 *     classe HIGH da política de DLP: o menor dos dois manda; acima, o pedido é recusado (422 GOV_DLP_VOLUME_EXCEEDED), nunca truncado.
 *   - `exportacao.crm.exige_mfa` (padrão Ligado; alterar exige MFA): o livro manda MFA na exportação da base de clientes e o piso do DLP
 *     (M9-D820) não deixa a classe HIGH sem MFA, então o valor Desligado é recusado (400 SETTING_INVALID_VALUE, como todo valor inválido
 *     de parâmetro) — a chave existe para o catálogo e para a tela mostrarem a regra, não para afrouxá-la (DI-M3CB-6).
 */
const KEYS = Object.freeze({ maxRows: 'exportacao.crm.linhas_maximo', requireMfa: 'exportacao.crm.exige_mfa' });
const CRM_EXPORT_DEFAULTS = Object.freeze({ [KEYS.maxRows]: 5000, [KEYS.requireMfa]: true });
const LIMITS = Object.freeze({ min: 1, max: 100000 });

const CRM_EXPORT_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.maxRows]: { type: 'integer', min: LIMITS.min, max: LIMITS.max },
  [KEYS.requireMfa]: {
    type: 'boolean',
    requiresMfa: true,
    validate: (key, value) => {
      if (value !== true) {
        throw AppError.badRequest('A exportação da base de clientes sempre exige MFA (livro do Marco 3, §18): este parâmetro não pode ser desligado.', 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
});

// settings.service.js importa este arquivo (SETTINGS_SCHEMA): a leitura é carregada na hora do uso, para não fechar um ciclo.
const getSetting = (...args) => require('../settings/settings.service').getSetting(...args);

/** Teto de linhas da exportação de oportunidades da empresa; valor gravado fora da faixa vale o padrão. */
async function readCrmExportMaxRows(tenant, transaction) {
  const value = Number(await getSetting(KEYS.maxRows, tenant, transaction, CRM_EXPORT_DEFAULTS[KEYS.maxRows]));
  return Number.isInteger(value) && value >= LIMITS.min && value <= LIMITS.max ? value : CRM_EXPORT_DEFAULTS[KEYS.maxRows];
}

module.exports = { KEYS, CRM_EXPORT_DEFAULTS, CRM_EXPORT_SETTINGS_SCHEMA, readCrmExportMaxRows };
