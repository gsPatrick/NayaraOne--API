'use strict';

/**
 * Dias úteis do bloco de governança (M9-D833 §3.3): segunda a sexta, exceto as datas do parâmetro `governanca.calendario.feriados` (lista de datas ISO). Parâmetro vazio =
 * os feriados nacionais do ano (calculados, sem tabela fixa: a Sexta-feira Santa vem da Páscoa). Datas sempre como texto AAAA-MM-DD, sem fuso (dia de calendário).
 */
const pad = (n) => String(n).padStart(2, '0');
const iso = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const parse = (text) => new Date(`${text}T00:00:00Z`);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Domingo de Páscoa (algoritmo gregoriano anônimo), em UTC. */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** Feriados nacionais do ano: 1/1, Sexta-feira Santa, 21/4, 1/5, 7/9, 12/10, 2/11, 15/11, 20/11 (desde 2024) e 25/12. */
function nationalHolidays(year) {
  const goodFriday = new Date(easterSunday(year).getTime() - 2 * 86400000);
  const fixed = [`${year}-01-01`, `${year}-04-21`, `${year}-05-01`, `${year}-09-07`, `${year}-10-12`, `${year}-11-02`, `${year}-11-15`, `${year}-12-25`];
  if (year >= 2024) fixed.push(`${year}-11-20`);
  return [...fixed, iso(goodFriday)].sort();
}

/** Conjunto de feriados para os anos dados: a lista do parâmetro (se houver data válida nela) ou os nacionais de cada ano. */
function holidaySet(text, years) {
  const listed = String(typeof text === 'string' ? text : '').split(/[\s,;]+/).filter((item) => ISO_DATE.test(item));
  if (listed.length) return new Set(listed);
  return new Set(years.flatMap((year) => nationalHolidays(year)));
}

function isBusinessDay(day, holidays) {
  const weekday = parse(day).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(day);
}

/** `days` dias úteis DEPOIS de `day` (o próprio dia não conta). Os anos cobertos pelo conjunto padrão são os do dia inicial e dos dois seguintes. */
function addBusinessDays(day, days, holidays) {
  let cursor = parse(day);
  let left = days;
  while (left > 0) {
    cursor = new Date(cursor.getTime() + 86400000);
    if (isBusinessDay(iso(cursor), holidays)) left -= 1;
  }
  return iso(cursor);
}

/** Anos que o prazo pode tocar a partir de `day` (o do dia e os dois seguintes, para o padrão nacional). */
const yearsFrom = (day) => { const y = Number(day.slice(0, 4)); return [y, y + 1, y + 2]; };

module.exports = { nationalHolidays, holidaySet, isBusinessDay, addBusinessDays, yearsFrom, ISO_DATE };
