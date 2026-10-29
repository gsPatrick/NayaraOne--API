'use strict';

const { govError } = require('../../governance.errors');

/**
 * Parâmetros da exportação (M9-D822; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv). O prazo do arquivo NÃO está aqui: é o
 * `max_expiry_hours` da política da classe (governanca.dlp.expiracao_horas_da_classe, M9-D820).
 *  - formatos: quais formatos a empresa aceita em POST /exports (o livro prevê CSV, XLSX e PDF).
 *  - csv_separador: separador das colunas do CSV.
 *  - marca_dagua.texto / marca_dagua.texto_csv: texto da marca d'água (XLSX/PDF) e a linha final do CSV; {usuario}, {data} e {job} são trocados na geração.
 *  - mascara_texto: o que sai no lugar de uma coluna que a pessoa não pode ver em claro (máscara FULL).
 *  - url_minutos: validade do endereço assinado de download (nunca passa da validade do arquivo).
 *  - job_expiracao_minutos / geracao_timeout_minutos: intervalo do exportExpiryJob e tempo máximo de um GENERATING antes de virar FAILED.
 */
const FORMATS_KEY = 'governanca.dlp.exportacao.formatos';
const SEPARATOR_KEY = 'governanca.dlp.exportacao.csv_separador';
const WM_TEXT_KEY = 'governanca.dlp.exportacao.marca_dagua.texto';
const WM_CSV_KEY = 'governanca.dlp.exportacao.marca_dagua.texto_csv';
const MASK_KEY = 'governanca.dlp.exportacao.mascara_texto';
const URL_MINUTES_KEY = 'governanca.dlp.exportacao.url_minutos';
const JOB_MINUTES_KEY = 'governanca.dlp.exportacao.job_expiracao_minutos';
const GEN_TIMEOUT_KEY = 'governanca.dlp.exportacao.geracao_timeout_minutos';

const ALL_FORMATS = Object.freeze(['CSV', 'XLSX', 'PDF']);
const SEPARATORS = Object.freeze({ PONTO_E_VIRGULA: ';', VIRGULA: ',', TAB: '\t' });

const EXPORT_SETTING_DEFAULTS = Object.freeze({
  [FORMATS_KEY]: 'CSV,XLSX,PDF',
  [SEPARATOR_KEY]: 'PONTO_E_VIRGULA',
  [WM_TEXT_KEY]: 'Nayara One · {usuario} · {data} · {job}',
  [WM_CSV_KEY]: '# Exportado por {usuario} em {data} (job {job})',
  [MASK_KEY]: '***',
  [URL_MINUTES_KEY]: 15,
  [JOB_MINUTES_KEY]: 15,
  [GEN_TIMEOUT_KEY]: 30,
});

function validateFormats(key, value) {
  const items = String(value).split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
  if (!items.length || items.some((v) => !ALL_FORMATS.includes(v))) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve listar formatos entre CSV, XLSX e PDF, separados por vírgula.`, { key, value });
  }
}
function validateSeparator(key, value) {
  if (!Object.keys(SEPARATORS).includes(String(value).toUpperCase())) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser PONTO_E_VIRGULA, VIRGULA ou TAB.`, { key, value });
  }
}
const validateText = (key, value) => {
  if (!String(value).trim() || String(value).length > 200) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ter de 1 a 200 caracteres.`, { key, value });
};

const EXPORT_SETTINGS_SCHEMA = {
  [FORMATS_KEY]: { type: 'string', validate: validateFormats },
  [SEPARATOR_KEY]: { type: 'string', validate: validateSeparator },
  [WM_TEXT_KEY]: { type: 'string', validate: validateText },
  [WM_CSV_KEY]: { type: 'string', validate: validateText },
  [MASK_KEY]: { type: 'string', validate: validateText },
  [URL_MINUTES_KEY]: { type: 'integer', min: 1, max: 1440 },
  [JOB_MINUTES_KEY]: { type: 'integer', min: 1, max: 1440 },
  [GEN_TIMEOUT_KEY]: { type: 'integer', min: 1, max: 1440 },
};

const intOr = (value, key) => (Number.isInteger(value) && value >= 1 ? value : EXPORT_SETTING_DEFAULTS[key]);
const textOr = (value, key) => (typeof value === 'string' && value.trim() ? value : EXPORT_SETTING_DEFAULTS[key]);

function parseFormats(value) {
  const list = [...new Set(String(typeof value === 'string' ? value : '').split(',').map((v) => v.trim().toUpperCase()).filter((v) => ALL_FORMATS.includes(v)))];
  return list.length ? list : EXPORT_SETTING_DEFAULTS[FORMATS_KEY].split(',');
}
const parseSeparator = (value) => SEPARATORS[String(value || '').toUpperCase()] || SEPARATORS[EXPORT_SETTING_DEFAULTS[SEPARATOR_KEY]];

/** "{usuario}" "{data}" "{job}" trocados pelos valores reais. */
const fillTemplate = (template, vars) => String(template).replace(/\{(usuario|data|job)\}/g, (_m, name) => String(vars[name] ?? ''));

module.exports = {
  FORMATS_KEY, SEPARATOR_KEY, WM_TEXT_KEY, WM_CSV_KEY, MASK_KEY, URL_MINUTES_KEY, JOB_MINUTES_KEY, GEN_TIMEOUT_KEY, ALL_FORMATS,
  EXPORT_SETTING_DEFAULTS, EXPORT_SETTINGS_SCHEMA, parseFormats, parseSeparator, fillTemplate, intOr, textOr,
};
