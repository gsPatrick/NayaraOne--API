'use strict';

/**
 * Invariantes do livro do Marco 3 que a carga confere (funções puras sobre o que fases.js fez e coleta.js leu do banco). Cada uma devolve a
 * lista de violações (vazia = respeitada). A carga só sai verde com TODAS vazias.
 *   pessoaUnica         — Caderno §4: match forte (CPF) bloqueia a criação; N criações SIMULTÂNEAS do mesmo CPF deixam UMA pessoa.
 *   pessoasPerdidas     — toda criação legítima da carga ficou gravada (nada some sob concorrência).
 *   proximaAcao         — Guia/Caderno: oportunidade ativa sem próxima ação não existe (nenhuma aceita, nenhuma no banco).
 *   radarIdempotente    — Guia §9: radar_match único por imóvel e fingerprint; um evento por match; notificação nunca repetida.
 *   isolamento          — Caderno §7: a empresa B não enxerga nada da empresa A.
 *   latencia            — p95 de cada consulta comum abaixo do limite da esteira (carga.limiteP95Ms).
 */

function percentil(tempos, p) {
  if (!tempos.length) return null;
  const ord = [...tempos].sort((a, b) => a - b);
  return Number(ord[Math.min(ord.length - 1, Math.ceil((p / 100) * ord.length) - 1)].toFixed(2));
}

function pessoaUnica(mesmoCpf, gravadas) {
  const v = [];
  if (mesmoCpf.aceitas !== 1) v.push(`${mesmoCpf.aceitas} criações aceitas com o mesmo CPF (esperado 1 de ${mesmoCpf.tentativas})`);
  if (gravadas !== 1) v.push(`${gravadas} pessoas gravadas com o mesmo CPF (esperado 1)`);
  const outras = Object.keys(mesmoCpf.recusas).filter((c) => !['PERSON_DUPLICATE', 'PERSON_DUPLICATE_TAX_ID'].includes(c));
  if (outras.length) v.push(`recusa com código inesperado: ${outras.join(', ')}`);
  return v;
}

function pessoasPerdidas(porEmpresa, gravadas, volume) {
  const v = [];
  for (const emp of Object.keys(porEmpresa)) {
    if (porEmpresa[emp].erros.length) v.push(`empresa ${emp}: ${porEmpresa[emp].erros.length} criações legítimas falharam (${porEmpresa[emp].erros[0]})`);
    if (gravadas[emp] !== volume.pessoasPorEmpresa) v.push(`empresa ${emp}: ${gravadas[emp]} pessoas gravadas, esperado ${volume.pessoasPorEmpresa}`);
  }
  return v;
}

function proximaAcao(oportunidades, banco, volume) {
  const v = [];
  if (oportunidades.erros.length) v.push(`${oportunidades.erros.length} oportunidades legítimas falharam (${oportunidades.erros[0]})`);
  if (banco.oportunidadesDaRodada !== volume.oportunidades) v.push(`${banco.oportunidadesDaRodada} oportunidades gravadas, esperado ${volume.oportunidades}`);
  if (oportunidades.semProximaAcao.aceitas) v.push(`${oportunidades.semProximaAcao.aceitas} oportunidades ativas SEM próxima ação foram aceitas`);
  const outras = Object.keys(oportunidades.semProximaAcao.recusas).filter((c) => c !== 'OPPORTUNITY_NEXT_ACTION_REQUIRED');
  if (outras.length) v.push(`recusa sem próxima ação com código inesperado: ${outras.join(', ')}`);
  if (banco.oportunidadesAtivasSemProximaAcao) v.push(`${banco.oportunidadesAtivasSemProximaAcao} oportunidades ativas sem próxima ação no banco`);
  return v;
}

function radarIdempotente(radar, banco, volume) {
  const v = [];
  if (radar.errosNasOfertas.length) v.push(`${radar.errosNasOfertas.length} imóveis/ofertas falharam (${radar.errosNasOfertas[0]})`);
  for (const fase of radar.radares) {
    const b = banco.radares.find((x) => x.radarId === fase.radarId);
    const p = `radar "${fase.tipo}"`;
    if (fase.reprocessamentos.finalComErro.length) v.push(`${p}: o reprocessamento depois da corrida falhou (${fase.reprocessamentos.finalComErro[0]})`);
    for (const m of b.matchesRepetidos) v.push(`${p}: radar_match repetido, imóvel ${m.property_id} fingerprint ${m.criteria_fingerprint} (${m.n}x)`);
    if (b.imoveisComMatch !== volume.imoveisComOferta) v.push(`${p}: ${b.imoveisComMatch} imóveis com match gravado, esperado ${volume.imoveisComOferta}`);
    if (b.eventosMatchCreated !== b.imoveisComMatch) v.push(`${p}: ${b.eventosMatchCreated} eventos crm.radar.match.created para ${b.imoveisComMatch} matches`);
    for (const e of b.eventosRadarMatchedPorImovel.filter((x) => x.n > 1)) v.push(`${p}: radar.matched repetido para o imóvel ${e.property_id} (${e.n}x)`);
    if (b.eventosRadarMatchedPorImovel.length !== volume.imoveisComOferta) v.push(`${p}: ${b.eventosRadarMatchedPorImovel.length} imóveis com radar.matched, esperado ${volume.imoveisComOferta}`);
    if (b.imoveisAnunciados > b.eventosRadarMatchedPorImovel.length) {
      v.push(`${p}: ${b.notificacoes} notificações "Novo match no Radar" anunciaram ${b.imoveisAnunciados} imóveis para ${b.eventosRadarMatchedPorImovel.length} matches: aviso repetido`);
    }
  }
  return v;
}

function isolamento(vistoPelaEmpresaB) {
  return Object.entries(vistoPelaEmpresaB).filter(([, qtd]) => qtd > 0).map(([o, qtd]) => `a empresa B enxerga ${qtd} ${o} da empresa A`);
}

function latencia(leituras, limiteP95Ms) {
  const resumo = Object.fromEntries(Object.entries(leituras).map(([nome, l]) => [nome, {
    n: l.n, linhas: l.linhas, p50Ms: percentil(l.tempos, 50), p95Ms: percentil(l.tempos, 95), maxMs: percentil(l.tempos, 100),
  }]));
  const violacoes = Object.entries(resumo).filter(([, r]) => r.p95Ms > limiteP95Ms).map(([nome, r]) => `${nome}: p95 ${r.p95Ms} ms acima do limite ${limiteP95Ms} ms`);
  return { resumo, violacoes };
}

module.exports = { percentil, pessoaUnica, pessoasPerdidas, proximaAcao, radarIdempotente, isolamento, latencia };
