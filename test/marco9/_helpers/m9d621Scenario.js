'use strict';

// Cenário da M9-D621 (exemplo do livro): hoje é 28/10/2026 (dia-base fixo). Contas a pagar 7d = 15.000,00; 30d = 22.000,00; 60d = 40.500,00.
// Recebíveis 7d = 18.000,00; 30d = 65.000,00; 60d = 112.500,00. Entram também os lançamentos que NÃO devem somar em nenhuma janela.
const env = require('./finKpiEnv');

const { dayAt } = env;
const EXPECTED = Object.freeze({
  'fin.payables_7d': '15000.00', 'fin.payables_30d': '22000.00', 'fin.payables_60d': '40500.00',
  'fin.receivables_7d': '18000.00', 'fin.receivables_30d': '65000.00', 'fin.receivables_60d': '112500.00',
});

async function seed(e, t) {
  const add = (nature, amount, offset, extra = {}) => env.ledger.insert(e, 'financial_entries', t, {
    entry_type: nature === 'RECEIVABLE' ? 'CREDIT' : 'DEBIT', nature, amount, status: 'PENDING', due_at: dayAt(offset), is_third_party_funds: false, ...extra,
  });
  // saídas próprias pendentes
  for (const [amount, offset] of [['10000.00', 0], ['5000.00', 5], ['7000.00', 7], ['18500.00', 40]]) await add('PAYABLE', amount, offset);
  // entradas próprias pendentes
  for (const [amount, offset] of [['18000.00', 3], ['47000.00', 20], ['47500.00', 45]]) await add('RECEIVABLE', amount, offset);
  // fora de todas as janelas ou fora da regra
  await add('PAYABLE', '999.00', 60);
  await add('RECEIVABLE', '999.00', 60);
  await add('PAYABLE', '777.00', -1); // vencido: é outro KPI
  await add('RECEIVABLE', '777.00', -1);
  await add('RECEIVABLE', '54000.00', 2, { is_third_party_funds: true }); // aluguel a repassar: dinheiro de terceiros
  await add('PAYABLE', '333.00', 2, { is_third_party_funds: true });
  await add('PAYABLE', '444.00', 2, { status: 'REVERSED' });
  await add('RECEIVABLE', '444.00', 2, { status: 'CANCELLED' });
  await add('PAYABLE', '555.00', 2, { status: 'SETTLED', settled_at: dayAt(-1) });
  await add('RECEIVABLE', '666.00', 2, { reversal_of_entry_id: env.ledger.uuid() }); // lançamento de estorno
}

module.exports = { seed, EXPECTED, CODES: Object.keys(EXPECTED) };
