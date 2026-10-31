'use strict';

/**
 * M9-D444 — motor do portão de sprints e da ordem de 11 passos do Marketing. Somente leitura, sem banco.
 * Regras (M9-D444, seções 3.3 a 3.4):
 *  - cada demanda M9-D400 a M9-D444 em exatamente um sprint (mapa da M9-D439, igual ao da M9-D444) e em exatamente um passo (tabela 3.2);
 *  - dependência para sprint ou passo posterior só nas "adiantadas" da tabela 3.3b, que também precisam existir de fato;
 *  - um passo só FECHA quando todas as suas demandas estão `verificada` e o passo anterior já fechou; sprint fecha com todas `verificada`;
 *  - demanda iniciada exige dependências `verificada` e sprints anteriores fechados, exceto as demandas ainda à espera de uma dependência de sprint posterior (adiantada).
 */
const S = require('./marketingSprints');
const P = require('./marketingPassos');

const C = Object.freeze({ ...S.CODIGOS, INICIO: 'MKT_SPRINT_START_BLOCKED' });
const MENSAGENS = Object.freeze({
  [C.MAPA]: 'A demanda não está em exatamente um sprint.',
  [C.ORDEM]: 'A dependência aponta para um sprint ou passo posterior.',
  [C.INICIO]: 'A demanda não pode começar antes das suas dependências.',
});
const ESCOPO = Object.freeze({
  M1: 'content/templates', M2: 'publication jobs', M3: 'automation engine', M4: 'consent/suppression', M5: 'WhatsApp/e-mail', M6: 'site/social', M7: 'tracking/attribution', M8: 'NAY/video', M9: 'kill switch/load/security',
});
const INICIADOS_PADRAO = Object.freeze(['em_execucao', 'corrigida']);
const ordemSprint = (s) => S.SPRINTS.indexOf(s);
const noBloco = (id) => { const n = Number(id.slice(4)); return n >= S.PRIMEIRA && n <= S.ULTIMA; };
const erro = (codigo, detalhe) => ({ codigo, mensagem: MENSAGENS[codigo], ...detalhe });

/** Quantas vezes cada id aparece nas listas { chave: [ids] }. */
function ocorrencias(grupos) {
  const onde = new Map();
  for (const [chave, ids] of Object.entries(grupos)) for (const id of ids) onde.set(id, [...(onde.get(id) || []), chave]);
  return onde;
}

/** Cobertura do mapa de sprints e dos passos: cada demanda do bloco em exatamente um sprint e um passo; mapa da D444 igual ao da D439. */
function coberturas({ mapa, mapaD444, passos, idsDoBloco }) {
  const erros = [];
  const cobS = S.cobertura(mapa, idsDoBloco);
  cobS.semSprint.forEach((id) => erros.push(erro(C.MAPA, { id, detalhe: 'sem sprint' })));
  cobS.emVarios.forEach((x) => erros.push(erro(C.MAPA, { id: x.id, detalhe: `em mais de um sprint (${x.sprints.join(', ')})` })));
  cobS.fora.forEach((id) => erros.push(erro(C.MAPA, { id, detalhe: 'o mapa cita uma demanda sem arquivo' })));
  const porPasso = Object.fromEntries(passos.map((p) => [p.n, p.ids]));
  const onde = ocorrencias(porPasso);
  idsDoBloco.filter((id) => !onde.has(id)).forEach((id) => erros.push(erro(C.MAPA, { id, detalhe: 'sem passo da ordem exata' })));
  [...onde].filter(([, ps]) => ps.length > 1).forEach(([id, ps]) => erros.push(erro(C.MAPA, { id, detalhe: `em mais de um passo (${ps.join(', ')})` })));
  [...onde.keys()].filter((id) => !idsDoBloco.includes(id)).forEach((id) => erros.push(erro(C.MAPA, { id, detalhe: 'a tabela de passos cita uma demanda sem arquivo' })));
  if (passos.map((p) => p.n).join() !== Array.from({ length: P.TOTAL_PASSOS }, (_, i) => i + 1).join()) erros.push(erro(C.MAPA, { id: 'passos', detalhe: `a tabela deve ter os passos 1 a ${P.TOTAL_PASSOS} em ordem` }));
  if (mapaD444) for (const s of S.SPRINTS) {
    const a = [...(mapa[s] || [])].sort().join();
    const b = [...(mapaD444[s] || [])].sort().join();
    if (a !== b) erros.push(erro(C.MAPA, { id: s, detalhe: 'o mapa da M9-D444 (3.1) difere do da M9-D439' }));
  }
  return erros;
}

/** Arestas para passo POSTERIOR (dependência dentro do bloco cujo passo vem depois do da dependente). */
function arestasDePasso(passos, demandas) {
  const passoDe = (id) => (passos.find((p) => p.ids.includes(id)) || {}).n || null;
  const arestas = [];
  for (const [id, d] of demandas) {
    if (!noBloco(id)) continue;
    for (const dep of d.dependencias.filter(noBloco)) {
      const a = passoDe(id);
      const b = passoDe(dep);
      if (a && b && b > a) arestas.push({ de: id, para: dep, passoDe: a, passoPara: b });
    }
  }
  return arestas;
}

