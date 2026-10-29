'use strict';

const { TIME_ZONE } = require('./budgets.constants');

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function zonedParts(date) {
  const p = Object.fromEntries(formatter.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}

/** Instante UTC em que o relógio de America/Sao_Paulo marca 00:00 do dia 1 do mês (ano, mês 1-12). */
function monthStartUtc(year, month) {
  const guess = Date.UTC(year, month - 1, 1, 0, 0, 0);
  // O fuso muda pouco: parte do palpite UTC e corrige pela diferença entre o relógio local e o alvo, duas vezes.
  let instant = guess;
  for (let i = 0; i < 2; i += 1) {
    const z = zonedParts(new Date(instant));
    const shown = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
    instant -= shown - guess;
  }
  return new Date(instant);
}

/** Período mensal que contém `at`: { start, end } (end exclusivo = 00:00 do dia 1 seguinte), no fuso do livro. */
function monthPeriodOf(at = new Date()) {
  const z = zonedParts(at);
  const nextYear = z.month === 12 ? z.year + 1 : z.year;
  const nextMonth = z.month === 12 ? 1 : z.month + 1;
  return { start: monthStartUtc(z.year, z.month), end: monthStartUtc(nextYear, nextMonth) };
}

module.exports = { monthPeriodOf, monthStartUtc };
