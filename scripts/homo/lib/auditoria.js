'use strict';
/** Leitura da trilha de auditoria pela API (GET /audit-log). Devolve as mais novas primeiro (limite do servidor: 1000 por filtro). */
async function listar(sessao, filtros = {}) {
  const qs = Object.entries(filtros).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await sessao.chamar('GET', `/audit-log${qs ? `?${qs}` : ''}`);
  return { status: r.status, itens: Array.isArray(r.dados) ? r.dados : [] };
}

/** Linha curta e legível: quem, o quê, quando. */
const linha = (e, nomes = {}) => `${e.action} | por ${e.userId ? (nomes[e.userId] || e.userId) : 'o próprio sistema (rotina automática)'} | em ${e.occurredAt} | id ${e.entityId}`;

module.exports = { listar, linha };
