'use strict';

/**
 * M9-D255 — regras puras do portão de sprint das integrações (recebem o mapa e as demandas lidas): cobertura do bloco, estado de cada sprint,
 * início fora de ordem e coerência das dependências. "Fechado" = todas as demandas do sprint estão `verificada` (só o verificador independente
 * marca assim). A M9-D255 em si é o mapa: não pertence a nenhum sprint.
 */
const ARQUIVO_DO_MAPA = 'M9-D255';
const BLOCO = /^M9-D2[0-5]\d$/;
const INICIADAS = ['em_execucao'];

function sprintsPorDemanda(mapa) {
  const por = new Map();
  for (const s of mapa.sprints) for (const id of s.demandas) por.set(id, [...(por.get(id) || []), s.codigo]);
  return por;
}

/** semSprint: demanda do bloco fora da tabela; emVarios: em mais de um sprint; inexistentes: o mapa cita demanda sem arquivo. */
function cobertura(mapa, demandas) {
  const por = sprintsPorDemanda(mapa);
  const bloco = [...demandas.keys()].filter((id) => BLOCO.test(id) && id !== ARQUIVO_DO_MAPA).sort();
  return {
    semSprint: bloco.filter((id) => !por.has(id)),
    emVarios: [...por].filter(([, v]) => v.length > 1).map(([id, sprints]) => ({ id, sprints })).sort((a, b) => a.id.localeCompare(b.id)),
    inexistentes: [...por.keys()].filter((id) => !demandas.has(id)).sort(),
  };
}

/** Cada passo da ordem exata aponta só para demandas que existem e que estão num sprint. */
function passosSemDestino(mapa, demandas) {
  const por = sprintsPorDemanda(mapa);
  return mapa.passos.filter((p) => !p.demandas.length || p.demandas.some((id) => !demandas.has(id) || !por.has(id))).map((p) => p.n);
}

function estadoDosSprints(mapa, demandas) {
  return mapa.sprints.map((s) => {
    const status = s.demandas.map((id) => (demandas.get(id) ? demandas.get(id).status : 'ausente'));
    const verificadas = status.filter((x) => x === 'verificada').length;
    const naoVerificadas = s.demandas.map((id, i) => ({ id, status: status[i] })).filter((d) => d.status !== 'verificada');
    let estado = 'aberto';
    if (s.demandas.length && verificadas === s.demandas.length) estado = 'fechado';
    else if (status.some((x) => x !== 'aberta' && x !== 'ausente')) estado = 'em andamento';
    return { codigo: s.codigo, n: s.n, tema: s.tema, estado, total: s.demandas.length, verificadas, naoVerificadas };
  });
}

/** Demanda iniciada num sprint cujo anterior (qualquer sprint menor) não fechou. */
function foraDeOrdem(mapa, demandas, { iniciadas = INICIADAS } = {}) {
  const estados = estadoDosSprints(mapa, demandas);
  const achados = [];
  for (const s of mapa.sprints) {
    const abertos = estados.filter((e) => e.n < s.n && e.estado !== 'fechado').map((e) => e.codigo);
    if (!abertos.length) continue;
    for (const id of s.demandas) {
      const d = demandas.get(id);
      if (d && iniciadas.includes(d.status)) achados.push({ id, sprint: s.codigo, status: d.status, bloqueadoPor: abertos });
    }
  }
  return achados;
}

/** Aresta demanda -> dependência (ambas no mapa) em que o sprint da dependência é posterior ao da demanda. */
function dependenciasIncoerentes(mapa, demandas) {
  const por = sprintsPorDemanda(mapa);
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

/**
 * Ordem de execução dentro de um sprint: a da lista do livro, adiantando a dependência que está no mesmo sprint e aparece depois (ordenação
 * topológica estável). `ciclo` lista as demandas presas em dependência circular (o sprint não tem ordem possível).
 */
function ordemDeExecucao(mapa, demandas, codigo) {
  const sprint = mapa.sprints.find((s) => s.codigo === codigo);
  const ids = sprint ? sprint.demandas : [];
  const dentro = (id) => (demandas.get(id) ? demandas.get(id).dependencias.filter((dep) => ids.includes(dep)) : []);
  const ordem = [];
  const restantes = [...ids];
  while (restantes.length) {
    const pronta = restantes.find((id) => dentro(id).every((dep) => ordem.includes(dep)));
    if (!pronta) return { ordem, ciclo: restantes };
    ordem.push(pronta);
    restantes.splice(restantes.indexOf(pronta), 1);
  }
  return { ordem, ciclo: [] };
}

module.exports = { cobertura, passosSemDestino, estadoDosSprints, foraDeOrdem, dependenciasIncoerentes, ordemDeExecucao, sprintsPorDemanda, ARQUIVO_DO_MAPA, BLOCO, INICIADAS };
