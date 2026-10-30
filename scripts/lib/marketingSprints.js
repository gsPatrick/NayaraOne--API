'use strict';

/**
 * M9-D439 — leitura do mapa sprint -> demandas do Marketing (fonte única: seção 3 da própria M9-D439) e a regra de coerência com o campo Dependências.
 * Somente leitura, sem banco. É o motor que o verificador da M9-D444 (`scripts/marketing/checkSprintGates.js`) também usa; aqui só entra a parte do mapa.
 *   lerMapaSprints(texto)               { M1: ['M9-D400', ...], ... }
 *   cobertura(mapa, ids)                { semSprint, emVarios, fora }  (cada demanda em exatamente um sprint)
 *   lerAdiantadas(textoD444)            ['M9-D408>M9-D425', ...]       (tabela fechada de dependências adiantadas, 3.3b da M9-D444)
 *   arestasParaFrente(mapa, demandas)   [{ de, para, sprintDe, sprintPara }]
 *   verificarOrdem(mapa, demandas, adiantadas)  { arestas, erros: [{ codigo, ... }] }
 */
const SPRINTS = Object.freeze(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']);
const PRIMEIRA = 400;
const ULTIMA = 444;
const CODIGOS = Object.freeze({ MAPA: 'MKT_SPRINT_MAP_INVALID', ORDEM: 'MKT_SPRINT_ORDER_VIOLATION' });

const idCurto = (n) => `M9-D${String(n).padStart(3, '0')}`;

/** "D400, D402, D420 a D424 (nota)" -> ids completos (intervalos "Dnnn a Dmmm" expandidos; o que está entre parênteses é nota). */
function expandirIds(trecho) {
  const limpo = String(trecho).replace(/\([^)]*\)/g, ' ');
  const ids = [];
  for (const m of limpo.matchAll(/D(\d{3})(?:\s+a\s+D(\d{3}))?/g)) {
    const de = Number(m[1]);
    const ate = m[2] ? Number(m[2]) : de;
    for (let n = de; n <= ate; n += 1) ids.push(idCurto(n));
  }
  return ids;
}

/** Mapa sprint -> demandas da linha "Mapa sprint -> demandas" da M9-D439 (seção 3). Lança erro claro se a linha não existe. */
function lerMapaSprints(texto) {
  const linha = String(texto).split('\n').find((l) => l.includes('Mapa sprint'));
  if (!linha) throw new Error('M9-D439: linha "Mapa sprint -> demandas" não encontrada');
  const corpo = linha.slice(linha.indexOf('**:') + 3);
  const mapa = {};
  for (const trecho of corpo.split(';')) {
    const m = trecho.match(/^\s*(M[1-9])\s+[^=]*=\s*(.*)$/s);
    if (m) mapa[m[1]] = expandirIds(m[2]);
  }
  return mapa;
}

/** Cada demanda de M9-D400 a M9-D444 que existe como arquivo precisa estar em exatamente um sprint; o mapa não cita demanda sem arquivo. */
function cobertura(mapa, idsDoBloco) {
  const onde = new Map();
  for (const [sprint, ids] of Object.entries(mapa)) for (const id of ids) onde.set(id, [...(onde.get(id) || []), sprint]);
  return {
    semSprint: idsDoBloco.filter((id) => !onde.has(id)),
    emVarios: [...onde.entries()].filter(([, s]) => s.length > 1).map(([id, sprints]) => ({ id, sprints })),
    fora: [...onde.keys()].filter((id) => !idsDoBloco.includes(id)),
  };
}

/** Linhas "| D408, D410 | D425 | motivo |" da tabela de dependências adiantadas -> ['M9-D408>M9-D425', ...]. */
function lerAdiantadas(textoD444) {
  const inicio = String(textoD444).indexOf('| Dependente |');
  if (inicio < 0) throw new Error('M9-D444: tabela de dependências adiantadas não encontrada');
  const pares = [];
  for (const linha of String(textoD444).slice(inicio).split('\n').slice(2)) {
    if (!linha.startsWith('|')) break;
    const [, dependentes, dependencia] = linha.split('|');
    for (const de of expandirIds(dependentes)) for (const para of expandirIds(dependencia)) pares.push(`${de}>${para}`);
  }
  return pares;
}

const sprintDe = (mapa, id) => Object.keys(mapa).find((s) => mapa[s].includes(id)) || null;
const ordem = (sprint) => SPRINTS.indexOf(sprint);

/** Dependências (dentro do bloco D400 a D444) que apontam para um sprint POSTERIOR ao da demanda. `demandas`: Map id -> { dependencias }. */
function arestasParaFrente(mapa, demandas) {
  const arestas = [];
  for (const [id, d] of demandas) {
    const n = Number(id.slice(4));
    if (n < PRIMEIRA || n > ULTIMA) continue;
    for (const dep of d.dependencias) {
      const m = Number(dep.slice(4));
      if (m < PRIMEIRA || m > ULTIMA) continue;
      const a = sprintDe(mapa, id);
      const b = sprintDe(mapa, dep);
      if (a && b && ordem(b) > ordem(a)) arestas.push({ de: id, para: dep, sprintDe: a, sprintPara: b });
    }
  }
  return arestas.sort((x, y) => (x.de + x.para).localeCompare(y.de + y.para));
}

/** Compara as arestas para frente reais com a lista fechada: aresta fora da lista reprova (ORDEM); item da lista que não existe de fato também (a tabela mente). */
function verificarOrdem(mapa, demandas, adiantadas) {
  const arestas = arestasParaFrente(mapa, demandas);
  const reais = new Set(arestas.map((a) => `${a.de}>${a.para}`));
  const permitidas = new Set(adiantadas);
  const erros = [];
  for (const a of arestas) {
    if (!permitidas.has(`${a.de}>${a.para}`)) erros.push({ codigo: CODIGOS.ORDEM, ...a, mensagem: 'A dependência aponta para um sprint ou passo posterior.' });
  }
  for (const par of permitidas) {
    if (!reais.has(par)) erros.push({ codigo: CODIGOS.ORDEM, de: par.split('>')[0], para: par.split('>')[1], mensagem: 'A tabela de dependências adiantadas lista uma aresta que não existe nos arquivos.' });
  }
  return { arestas, erros };
}

module.exports = { SPRINTS, PRIMEIRA, ULTIMA, CODIGOS, idCurto, expandirIds, lerMapaSprints, cobertura, lerAdiantadas, arestasParaFrente, verificarOrdem, sprintDe };
