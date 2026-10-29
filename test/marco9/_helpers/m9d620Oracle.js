'use strict';

// Apoio da M9-D620: recalcula o caixa livre e o dinheiro de terceiros "do zero" só com as linhas-fonte do Financeiro (conexão de superusuário),
// sem usar o read model, o worker nem a fórmula. Dinheiro em centavos inteiros (BigInt); fim do dia-base de São Paulo na mão (UTC-3 fixo).
const toCents = (text) => {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text));
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] || '').padEnd(2, '0').slice(0, 2));
  return m[1] ? -cents : cents;
};
const fromCents = (c) => `${c < 0n ? '-' : ''}${(c < 0n ? -c : c) / 100n}.${String((c < 0n ? -c : c) % 100n).padStart(2, '0')}`;
const dayEnd = (asOf) => new Date(Date.parse(`${asOf}T00:00:00Z`) + 86400000 + 3 * 3600 * 1000);

/** { caixaTotal, terceirosRetidos, freeCash, entradasTerceiros, liberacoes } em texto decimal, a partir das linhas de `company_id`. */
async function cashFromSource(env, t, asOf, { includeOpening = true } = {}) {
  const [rows] = await env.admin.query(
    `SELECT nature, entry_type, amount::text AS amount, status, settled_at, is_third_party_funds, reversal_of_entry_id, idempotency_key FROM finance.financial_entries WHERE company_id = :c`,
    { replacements: { c: t.companyId } });
  const [accounts] = await env.admin.query('SELECT opening_balance::text AS opening FROM finance.bank_accounts WHERE company_id = :c AND deleted_at IS NULL AND owner_person_id IS NULL', { replacements: { c: t.companyId } });
  const end = dayEnd(asOf);
  let total = 0n;
  let inflowThird = 0n;
  let outflowThird = 0n;
  for (const r of rows) {
    if (r.status !== 'SETTLED' || r.reversal_of_entry_id || !r.settled_at || new Date(r.settled_at) >= end) continue;
    const cents = toCents(r.amount);
    const intercompany = r.nature === 'ADJUSTMENT' && String(r.idempotency_key || '').startsWith('intercompany-transfer:');
    if (r.nature === 'RECEIVABLE') total += cents;
    else if (r.nature === 'PAYABLE') total -= cents;
    else if (intercompany) total += r.entry_type === 'CREDIT' ? cents : -cents;
    if (r.is_third_party_funds && r.nature === 'RECEIVABLE') inflowThird += cents;
    if (r.is_third_party_funds && r.nature === 'PAYABLE') outflowThird += cents;
  }
  if (includeOpening) for (const a of accounts) total += toCents(a.opening);
  const retained = inflowThird - outflowThird;
  return {
    caixaTotal: fromCents(total), terceirosRetidos: fromCents(retained), freeCash: fromCents(total - retained), entradasTerceiros: fromCents(inflowThird), liberacoes: fromCents(outflowThird),
  };
}

module.exports = { cashFromSource, toCents, fromCents, dayEnd };
