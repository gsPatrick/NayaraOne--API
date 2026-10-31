#!/usr/bin/env node
'use strict';

/**
 * M9-D444 — portão de sprints M1 a M9 e ordem exata de 11 passos do Marketing. Lê os arquivos de demanda M9-D400 a M9-D444 (mapa de sprints da M9-D439, passos e dependências
 * adiantadas da M9-D444) e informa, por sprint e por passo, "aberto", "em andamento" ou "fechado". Reprova (saída 1) com:
 *   MKT_SPRINT_MAP_INVALID, MKT_SPRINT_ORDER_VIOLATION e MKT_SPRINT_START_BLOCKED. Somente leitura, sem banco.
 * Uso: node scripts/marketing/checkSprintGates.js [--demandas <pasta>] [--iniciado em_execucao,corrigida] [--json] [--demandas-opcional]
 *      [--pronto-para-lab [--esteira <pasta dos relatórios>]]   (DoD item a item e as 4 respostas do Guia §16; saída 1 enquanto houver item pendente)
 *   --demandas-opcional: sem a pasta de demandas (CI que só baixa a API) avisa e sai 0; com a pasta, o portão vale integralmente.
 */
const fs = require('node:fs');
const path = require('node:path');
const { carregarDemandas, pastaPadrao } = require('../analytics/sprints/demandasMd');
const S = require('../lib/marketingSprints');
const P = require('../lib/marketingPassos');
const G = require('../lib/marketingPortao');
const L = require('../lib/marketingProntoParaLab');
const { lerDodDemanda } = require('../lib/marketingDod');

const arg = (nome, padrao) => { const i = process.argv.indexOf(nome); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao; };
const flag = (nome) => process.argv.includes(nome);

/** Avalia a pasta de demandas (ou o Map já lido, nos testes). */
function avaliarPasta({ demandas, iniciados }) {
  const d439 = demandas.get('M9-D439');
  const d444 = demandas.get('M9-D444');
  if (!d439 || !d444) throw new Error('M9-D439 e M9-D444 precisam existir em demandas/marco-9 (o mapa e a tabela de adiantadas moram nelas)');
  return G.avaliar({
    demandas, iniciados,
    mapa: S.lerMapaSprints(d439.texto), mapaD444: P.lerMapaD444(d444.texto), passos: P.lerPassos(d444.texto), adiantadas: S.lerAdiantadas(d444.texto),
  });
}

function imprimir(r) {
  console.log(`Marketing: ${r.total} demandas, ${r.sprints.length} sprints, ${r.passos.length} passos, ${r.adiantadas.length} dependências adiantadas`);
  for (const s of r.sprints) {
    console.log(`${s.codigo} ${s.escopo}: ${s.estado} (${s.verificadas}/${s.total} verificadas)`);
    s.motivos.forEach((m) => console.log(`   - ${m}`));
  }
  for (const p of r.passos) {
    console.log(`${p.codigo} ${p.escopo}: ${p.estado} (${p.verificadas}/${p.total} verificadas)`);
    p.motivos.forEach((m) => console.log(`   - ${m}`));
  }
  r.adiantadas.forEach((a) => console.log(`adiantada ${a.replace('>', ' depende de ')}`));
}

/** Declaração "PRONTO PARA LAB": DoD da M9-D439 item a item, as 4 respostas da autochecagem e o relatório da esteira de 14 estágios. */
function declararProntoParaLab(demandas, dirEsteira) {
  const dod = lerDodDemanda(demandas.get('M9-D439').texto);
  const r = L.declaracao({ demandas, dod, esteira: L.lerRelatoriosEsteira(dirEsteira) });
  r.itens.forEach((i) => console.log(`DoD ${i.verde ? 'verde   ' : 'PENDENTE'} ${i.item} <- ${i.demandas.join(', ')}${i.pendentes.length ? ` [${i.pendentes.join('; ')}]` : ''}`));
  r.respostas.forEach((a) => console.log(`§16 ${a.pergunta} ${a.resposta} (${a.evidencia})${a.pendentes.length ? ` [${a.pendentes.join('; ')}]` : ''}`));
  console.log(r.mensagem);
  return r;
}

function main() {
  const pasta = arg('--demandas', pastaPadrao());
  if (flag('--demandas-opcional') && !fs.existsSync(path.join(pasta, 'marco-9'))) {
    console.log(`Aviso: pasta de demandas ausente (${path.join(pasta, 'marco-9')}); portão de sprints do Marketing não conferido neste ambiente.`);
    return;
  }
  const iniciados = arg('--iniciado', G.INICIADOS_PADRAO.join(',')).split(',').map((x) => x.trim()).filter(Boolean);
  const demandasLidas = carregarDemandas(pasta);
  const r = avaliarPasta({ demandas: demandasLidas, iniciados });
  if (flag('--json')) console.log(JSON.stringify(r, null, 2)); else imprimir(r);
  if (flag('--pronto-para-lab') && r.ok) {
    const lab = declararProntoParaLab(demandasLidas, arg('--esteira', path.join(path.join(__dirname, '..', '..'), 'docs', 'evidencias', 'ci')));
    if (!lab.pronto) process.exitCode = 1;
  }
  if (!r.ok) {
    console.error(`\nReprovado: ${r.erros.length} problema(s) no portão de sprints do Marketing.`);
    r.erros.forEach((e) => console.error(`  - ${e.codigo}: ${e.mensagem} ${e.id || e.de || ''}${e.para ? ` -> ${e.para}` : ''}${e.detalhe ? ` (${e.detalhe})` : ''}${e.bloqueadoPor ? ` [${e.bloqueadoPor.join('; ')}]` : ''}`));
    process.exitCode = 1;
  }
}

if (require.main === module) { try { main(); } catch (e) { console.error(`Erro: ${e.message}`); process.exitCode = 1; } }

module.exports = { avaliarPasta };
