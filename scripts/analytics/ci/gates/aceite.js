'use strict';

/**
 * M9-D705 etapa 14 (owner reconciliation) — em PRODUCAO toda métrica publicada precisa de aceite ACCEPTED da versão atual (Caderno §23);
 * sem nenhuma métrica publicada também não há o que liberar, e a produção fica bloqueada. Em LAB a etapa não reprova pelo aceite: a cliente
 * decidiu em 16/11/2026 deixar o aceite dos owners para o Marco 10, e a etapa REGISTRA essa pendência (`registro`), sem fingir que houve aceite.
 * Função pura: quem lê as métricas e os aceites (M9-D708) passa as listas.
 * @param {{ ambiente: 'LAB'|'PRODUCAO', metricas: Array<{code: string, version: number}>, aceites: Array<{code: string, version: number, status: string}> }} p
 */
const DECISAO_ACEITE_ADIADO = Object.freeze({
  data: '2026-11-16',
  texto: 'aceite dos owners: pendente para o Marco 10 (decisão da cliente de 16/11/2026)',
});

function pendenciasDe(metricas, aceites) {
  const pendentes = [];
  for (const m of metricas) {
    const atual = aceites.find((a) => a.code === m.code && a.version === m.version && a.status === 'ACCEPTED');
    if (atual) continue;
    const antigo = aceites.find((a) => a.code === m.code && a.status === 'ACCEPTED');
    pendentes.push(antigo
      ? `${m.code}: sem aceite da versão ${m.version} (o aceite existente é da versão ${antigo.version}).`
      : `${m.code}: sem aceite do responsável (versão ${m.version}).`);
  }
  return pendentes;
}

/** Linha de registro da etapa em LAB: a pendência adiada para o Marco 10, ou o aceite completo quando de fato existe. */
function registroLab({ total, pendentes }) {
  if (total > 0 && pendentes === 0) return `aceite dos owners: ${total} de ${total} métrica(s) publicada(s) com aceite da versão atual`;
  return `${DECISAO_ACEITE_ADIADO.texto}; ${total - pendentes} de ${total} métrica(s) publicada(s) com aceite; a liberação para PRODUÇÃO continua exigindo o aceite`;
}

function avaliarAceite({ ambiente, metricas, aceites }) {
  if (!['LAB', 'PRODUCAO'].includes(ambiente)) throw new Error(`ambiente inválido: ${ambiente} (LAB ou PRODUCAO).`);
  const pendentes = pendenciasDe(metricas, aceites);
  if (ambiente === 'LAB') {
    return { ok: true, ambiente, pendentes, problemas: [], aceiteCompleto: metricas.length > 0 && pendentes.length === 0, registro: registroLab({ total: metricas.length, pendentes: pendentes.length }) };
  }
  const problemas = metricas.length ? pendentes : ['nenhuma métrica publicada: sem reconciliação e aceite não há o que liberar para produção.'];
  return { ok: problemas.length === 0, ambiente, pendentes, problemas, aceiteCompleto: problemas.length === 0, registro: null };
}

module.exports = { avaliarAceite, registroLab, DECISAO_ACEITE_ADIADO };
