'use strict';

/**
 * formatBR — formatação brasileira para TEXTOS gerados pela API (descrições de lançamento,
 * motivos de auditoria, tarefas). M45-RECONF F8: "competência 2026-09" aparecia em ISO.
 */

/** "2026-09" -> "09/2026". Qualquer outro formato volta como veio. */
function formatCompetenceBR(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || '').trim());
  return m ? `${m[2]}/${m[1]}` : String(period || '');
}

/** 1234.5 -> "R$ 1.234,50". */
function formatMoneyBR(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n).replace(/\u00a0/g, ' ');
}

module.exports = { formatCompetenceBR, formatMoneyBR };
