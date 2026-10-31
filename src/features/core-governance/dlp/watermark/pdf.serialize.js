'use strict';

/** Escreve de volta a estrutura do leitor (pdf.lexer.js) como texto de objeto PDF. Strings saem em hexadecimal para não depender de escape. */
function serialize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  if (Array.isArray(value)) return `[${value.map(serialize).join(' ')}]`;
  if (value.name !== undefined) return `/${String(value.name).replace(/[^A-Za-z0-9._-]/g, (ch) => `#${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
  if (value.ref !== undefined) return `${value.ref} ${value.gen || 0} R`;
  if (value.str !== undefined) return `<${value.str.toString('hex')}>`;
  if (value.dict) return `<<${Object.entries(value.dict).map(([key, inner]) => `${serialize({ name: key })} ${serialize(inner)}`).join(' ')}>>`;
  throw new Error('valor PDF desconhecido');
}

module.exports = { serialize };
