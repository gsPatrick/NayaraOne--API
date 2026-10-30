'use strict';

/** M9-D253 — ambiente falso do Definition of Done: tudo verde por padrão; os testes derrubam uma evidência de cada vez. */
const { ITENS } = require('../../../scripts/int-ci/lib/dodItens');
const { PRINCIPIOS } = require('../../../scripts/int-ci/lib/matrizInt');

const evidencias = ITENS.flatMap((i) => i.evidencias);

function ambienteVerde(mexer = {}) {
  const arquivos = new Set(evidencias.filter((e) => e.arquivo).map((e) => e.arquivo));
  const testes = new Set([...evidencias.filter((e) => e.teste).map((e) => e.teste), ...PRINCIPIOS.flatMap((p) => p.testes)]);
  const amb = {
    existeArquivo: (rel) => arquivos.has(rel),
    existeTeste: (nome) => testes.has(nome),
    contratosFaltando: () => [],
    runbooksFaltando: () => [],
    familiasSemSandbox: () => [],
    adversariais: () => ({ ok: true, problemas: [], ausentes: [] }),
    ...mexer,
  };
  return { amb, arquivos, testes };
}

module.exports = { ambienteVerde, evidencias };
