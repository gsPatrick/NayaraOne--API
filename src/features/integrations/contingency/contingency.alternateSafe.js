'use strict';

/**
 * Operações em que a troca para o alternativo é AUTOMÁTICA (M9-D226 3.3 item 2, `alternate_safe` do port). Regra: toda operação SAFE do port (consulta,
 * envio de mensagem) pode trocar sozinha; a DANGEROUS (pagamento, assinatura, publicação) exige aprovação humana, salvo as marcadas aqui. Marcada:
 * `FINANCING.submitCase`, porque o alternativo do financiamento é o fluxo manual assistido, que só registra uma tarefa para uma pessoa agir (sem efeito externo sozinho).
 */
const MARCADAS = Object.freeze({ FINANCING: Object.freeze(['submitCase']) });

/** `def` = definição da operação no port ({ opClass }). */
function isAlternateSafe(domain, operation, def) {
  if (!def) return false;
  if (def.opClass === 'SAFE') return true;
  return Boolean(MARCADAS[domain] && MARCADAS[domain].includes(operation));
}

module.exports = { isAlternateSafe, MARCADAS };
