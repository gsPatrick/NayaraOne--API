#!/usr/bin/env node
'use strict';

/**
 * M9-D045 — portão de sprint da NAY (AI1 a AI10). O mapa vem da tabela da própria demanda M9-D045 (`demandas/marco-9/`); o status de cada
 * demanda, do cabeçalho do arquivo. Sem `--sprint` mostra o painel dos 10 sprints e reprova (exit 1) cobertura quebrada (demanda do bloco A
 * sem sprint ou em dois), passo sem demanda, início fora de ordem e dependência que contraria a ordem. Com `--sprint AIn` avalia o portão
 * de saída: demandas `verificada`, testes do portão verdes (com `--executar`, sob banco descartável), archGuard e, no AI2, piloto somente leitura.
 * Uso: node scripts/ai-sprint-gate.js [--sprint AI2] [--executar] [--demandas <pasta>] [--iniciado em_execucao,corrigida] [--json]
 * Somente leitura; não grava nada.
 */
const { carregarDemandas, pastaPadrao } = require('./analytics/sprints/demandasMd');
const { lerMapa } = require('./ai-sprint/lib/mapa');
const A = require('./ai-sprint/lib/avaliar');
const { avaliarSprint } = require('./ai-sprint/lib/portao');

const arg = (nome, padrao) => { const i = process.argv.indexOf(nome); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao; };
const flag = (nome) => process.argv.includes(nome);

function avaliarEstrutura(mapa, demandas, iniciadas) {
  const erros = [];
  const cob = A.cobertura(mapa, demandas);
  cob.semSprint.forEach((id) => erros.push(`${id}: demanda do bloco A sem sprint na tabela da M9-D045`));
  cob.emVarios.forEach((x) => erros.push(`${x.id}: em mais de um sprint (${x.sprints.join(', ')})`));
  cob.inexistentes.forEach((id) => erros.push(`${id}: a tabela cita uma demanda sem arquivo`));
  A.passosSemDestino(mapa, demandas).forEach((n) => erros.push(`passo ${n} da ordem exata sem demanda ou com demanda fora dos sprints`));
  A.foraDeOrdem(mapa, demandas, { iniciadas }).forEach((v) => erros.push(`${v.id} (${v.sprint}) está ${v.status} fora de ordem: sprint anterior não fechado (${v.bloqueadoPor.join(', ')})`));
  A.dependenciasIncoerentes(mapa, demandas).forEach((x) => erros.push(`${x.id} (${x.sprint}) depende de ${x.dependencia}, que é do sprint posterior ${x.sprintDaDependencia}`));
  return { erros, estados: A.estadoDosSprints(mapa, demandas) };
}

function imprimirSprint(r) {
  console.log(`${r.sprint} ${r.tema}: ${r.ok ? 'PORTAO APROVADO' : 'PORTAO REPROVADO'}`);
  console.log(`  demandas: ${r.demandas.verificadas}/${r.demandas.total} verificadas`);
  r.demandas.naoVerificadas.forEach((d) => console.log(`    - ${d.id}: ${d.status}`));
  r.testes.forEach((t) => console.log(`  teste [${t.estado}] ${t.rotulo}${t.arquivos.length ? ` (${t.arquivos.length} arquivo(s))` : ''}`));
  r.comandos.forEach((c) => console.log(`  comando [${c.estado}] ${c.rotulo}`));
  r.verificacoes.forEach((v) => console.log(`  verificacao [${v.ok ? 'verde' : 'vermelho'}] ${v.nome}: ${v.ok ? `allowlist do piloto somente leitura (${v.tools.join(', ')}); propostas Desligadas` : v.motivos.join('; ')}`));
}

function main() {
  const demandas = carregarDemandas(arg('--demandas', pastaPadrao()));
  const d045 = demandas.get(A.ARQUIVO_DO_MAPA);
  if (!d045) throw new Error('M9-D045 não encontrada em demandas/marco-9 (o mapa de sprints mora nela)');
  const mapa = lerMapa(d045.texto);
  const iniciadas = arg('--iniciado', A.INICIADAS.join(',')).split(',').map((x) => x.trim()).filter(Boolean);
  const codigo = arg('--sprint', '');
  const { erros, estados } = avaliarEstrutura(mapa, demandas, iniciadas);
  let saida = { estrutura: { ok: erros.length === 0, erros, sprints: estados } };
  let ok = erros.length === 0;
  if (codigo) {
    const r = avaliarSprint(mapa, demandas, codigo.toUpperCase(), { executar: flag('--executar'), iniciadas });
    saida = { ...saida, portao: r };
    ok = ok && r.ok;
    if (!flag('--json')) imprimirSprint(r);
  } else if (!flag('--json')) {
    estados.forEach((s) => console.log(`${s.codigo} ${s.tema}: ${s.estado} (${s.verificadas}/${s.total} verificadas)`));
  }
  if (flag('--json')) console.log(JSON.stringify(saida, null, 2));
  if (erros.length) { console.error('\nEstrutura reprovada:'); erros.forEach((e) => console.error(`  - ${e}`)); }
  if (!ok) { if (codigo && saida.portao) saida.portao.motivos.forEach((m) => console.error(`  - ${m}`)); process.exitCode = 1; }
}

try { main(); } catch (e) { console.error(`Erro: ${e.message}`); process.exitCode = 1; }
