'use strict';

/**
 * M9-D706 — regras do portão de sprint, puras (recebem o mapa e as demandas lidas): cobertura do bloco D, estado de cada sprint, início fora de
 * ordem e coerência das dependências. "Fechado" = todas as demandas do sprint `verificada` (e, no B9, a esteira do BI aprovada).
 */
const { BLOCO_BI } = require('./demandasMd');
const { avaliarEsteira } = require('./esteira');

const INICIADOS_PADRAO = ['em_execucao'];

function sprintsDe(mapa) {
  const por = new Map();
  for (const s of mapa.sprints) for (const id of s.demandas) por.set(id, [...(por.get(id) || []), s.codigo]);
  return por;
}

function cobertura(mapa, demandas) {
  const por = sprintsDe(mapa);
  const bloco = [...demandas.keys()].filter((id) => BLOCO_BI.test(id)).sort();
  return {
    semSprint: bloco.filter((id) => !por.has(id)),
    emVarios: [...por].filter(([, v]) => v.length > 1).map(([id, sprints]) => ({ id, sprints })).sort((a, b) => a.id.localeCompare(b.id)),
    inexistentes: [...por.keys()].filter((id) => !demandas.has(id)).sort(),
  };
}

function estadoDosSprints(mapa, demandas, { esteira = {} } = {}) {
  return mapa.sprints.map((s) => {
    const statusDe = s.demandas.map((id) => (demandas.get(id) ? demandas.get(id).status : 'ausente'));
    const verificadas = statusDe.filter((x) => x === 'verificada').length;
    const motivos = [];
    let estado;
    if (s.demandas.length && verificadas === s.demandas.length) {
      estado = 'fechado';
      if (s.codigo === 'B9') {
        const r = avaliarEsteira(esteira);
        if (!r.ok) { estado = 'em andamento'; motivos.push(...r.motivos); }
      }
    } else if (statusDe.some((x) => x !== 'aberta' && x !== 'ausente')) estado = 'em andamento';
    else estado = 'aberto';
    return { codigo: s.codigo, n: s.n, escopo: s.escopo, estado, total: s.demandas.length, verificadas, motivos };
  });
}

/** Demanda iniciada (status em `iniciados`) num sprint cujo anterior (qualquer sprint menor) não está fechado. */
function foraDeOrdem(mapa, demandas, { iniciados = INICIADOS_PADRAO, esteira } = {}) {
  const estados = estadoDosSprints(mapa, demandas, { esteira });
  const violacoes = [];
  for (const s of mapa.sprints) {
    const abertos = estados.filter((e) => e.n < s.n && e.estado !== 'fechado').map((e) => e.codigo);
    if (!abertos.length) continue;
    for (const id of s.demandas) {
      const d = demandas.get(id);
      if (d && iniciados.includes(d.status)) violacoes.push({ id, sprint: s.codigo, status: d.status, bloqueadoPor: abertos });
    }
  }
  return violacoes;
}

/** Aresta demanda -> dependência (ambas no mapa) em que o sprint da dependência é posterior ao da demanda. */
function dependenciasIncoerentes(mapa, demandas) {
  const por = sprintsDe(mapa);
  const n = (cod) => Number(cod.slice(1));
  const achados = [];
  for (const [id, sprints] of por) {
    const d = demandas.get(id);
    if (!d) continue;
    for (const dep of d.dependencias) {
      const sd = por.get(dep);
      if (sd && n(sd[0]) > n(sprints[0])) achados.push({ id, sprint: sprints[0], dependencia: dep, sprintDaDependencia: sd[0] });
    }
  }
  return achados.sort((a, b) => a.id.localeCompare(b.id) || a.dependencia.localeCompare(b.dependencia));
}

module.exports = { cobertura, estadoDosSprints, foraDeOrdem, dependenciasIncoerentes, INICIADOS_PADRAO };
