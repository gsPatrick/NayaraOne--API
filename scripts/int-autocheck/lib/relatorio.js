'use strict';

/**
 * Leitura do relatório da suíte offline (reports/offline-run.json, gerado por scripts/int-ci/offlineRelatorio.js a partir do JUnit das etapas e do registro de conexões externas):
 * { chamadasExternas, arquivos: { '<teste>.test.js': [[nome, 'pass'|'fail'|'skip'], ...] } }. Funções puras: o "verde" de um teste é o que o relatório diz, nunca uma declaração.
 */
const casos = (rel) => Object.entries((rel && rel.arquivos) || {}).flatMap(([arquivo, lista]) => lista.map(([nome, status]) => ({ arquivo, nome, status })));

/** Teste nomeado: verde só se existe ao menos uma execução dele e nenhuma falhou nem foi pulada. */
function nomeVerde(rel, nome) {
  const achados = casos(rel).filter((c) => c.nome === nome);
  if (!achados.length) return { ok: false, detalhe: `teste ${nome} não consta da execução` };
  const ruim = achados.find((c) => c.status !== 'pass');
  return ruim ? { ok: false, detalhe: `teste ${nome} ${ruim.status === 'fail' ? 'vermelho' : 'pulado'} em ${ruim.arquivo}` } : { ok: true, detalhe: '' };
}

/** Arquivos de teste que casam com `padrao`: precisa haver pelo menos um e todos os casos têm de ser verdes. */
function arquivosVerdes(rel, padrao, rotulo = String(padrao)) {
  const arquivos = Object.keys((rel && rel.arquivos) || {}).filter((a) => padrao.test(a));
  if (!arquivos.length) return { ok: false, detalhe: `nenhum teste ${rotulo} na execução` };
  const ruins = casos(rel).filter((c) => padrao.test(c.arquivo) && c.status !== 'pass');
  if (ruins.length) return { ok: false, detalhe: `${ruins.length} teste(s) não verdes em ${[...new Set(ruins.map((c) => c.arquivo))].join(', ')}` };
  return { ok: true, detalhe: `${arquivos.length} arquivo(s)` };
}

/** Problemas da execução offline: relatório ausente, chamada externa, teste não verde ou arquivo da suíte que não rodou. */
function problemasOffline(rel, esperados) {
  if (!rel) return ['relatório da execução offline ausente (rode a esteira, etapas 3 a 9)'];
  const p = [];
  if (!(Number.isInteger(rel.chamadasExternas) && rel.chamadasExternas === 0)) p.push(`${rel.chamadasExternas === undefined ? 'contagem de' : rel.chamadasExternas} chamada(s) externa(s) na execução offline (o esperado é 0)`);
  const ruins = casos(rel).filter((c) => c.status !== 'pass');
  if (ruins.length) p.push(`${ruins.length} teste(s) não verdes na execução offline (primeiro: ${ruins[0].nome})`);
  const faltando = (esperados || []).filter((a) => !(rel.arquivos && rel.arquivos[a] && rel.arquivos[a].length));
  if (faltando.length) p.push(`${faltando.length} arquivo(s) da suíte fora da execução offline (primeiro: ${faltando[0]})`);
  return p;
}

module.exports = { casos, nomeVerde, arquivosVerdes, problemasOffline };
