'use strict';

/**
 * Serialização canônica de uma linha (M9-D905 §3.1). Campos na ordem do esquema da entidade; cada valor vira `<comprimento em bytes UTF-8>:<valor>`; nulo é o byte único
 * 0x00 (a cadeia vazia é `0:`, portanto diferente do nulo); o separador de campo é 0x1F. Texto em NFC e sem espaços nas pontas; inteiro em decimal sem `+`; dinheiro em
 * centavos inteiros; datas e instantes em ISO 8601 UTC com milissegundos; booleano 1/0; decimal na escala do esquema, sem expoente, `-` quando negativo.
 */
const SEPARATOR = Buffer.from([0x1f]);
const NULL_BYTE = Buffer.from([0x00]);

const prefixed = (text) => {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from(`${bytes.length}:`, 'utf8'), bytes]);
};

function integerText(value, label) {
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) throw new Error(`Valor inválido para ${label}: ${text}.`);
  return BigInt(text.replace(/^\+/, '')).toString();
}

/** Decimal em texto com a escala pedida (arredonda para longe do zero, como o banco; "-0,00" vira "0,00"). Aceita notação científica. */
function decimalText(value, scale) {
  const match = /^([+-]?)(\d*)\.?(\d*)(?:[eE]([+-]?\d+))?$/.exec(String(value).trim());
  if (!match || (match[2] === '' && match[3] === '')) throw new Error(`Decimal inválido: ${value}.`);
  const places = Number(scale) || 0;
  const negative = match[1] === '-';
  let digits = (match[2] || '0') + match[3];
  let point = (match[2] || '0').length + Number(match[4] || 0);
  if (point < 0) { digits = '0'.repeat(-point) + digits; point = 0; }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const whole = digits.slice(0, point) || '0';
  const fraction = digits.slice(point);
  const scaled = fraction.length <= places
    ? BigInt(whole + fraction.padEnd(places, '0'))
    : BigInt(whole + fraction.slice(0, places)) + (fraction.charCodeAt(places) - 48 >= 5 ? 1n : 0n);
  const padded = scaled.toString().padStart(places + 1, '0');
  const body = places ? `${padded.slice(0, -places)}.${padded.slice(-places)}` : padded;
  return (negative && scaled !== 0n ? '-' : '') + body;
}

function instantText(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Instante inválido: ${value}.`);
  return date.toISOString();
}

/** Data de calendário (sem hora) como instante UTC à meia-noite. */
function dateText(value) {
  if (value instanceof Date) return `${value.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  if (!match || Number.isNaN(Date.parse(`${match[1]}T00:00:00.000Z`))) throw new Error(`Data inválida: ${value}.`);
  return `${match[1]}T00:00:00.000Z`;
}

function boolText(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return '1';
  if (value === false || value === 0 || value === '0' || value === 'false') return '0';
  throw new Error(`Booleano inválido: ${value}.`);
}

/** Um valor no formato canônico (Buffer). `type`: text, int, money, decimal, bool, instant, date. */
function serializeValue(type, value, scale) {
  if (value === null || value === undefined) return NULL_BYTE;
  switch (type) {
    case 'text': return prefixed(String(value).normalize('NFC').trim());
    case 'int': return prefixed(integerText(value, 'inteiro'));
    case 'money':
      if (typeof value === 'number' && !Number.isInteger(value)) throw new Error('Dinheiro deve vir em centavos inteiros.');
      if (typeof value === 'string' && !/^[+-]?\d+$/.test(value.trim())) throw new Error('Dinheiro deve vir em centavos inteiros.');
      return prefixed(integerText(value, 'dinheiro'));
    case 'decimal': return prefixed(decimalText(value, scale));
    case 'bool': return prefixed(boolText(value));
    case 'instant': return prefixed(instantText(value));
    case 'date': return prefixed(dateText(value));
    default: throw new Error(`Tipo canônico desconhecido: ${type}.`);
  }
}

/** A linha inteira: os campos do esquema, na ordem, separados por 0x1F. */
function canonicalLine(fields, values) {
  const parts = [];
  fields.forEach((def, index) => {
    if (index) parts.push(SEPARATOR);
    parts.push(serializeValue(def.type, values[def.field], def.scale));
  });
  return Buffer.concat(parts);
}

module.exports = { serializeValue, canonicalLine, decimalText, SEPARATOR, NULL_BYTE };
