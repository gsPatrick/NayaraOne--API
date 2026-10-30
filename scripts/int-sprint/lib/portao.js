'use strict';

/**
 * M9-D255 — avalia o portão de saída de UM sprint das integrações: (1) todas as demandas do sprint `verificada`; (2) os testes do portão presentes
 * e verdes (o sprint não fecha com teste ausente, vermelho ou não executado); (3) os comandos do livro (DoD, ensaio de falha, carga); (4) nenhum
 * sprint anterior aberto com demanda deste em execução. Reprovação = código INTEGRATION_SPRINT_GATE_FAILED. Devolve
 * { sprint, ok, code, message, demandas, testes, comandos, motivos }.
 */
const { spawnSync } = require('node:child_process');
const { estadoDosSprints, foraDeOrdem, ordemDeExecucao } = require('./avaliar');
const T = require('../../ai-sprint/lib/testes');
const { exigenciasDoSprint, RAIZ } = require('./exigencias');

const CODIGO_REPROVADO = 'INTEGRATION_SPRINT_GATE_FAILED';
const MENSAGEM = 'Há demandas do sprint ainda não verificadas.';

function rodarComando(c, { spawn = spawnSync, env = process.env, raiz = RAIZ } = {}) {
  const r = spawn(c.argv[0], c.argv.slice(1), { cwd: raiz, env, encoding: 'utf8' });
  return r.status === 0;
}

function avaliarSprint(mapa, demandas, codigo, { executar = false, exigencias, iniciadas, ambiente, spawn, raiz = RAIZ } = {}) {
  const sprint = mapa.sprints.find((s) => s.codigo === codigo);
  if (!sprint) throw new Error(`sprint desconhecido: ${codigo} (use I1 a I9)`);
  const estado = estadoDosSprints(mapa, demandas).find((e) => e.codigo === codigo);
  const ex = exigencias || exigenciasDoSprint(mapa, codigo, { raiz });
  const motivos = [];
  estado.naoVerificadas.forEach((d) => motivos.push(`${d.id} está ${d.status}: o sprint só fecha com todas as demandas verificadas`));
  foraDeOrdem(mapa, demandas, { iniciadas }).filter((v) => v.sprint === codigo).forEach((v) => motivos.push(`${v.id} ${v.status} com o sprint ${v.bloqueadoPor.join(', ')} ainda não fechado`));
  const { ciclo } = ordemDeExecucao(mapa, demandas, codigo);
  if (ciclo.length) motivos.push(`dependência circular entre ${ciclo.join(', ')}`);
  (ex.semTeste || []).forEach((id) => motivos.push(`${id} não tem teste nomeado m9d${id.slice(4)}.* nem teste citado no portão`));

  const testes = T.avaliarItens(T.resolver(ex.testes, raiz), { rodar: executar, env: ambiente, raiz, spawn });
  for (const t of testes) {
    if (t.estado === 'ausente') motivos.push(`teste do portão ausente: ${t.rotulo}`);
    else if (t.estado === 'vermelho') motivos.push(`teste do portão vermelho: ${t.rotulo}`);
    else if (t.estado === 'nao_executado') motivos.push(`teste do portão não executado: ${t.rotulo} (rode com --executar, em banco descartável)`);
  }
  const comandos = ex.comandos.map((c) => ({ rotulo: c.rotulo, estado: executar ? (rodarComando(c, { spawn, env: ambiente || process.env, raiz }) ? 'verde' : 'vermelho') : 'nao_executado' }));
  for (const c of comandos) if (c.estado !== 'verde') motivos.push(`${c.rotulo}: ${c.estado === 'vermelho' ? 'vermelho' : 'não executado (rode com --executar)'}`);
  const ok = motivos.length === 0;
  return {
    sprint: codigo, tema: sprint.tema, portao: sprint.portao, ok, code: ok ? null : CODIGO_REPROVADO, message: ok ? null : MENSAGEM,
    demandas: { total: estado.total, verificadas: estado.verificadas, naoVerificadas: estado.naoVerificadas }, testes, comandos, motivos,
  };
}

module.exports = { avaliarSprint, CODIGO_REPROVADO, MENSAGEM };
