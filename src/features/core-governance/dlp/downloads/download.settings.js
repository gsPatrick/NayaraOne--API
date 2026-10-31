'use strict';

const { govError } = require('../../governance.errors');

/**
 * Parâmetros do download de anexos e da marca d'água de arquivo (M9-D920; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv). O prazo da
 * classe NÃO está aqui: é o `max_expiry_hours` da política EXPORT da classe (governanca.dlp.expiracao_horas_da_classe, M9-D820); o endereço vale o MENOR entre `url_min` e esse teto.
 *  - governanca.dlp.download.url_min: validade do endereço assinado de uso único do download de HIGH e RESTRICTED (padrão 15 minutos).
 *  - governanca.dlp.download.lote_max: quantos arquivos cabem num download em lote (zip).
 *  - governanca.dlp.marca.paginas_max: PDF com mais páginas que isto não recebe marca (o download marcado é recusado).
 *  - governanca.dlp.anexos.categoria_entidade: de que tabela do registro de classificação sai a classe de um anexo novo, por categoria do upload ("categoria: schema.tabela; ...").
 *    A classe padrão do anexo é a MAIOR entre as colunas dessa tabela; categoria sem tabela (anexo avulso) recebe governanca.dlp.classificacao_padrao (HIGH).
 */
const URL_MIN_KEY = 'governanca.dlp.download.url_min';
const BATCH_MAX_KEY = 'governanca.dlp.download.lote_max';
const WM_PAGES_KEY = 'governanca.dlp.marca.paginas_max';
const ENTITY_MAP_KEY = 'governanca.dlp.anexos.categoria_entidade';

const DOWNLOAD_SETTING_DEFAULTS = Object.freeze({
  [URL_MIN_KEY]: 15,
  [BATCH_MAX_KEY]: 200,
  [WM_PAGES_KEY]: 500,
  [ENTITY_MAP_KEY]: 'contracts: legal.contract_versions; contracts-signed: legal.contract_versions; inspections: legal.inspection_items; people-documents: people.person_documents; '
    + 'property-documents: real_estate.property_documents; insurance: procurement.insurance_policies; inventory-invoices: inventory.receipts; correspondent: correspondent.case_documents',
});

const PAIR = /^([a-z][a-z0-9-]{0,39})\s*:\s*([a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62})$/;
function parseEntityMap(value) {
  const out = {};
  for (const part of String(typeof value === 'string' ? value : '').split(';').map((p) => p.trim()).filter(Boolean)) {
    const match = PAIR.exec(part);
    if (!match) return null;
    out[match[1]] = match[2];
  }
  return out;
}
function validateEntityMap(key, value) {
  if (parseEntityMap(value) === null) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser uma lista "categoria: schema.tabela" separada por ponto e vírgula.`, { key, value });
}

const DOWNLOAD_SETTINGS_SCHEMA = {
  [URL_MIN_KEY]: { type: 'integer', min: 1, max: 1440 },
  [BATCH_MAX_KEY]: { type: 'integer', min: 1, max: 5000 },
  [WM_PAGES_KEY]: { type: 'integer', min: 1, max: 20000 },
  [ENTITY_MAP_KEY]: { type: 'string', validate: validateEntityMap },
};

const intOr = (value, key) => (Number.isInteger(value) && value >= 1 ? value : DOWNLOAD_SETTING_DEFAULTS[key]);
const entityMapOr = (value) => parseEntityMap(value) || parseEntityMap(DOWNLOAD_SETTING_DEFAULTS[ENTITY_MAP_KEY]);

module.exports = { URL_MIN_KEY, BATCH_MAX_KEY, WM_PAGES_KEY, ENTITY_MAP_KEY, DOWNLOAD_SETTING_DEFAULTS, DOWNLOAD_SETTINGS_SCHEMA, intOr, entityMapOr, parseEntityMap };
