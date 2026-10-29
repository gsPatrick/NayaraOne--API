'use strict';

/**
 * M9-D710 (3.2) — janela dos fatos do dia. Hoje: móvel, de (leitura - janela_horas) até o instante da leitura (inclusive). Data passada: termina às 00:00 do dia seguinte de São Paulo
 * (exclusivo) e começa janela_horas antes. A janela anterior é a imediatamente anterior, de mesma duração: [início - janela_horas, início). Os limites são instantes; o dia de
 * calendário de cada fato é decidido pelo read model na data de São Paulo (M9-D606). Tudo é função pura do instante `now` já fixado pelo chamador (um único relógio por cálculo).
 */
const { businessDateKey, startOfBusinessDay } = require('../../../../../utils/businessDate');

const HOUR = 3600 * 1000;
const MS = 1;

/** { from, to, previousFrom, hours, isToday }: intervalos [from, to) e [previousFrom, from). */
function windowOf(asOfDate, now, hours) {
  const isToday = asOfDate === businessDateKey(now);
  const end = isToday ? now : startOfBusinessDay(new Date(`${asOfDate}T12:00:00Z`), 1); // fim lógico: hoje = o instante da leitura; passado = 00:00 do dia seguinte
  const from = new Date(end.getTime() - hours * HOUR);
  const to = isToday ? new Date(end.getTime() + MS) : end; // hoje inclui o instante da leitura; o dia passado exclui a meia-noite seguinte
  return { from, to, previousFrom: new Date(from.getTime() - hours * HOUR), hours, isToday };
}

module.exports = { windowOf };
