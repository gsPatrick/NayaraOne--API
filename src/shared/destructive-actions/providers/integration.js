'use strict';

const { rows, one, blocker } = require('./sql');

/** Retry perigoso (linha 16): só vale para erro de envio (DISPATCH) cuja operação é DANGEROUS; as demais repetições seguem a regra da M9-D250. */
async function integrationRetry({ id, transaction, preview }) {
  const e = await one(transaction, 'SELECT id, source, source_ref_id, status, operation, provider_code, error_class FROM integration.integration_errors WHERE id = :id', { id }, 'Erro de integração não encontrado.', 'INTEGRATION_ERROR_NOT_FOUND');
  let dispatch = null;
  if (e.source === 'DISPATCH' && e.source_ref_id) [dispatch] = await rows(transaction, 'SELECT id, criticality_op, attempts, max_attempts, operation FROM integration.dispatches WHERE id = :rid', { rid: e.source_ref_id });
  const dangerous = Boolean(dispatch && dispatch.criticality_op === 'DANGEROUS');
  if (!preview && !dangerous) return { skip: true };
  const blockers = ['OPEN', 'RETRYING'].includes(e.status) ? [] : [blocker('ERROR_NOT_OPEN', `o erro está ${e.status} e não aceita nova repetição`)];
  return {
    code: String(e.id).slice(0, 8).toUpperCase(),
    label: `${e.provider_code} · ${e.operation || e.source}`,
    impact: {
      counts: { operations: dispatch ? 1 : 0, attemptsSoFar: dispatch ? Number(dispatch.attempts) : 0, dangerous: dangerous ? 1 : 0 },
      totalAmountCents: 0,
      blockers,
      items: [{ type: 'INTEGRATION_ERROR', id: e.id, label: `${e.provider_code} · ${e.operation || e.source}`, dangerous }],
    },
  };
}

const DISABLING = ['DISABLED', 'REVOKED'];

/** Desligar/revogar uma integração (linha 17): só a transição para DISABLED ou REVOKED pede confirmação; mostra envios pendentes e erros abertos. */
async function integrationConnection({ id, transaction, preview, req }) {
  const target = String((req && req.body && (req.body.toStatus || req.body.status || req.body.targetStatus)) || '').toUpperCase();
  if (!preview && !DISABLING.includes(target)) return { skip: true };
  const c = await one(transaction, 'SELECT id, label, provider_code, environment, status FROM integration.connections WHERE id = :id', { id }, 'Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  const [pending] = await rows(transaction, `SELECT COUNT(*)::int AS n FROM integration.dispatches WHERE connection_id = :id AND status NOT IN ('CONFIRMED','DEAD_LETTER','FAILED','CANCELLED')`, { id });
  const [errors] = await rows(transaction, `SELECT COUNT(*)::int AS n FROM integration.integration_errors WHERE connection_id = :id AND status IN ('OPEN','RETRYING')`, { id });
  const blockers = DISABLING.includes(c.status) ? [blocker('CONNECTION_ALREADY_OFF', `a integração já está ${c.status === 'DISABLED' ? 'desligada' : 'revogada'}`)] : [];
  return {
    code: c.label,
    label: `${c.label} (${c.provider_code}, ${c.environment})`,
    impact: { counts: { connections: 1, pendingDispatches: pending.n, openErrors: errors.n }, totalAmountCents: 0, blockers, items: [{ type: 'CONNECTION', id: c.id, label: `${c.label} · ${c.environment}`, status: c.status }] },
  };
}

module.exports = { integrationRetry, integrationConnection };
