'use strict';

/**
 * M9-D045 — avalia o portão de saída de UM sprint: (1) todas as demandas do sprint `verificada`; (2) os testes do portão presentes e verdes
 * (o sprint não fecha com teste ausente, vermelho ou não executado); (3) os comandos (archGuard) e as verificações (piloto do AI2) do livro;
 * (4) nenhum sprint anterior aberto com demanda deste em execução. Devolve { sprint, ok, demandas, testes, comandos, verificacoes, motivos }.
 */
const { spawnSync } = require('node:child_process');
const { estadoDosSprints, foraDeOrdem } = require('./avaliar');
const T = require('./testes');
const { exigenciasDoSprint, RAIZ } = require('./exigencias');
const { verificarPiloto } = require('./piloto');

const VERIFICACOES = { piloto: () => verificarPiloto() };

function rodarComando(c, { spawn = spawnSync, env = process.env } = {}) {
  const r = spawn(c.argv[0], c.argv.slice(1), { cwd: RAIZ, env, encoding: 'utf8' });
  return r.status === 0;
}

function avaliarSprint(mapa, demandas, codigo, { executar = false, exigencias, iniciadas, ambiente, spawn, raiz } = {}) {
  const sprint = mapa.sprints.find((s) => s.codigo === codigo);
  if (!sprint) throw new Error(`sprint desconhecido: ${codigo} (use AI1 a AI10)`);
  const estado = estadoDosSprints(mapa, demandas).find((e) => e.codigo === codigo);
  const ex = exigencias || exigenciasDoSprint(codigo);
  const motivos = [];
  estado.naoVerificadas.forEach((d) => motivos.push(`${d.id} está ${d.status}: o sprint só fecha com todas as demandas verificadas`));
  foraDeOrdem(mapa, demandas, { iniciadas }).filter((v) => v.sprint === codigo).forEach((v) => motivos.push(`${v.id} ${v.status} com o sprint ${v.bloqueadoPor.join(', ')} ainda não fechado`));

  const testes = T.avaliarItens(T.resolver(ex.testes, raiz), { rodar: executar, env: ambiente, raiz, spawn });
  for (const t of testes) {
    if (t.estado === 'ausente') motivos.push(`teste do portão ausente: ${t.rotulo}`);
    else if (t.estado === 'vermelho') motivos.push(`teste do portão vermelho: ${t.rotulo}`);
    else if (t.estado === 'nao_executado') motivos.push(`teste do portão não executado: ${t.rotulo} (rode com --executar, em banco descartável)`);
  }
  const comandos = ex.comandos.map((c) => ({ rotulo: c.rotulo, estado: executar ? (rodarComando(c, { spawn, env: ambiente || process.env }) ? 'verde' : 'vermelho') : 'nao_executado' }));
  for (const c of comandos) if (c.estado !== 'verde') motivos.push(`${c.rotulo}: ${c.estado === 'vermelho' ? 'vermelho' : 'não executado (rode com --executar)'}`);
  const verificacoes = ex.verificacoes.map((nome) => ({ nome, ...VERIFICACOES[nome]() }));
  for (const v of verificacoes) if (!v.ok) v.motivos.forEach((m) => motivos.push(`portão do ${codigo}: ${m}`));
  return { sprint: codigo, tema: sprint.tema, ok: motivos.length === 0, demandas: { total: estado.total, verificadas: estado.verificadas, naoVerificadas: estado.naoVerificadas }, testes, comandos, verificacoes, motivos };
}

module.exports = { avaliarSprint };
