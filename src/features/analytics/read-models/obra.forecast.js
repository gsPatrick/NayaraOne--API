'use strict';

/**
 * M9-D618 (3.3) — previsão de término da obra (natureza PROJECTED, M9-D610). A fórmula oficial do KPI é da M9-D650; este read model guarda
 * a projeção que o método do administrador (`analytics.obra.previsao_metodo`) calcula, para o KPI ler pronta:
 *   RITMO      término = início + ceil(dias decorridos × 100 ÷ % realizado), nunca antes da data-base; 100% = data real de término (ou a
 *              data-base); sem % realizado a previsão é nula (a D650 marca o KPI como INCOMPLETE em vez de inventar prazo).
 *   PLANEJADO  término = o planejado (baseline).
 * Aritmética de dias inteira e de decimal em BigInt (sem ponto flutuante). Datas 'AAAA-MM-DD' do calendário de São Paulo.
 */
const DAY_MS = 86400000;
const toDay = (key) => Math.round(Date.parse(`${key}T00:00:00Z`) / DAY_MS);
const fromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** '12.345600' -> 12345600n (6 casas). */
function scaled6(text) {
  const [i, f = ''] = String(text).split('.');
  return BigInt(i + f.padEnd(6, '0').slice(0, 6));
}

function forecastFinishDate({ method, asOfDate, startDate, plannedEndDate, actualEndDate, actualPercent }) {
  if (method === 'PLANEJADO') return plannedEndDate || null;
  if (actualPercent === null || actualPercent === undefined) return null;
  const pct = scaled6(actualPercent);
  if (pct <= 0n) return null;
  if (pct >= 100000000n) return actualEndDate || asOfDate;
  if (!startDate) return null;
  const elapsed = BigInt(Math.max(0, toDay(asOfDate) - toDay(startDate)));
  const total = (elapsed * 100n * 1000000n + pct - 1n) / pct; // teto da divisão inteira
  return fromDay(Math.max(toDay(startDate) + Number(total), toDay(asOfDate)));
}

module.exports = { forecastFinishDate };
