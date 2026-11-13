'use strict';

/**
 * Data em texto que o servidor e o banco leem do MESMO jeito (rodada 8 da verificação do Marco 9, 12/11/2026; DI-M9R-25).
 *
 * O `Date.parse` do JavaScript aceita formas que o Postgres não aceita, ou lê diferente: "2026-02-30" vira 2 de março, "20261" vira o ano 20.261,
 * "0" vira o ano 2000, "0000-01-01" é o ano zero (que o Postgres recusa). E o Sequelize transforma o texto que não é data em "Invalid date", um valor
 * que o pedido não tem. A forma aceita na porta é a ISO 8601 que a tela e as integrações mandam:
 *   AAAA-MM-DD, opcionalmente seguida de T ou espaço, HH:MM, :SS, fração de segundo e fuso (Z ou ±HH:MM / ±HHMM),
 * com ano de 0001 a 9999, mês e dia que existem no calendário (inclusive o 29 de fevereiro só em ano bissexto), hora até 23, minuto e segundo até 59
 * e fuso até 14 horas.
 */
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):?(\d{2}))?)?$/;

function dataIsoValida(texto) {
  if (typeof texto !== 'string') return false;
  const m = ISO.exec(texto.trim());
  if (!m) return false;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (ano < 1 || mes < 1 || mes > 12 || dia < 1) return false;
  const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
  const dias = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1];
  if (dia > dias) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return false;
  if (m[8] !== undefined && (Number(m[8]) > 14 || Number(m[9]) > 59)) return false;
  return true;
}

module.exports = { dataIsoValida };
