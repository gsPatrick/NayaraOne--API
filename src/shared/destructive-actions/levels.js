'use strict';

const AppError = require('../../utils/AppError');
const inventory = require('./inventory');

const invalid = (key, message) => AppError.badRequest(message, 'SETTING_INVALID_VALUE', { key });

/**
 * Nível de confirmação por ação (M9-D852 §3.1): o padrão é o do livro (inventário); o administrador pode mudar chave a chave no
 * parâmetro `governanca.ui.confirmacao_por_nivel`, texto no formato `chave=nível; chave=nível` (1 simples, 2 com impacto, 3 crítica).
 */
const LEVELS_KEY = 'governanca.ui.confirmacao_por_nivel';

const defaultLevelsText = () => inventory.all().map((a) => `${a.key}=${a.level}`).join('; ');

function parseLevels(text) {
  const map = new Map();
  for (const part of String(text || '').split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const [key, value] = piece.split('=').map((s) => s.trim());
    map.set(key, Number(value));
  }
  return map;
}

/** Validação do parâmetro (SETTINGS_SCHEMA): só chaves do inventário, níveis 1 a 3 e nunca abaixo do nível do livro. */
function validateLevelsText(settingKey, value) {
  if (typeof value !== 'string') throw invalid(settingKey, `"${settingKey}" deve ser um texto.`);
  const known = new Set(inventory.all().map((a) => a.key));
  for (const part of value.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const match = /^([a-z0-9_.]+)\s*=\s*([123])$/.exec(piece);
    if (!match) throw invalid(settingKey, `"${settingKey}": use o formato chave=nível com nível 1, 2 ou 3 (trecho "${piece}").`);
    if (!known.has(match[1])) throw invalid(settingKey, `"${settingKey}": a ação "${match[1]}" não existe no inventário.`);
    // R4-L1: o nível do livro é o piso; o administrador só pode endurecer a confirmação, nunca afrouxá-la.
    if (Number(match[2]) < inventory.get(match[1]).level) throw invalid(settingKey, `"${settingKey}": a ação "${match[1]}" não pode ficar abaixo do nível ${inventory.get(match[1]).level} do livro.`);
  }
}

function effectiveLevel(key, text) {
  const level = parseLevels(text).get(key);
  return [1, 2, 3].includes(level) ? level : inventory.get(key).level;
}

module.exports = { LEVELS_KEY, defaultLevelsText, parseLevels, validateLevelsText, effectiveLevel };
