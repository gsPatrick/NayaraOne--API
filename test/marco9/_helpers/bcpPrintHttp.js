'use strict';

// Apoio dos testes de impressão do BCP (M9-D834): GET que devolve o corpo bruto (PDF), sem interpretar como JSON. Não é teste.
async function getRaw(http, who, path) {
  const res = await fetch(`${http.baseUrl}${path}`, { headers: { Authorization: `Bearer ${http.tokens[who]}` } });
  const buffer = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, buffer, json: type.includes('json') ? JSON.parse(buffer.toString('utf8')) : null };
}

/** Quantidade de páginas de um PDF do pdfkit (objetos /Type /Page, sem contar /Pages). */
const pageCount = (buffer) => (buffer.toString('latin1').match(/\/Type \/Page(?![s\w])/g) || []).length;

module.exports = { getRaw, pageCount };
