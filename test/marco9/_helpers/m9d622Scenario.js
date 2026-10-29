'use strict';

// Cenários da M9-D622 (exemplos do livro), dia-base fixo 28/10/2026. Inadimplência: 12.000,00 vencidos há 15 dias + 4.000,00 há 70 dias = 16.000,00 na janela de
// 90 dias, mais 9.000,00 vencidos há 120 dias (fora da janela): valor inadimplente 25.000,00, base 200.000,00 e taxa 8,00%. Necessidade para respirar: vencido a
// pagar 6.500,00 + a pagar em 30 dias 22.000,00 + comissões 3.000,00 - caixa livre 18.000,00 = 13.500,00. Cada cenário também grava o que NÃO deve entrar.
const env = require('./finKpiEnv');

const { dayAt, ledger } = env;
const CONTRACT = Object.freeze({ one: '33333333-3333-4333-8333-333333333333', two: '44444444-4444-4444-8444-444444444444' });

/** Lançamento do ledger: padrão = entrada própria pendente. */
const entry = (e, t, { nature = 'RECEIVABLE', amount, due, status = 'PENDING', third = false, reversalOf = null, contract = null, settled = null }) => ledger.insert(e, 'financial_entries', t, {
  entry_type: nature === 'RECEIVABLE' ? 'CREDIT' : 'DEBIT', nature, amount, status, due_at: due === undefined ? null : due, settled_at: settled, is_third_party_funds: third, reversal_of_entry_id: reversalOf, contract_id: contract,
});

async function seedOverdue(e, t) {
  await entry(e, t, { amount: '12000.00', due: dayAt(-15), contract: CONTRACT.one });
  await entry(e, t, { amount: '4000.00', due: dayAt(-70), contract: CONTRACT.two });
  await entry(e, t, { amount: '9000.00', due: dayAt(-120), contract: CONTRACT.one });
  await entry(e, t, { amount: '1500.00', due: dayAt(0), contract: CONTRACT.one }); // vence hoje: não é inadimplente, entra na base
  await entry(e, t, { amount: '182500.00', due: dayAt(-30), status: 'SETTLED', settled: dayAt(-29), contract: CONTRACT.two }); // pago: só base
  // o que fica de fora de tudo
  await entry(e, t, { amount: '3000.00', due: dayAt(-10), third: true, contract: CONTRACT.one }); // dinheiro de terceiros
  await entry(e, t, { amount: '2000.00', due: dayAt(-10), status: 'REVERSED', contract: CONTRACT.one });
  await entry(e, t, { amount: '1000.00', due: dayAt(-10), status: 'CANCELLED', contract: CONTRACT.one });
  await entry(e, t, { amount: '666.00', due: dayAt(-10), reversalOf: ledger.uuid(), contract: CONTRACT.one }); // lançamento de estorno
  await entry(e, t, { nature: 'PAYABLE', amount: '6500.00', due: dayAt(-10) }); // saída vencida: é outro número
  await entry(e, t, { amount: '777.00', due: dayAt(-120), status: 'SETTLED', settled: dayAt(-119), contract: CONTRACT.one }); // pago, fora da janela
}

/** Necessidade para respirar: vencido a pagar 6.500,00, a pagar em 30 dias 22.000,00, comissões 3.000,00 sem lançamento e caixa livre `cash`. */
async function seedBreathing(e, t, { cash = '18000.00' } = {}) {
  await entry(e, t, { nature: 'PAYABLE', amount: '6500.00', due: dayAt(-10) });
  await entry(e, t, { nature: 'PAYABLE', amount: '22000.00', due: dayAt(10) });
  await entry(e, t, { nature: 'RECEIVABLE', amount: cash, due: dayAt(-20), status: 'SETTLED', settled: dayAt(-1) });
  const commission = ledger.uuid();
  const installment = (n, amount, extra) => ledger.insert(e, 'commission_installments', t, { commission_id: commission, installment_number: n, amount, due_at: dayAt(5), status: 'PENDING', ...extra });
  await installment(1, '3000.00');
  // o que fica de fora
  await entry(e, t, { nature: 'PAYABLE', amount: '999.00', due: dayAt(-10), third: true });
  await entry(e, t, { nature: 'PAYABLE', amount: '5000.00', due: dayAt(45) }); // além dos 30 dias
  await installment(2, '777.00', { financial_entry_id: ledger.uuid() }); // já tem lançamento a pagar
  await installment(3, '888.00', { due_at: dayAt(45) }); // vence depois de hoje+29
  await installment(4, '555.00', { status: 'PAID' });
}

module.exports = { CONTRACT, entry, seedOverdue, seedBreathing };
