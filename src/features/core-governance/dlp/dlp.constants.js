'use strict';

/**
 * Vocabulário fechado do DLP (M9-D820 §3.1 e §3.2). Níveis de classificação em ordem crescente de sensibilidade e as seis ações da política.
 * `kind` do pedido de exportação (M9-D821 §3.2, decisão K10) e piso do livro para exportação de dados sensíveis (M9-D820 §3.3 item 2).
 */
const CLASSES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'RESTRICTED']);
const ACTIONS = Object.freeze(['VIEW', 'COPY', 'EXPORT', 'PRINT', 'SHARE', 'AI']);
const KINDS = Object.freeze(['EXPORT', 'SHARE', 'PRINT', 'DOWNLOAD']);

/** Permissão dedicada para ver RESTRICTED em claro (M9-D800 §3.3). */
const VIEW_RESTRICTED_PERMISSION = 'governance:dlp:view-restricted';
const ADMIN_PERMISSION = 'governance:dlp:admin';
const EXPORT_PERMISSION = 'governance:dlp:export';

/** Classes cujo EXPORT não pode perder justificativa, MFA, auditoria nem expiração (o livro). */
const FLOOR_CLASSES = Object.freeze(['HIGH', 'RESTRICTED']);
const FLOOR_ACTION = 'EXPORT';

/** Posição da classe na ordem de sensibilidade (LOW = 0). -1 se desconhecida. */
const classRank = (value) => CLASSES.indexOf(value);

/** A mais alta entre várias classes (M9-D821 etapa 1); lista vazia devolve null. */
function highestClass(values) {
  let best = null;
  for (const value of values) if (classRank(value) > classRank(best)) best = value;
  return best;
}

module.exports = {
  CLASSES, ACTIONS, KINDS, VIEW_RESTRICTED_PERMISSION, ADMIN_PERMISSION, EXPORT_PERMISSION, FLOOR_CLASSES, FLOOR_ACTION, classRank, highestClass,
};
