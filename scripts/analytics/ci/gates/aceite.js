'use strict';

/**
 * M9-D705 etapa 14 (owner reconciliation) — em PRODUCAO toda métrica publicada precisa de aceite ACCEPTED da versão atual (Caderno §23);
 * em LAB a etapa só informa os pendentes. Função pura: quem lê as métricas e os aceites (M9-D708) passa as listas.
 * @param {{ ambiente: 'LAB'|'PRODUCAO', metricas: Array<{code: string, version: number}>, aceites: Array<{code: string, version: number, status: string}> }} p
 */
function avaliarAceite({ ambiente, metricas, aceites }) {
  if (!['LAB', 'PRODUCAO'].includes(ambiente)) throw new Error(`ambiente inválido: ${ambiente} (LAB ou PRODUCAO).`);
  const pendentes = [];
  for (const m of metricas) {
    const atual = aceites.find((a) => a.code === m.code && a.version === m.version && a.status === 'ACCEPTED');
    if (atual) continue;
    const antigo = aceites.find((a) => a.code === m.code && a.status === 'ACCEPTED');
    pendentes.push(antigo
      ? `${m.code}: sem aceite da versão ${m.version} (o aceite existente é da versão ${antigo.version}).`
      : `${m.code}: sem aceite do responsável (versão ${m.version}).`);
  }
  return { ok: ambiente === 'LAB' || pendentes.length === 0, ambiente, pendentes, problemas: ambiente === 'PRODUCAO' ? pendentes : [] };
}

module.exports = { avaliarAceite };
