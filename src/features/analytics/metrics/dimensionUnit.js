'use strict';

/**
 * M9-D624 — unidade de uma dimensão do indicador. A dimensão `valor_brl` (ex.: soma em reais das conciliações pendentes) e `mais_antiga_dias`
 * (idade do registro mais antigo) são medidas de outra unidade que a do indicador (COUNT); o sufixo da chave diz qual. Demais chaves herdam
 * a unidade da versão.
 */
function dimensionUnit(dimensionKey, versionUnit) {
  if (/(^|:)[a-z_]*_brl$/.test(dimensionKey || '')) return 'BRL';
  if (/(^|:)[a-z_]*_dias$/.test(dimensionKey || '')) return 'DAYS';
  if (/(^|:)[a-z_]*_horas$/.test(dimensionKey || '')) return 'HOURS'; // M9-D642: tempo médio de resolução dos chamados
  if (/(^|:)([a-z0-9_]*_)?pct$/.test(dimensionKey || '')) return 'PERCENT'; // M9-D623: margem % e parte sem setor; M9-D673: a medida solta `pct` (participação do motivo)
  if (/(^|:)([a-z0-9_]*_)?qtd$/.test(dimensionKey || '')) return 'COUNT'; // M9-D623: quantidades dentro de um indicador em reais; M9-D673: com dígito no nome (nota_5_qtd) ou solta (qtd)
  if (/(^|:)[a-z_]*_min$/.test(dimensionKey || '')) return 'MINUTES'; // M9-D630: tempo médio por origem e por corretor
  if (/(^|:)[a-z_]*_pp$/.test(dimensionKey || '')) return 'PP'; // M9-D650: desvio de avanço em pontos percentuais
  if (/(^|:)[a-z_]*_nota$/.test(dimensionKey || '')) return 'GRADE'; // M9-D681: nota média das avaliações de 0 a 100, com 1 casa
  if (/(^|:)[a-z_0-9]*_ms$/.test(dimensionKey || '')) return 'MS'; // M9-D682: latência p95 e p99 das integrações em milissegundos
  if (/(^|:)[a-z_]*_s$/.test(dimensionKey || '')) return 'SECONDS'; // M9-D682: idade do item mais antigo da fila em segundos
  return versionUnit;
}

module.exports = { dimensionUnit };
