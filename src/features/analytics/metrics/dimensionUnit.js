'use strict';

/**
 * M9-D624 — unidade de uma dimensão do indicador. A dimensão `valor_brl` (ex.: soma em reais das conciliações pendentes) e `mais_antiga_dias`
 * (idade do registro mais antigo) são medidas de outra unidade que a do indicador (COUNT); o sufixo da chave diz qual. Demais chaves herdam
 * a unidade da versão.
 */
function dimensionUnit(dimensionKey, versionUnit) {
  if (/(^|:)[a-z_]*_brl$/.test(dimensionKey || '')) return 'BRL';
  if (/(^|:)[a-z_]*_dias$/.test(dimensionKey || '')) return 'DAYS';
  return versionUnit;
}

module.exports = { dimensionUnit };
