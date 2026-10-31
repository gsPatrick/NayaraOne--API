'use strict';

const { govError } = require('../../governance.errors');

/**
 * Parâmetros da impressão (M9-D920; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.dlp.impressao.url_min: validade do endereço assinado do PDF de impressão (o menor entre isto e o teto da política PRINT da classe, quando ela tem um); padrão 15.
 *  - governanca.dlp.impressao.rodape: modelo do rodapé de todo PDF impresso; {usuario}, {data} e {documento} são trocados na geração.
 *  - governanca.dlp.impressao.fuso: fuso da data e hora do rodapé (padrão America/Sao_Paulo).
 */
const URL_MIN_KEY = 'governanca.dlp.impressao.url_min';
const FOOTER_KEY = 'governanca.dlp.impressao.rodape';
const TZ_KEY = 'governanca.dlp.impressao.fuso';

const PRINT_SETTING_DEFAULTS = Object.freeze({
  [URL_MIN_KEY]: 15,
  [FOOTER_KEY]: 'Impresso por {usuario} em {data} · documento {documento}',
  [TZ_KEY]: 'America/Sao_Paulo',
});

function validateFooter(key, value) {
  const text = String(value);
  if (!text.trim() || text.length > 200 || !text.includes('{usuario}') || !text.includes('{documento}')) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ter até 200 caracteres e conter {usuario} e {documento}.`, { key, value });
  }
}
const validZone = (zone) => { try { Intl.DateTimeFormat('pt-BR', { timeZone: zone }); return true; } catch (_e) { return false; } };
function validateZone(key, value) {
  if (!validZone(String(value))) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser um fuso horário válido (ex.: America/Sao_Paulo).`, { key, value });
}

const PRINT_SETTINGS_SCHEMA = {
  [URL_MIN_KEY]: { type: 'integer', min: 1, max: 1440 },
  [FOOTER_KEY]: { type: 'string', validate: validateFooter },
  [TZ_KEY]: { type: 'string', validate: validateZone },
};

const intOr = (value) => (Number.isInteger(value) && value >= 1 ? value : PRINT_SETTING_DEFAULTS[URL_MIN_KEY]);
const footerOr = (value) => (typeof value === 'string' && value.trim() && value.includes('{usuario}') ? value : PRINT_SETTING_DEFAULTS[FOOTER_KEY]);
const zoneOr = (value) => (typeof value === 'string' && validZone(value) ? value : PRINT_SETTING_DEFAULTS[TZ_KEY]);

/** "{usuario}" "{data}" "{documento}" trocados pelos valores reais. */
const fillFooter = (template, vars) => String(template).replace(/\{(usuario|data|documento)\}/g, (_m, name) => String(vars[name] ?? ''));

module.exports = { URL_MIN_KEY, FOOTER_KEY, TZ_KEY, PRINT_SETTING_DEFAULTS, PRINT_SETTINGS_SCHEMA, intOr, footerOr, zoneOr, fillFooter };
