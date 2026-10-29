'use strict';

const { TIME_ZONE } = require('../bcp.constants');
const { parseOccurredAt } = require('../bcp.time');

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const minuteFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Normalizações usadas na conferência papel x comando (M9-D832 §3.5): comparação exata, sem tolerância, depois de igualar a forma. */
const text = (v) => (v === undefined || v === null ? '' : String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim());
const digits = (v) => (v === undefined || v === null ? '' : String(v).replace(/\D/g, ''));
const id = (v) => (v === undefined || v === null ? '' : String(v).toLowerCase());
const cents = (decimalOrCents, { fromDecimal = false } = {}) => (decimalOrCents === undefined || decimalOrCents === null || decimalOrCents === '' ? null : (fromDecimal ? Math.round(Number(decimalOrCents) * 100) : Number(decimalOrCents)));
/** Dia (AAAA-MM-DD) no relógio de America/Sao_Paulo; data pura do papel vale como está. */
const day = (v) => {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const date = v instanceof Date ? v : parseOccurredAt(String(v));
  return date && !Number.isNaN(date.getTime()) ? dayFormatter.format(date) : '';
};
/** Data e hora (AAAA-MM-DD HH:MM) no relógio de Brasília; texto sem fuso do papel é horário de Brasília. */
const minute = (v) => {
  const date = v instanceof Date ? v : parseOccurredAt(String(v || ''));
  return date && !Number.isNaN(date.getTime()) ? minuteFormatter.format(date).replace(',', '') : '';
};

/** Meio-dia de Brasília da data pura do papel (evita virar o dia por causa do fuso ao gravar um instante). */
const noonOf = (dayText) => parseOccurredAt(`${dayText}T12:00`);

module.exports = { text, digits, id, cents, day, minute, noonOf };
