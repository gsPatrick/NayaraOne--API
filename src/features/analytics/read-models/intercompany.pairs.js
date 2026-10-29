'use strict';

/**
 * M9-D625 (3.2 e 3.3) — estado do par de uma transferência entre empresas: os dois lados são lançamentos (saída na origem, entrada no destino)
 * criados juntos na aprovação. Lado "existe" = lançamento presente e fora de CANCELLED e REVERSED. MATCHED = os dois existem e o valor de cada um é
 * o valor da transferência; um lado só = ONLY_FROM ou ONLY_TO; os dois existem com valor diferente = AMOUNT_MISMATCH. Sem nenhum lado: não há efeito no
 * ledger (nada a eliminar nem a alertar) e a transferência não vira linha. Função pura: o par nunca é "aproximado".
 */
const money = require('../metrics/formulas/money');

const DEAD = new Set(['CANCELLED', 'REVERSED']);
const alive = (entry) => Boolean(entry) && !DEAD.has(entry.status);

function pairState(transfer, from, to) {
  const hasFrom = alive(from);
  const hasTo = alive(to);
  if (!hasFrom && !hasTo) return null;
  if (hasFrom && !hasTo) return 'ONLY_FROM';
  if (!hasFrom && hasTo) return 'ONLY_TO';
  const same = (entry) => money.cmp(String(entry.amount), String(transfer.amount)) === 0;
  return same(from) && same(to) ? 'MATCHED' : 'AMOUNT_MISMATCH';
}

/** Campos da linha do read model (colunas de rm_finance_intercompany). */
function pairFields(transfer, from, to, state) {
  const side = (entry, prefix) => ({
    [`${prefix}_entry_id`]: entry ? entry.id : null, [`${prefix}_entry_status`]: entry ? entry.status : null, [`${prefix}_amount`]: entry ? entry.amount : null,
    [`${prefix}_due_at`]: entry ? entry.due_at : null, [`${prefix}_settled_at`]: entry ? entry.settled_at : null,
  });
  return { to_company_id: transfer.to_company_id, amount: transfer.amount, transfer_status: transfer.status, pair_state: state, ...side(from, 'from'), ...side(to, 'to') };
}

module.exports = { pairState, pairFields, alive };
