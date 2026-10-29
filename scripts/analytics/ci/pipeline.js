'use strict';

/**
 * M9-D705 — executor da esteira do BI. Roda as etapas da fase pedida na ordem; a primeira que reprova bloqueia as seguintes (BLOQUEADA, com o
 * motivo apontando a etapa). Cada etapa arquiva um log e o resumo.json traz etapa, status, motivo, horários e o log. O executor de comandos é
 * injetado (o teste usa um falso; o `run.js` usa o processo de verdade).
 */
const { ETAPAS } = require('./etapas');
const { gravarLog, gravarResumo, redigir } = require('./arquivo');

const FASES = { pr: ['pr'], promocao: ['promocao'], tudo: ['pr', 'promocao'] };

function motivoDe(saida) {
  const linhas = redigir(saida).split('\n').map((l) => l.trim()).filter(Boolean);
  const erro = linhas.find((l) => /^(✖|not ok)\s/.test(l)) || [...linhas].reverse().find((l) => /erro|error|falh|fail|reprov|sem |✖|not ok/i.test(l));
  return (erro || linhas[linhas.length - 1] || 'a etapa terminou com erro sem mensagem').slice(0, 300);
}

async function runPipeline({ fase = 'pr', executar, saida, etapas = ETAPAS, agora = () => new Date() }) {
  if (!FASES[fase]) throw new Error(`fase inválida: ${fase} (pr, promocao ou tudo).`);
  const resultado = [];
  let bloqueio = null;
  for (const etapa of etapas) {
    const base = { n: etapa.n, chave: etapa.chave, livro: etapa.livro, fase: etapa.fase };
    if (!FASES[fase].includes(etapa.fase)) { resultado.push({ ...base, status: 'FORA_DA_FASE', motivo: `a etapa ${etapa.n} roda na fase ${etapa.fase}` }); continue; }
    const inicio = agora().toISOString();
    if (bloqueio) {
      const log = gravarLog(saida, etapa, `Etapa ${etapa.n} (${etapa.livro}) bloqueada: a etapa ${bloqueio.n} (${bloqueio.livro}) reprovou.\n`);
      resultado.push({ ...base, status: 'BLOQUEADA', motivo: `bloqueada pela etapa ${bloqueio.n} (${bloqueio.livro})`, inicio, fim: inicio, log });
      continue;
    }
    let texto = '';
    let reprovada = null;
    for (const comando of etapa.comandos) {
      const r = await executar({ ...comando, etapa: etapa.n });
      texto += `$ ${comando.cmd} ${comando.args.join(' ')}\n${r.output}\n`;
      if (r.code !== 0) { reprovada = motivoDe(r.output); break; }
    }
    const log = gravarLog(saida, etapa, texto);
    const fim = agora().toISOString();
    if (reprovada) { bloqueio = etapa; resultado.push({ ...base, status: 'REPROVADA', motivo: reprovada, inicio, fim, log }); }
    else resultado.push({ ...base, status: 'APROVADA', motivo: null, inicio, fim, log });
  }
  const ok = !bloqueio;
  gravarResumo(saida, { fase, ok, reprovadaNaEtapa: bloqueio ? bloqueio.n : null, etapas: resultado });
  return { ok, etapas: resultado };
}

module.exports = { runPipeline };