/** Aresta para frente (sprint ou passo) fora da tabela fechada reprova; item da tabela sem aresta real também. */
function ordemDasDependencias({ mapa, passos, demandas, adiantadas }) {
  const { arestas, erros } = S.verificarOrdem(mapa, demandas, adiantadas);
  const permitidas = new Set(adiantadas);
  const doPasso = arestasDePasso(passos, demandas);
  const jaCitadas = new Set(arestas.map((a) => `${a.de}>${a.para}`));
  for (const a of doPasso) if (!permitidas.has(`${a.de}>${a.para}`) && !jaCitadas.has(`${a.de}>${a.para}`)) erros.push({ codigo: C.ORDEM, mensagem: MENSAGENS[C.ORDEM], ...a });
  const reaisPasso = new Set(doPasso.map((a) => `${a.de}>${a.para}`));
  const reaisSprint = new Set(arestas.map((a) => `${a.de}>${a.para}`));
  for (const par of permitidas) if (reaisSprint.has(par) && !reaisPasso.has(par)) erros.push({ codigo: C.ORDEM, mensagem: 'A tabela de dependências adiantadas lista uma aresta que não é para passo posterior.', de: par.split('>')[0], para: par.split('>')[1] });
  return { arestas, arestasDePasso: doPasso, erros: erros.map((e) => ({ ...e, mensagem: e.mensagem || MENSAGENS[e.codigo] })) };
}

const verificada = (demandas, id) => (demandas.get(id) || {}).status === 'verificada';
const andamento = (demandas, ids) => ids.some((id) => (demandas.get(id) || {}).status && demandas.get(id).status !== 'aberta');

/** Estado de um grupo ordenado (sprints ou passos): fechado / em andamento / aberto. `ordenado`: só fecha com o anterior fechado. */
function estados(grupos, demandas, { ordenado }) {
  let anteriorFechado = true;
  return grupos.map((g) => {
    const faltam = g.ids.filter((id) => !verificada(demandas, id));
    const motivos = faltam.map((id) => `${id} está ${(demandas.get(id) || { status: 'sem arquivo' }).status}`);
    let estado = 'aberto';
    if (!faltam.length && (!ordenado || anteriorFechado)) estado = 'fechado';
    else if (!faltam.length) { estado = 'em andamento'; motivos.push(`aguarda o fechamento do ${g.anterior}`); }
    else if (andamento(demandas, g.ids)) estado = 'em andamento';
    anteriorFechado = estado === 'fechado';
    return { codigo: g.codigo, escopo: g.escopo, estado, verificadas: g.ids.length - faltam.length, total: g.ids.length, motivos };
  });
}

const estadoDosSprints = (mapa, demandas) => estados(S.SPRINTS.map((s, i) => ({ codigo: s, escopo: ESCOPO[s], ids: mapa[s] || [], anterior: S.SPRINTS[i - 1] })), demandas, { ordenado: false });
const estadoDosPassos = (passos, demandas) => estados(passos.map((p) => ({ codigo: `passo ${p.n}`, escopo: p.nome, ids: p.ids, anterior: `passo ${p.n - 1}` })), demandas, { ordenado: true });

/** Dependências (transitivas) ainda não verificadas e de sprint posterior ao da demanda: a demanda está à espera de uma adiantada. */
function esperaPorPosterior(id, mapa, demandas) {
  const meu = ordemSprint(S.sprintDe(mapa, id));
  const visto = new Set([id]);
  const fila = [id];
  while (fila.length) {
    for (const dep of (demandas.get(fila.shift()) || { dependencias: [] }).dependencias) {
      if (visto.has(dep)) continue;
      visto.add(dep);
      if (!verificada(demandas, dep) && noBloco(dep) && ordemSprint(S.sprintDe(mapa, dep)) > meu) return true;
      fila.push(dep);
    }
  }
  return false;
}

/** Demandas iniciadas (status em `iniciados`) fora de ordem: dependência não verificada, ou sprint anterior aberto que não está só à espera de uma adiantada. */
function inicioForaDeOrdem({ mapa, demandas, iniciados = INICIADOS_PADRAO }) {
  const erros = [];
  for (const [id, d] of demandas) {
    if (!noBloco(id) || !iniciados.includes(d.status)) continue;
    const bloqueios = d.dependencias.filter((dep) => !verificada(demandas, dep)).map((dep) => `dependência ${dep} está ${(demandas.get(dep) || { status: 'sem arquivo' }).status}`);
    const meu = ordemSprint(S.sprintDe(mapa, id));
    for (const s of S.SPRINTS.filter((x) => ordemSprint(x) < meu)) {
      const abertas = (mapa[s] || []).filter((o) => !verificada(demandas, o) && !esperaPorPosterior(o, mapa, demandas));
      if (abertas.length) bloqueios.push(`sprint ${s} não fechado (${abertas.join(', ')})`);
    }
    if (bloqueios.length) erros.push(erro(C.INICIO, { id, status: d.status, bloqueadoPor: bloqueios }));
  }
  return erros;
}

/** Avaliação completa. `fontes`: { demandas: Map, mapa (D439), mapaD444, passos, adiantadas }. */
function avaliar({ demandas, mapa, mapaD444, passos, adiantadas, iniciados }) {
  const idsDoBloco = [...demandas.keys()].filter(noBloco).sort();
  const ordem = ordemDasDependencias({ mapa, passos, demandas, adiantadas });
  const erros = [
    ...coberturas({ mapa, mapaD444, passos, idsDoBloco }),
    ...ordem.erros,
    ...inicioForaDeOrdem({ mapa, demandas, iniciados }),
  ];
  return { ok: erros.length === 0, total: idsDoBloco.length, sprints: estadoDosSprints(mapa, demandas), passos: estadoDosPassos(passos, demandas), adiantadas, arestas: ordem.arestas, erros };
}

module.exports = { C, MENSAGENS, ESCOPO, INICIADOS_PADRAO, noBloco, coberturas, arestasDePasso, ordemDasDependencias, estadoDosSprints, estadoDosPassos, esperaPorPosterior, inicioForaDeOrdem, avaliar };
