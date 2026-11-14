'use strict';
/**
 * Regras do portão de produção do jurídico (Guia M5 §17 etapa production_approval; Guia §22 "Produção apenas depois de
 * gates reais, falhas, restore e pentest"). Função pura: recebe o que a execução da esteira deixou e devolve se a produção
 * pode ser pedida e, se não, cada bloqueio com o código. Nada é lido aqui (gateProducao.js lê os arquivos).
 *
 * Libera só se TODOS forem verdadeiros, no MESMO commit da execução e com a árvore limpa:
 *   1. etapas 1 a 17 da esteira VERDE (gates reais), na execução completa (desde a etapa 1);
 *   2. restore: relatório do drill completo com exitCode 0, todas as checagens aprovadas, commit igual, dirty false;
 *   3. pentest: relatório completo (sem fase abortada, sem filtro de rotas, pelo menos 150 rotas), commit igual, sem
 *      arquivo alterado, nenhum achado crítico ou alto;
 *   4. nenhuma falha aberta: nenhum teste das etapas com status fail, skip ou todo (todo = defeito conhecido ainda aberto),
 *      e toda etapa de teste com resultado gravado.
 */
const ETAPAS_ANTES_DO_PORTAO = 17;
const ROTAS_MINIMAS_PENTEST = 150;

const mesmoCommit = (a, b) => Boolean(a && b) && (String(a).startsWith(String(b)) || String(b).startsWith(String(a))) && Math.min(String(a).length, String(b).length) >= 7;

function conferirEtapas(relatorio, commit, bloqueios) {
  if (!relatorio) { bloqueios.push({ codigo: 'GATE_RELATORIO_AUSENTE', detalhe: 'sem o relatório da execução da esteira' }); return; }
  if (!mesmoCommit(relatorio.commit, commit)) bloqueios.push({ codigo: 'GATE_ETAPA_OUTRO_COMMIT', detalhe: `relatório da esteira em ${relatorio.commit}, portão em ${commit}` });
  if (relatorio.dirty !== false) bloqueios.push({ codigo: 'GATE_ARVORE_SUJA', detalhe: 'a esteira rodou com alterações não commitadas (ou sem git): produção só de commit limpo' });
  for (let n = 1; n <= ETAPAS_ANTES_DO_PORTAO; n += 1) {
    const e = (relatorio.etapas || []).find((x) => x.numero === n);
    if (!e) bloqueios.push({ codigo: 'GATE_ETAPA_NAO_RODOU', detalhe: `etapa ${n} não está no relatório (execução parcial)` });
    else if (e.status !== 'VERDE') bloqueios.push({ codigo: 'GATE_ETAPA_NAO_VERDE', detalhe: `etapa ${n} ${e.nome}: ${e.status}` });
    else if (!mesmoCommit(e.commit, commit)) bloqueios.push({ codigo: 'GATE_ETAPA_OUTRO_COMMIT', detalhe: `etapa ${n} ${e.nome} em ${e.commit}` });
  }
}

function conferirRestore(restores, commit, bloqueios) {
  if (!restores || restores.length === 0) { bloqueios.push({ codigo: 'GATE_RESTORE_AUSENTE', detalhe: 'nenhum relatório do drill de restore nesta execução' }); return; }
  const doCommit = restores.filter((r) => mesmoCommit(r.dados && r.dados.commit, commit));
  if (doCommit.length === 0) { bloqueios.push({ codigo: 'GATE_RESTORE_OUTRO_COMMIT', detalhe: `drill em ${restores.map((r) => r.dados && r.dados.commit).join(', ')}` }); return; }
  for (const { arquivo, dados } of doCommit) {
    const resultados = Array.isArray(dados.results) ? dados.results : [];
    const reprovadas = resultados.filter((x) => x.ok !== true);
    if (dados.dirty !== false) bloqueios.push({ codigo: 'GATE_RESTORE_ARVORE_SUJA', detalhe: `${arquivo}: dirty=${dados.dirty}` });
    if (dados.exitCode !== 0 || resultados.length === 0 || reprovadas.length > 0) {
      bloqueios.push({ codigo: 'GATE_RESTORE_VERMELHO', detalhe: `${arquivo}: exitCode ${dados.exitCode}, ${resultados.length - reprovadas.length}/${resultados.length} checagens aprovadas` });
    }
  }
}

