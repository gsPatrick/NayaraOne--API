#!/usr/bin/env node
'use strict';

/**
 * M9-D706 — portão de sprint do BI (B1 a B9). Lê o mapa sprint -> demandas da própria M9-D706 e o status de cada demanda em
 * `demandas/marco-9/`, e informa por sprint "aberto", "em andamento" ou "fechado" (todas `verificada`; o B9 também exige a esteira do BI
 * aprovada). Reprova (exit 1) início fora de ordem, demanda do bloco D sem sprint ou em mais de um, dependência que contraria a ordem e os
 * 11 passos do Guia sem sprint. Somente leitura.
 * Uso: node scripts/analytics/checkSprintGates.js [--demandas <pasta>] [--esteira <pasta>] [--iniciado em_execucao,corrigida]
 *      [--idade-max-horas 24] [--json]
 */
const { carregarDemandas, pastaPadrao } = require('./sprints/demandasMd');
const { lerMapa, PASSOS } = require('./sprints/mapa');
const { cobertura, estadoDosSprints, foraDeOrdem, dependenciasIncoerentes, INICIADOS_PADRAO } = require('./sprints/avaliar');
const { PADRAO_DIR, IDADE_PADRAO_HORAS } = require('./sprints/esteira');

const arg = (nome, padrao) => { const i = process.argv.indexOf(nome); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao; };
const flag = (nome) => process.argv.includes(nome);

function avaliar(opcoes) {
  const demandas = carregarDemandas(opcoes.demandas);
  const d706 = demandas.get('M9-D706');
  if (!d706) throw new Error('M9-D706 não encontrada em demandas/marco-9 (o mapa de sprints mora nela)');
  const mapa = lerMapa(d706.texto);
  const cob = cobertura(mapa, demandas);
  const sprints = estadoDosSprints(mapa, demandas, { esteira: opcoes.esteira });
  const ordem = foraDeOrdem(mapa, demandas, { iniciados: opcoes.iniciados, esteira: opcoes.esteira });
  const incoerentes = dependenciasIncoerentes(mapa, demandas);
  const codigos = new Set(mapa.sprints.map((s) => s.codigo));
  const passosSemSprint = PASSOS.filter((p) => !p.sprints.length || p.sprints.some((s) => !codigos.has(s))).map((p) => p.n);
  const erros = [];
  cob.semSprint.forEach((id) => erros.push(`${id}: demanda do bloco D sem sprint no mapa`));
  cob.emVarios.forEach((x) => erros.push(`${x.id}: em mais de um sprint (${x.sprints.join(', ')})`));
  cob.inexistentes.forEach((id) => erros.push(`${id}: o mapa cita uma demanda sem arquivo`));
  ordem.forEach((v) => erros.push(`${v.id} (${v.sprint}) está ${v.status} fora de ordem: sprint anterior não fechado (${v.bloqueadoPor.join(', ')})`));
  incoerentes.forEach((x) => erros.push(`${x.id} (${x.sprint}) depende de ${x.dependencia}, que é do sprint posterior ${x.sprintDaDependencia}`));
  passosSemSprint.forEach((n) => erros.push(`passo ${n} do Guia aponta para sprint inexistente`));
  return { ok: erros.length === 0, sprints, passos: PASSOS, erros };
}

function imprimir(r) {
  for (const s of r.sprints) {
    console.log(`${s.codigo} ${s.escopo}: ${s.estado} (${s.verificadas}/${s.total} verificadas)`);
    s.motivos.forEach((m) => console.log(`   - ${m}`));
  }
  for (const p of r.passos) console.log(`passo ${p.n} ${p.nome}: ${p.sprints.join(', ')}`);
}

function main() {
  const iniciados = arg('--iniciado', INICIADOS_PADRAO.join(',')).split(',').map((x) => x.trim()).filter(Boolean);
  const r = avaliar({
    demandas: arg('--demandas', pastaPadrao()),
    iniciados,
    esteira: { dir: arg('--esteira', PADRAO_DIR), idadeMaximaHoras: Number(arg('--idade-max-horas', IDADE_PADRAO_HORAS)) },
  });
  if (flag('--json')) console.log(JSON.stringify(r, null, 2)); else imprimir(r);
  if (!r.ok) {
    console.error(`\nReprovado: ${r.erros.length} problema(s) no portão de sprint (início fora de ordem, cobertura ou dependência).`);
    r.erros.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
  }
}

try { main(); } catch (e) { console.error(`Erro: ${e.message}`); process.exitCode = 1; }
