'use strict';

/** Fatos da autochecagem (M9-D258) que vêm dos arquivos de demanda em Maturacao/demandas: estrutura (demandas-check.js), mapa de sprints (D255/D045) e parâmetros `integration.*` citados. */
const fs = require('node:fs');
const path = require('node:path');
const { carregarDemandas, pastaPadrao } = require('../../analytics/sprints/demandasMd');
const { lerMapa } = require('../../int-sprint/lib/mapa');
const { lerMapa: lerMapaIa } = require('../../ai-sprint/lib/mapa');
const AInt = require('../../int-sprint/lib/avaliar');
const AIa = require('../../ai-sprint/lib/avaliar');

const MAPAS = { integracoes: { ler: lerMapa, regras: AInt, dona: 'M9-D255' }, 'ia-nay': { ler: lerMapaIa, regras: AIa, dona: 'M9-D045' } };
const PARAMETRO = /\bintegration\.[a-z0-9_]+(?:\.[a-z0-9_]+)+(?![a-z0-9_.*])/g;

/** Lista { id, status, dependencias, erros } de todas as demandas, com os erros do demandas-check.js (12 seções não vazias, dependências existentes, cabeçalho). */
function listarDemandas(pasta) {
  try {
    const ferramentas = path.join(pasta, '_ferramentas');
    const check = require(path.join(ferramentas, 'demandas-check.js'));
    const a = check.analisar({ raiz: pasta, permitidas: path.join(ferramentas, 'palavras-permitidas.txt'), faixas: path.join(ferramentas, 'faixas.json') });
    return a.demandas.filter((d) => d.id).map((d) => ({ id: d.id, status: d.status, dependencias: d.deps || [], erros: a.resultados.get(d).erros }));
  } catch (e) {
    return [{ id: '(demandas)', status: '', dependencias: [], erros: [`pasta de demandas ilegível: ${path.basename(pasta)} (${e.code || e.message})`] }];
  }
}

/** Demandas de um sprint presas em dependência circular entre si (lista vazia = há ordem de execução possível). */
function ciclosDoSprint(sprint, demandas) {
  const dentro = (id) => (demandas.get(id) ? demandas.get(id).dependencias.filter((dep) => sprint.demandas.includes(dep)) : []);
  const feitas = [];
  let restantes = [...sprint.demandas];
  for (let pronta = restantes.find((id) => dentro(id).every((d) => feitas.includes(d))); pronta; pronta = restantes.find((id) => dentro(id).every((d) => feitas.includes(d)))) {
    feitas.push(pronta);
    restantes = restantes.filter((id) => id !== pronta);
  }
  return restantes;
}

/** Mapa de passos e sprints do escopo: cobertura (sem órfã), passos sem destino, dependência para sprint posterior e ciclo. `erro` quando a tabela não existe. */
function mapaDoEscopo(pasta, escopo) {
  const { ler, regras, dona } = MAPAS[escopo];
  try {
    const demandas = carregarDemandas(pasta);
    const arquivo = demandas.get(dona);
    if (!arquivo) return { erro: `${dona} não encontrada em demandas/marco-9` };
    const mapa = ler(arquivo.texto);
    const cob = regras.cobertura(mapa, demandas);
    const ciclos = mapa.sprints.map((s) => ciclosDoSprint(s, demandas)).filter((c) => c.length).map((c) => c.join(', '));
    return { erro: null, ...cob, passosSemDestino: regras.passosSemDestino(mapa, demandas), dependenciasIncoerentes: regras.dependenciasIncoerentes(mapa, demandas), ciclos };
  } catch (e) {
    return { erro: e.message };
  }
}

const colunaCsv = (arquivo, coluna) => {
  if (!fs.existsSync(arquivo)) return [];
  const linhas = fs.readFileSync(arquivo, 'utf8').split('\n').filter(Boolean);
  const i = linhas[0].split(',').indexOf(coluna);
  return i < 0 ? [] : linhas.slice(1).map((l) => (l.split(',')[i] || '').replace(/^"|"$/g, ''));
};

/**
 * Parâmetros `integration.*` citados nas demandas do bloco B que não têm linha no catálogo (`_parametros-bloco-B.csv` ou o `parametros.csv` mestre). Chave citada só conta como parâmetro
 * se o código a declara em settings (`chavesDeCodigo`) ou se a demanda a chama de parâmetro ao lado da chave: o nome de evento (`integration.dispatch.confirmed`) não é parâmetro.
 */
function parametrosNaoCobertos(pasta, chavesDeCodigo) {
  let demandas;
  try { demandas = carregarDemandas(pasta); } catch (e) { return [`(pasta de demandas ilegível: ${e.code || 'erro'})`]; }
  const catalogo = new Set([...colunaCsv(path.join(pasta, 'marco-9', '_parametros-bloco-B.csv'), 'parametro'), ...colunaCsv(path.join(pasta, 'parametros.csv'), 'chave')]);
  const faltando = new Set();
  for (const [id, d] of demandas) {
    if (!/^M9-D[23]\d{2}$/.test(id)) continue;
    for (const linha of d.texto.split('\n')) {
      for (const m of linha.matchAll(PARAMETRO)) {
        const chave = m[0];
        const antes = linha.slice(Math.max(0, m.index - 40), m.index);
        const depois = linha.slice(m.index + chave.length, m.index + chave.length + 25);
        const ehParametro = chavesDeCodigo.has(chave) || /par[aâ]metros?[^`]{0,30}`?$/i.test(antes) || /^`?\s*\(\s*par[aâ]metro/i.test(depois);
        if (ehParametro && !catalogo.has(chave)) faltando.add(chave);
      }
    }
  }
  return [...faltando].sort();
}

module.exports = { ciclosDoSprint, listarDemandas, mapaDoEscopo, parametrosNaoCobertos, pastaPadrao };
