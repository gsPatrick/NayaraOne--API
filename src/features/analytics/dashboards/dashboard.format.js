'use strict';

/**
 * M9-D634 (3.3) — formato pt-BR do valor que o painel entrega pronto. Só apresenta o texto decimal que o snapshot guardou
 * (nenhum cálculo de indicador): arredonda para as casas da unidade (meio para cima, aritmética exata) e põe separadores. O Front exibe o
 * `formatted` como veio e nunca refaz a conta.
 */
const money = require('../metrics/formulas/money');

// unidade -> [casas, prefixo, sufixo]
const SHAPES = Object.freeze({
  BRL: [2, 'R$ ', ''], BRL_PER_UNIT: [2, 'R$ ', ''], PERCENT: [2, '', '%'], COUNT: [0, '', ''], DAYS: [1, '', ' dias'], HOURS: [1, '', ' h'],
  MINUTES: [1, '', ' min'], SECONDS: [0, '', ' s'], SCORE: [2, '', ''], NUMBER: [2, '', ''], PP: [1, '', ' p.p.'],
});

function withSeparators(plain) {
  const negative = plain.startsWith('-');
  const [int, frac] = (negative ? plain.slice(1) : plain).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${grouped}${frac === undefined ? '' : `,${frac}`}`;
}

/** "120000.0000" + BRL -> "R$ 120.000,00"; valor nulo ou fora do formato -> null (o cartão mostra "Dado incompleto"). */
function formatValue(unit, value) {
  if (value === null || value === undefined || !/^-?\d+(\.\d+)?$/.test(String(value))) return null;
  const [places, prefix, rawSuffix] = SHAPES[unit] || SHAPES.NUMBER;
  let text = withSeparators(money.round(String(value), places));
  if (places === 1 && text.endsWith(',0')) text = text.slice(0, -2); // 12,0 dias -> 12 dias; 5,5 dias continua
  const suffix = unit === 'DAYS' && text === '1' ? ' dia' : rawSuffix;
  return text.startsWith('-') ? `-${prefix}${text.slice(1)}${suffix}` : `${prefix}${text}${suffix}`;
}

module.exports = { formatValue };
