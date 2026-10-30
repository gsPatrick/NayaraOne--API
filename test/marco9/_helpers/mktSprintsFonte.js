'use strict';

// Apoio dos testes M9-D439 (mapa de sprints, DoD e estrutura do Marketing): lê as demandas e o livro reais de Maturacao. Não é teste.
const fs = require('node:fs');
const path = require('node:path');
const { carregarDemandas, pastaPadrao } = require('../../../scripts/analytics/sprints/demandasMd');

const RAIZ_API = path.join(__dirname, '..', '..', '..');
const CADERNO = path.join(RAIZ_API, '..', 'Maturacao', 'MARCO_9_CADERNO_COMPLETO.md');

const demandas = () => carregarDemandas(pastaPadrao());
const caderno = () => fs.readFileSync(CADERNO, 'utf8');
const idsDoBloco = (todas) => [...todas.keys()].filter((id) => Number(id.slice(4)) >= 400 && Number(id.slice(4)) <= 444);

/** Cópia do mapa com a demanda `id` movida para o sprint `sprint` (ou removida, com sprint = null). */
function comDemandaMovida(mapa, id, sprint) {
  const copia = Object.fromEntries(Object.entries(mapa).map(([s, ids]) => [s, ids.filter((x) => x !== id)]));
  if (sprint) copia[sprint] = [...copia[sprint], id];
  return copia;
}

/** Cópia do Map de demandas com `dep` acrescentada às dependências de `id`. */
function comDependencia(todas, id, dep) {
  const copia = new Map(todas);
  copia.set(id, { ...todas.get(id), dependencias: [...todas.get(id).dependencias, dep] });
  return copia;
}

module.exports = { RAIZ_API, CADERNO, demandas, caderno, idsDoBloco, comDemandaMovida, comDependencia };
