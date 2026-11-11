'use strict';

// Cenários da M9-D623 (exemplos do livro), dia-base fixo 28/10/2026 (quarta-feira). Margem por setor: Locação 80.000,00 de receita e 52.000,00 de custo
// (28.000,00 e 35,00%) e Vendas 100.000,00 e 61.500,00 (38.500,00 e 38,50%). Comissões provisionadas 15.000,00 + 6.000,00 = 21.000,00 e pagas em outubro
// 18.000,00. Repasses pendentes ao proprietário 54.000,00. Cada cenário também grava o que NÃO deve entrar.
const env = require('./finKpiEnv');

const { dayAt, ledger } = env;
const MONTH = '2026-10';
const CENTER = Object.freeze({ locacao: '11111111-1111-4111-8111-111111111111', vendas: '22222222-2222-4222-8222-222222222222' });

const entry = (e, t, { nature, amount, center = null, month = MONTH, status = 'SETTLED', third = false, reversalOf = null }) => ledger.insert(e, 'financial_entries', t, {
  entry_type: nature === 'RECEIVABLE' ? 'CREDIT' : 'DEBIT', nature, amount, status, settled_at: status === 'SETTLED' ? dayAt(-1) : null, due_at: dayAt(-1),
  is_third_party_funds: third, result_center_id: center, competence_month: month, reversal_of_entry_id: reversalOf,
});

/** Receita e custo realizados por setor + o que fica de fora (terceiros, pendente, estornado, outro mês, lançamento de estorno). */
async function seedMargin(e, t, { withoutCenter = null } = {}) {
  for (const [center, revenue, cost] of [[CENTER.locacao, '80000.00', '52000.00'], [CENTER.vendas, '100000.00', '61500.00']]) {
    await entry(e, t, { nature: 'RECEIVABLE', amount: revenue, center });
    await entry(e, t, { nature: 'PAYABLE', amount: cost, center });
  }
  await entry(e, t, { nature: 'RECEIVABLE', amount: '9999.00', center: CENTER.locacao, third: true });
  await entry(e, t, { nature: 'RECEIVABLE', amount: '8888.00', center: CENTER.locacao, status: 'PENDING' });
  await entry(e, t, { nature: 'PAYABLE', amount: '7777.00', center: CENTER.vendas, status: 'REVERSED' });
  await entry(e, t, { nature: 'RECEIVABLE', amount: '6666.00', center: CENTER.vendas, month: '2026-09' });
  await entry(e, t, { nature: 'PAYABLE', amount: '5555.00', center: CENTER.vendas, reversalOf: ledger.uuid() });
  if (withoutCenter) {
    // Caderno M4 §7 (CHECK amount > 0, M4LR): lançamento de valor zero não existe — "custo 0" é a ausência do lançamento.
    if (Number(withoutCenter.revenue) > 0) await entry(e, t, { nature: 'RECEIVABLE', amount: withoutCenter.revenue, center: null });
    if (Number(withoutCenter.cost) > 0) await entry(e, t, { nature: 'PAYABLE', amount: withoutCenter.cost, center: null });
  }
}

/** Tudo o que o refresh precisa para ver os lançamentos de margem: um evento por setor e mês (o payload leva setor e competência). */
async function refreshMargin(t, centers = [CENTER.locacao, CENTER.vendas, null]) {
  for (const resultCenterId of centers) await env.refreshEntries(t, { resultCenterId, competenceMonth: MONTH });
}

const installment = (e, t, commission, n, amount, extra) => ledger.insert(e, 'commission_installments', t, { commission_id: commission, installment_number: n, amount, due_at: dayAt(10), status: 'PENDING', ...extra });
const commissionRow = (e, t, broker, extra) => ledger.insert(e, 'commissions', t, {
  beneficiary_user_id: broker, base_amount: '300000.00', percentage: '0.05', total_amount: '21000.00', status: 'APPROVED', rule_version_id: ledger.uuid(), source_entry_id: ledger.uuid(), component: 'BROKER', ...extra,
});

/** Comissões: provisionadas 15.000,00 + 6.000,00 (corretor `broker`), paga em outubro 18.000,00; mais o que não entra. */
async function seedCommissions(e, t, broker, { withoutBroker = false, paidWithoutEntry = false } = {}) {
  const main = await commissionRow(e, t, broker);
  await installment(e, t, main, 1, '15000.00');
  await installment(e, t, main, 2, '6000.00', { due_at: dayAt(-4) });
  const settledEntry = await entry(e, t, { nature: 'PAYABLE', amount: '18000.00', month: '2026-09' }); // competência fora de outubro: não mexe na margem do mês
  await installment(e, t, main, 3, '18000.00', { status: 'PAID', paid_at: dayAt(-2), financial_entry_id: settledEntry });
  await installment(e, t, main, 4, '777.00', { status: 'PAID', paid_at: '2026-09-30T20:00:00.000Z', financial_entry_id: settledEntry }); // paga em setembro: fora de outubro
  await installment(e, t, main, 5, '555.00', { status: 'CANCELLED' });
  const cancelled = await commissionRow(e, t, broker, { status: 'CANCELLED' });
  await installment(e, t, cancelled, 1, '444.00', { status: 'CANCELLED' });
  if (withoutBroker) {
    const orphan = await commissionRow(e, t, ledger.uuid(), { component: 'MANAGER' });
    await installment(e, t, orphan, 1, '1000.00'); // beneficiário que não é usuário ativo: "Sem corretor"
  }
  if (paidWithoutEntry) await installment(e, t, main, 6, '300.00', { status: 'PAID', paid_at: dayAt(-1), financial_entry_id: null });
}

/** Repasses ao proprietário: 40.000,00 pendente + 14.000,00 aprovado = 54.000,00; pago e cancelado ficam fora. */
async function seedRepasses(e, t, { old = '2026-10-14T15:00:00.000Z', recent = '2026-10-26T15:00:00.000Z' } = {}) {
  const base = (net, status, createdAt, owner) => ledger.insert(e, 'owner_repasses', t, {
    property_id: ledger.uuid(), owner_person_id: owner || ledger.uuid(), gross_amount: net, deductions_amount: '0.00', net_amount: net, status, reference_month: MONTH, created_at: createdAt,
  });
  const owner = ledger.uuid();
  await base('40000.00', 'PENDING', old, owner); // 14/10: 10 dias úteis até 28/10, passa de 5
  await base('14000.00', 'APPROVED', recent); // 26/10: 2 dias úteis
  await base('900.00', 'PAID', old);
  await base('800.00', 'CANCELLED', old);
  return { owner };
}

module.exports = { MONTH, CENTER, entry, seedMargin, refreshMargin, seedCommissions, seedRepasses };
