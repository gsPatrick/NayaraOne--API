'use strict';

/**
 * M9-D701 (3.1 e 3.3) — arquivo CSV da exportação (o livro não fixa o formato; CSV é o mínimo para levar o dado para fora): UTF-8 com BOM (abre
 * certo no Excel), separador `;` e fim de linha CRLF. Antes da tabela vai o cabeçalho de rastreabilidade em linhas `# chave: valor`
 * (indicador, versão, período, sourceSnapshotAt, freshness, status de qualidade, usuário). Célula que começa com = + - @ ganha apóstrofo
 * na frente: planilha nunca executa fórmula vinda do dado (CSV injection).
 */
const crypto = require('node:crypto');

const BOM = '﻿';
const EOL = '\r\n';
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(text) && !/^-?\d+([.,]\d+)?$/.test(text)) text = `'${text}`; // número negativo legítimo não é fórmula
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const line = (values) => values.map(cell).join(';');

/** header: [[chave, valor]]; columns: nomes; rows: lista de objetos { coluna: valor }. Devolve { buffer, sha256, rowCount }. */
function buildCsv({ header, columns, rows }) {
  const lines = header.map(([key, value]) => `# ${String(key).replace(/[\r\n]/g, ' ')}: ${String(value ?? '').replace(/[\r\n]/g, ' ')}`);
  lines.push(line(columns));
  for (const row of rows) lines.push(line(columns.map((c) => row[c])));
  const buffer = Buffer.from(BOM + lines.join(EOL) + EOL, 'utf8');
  return { buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), rowCount: rows.length };
}

module.exports = { buildCsv, cell };
