'use strict';

const { TIME_ZONE, prefixOf } = require('./bcp.constants');
const E = require('./bcp.errors');

const NUMBER = /^\d+$/;
const MAX_SEQUENCE = 99999;
const yearFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric' });

/** Ano corrente em America/Sao_Paulo no instante dado. */
const currentYear = (now = new Date()) => Number(yearFormatter.format(now));

/**
 * Faixa de folhas da impressão (M9-D834 §3.3). Sem `from` e `to`: uma folha em branco ([null]). Com os dois: os números `<PREFIXO>-<AAAA>-<nnnnn>` de `from` a `to`, no ano
 * pedido ou no corrente. Inválida (só um dos extremos, não inteiro, `to` < `from`, acima de 99999, mais folhas que o limite do parâmetro, ano fora de AAAA): 400 GOV_BCP_RANGE_INVALID.
 */
function resolveReferences(sector, query, maxSheets, now) {
  const { from, to, year } = query || {};
  if (from === undefined && to === undefined) return [null];
  if (![from, to].every((v) => typeof v === 'string' && NUMBER.test(v))) throw E.rangeInvalid(maxSheets);
  const first = Number(from);
  const last = Number(to);
  if (first < 1 || last < first || last > MAX_SEQUENCE || last - first + 1 > maxSheets) throw E.rangeInvalid(maxSheets);
  if (year !== undefined && !(typeof year === 'string' && /^\d{4}$/.test(year) && Number(year) >= 2000)) throw E.rangeInvalid(maxSheets);
  const label = year === undefined ? currentYear(now) : Number(year);
  const references = [];
  for (let n = first; n <= last; n += 1) references.push(`${prefixOf(sector)}-${label}-${String(n).padStart(5, '0')}`);
  return references;
}

module.exports = { resolveReferences, currentYear };