function conferirPentest(pentest, commit, bloqueios) {
  if (!pentest) { bloqueios.push({ codigo: 'GATE_PENTEST_AUSENTE', detalhe: 'nenhum relatório do pentest nesta execução' }); return; }
  const meta = pentest.meta || {};
  const resumo = pentest.resumo || {};
  if (!mesmoCommit(meta.commit, commit)) bloqueios.push({ codigo: 'GATE_PENTEST_OUTRO_COMMIT', detalhe: `pentest em ${meta.commit}` });
  if (meta.arquivosAlteradosNaoCommitados !== 0) bloqueios.push({ codigo: 'GATE_PENTEST_ARVORE_SUJA', detalhe: `${meta.arquivosAlteradosNaoCommitados} arquivo(s) alterado(s) na execução do pentest` });
  const incompleto = (meta.falhasFase || []).length > 0 || meta.filtroDeRotas !== null || !(Number(resumo.rotas) >= ROTAS_MINIMAS_PENTEST);
  if (incompleto) bloqueios.push({ codigo: 'GATE_PENTEST_INCOMPLETO', detalhe: `fases abortadas ${(meta.falhasFase || []).length}, filtro ${meta.filtroDeRotas}, rotas ${resumo.rotas}` });
  const graves = (pentest.ataques || []).filter((a) => a.veredito === 'achado' && (a.gravidade === 'critico' || a.gravidade === 'alto'));
  const porGravidade = resumo.porGravidade || {};
  const declarados = Number(porGravidade.critico || 0) + Number(porGravidade.alto || 0);
  if (graves.length > 0 || declarados > 0) {
    bloqueios.push({ codigo: 'GATE_PENTEST_ACHADO_GRAVE', detalhe: `${Math.max(graves.length, declarados)} achado(s) crítico(s)/alto(s): ${graves.slice(0, 5).map((a) => `${a.gravidade} ${a.rota}`).join('; ')}` });
  }
}

function conferirTestes(testes, etapasDeTeste, bloqueios) {
  for (const etapa of etapasDeTeste) {
    const linhas = (testes || {})[etapa];
    if (!linhas || linhas.length === 0) bloqueios.push({ codigo: 'GATE_TESTES_AUSENTES', detalhe: `etapa ${etapa} sem resultado de teste gravado` });
  }
  for (const [etapa, linhas] of Object.entries(testes || {})) {
    for (const l of linhas.filter((x) => x.status !== 'pass')) {
      bloqueios.push({ codigo: 'GATE_FALHA_ABERTA', detalhe: `${etapa}: ${l.status} — ${l.arquivo} › ${l.nome}${l.motivo ? ` (${l.motivo})` : ''}` });
    }
  }
}

function contarTestes(testes) {
  const c = { pass: 0, fail: 0, skip: 0, todo: 0 };
  for (const linhas of Object.values(testes || {})) for (const l of linhas) c[l.status] = (c[l.status] || 0) + 1;
  return c;
}

/**
 * entrada: { commit, relatorio, restores: [{arquivo, dados}], pentest, testes: { '<etapa>': [linhas] }, etapasDeTeste: ['<etapa>'] }
 * saída: { liberado, commit, bloqueios: [{codigo, detalhe}], resumo }
 */
function avaliarPortao(entrada) {
  const { commit, relatorio, restores, pentest, testes, etapasDeTeste = [] } = entrada;
  const bloqueios = [];
  if (!commit) bloqueios.push({ codigo: 'GATE_COMMIT_DESCONHECIDO', detalhe: 'sem o commit atual' });
  conferirEtapas(relatorio, commit, bloqueios);
  conferirRestore(restores, commit, bloqueios);
  conferirPentest(pentest, commit, bloqueios);
  conferirTestes(testes, etapasDeTeste, bloqueios);
  const resumo = {
    etapasVerdes: ((relatorio && relatorio.etapas) || []).filter((e) => e.numero <= ETAPAS_ANTES_DO_PORTAO && e.status === 'VERDE').length,
    restore: (restores || []).map((r) => ({ arquivo: r.arquivo, commit: r.dados && r.dados.commit, dirty: r.dados && r.dados.dirty, exitCode: r.dados && r.dados.exitCode, aprovadas: ((r.dados && r.dados.results) || []).filter((x) => x.ok === true).length, total: ((r.dados && r.dados.results) || []).length })),
    pentest: pentest ? { commit: pentest.meta && pentest.meta.commit, rotas: pentest.resumo && pentest.resumo.rotas, ataques: pentest.resumo && pentest.resumo.ataques, porGravidade: pentest.resumo && pentest.resumo.porGravidade } : null,
    testes: contarTestes(testes),
  };
  return { liberado: bloqueios.length === 0, commit, bloqueios, resumo };
}

module.exports = { avaliarPortao, mesmoCommit, ETAPAS_ANTES_DO_PORTAO, ROTAS_MINIMAS_PENTEST };
