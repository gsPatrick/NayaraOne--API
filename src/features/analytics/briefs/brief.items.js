'use strict';

/**
 * M9-D693 (3.3, 3.4, 3.6) — monta os itens finais do briefing. A ORDEM, o tipo, a fonte e o frescor são do servidor (candidatos); da NAY vem só o
 * texto que passou pela verificação de grounding. O item de qualidade é texto do servidor (o dado está incompleto, sem conclusão). A ação
 * sugerida é sempre texto do tipo SUGESTAO: nenhuma ação é executada, e decisão crítica segue o fluxo de aprovação existente.
 */
const NO_CAUSE = 'causa não identificada nos dados';

const suggestion = (text) => ({ tipo: 'SUGESTAO', texto: String(text ?? '').trim() });

/** Garante a frase obrigatória quando o item não afirma causa registrada (3.2 item 4); a frase é fato do servidor, não hipótese. */
function withUncertainty(item) {
  if (item.tipoAfirmacao === 'CAUSA') return String(item.incerteza ?? '').trim();
  const text = String(item.incerteza ?? '').trim();
  if (text.toLowerCase().includes(NO_CAUSE)) return text;
  return text ? `${text.replace(/[.\s]+$/, '')}. ${NO_CAUSE[0].toUpperCase()}${NO_CAUSE.slice(1)}.` : `${NO_CAUSE[0].toUpperCase()}${NO_CAUSE.slice(1)}.`;
}

function modelItem(candidate, item) {
  const cause = item.tipoAfirmacao === 'CAUSA';
  return {
    refId: candidate.refId, tipo: candidate.tipo, fato: item.fato.trim(), variacao: String(item.variacao ?? '').trim(), fonte: candidate.fonte,
    incerteza: withUncertainty(item), acaoSugerida: suggestion(item.acaoSugerida), dominios: candidate.domains, metricCodes: [candidate.metricCode],
    ...(cause ? { tipoAfirmacao: 'CAUSA', fonteCausa: item.fonteCausa } : {}),
  };
}

function qualityItem(candidate) {
  return {
    refId: candidate.refId, tipo: 'ATENCAO_QUALIDADE', fato: candidate.fato, variacao: '', fonte: candidate.fonte,
    incerteza: `Situação do dado: ${candidate.reasons.join(', ')}.`, acaoSugerida: suggestion(`Aguardar a atualização do dado de ${candidate.area} antes de decidir.`),
    dominios: candidate.domains, metricCodes: candidate.metricCodes,
  };
}

/** `validByRef`: Map(refId -> item da NAY aprovado). Candidato de métrica sem item aprovado fica de fora. */
function composeItems(selected, validByRef) {
  const out = [];
  for (const c of selected) {
    const item = c.kind === 'QUALIDADE' ? qualityItem(c) : validByRef.has(c.refId) ? modelItem(c, validByRef.get(c.refId)) : null;
    if (item) out.push({ ordem: out.length + 1, ...item });
  }
  return out;
}

module.exports = { composeItems, NO_CAUSE };
