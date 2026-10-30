'use strict';

const { keyForbidden } = require('./storage.errors');

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_SUFFIX = '.meta';

/**
 * Chave de objeto (M9-D242 3.1): sempre `company/<id da empresa>/<caminho>`. O prefixo é conferido contra a empresa de quem chama (nunca contra o que o
 * cliente mandou): chave de outra empresa, caminho com `..`, segmento vazio ou fora do alfabeto seguro, ou o sufixo reservado dos metadados, vira 403
 * INTEGRATION_STORAGE_KEY_FORBIDDEN. Devolve o caminho relativo (sem o prefixo).
 */
function assertCompanyKey(companyId, key) {
  const id = String(companyId || '').toLowerCase();
  const k = String(key || '');
  if (!id) throw keyForbidden('NO_COMPANY');
  const prefixo = `company/${id}/`;
  if (!k.toLowerCase().startsWith(prefixo)) throw keyForbidden('PREFIX');
  const resto = k.slice(prefixo.length);
  const segmentos = resto.split('/');
  if (!resto || segmentos.some((s) => !s || s === '.' || s === '..' || !SEGMENT_RE.test(s))) throw keyForbidden('PATH');
  if (resto.endsWith(RESERVED_SUFFIX)) throw keyForbidden('RESERVED');
  return resto;
}

/** Monta a chave da empresa a partir de um caminho relativo já seguro. */
const buildKey = (companyId, relative) => `company/${String(companyId).toLowerCase()}/${relative}`;

module.exports = { assertCompanyKey, buildKey, RESERVED_SUFFIX };
