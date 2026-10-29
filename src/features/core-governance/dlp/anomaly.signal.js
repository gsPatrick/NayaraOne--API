'use strict';

/**
 * Do `access_signal` do guard (M9-D821) para a linha de governance.access_signals (M9-D824 §3.1). Leitura (VIEW) e cópia (COPY) de recurso HIGH ou RESTRICTED viram
 * sinal READ e COPY; exportação, compartilhamento e impressão (aprovados ou bloqueados) viram EXPORT em qualquer classe; AI e as classes baixas não geram sinal.
 * `outcome` DENIED = a decisão foi DENY (cópia negada, valor devolvido mascarado, exportação bloqueada).
 */
const SENSITIVE = Object.freeze(['HIGH', 'RESTRICTED']);
const EXPORT_ACTIONS = Object.freeze(['EXPORT', 'SHARE', 'PRINT']);

/** Anomalia que o tipo de sinal alimenta: leitura e cópia somam em READ; exportação em EXPORT. */
const anomalyKindOf = (signalKind) => (signalKind === 'EXPORT' ? 'EXPORT' : 'READ');

function toRow(signal) {
  if (!signal || !signal.actorUserId) return null;
  let kind = null;
  if (signal.action === 'VIEW' && SENSITIVE.includes(signal.classification)) kind = 'READ';
  else if (signal.action === 'COPY' && SENSITIVE.includes(signal.classification)) kind = 'COPY';
  else if (EXPORT_ACTIONS.includes(signal.action)) kind = 'EXPORT';
  if (!kind) return null;
  const count = Number.isInteger(signal.count) && signal.count >= 1 ? signal.count : 1;
  return {
    userId: signal.actorUserId, kind, action: signal.action, classification: signal.classification, outcome: signal.decision === 'DENY' ? 'DENIED' : 'ALLOWED',
    resourceType: signal.resourceType || null, count, occurredAt: signal.occurredAt || new Date(),
  };
}

module.exports = { toRow, anomalyKindOf };
