'use strict';

const AppError = require('../../utils/AppError');

/**
 * Catálogo de papéis da pessoa (M3-02 / CRMX-002, DI-M3PE-2). Livro §2: "A mesma pessoa pode ser cliente, proprietário, vendedor, locatário,
 * fornecedor etc." Os cinco papéis citados pelo livro são obrigatórios no catálogo (o administrador não os retira); o "etc." é a parte
 * configurável: o administrador acrescenta papéis e muda os rótulos em Configurações > Pessoas (`people.papeis`).
 *
 * Formato do parâmetro: itens `CODIGO=Rótulo` separados por vírgula. Código em maiúsculas (letras, números e _), até 40 caracteres, sem
 * repetir; rótulo de 1 a 60 caracteres. Retirar um papel do catálogo não apaga o papel de quem já o tem: só impede atribuí-lo de novo.
 */
const ROLES_KEY = 'people.papeis';
const BOOK_ROLES = Object.freeze(['CLIENTE', 'PROPRIETARIO', 'VENDEDOR', 'LOCATARIO', 'FORNECEDOR']);
// Padrão = os cinco do livro mais os que o sistema já aceitava antes (comportamento atual), na mesma ordem da tela.
const DEFAULT_ROLES =
  'CLIENTE=Cliente, PROPRIETARIO=Proprietário, VENDEDOR=Vendedor, LOCATARIO=Locatário, FORNECEDOR=Fornecedor, CORRETOR=Corretor, ' +
  'COMPRADOR=Comprador, FIADOR=Fiador, COLABORADOR=Colaborador, LOCADOR=Locador';
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

/** Lê o texto do parâmetro como [{ code, label }]; lança 400 SETTING_INVALID_VALUE com o motivo quando o texto não serve. */
function parseRoles(text, key = ROLES_KEY) {
  const invalid = (motivo) => AppError.badRequest(`O valor de "${key}" é inválido: ${motivo}`, 'SETTING_INVALID_VALUE', { key });
  const items = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw invalid('informe pelo menos os papéis do livro.');
  const seen = new Set();
  const roles = items.map((item) => {
    const eq = item.indexOf('=');
    const code = (eq === -1 ? item : item.slice(0, eq)).trim().toUpperCase();
    const label = (eq === -1 ? code : item.slice(eq + 1)).trim();
    if (!CODE.test(code)) throw invalid(`o código "${code}" deve ter só letras maiúsculas, números e _ (até 40 caracteres).`);
    if (!label || label.length > 60) throw invalid(`o rótulo do papel ${code} deve ter de 1 a 60 caracteres.`);
    if (seen.has(code)) throw invalid(`o papel ${code} aparece mais de uma vez.`);
    seen.add(code);
    return { code, label };
  });
  const missing = BOOK_ROLES.filter((code) => !seen.has(code));
  if (missing.length) throw invalid(`os papéis citados no livro não podem sair do catálogo: ${missing.join(', ')}.`);
  return roles;
}

const PEOPLE_ROLES_SETTINGS_SCHEMA = Object.freeze({
  [ROLES_KEY]: { type: 'string', validate: (key, value) => { parseRoles(value, key); } },
});

/** Catálogo vigente da empresa. Valor gravado que não serve mais (não deveria acontecer: a escrita valida) cai no padrão. */
async function readRoleCatalog(tenant, transaction) {
  const { getSetting } = require('../settings/settings.service');
  const raw = await getSetting(ROLES_KEY, tenant, transaction, DEFAULT_ROLES);
  try {
    return parseRoles(raw);
  } catch (err) {
    return parseRoles(DEFAULT_ROLES);
  }
}

module.exports = { ROLES_KEY, BOOK_ROLES, DEFAULT_ROLES, PEOPLE_ROLES_SETTINGS_SCHEMA, parseRoles, readRoleCatalog };
