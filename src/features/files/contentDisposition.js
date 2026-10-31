'use strict';

/** Cabeçalho Content-Disposition: versão simples (ASCII) para navegadores antigos e a versão UTF-8 (RFC 5987) com acentos. */
function contentDisposition(disposition, fileName) {
  const clean = String(fileName || 'arquivo').replace(/[\r\n"\\]/g, '_');
  const ascii = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

module.exports = { contentDisposition };
