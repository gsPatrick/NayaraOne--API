'use strict';

const { HEADERS_NEVER_STORED } = require('./inbox.constants');

/** Só os cabeçalhos da lista permitida (nome em minúsculas), nunca authorization/cookie, valores curtos. */
function pickHeaders(headers, allowlist) {
  const out = {};
  const permitidos = new Set((allowlist || []).map((h) => String(h).toLowerCase()));
  Object.entries(headers || {}).forEach(([nome, valor]) => {
    const chave = String(nome).toLowerCase();
    if (!permitidos.has(chave) || HEADERS_NEVER_STORED.includes(chave)) return;
    out[chave] = String(Array.isArray(valor) ? valor.join(',') : valor).slice(0, 300);
  });
  return out;
}

module.exports = { pickHeaders };
