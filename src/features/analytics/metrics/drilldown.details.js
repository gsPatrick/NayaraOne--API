'use strict';

/**
 * M9-D690 (3.3) — o que cada linha do detalhe mostra além do id: colunas de negócio da tabela de origem e o caminho da tela do registro
 * (que reaplica a permissão). Cada demanda de KPI registra o seu com `registerDrilldownDetail`; sem registro o detalhe mostra as colunas
 * que a própria origem declara (status, natureza, período e valor). Identificadores validados aqui; nunca vêm do usuário.
 */
const IDENT = /^[a-z_][a-z0-9_]*$/;
const LINK = /^\/[A-Za-z0-9/_-]*(\{id\})?[A-Za-z0-9/_-]*$/;
const details = new Map();

function registerDrilldownDetail(metricCode, { columns = [], link = null } = {}) {
  if (!Array.isArray(columns) || !columns.every((c) => IDENT.test(c))) throw new Error(`Detalhe de ${metricCode}: columns inválido.`);
  if (link !== null && !LINK.test(link)) throw new Error(`Detalhe de ${metricCode}: link deve ser um caminho de tela (com {id} quando a tela abre um registro).`);
  details.set(metricCode, Object.freeze({ columns: Object.freeze([...columns]), link }));
}

/** Colunas de negócio (únicas) e link do detalhe da métrica, a partir do registro e da especificação de origem. */
function detailOf(spec) {
  const own = details.get(spec.metricCode) || { columns: [], link: null };
  const c = spec.columns || {};
  const fromSpec = [c.status, c.nature, c.period, spec.valueColumn].filter(Boolean);
  return { columns: [...new Set([...fromSpec, ...own.columns])], link: own.link };
}

const unregisterDrilldownDetail = (metricCode) => details.delete(metricCode); // só para teste

module.exports = { registerDrilldownDetail, detailOf, unregisterDrilldownDetail };
