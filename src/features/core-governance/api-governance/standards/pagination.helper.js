'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { PAGE_SIZE_KEY, STANDARDS_SETTING_DEFAULTS } = require('./standards.settings');
const { paginationInvalid } = require('./standards.errors');

/**
 * Paginação única (M9-D843 §3.2): `page` (a partir de 1) e `pageSize` (1 a 200; padrão do parâmetro governanca.api.paginacao.tamanho_padrao, 50). Valor inválido: 400
 * GOV_VALIDATION_PAGINATION; pageSize acima de 200 é recusado, nunca cortado em silêncio. Resposta: `pagination: {page, pageSize, total, totalPages}` (success() já suporta).
 */
const MAX_PAGE_SIZE = 200;
const INTEGER = /^\d+$/;

/** Confere os parâmetros de paginação de uma query (só os que vieram). Devolve { page, pageSize } com `undefined` no que não veio. */
function checkPagination(query = {}) {
  const out = {};
  const problems = [];
  for (const [name, max] of [['page', Number.MAX_SAFE_INTEGER], ['pageSize', MAX_PAGE_SIZE]]) {
    const raw = query[name];
    if (raw === undefined) continue;
    const text = Array.isArray(raw) ? null : String(raw).trim();
    const value = text !== null && INTEGER.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) problems.push({ field: name, value: Array.isArray(raw) ? raw : String(raw), reason: name === 'pageSize' ? `deve ser inteiro de 1 a ${MAX_PAGE_SIZE}` : 'deve ser inteiro maior ou igual a 1' });
    else out[name] = value;
  }
  if (problems.length) throw paginationInvalid({ problems });
  return out;
}

/** page, pageSize, limit e offset prontos para a consulta; o tamanho padrão vem do parâmetro da empresa. */
async function parsePagination(query, tenant, transaction, moduleDefault) {
  const checked = checkPagination(query);
  // `moduleDefault`: tamanho padrão próprio do módulo (parâmetro dele, já lido); sem ele vale governanca.api.paginacao.tamanho_padrao. Nunca passa de MAX_PAGE_SIZE.
  const given = Number(moduleDefault);
  const fallback = Number.isInteger(given) && given > 0 ? Math.min(given, MAX_PAGE_SIZE) : Number(await getSetting(PAGE_SIZE_KEY, tenant, transaction, STANDARDS_SETTING_DEFAULTS[PAGE_SIZE_KEY]));
  const page = checked.page || 1;
  const pageSize = checked.pageSize || fallback;
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

const buildPagination = ({ page, pageSize, total }) => ({ page, pageSize, total, totalPages: Math.ceil(total / pageSize) });

/** Resultado de lista no formato único: `items` da página e o bloco `pagination` {page,pageSize,total,totalPages}. */
const pageResult = (items, paging, total) => ({ items, pagination: buildPagination({ page: paging.page, pageSize: paging.pageSize, total }) });

/** Lista pequena já em memória (catálogo fixo): recorta a página pedida e devolve no formato único. */
const pageOfArray = (rows, paging) => pageResult(rows.slice(paging.offset, paging.offset + paging.pageSize), paging, rows.length);

/** Middleware: recusa page/pageSize inválidos antes do handler (aplicado às rotas de governança). */
function paginationGuard(req, _res, next) {
  try { checkPagination(req.query); return next(); } catch (error) { return next(error); }
}

module.exports = { MAX_PAGE_SIZE, checkPagination, parsePagination, buildPagination, pageResult, pageOfArray, paginationGuard };
