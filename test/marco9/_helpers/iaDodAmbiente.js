'use strict';

// Apoio dos testes do DoD da NAY (M9-D047): ambiente falso todo verde (os 16 itens com prova e as quatro perguntas SIM); cada teste derruba um fato por vez.
// O script real lê os mesmos fatos nos arquivos e nos relatórios (scripts/ai-dod/lib/ambiente.js).
const { carregar } = require('../../../scripts/ai-dod/lib/matriz');
const { ambienteVerde } = require('./m9d258Ambiente');

const ARQUIVO_VERDE = 'test/marco9/ia/m9dfalso.test.js';

/** Matriz real (docs/ai/dod-ia-nay.json), copiada para o teste poder mexer sem tocar no arquivo. */
const matrizReal = () => JSON.parse(JSON.stringify(carregar()));

function relatorioIaVerde(matriz = carregar()) {
  const provas = [...new Set(matriz.itens.flatMap((it) => it.provas.map((p) => p.teste)))];
  return { chamadasExternas: 0, arquivos: { [ARQUIVO_VERDE]: provas.map((n) => [n, 'pass']) } };
}

/** `mexer` troca fatos do ambiente (ex.: { redTeam: () => ['...'] }); `matriz` é a matriz usada para montar o relatório verde. */
function ambienteIaVerde(mexer = {}, matriz = carregar()) {
  const relatorio = relatorioIaVerde(matriz);
  const { amb } = ambienteVerde({ relatorioOffline: () => relatorio, arquivosEsperados: () => [ARQUIVO_VERDE] });
  return {
    relatorio,
    amb: { ...amb, testeDeclarado: () => true, relatorioAdversarial: () => ({ ausente: false, problemas: [] }), redTeam: () => [], ...mexer },
  };
}

module.exports = { ambienteIaVerde, relatorioIaVerde, matrizReal, ARQUIVO_VERDE };
