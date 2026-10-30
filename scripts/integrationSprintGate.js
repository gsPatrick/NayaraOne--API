#!/usr/bin/env node
'use strict';

/**
 * M9-D255 — portão de sprint das integrações (I1 a I9). O mapa vem da tabela da própria demanda M9-D255 (`demandas/marco-9/`); o status de cada
 * demanda, do cabeçalho do arquivo. Sem `--sprint` mostra o painel dos 9 sprints e reprova (exit 1) cobertura quebrada (demanda do bloco sem
 * sprint ou em dois), passo sem demanda e dependência de sprint posterior. Com `--sprint In` avalia o portão de saída; sem demanda verificada
 * sai com 1 e INTEGRATION_SPRINT_GATE_FAILED. `--gerar-doc` escreve docs/integrations/SPRINTS.md.
 * Uso: node scripts/integrationSprintGate.js [--sprint I3] [--executar] [--demandas <pasta>] [--iniciado em_execucao,corrigida] [--json] [--gerar-doc]
 * Somente leitura (exceto --gerar-doc).
 */
const fs = require('node:fs');
const path = require('node:path');
const { carregarDemandas, pastaPadrao } = require('./analytics/sprints/demandasMd');
const { lerMapa } = require('./int-sprint/lib/mapa');
const A = require('./int-sprint/lib/avaliar');
const { avaliarSprint, CODIGO_REPROVADO } = require('./int-sprint/lib/portao');
const { gerarDocumento } = require('./int-sprint/lib/documento');

const DOC = path.join(__dirname, '..', 'docs', 'integrations', 'SPRINTS.md');
const arg = (nome, padrao) => { const i = process.argv.indexOf(nome); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao; };
const flag = (nome) => process.argv.includes(nome);

function avaliarEstrutura(mapa, demandas) {
  const erros = [];
  const cob = A.cobertura(mapa, demandas);
  cob.semSprint.forEach((id) => erros.push(`${id}: demanda do bloco sem sprint na tabela da M9-D255`));
  cob.emVarios.forEach((x) => erros.push(`${x.id}: em mais de um sprint (${x.sprints.join(', ')})`));
  cob.inexistentes.forEach((id) => erros.push(`${id}: a tabela cita uma demanda sem arquivo`));
  A.passosSemDestino(mapa, demandas).forEach((n) => erros.push(`passo ${n} da ordem exata sem demanda ou com demanda fora dos sprints`));
  A.dependenciasIncoerentes(mapa, demandas).forEach((x) => erros.push(`${x.id} (${x.sprint}) depende de ${x.dependencia}, que é do sprint posterior ${x.sprintDaDependencia}`));
  mapa.sprints.forEach((s) => { const { ciclo } = A.ordemDeExecucao(mapa, demandas, s.codigo); if (ciclo.length) erros.push(`${s.codigo}: dependência circular entre ${ciclo.join(', ')}`); });
  return { erros, estados: A.estadoDosSprints(mapa, demandas) };
}

function imprimirSprint(r) {
  console.log(`${r.sprint} ${r.tema}: ${r.ok ? 'PORTAO APROVADO' : 'PORTAO REPROVADO'}`);
  console.log(`  demandas: ${r.demandas.verificadas}/${r.demandas.total} verificadas`);
  r.demandas.naoVerificadas.forEach((d) => console.log(`    - ${d.id}: ${d.status}`));
  r.testes.forEach((t) => console.log(`  teste [${t.estado}] ${t.rotulo}${t.arquivos.length ? ` (${t.arquivos.length} arquivo(s))` : ''}`));
  r.comandos.forEach((c) => console.log(`  comando [${c.estado}] ${c.rotulo}`));
}

function main() {
  const demandas = carregarDemandas(arg('--demandas', pastaPadrao()));
  const d255 = demandas.get(A.ARQUIVO_DO_MAPA);
  if (!d255) throw new Error('M9-D255 não encontrada em demandas/marco-9 (o mapa de sprints mora nela)');
  const mapa = lerMapa(d255.texto);
  if (flag('--gerar-doc')) { fs.mkdirSync(path.dirname(DOC), { recursive: true }); fs.writeFileSync(DOC, gerarDocumento(mapa, demandas)); console.log(`Escrito: ${path.relative(process.cwd(), DOC)}`); return; }
  const iniciadas = arg('--iniciado', A.INICIADAS.join(',')).split(',').map((x) => x.trim()).filter(Boolean);
  const codigo = arg('--sprint', '');
  const { erros, estados } = avaliarEstrutura(mapa, demandas);
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
  if (!ok) {
    if (codigo && saida.portao) { console.error(`\n${CODIGO_REPROVADO}: ${saida.portao.message || 'Há demandas do sprint ainda não verificadas.'}`); saida.portao.motivos.forEach((m) => console.error(`  - ${m}`)); }
    process.exitCode = 1;
  }
}

try { main(); } catch (e) { console.error(`Erro: ${e.message}`); process.exitCode = 1; }
