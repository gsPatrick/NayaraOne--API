'use strict';

/**
 * Pergunta 3, "Tem caminho técnico?" (livro 513) e pergunta 4, "Outro programador assume?" (livro 514). A 3 lista os sete componentes um a um (framework, adapters, webhooks, retry, CI, tests
 * e sprints), cada um só verde com as demandas `verificada` e a evidência de execução. A 4 confere a matriz dos 15 princípios, a cobertura dos parâmetros `integration.*`, o mapa e a
 * autossuficiência de cada demanda.
 */
const { verificacao, naoVerificadas, faixa, falhasDasDemandas, falhasDoMapa } = require('./verificacao');
const { arquivosVerdes, nomeVerde } = require('./relatorio');

const ruins = (lista) => lista.filter((r) => !r.ok).map((r) => r.detalhe);

function caminho(amb) {
  const rel = amb.relatorioOffline('integracoes');
  const mapa = amb.mapa('integracoes');
  const esteira = amb.esteira();
  const manifesto = amb.nomesAdversariais();
  return [
    verificacao('framework (D200 a D210)', naoVerificadas(amb, faixa(200, 210))),
    verificacao('adapters (14 famílias com adapter registrado e suíte de contrato verde)', [...amb.familiasSemAdapter().map((f) => `família sem adapter registrado: ${f}`), ...amb.contratosFaltando().map((c) => `contrato sem relatório verde: ${c}`)]),
    verificacao('webhooks (D211 a D213)', [...naoVerificadas(amb, faixa(211, 213)), ...ruins([arquivosVerdes(rel, /m9d21[123]\.[^/]*\.test\.js$/, 'de webhook (m9d211 a m9d213)')])]),
    verificacao('retry (D216 e D217)', [...naoVerificadas(amb, faixa(216, 217)), ...ruins([arquivosVerdes(rel, /m9d21[67]\.[^/]*\.test\.js$/, 'de retry e circuito (m9d216, m9d217)')])]),
    verificacao('CI (D254, as 13 etapas na ordem do livro)', [...naoVerificadas(amb, ['M9-D254']), ...esteira.problemas.map((p) => `esteira: ${p}`)]),
    verificacao('tests (D222 mais o manifesto D251/D252)', [...naoVerificadas(amb, ['M9-D222', 'M9-D251', 'M9-D252']), ...ruins(manifesto.map((n) => nomeVerde(rel, n))), ...ruins([arquivosVerdes(rel, /m9d222\.[^/]*\.test\.js$/, 'de contrato (m9d222)')])]),
    verificacao('sprints (D255 mapeia 100% das demandas do bloco, sem órfã)', [...naoVerificadas(amb, ['M9-D255']), ...falhasDoMapa(mapa)]),
  ];
}

function programador(amb, esc) {
  const mapa = amb.mapa('integracoes');
  return [
    verificacao('a matriz docs/integrations/MATRIZ_INT.md (15 princípios, demanda dona e teste existente)', [...(amb.existeArquivo('docs/integrations/MATRIZ_INT.md') ? [] : ['MATRIZ_INT.md ausente']), ...amb.problemasDaMatriz()]),
    verificacao('o _parametros-bloco-B.csv cobre todo parâmetro integration.* citado nas demandas', amb.parametrosNaoCobertos().map((k) => `parâmetro sem linha no catálogo: ${k}`)),
    verificacao('o mapa de passos e sprints não tem demanda órfã e a ordem respeita as dependências', falhasDoMapa(mapa)),
    verificacao('cada demanda do bloco é autossuficiente (12 seções, dependências existentes)', falhasDasDemandas(amb, esc)),
  ];
}

module.exports = { caminho, programador };
