'use strict';
/**
 * Extrato importado idempotente (Guia §10, FIN-TS-007) e conciliação explicável nas 5 classes do
 * §11 (Exato, Forte, Provável, Ambíguo, Sem correspondência), com pesos do Guia §9.
 */
const receber = (desc, valor, extra = {}) => (c) => ({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: valor, description: `${desc} ${c.sfx}`, resultCenterId: c.rc2, bankAccountId: c.baRec, dueAt: `${c.hoje}T12:00:00-03:00`, ...extra });

function txPorExt(lista, ext) {
  return (lista || []).find((t) => t.externalTransactionId === ext);
}

module.exports = async function conciliacao(R) {
  const s = R.ctx.sfx;
  const v = (base) => (base + (Number(s) % 97) / 100).toFixed(2);
  R.ctx.valores = { ex: v(101), fo: v(202), pr: v(303), am: v(404), sem: v(505), dv: v(606) };
  const V = R.ctx.valores;

  await R.http({ id: 'C01', linhas: ['M4-§11.1'], titulo: 'Lançamento com referência externa (chave = ID externo que virá no extrato)', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: receber('Recebimento classe EXATO', V.ex, { idempotencyKey: `EXT-EX-${s}` }), esperado: { status: 201 }, guardar: (b, c) => { c.eEx = b.data.id; } });
  await R.http({ id: 'C02', linhas: ['M4-§11.2'], titulo: 'Lançamento para a classe FORTE', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: receber('Recebimento classe FORTE', V.fo), esperado: { status: 201 }, guardar: (b, c) => { c.eFo = b.data.id; } });
  await R.http({ id: 'C03', linhas: ['M4-§11.3'], titulo: 'Lançamento para a classe PROVÁVEL', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: receber('Recebimento classe PROVAVEL', V.pr), esperado: { status: 201 }, guardar: (b, c) => { c.ePr = b.data.id; } });
  await R.http({ id: 'C04', linhas: ['M4-§11.4'], titulo: 'Dois lançamentos de MESMO valor (1/2) para a classe AMBÍGUO', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: receber('Recebimento ambiguo 1', V.am), esperado: { status: 201 }, guardar: (b, c) => { c.eAm1 = b.data.id; } });
  await R.http({ id: 'C05', linhas: ['M4-FIN-TS-008'], titulo: 'Dois lançamentos de MESMO valor (2/2) para a classe AMBÍGUO', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: receber('Recebimento ambiguo 2', V.am), esperado: { status: 201 }, guardar: (b, c) => { c.eAm2 = b.data.id; } });
  await R.http({ id: 'C06', linhas: ['M4-§8.12'], titulo: 'Lançamento cujo extrato vem com valor divergente', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: receber('Recebimento divergente', V.dv), esperado: { status: 201 }, guardar: (b, c) => { c.eDv = b.data.id; } });

  const csv = (c) => [
    'externalTransactionId,transactionDate,description,amount',
    `EXT-EX-${s},${c.hoje},PIX recebido referencia externa,${V.ex}`,
    `EXT-FO-${s},${c.hoje},PIX recebido ref ${c.eFo},${V.fo}`,
    `EXT-PR-${s},${c.hoje},PIX recebido sem referencia,${V.pr}`,
    `EXT-AM-${s},${c.hoje},PIX recebido valor repetido,${V.am}`,
    `EXT-SEM-${s},${c.hoje},Credito sem lancamento correspondente,${V.sem}`,
    `EXT-DV-${s},${c.hoje},PIX recebido valor diferente,${(Number(V.dv) - 1).toFixed(2)}`,
    '',
  ].join('\n');
  await R.http({ id: 'C10', linhas: ['M4-§5.8', 'M4-G§1.8', 'M4-G§19.F5'], titulo: 'Importa o extrato CSV (1ª vez): 6 transações bancárias com fingerprint', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-transactions/import', corpo: (c) => ({ bankAccountId: c.baRec, csvText: csv(c) }), esperado: { status: 201 } });
  await R.http({ id: 'C11', linhas: ['M4-FIN-TS-007', 'M4-G§10', 'M4-§10.5'], titulo: 'Reimporta o MESMO extrato: todas duplicadas, nenhuma transação nova (UNIQUE conta + fingerprint)', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-transactions/import', corpo: (c) => ({ bankAccountId: c.baRec, csvText: csv(c) }), esperado: { status: 201 } });
  await R.http({ id: 'C12', linhas: ['M4-FIN-TS-007', 'M4-§21.6'], titulo: 'Extrato da conta: exatamente 6 transações depois das duas importações', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/finance/bank-transactions?bankAccountId=${c.baRec}`, esperado: { status: 200 }, guardar: (b, c) => { c.tx = Object.fromEntries(['EX', 'FO', 'PR', 'AM', 'SEM', 'DV'].map((k) => [k, (txPorExt(b.data, `EXT-${k}-${s}`) || {}).id])); } });
  await R.http({ id: 'C14a', linhas: ['M4-FIN-TS-020'], titulo: 'Tenant B cadastra a própria conta bancária', quem: 'B:gestor', metodo: 'POST', rota: '/finance/bank-accounts', corpo: (c) => ({ bankCode: '237', agency: '0002', accountNumber: `B-${c.sfx}` }), esperado: { status: 201 }, guardar: (b, c) => { c.baB = b.data.id; } });
  await R.http({ id: 'C14b', linhas: ['M4-FIN-TS-007'], titulo: 'Tenant B importa extrato do PRÓPRIO banco com um ID externo que por acaso é igual ao de uma linha do tenant A: deve importar normalmente (isolamento por conta/empresa)', quem: 'B:gestor', metodo: 'POST', rota: '/finance/bank-transactions/import', corpo: (c) => ({ bankAccountId: c.baB, csvText: `externalTransactionId,transactionDate,description,amount\nEXT-EX-${s},${c.hoje},Credito no banco do tenant B,12.34\n` }), esperado: { status: 201 } });
  await R.http({ id: 'C13', linhas: ['M4-§17.1'], titulo: 'Cabeçalho de extrato inválido é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-transactions/import', corpo: (c) => ({ bankAccountId: c.baRec, csvText: 'a,b\n1,2\n' }), esperado: { status: 400, codigo: 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_HEADER' } });

  const sug = (id, linhas, k, titulo) => R.http({ id, linhas, titulo, quem: 'A:leitura', metodo: 'GET', rota: (c) => `/finance/bank-transactions/${c.tx[k]}/reconciliation-suggestions`, esperado: { status: 200 } });
  await sug('C20', ['M4-§11.1', 'M4-FIN-009'], 'EX', 'Sugestão EXATO: ID externo + valor + data, com score 1.00 e critérios');
  await sug('C21', ['M4-§11.2', 'M4-G§9'], 'FO', 'Sugestão FORTE: referência + contraparte (conta) + janela, score 0.90 (pesos 0.45/0.30/0.15/0.10)');
  await sug('C22', ['M4-§11.3', 'M4-G§20.7'], 'PR', 'Sugestão PROVÁVEL: valor/data/conta parecidos, score 0.70 — humano confirma');
  await sug('C23', ['M4-§11.4', 'M4-FIN-TS-008'], 'AM', 'Dois candidatos empatados: AMBÍGUO, nunca auto');
  await sug('C24', ['M4-§11.5', 'M4-G§15.7'], 'SEM', 'Nenhum candidato: SEM CORRESPONDÊNCIA (fila de pendência)');

  const auto = (id, linhas, k, titulo) => R.http({ id, linhas, titulo, quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/bank-transactions/${c.tx[k]}/auto-reconcile`, corpo: {}, esperado: { status: 200 } });
  await auto('C30', ['M4-§11.1', 'M4-G§1.9', 'M4-§8.11'], 'EX', 'Auto-conciliação do EXATO: confirmada sozinha (fonte confiável), método AUTO_EXACT');
  await auto('C31', ['M4-§11.2', 'M4-FIN-009'], 'FO', 'Auto-conciliação do FORTE: por padrão fica para revisão (política auto_strong desligada)');
  await auto('C32', ['M4-§11.3'], 'PR', 'Auto-conciliação do PROVÁVEL: não executa (só sugestão)');
  await auto('C33', ['M4-G§16.8', 'M4-G§18.6', 'M4-FIN-TS-008'], 'AM', 'Auto-conciliação do AMBÍGUO: recusada (nunca auto conciliar)');
  await auto('C34', ['M4-§11.5'], 'SEM', 'Auto-conciliação sem correspondência: nada é conciliado');

  await R.http({ id: 'C40', linhas: ['M4-§11.2', 'M4-§5.9', 'M4-G§15.8'], titulo: 'Humano confirma o match FORTE (vínculo banco x lançamento)', quem: 'A:gestor', metodo: 'POST', rota: '/finance/reconciliations', corpo: (c) => ({ financialEntryId: c.eFo, bankTransactionId: c.tx.FO }), esperado: { status: 201 } });
  await R.http({ id: 'C41', linhas: ['M4-§11.3', 'M4-G§14.7', 'M4-§17.7'], titulo: 'Humano confirma o match PROVÁVEL', quem: 'A:gestor', metodo: 'POST', rota: '/finance/reconciliations', corpo: (c) => ({ financialEntryId: c.ePr, bankTransactionId: c.tx.PR }), esperado: { status: 201 } });
  await R.http({ id: 'C42', linhas: ['M4-§21.6', 'M4-G§17.9'], titulo: 'Conciliar de novo a mesma transação: recusado (conciliação duplicada)', quem: 'A:gestor', metodo: 'POST', rota: '/finance/reconciliations', corpo: (c) => ({ financialEntryId: c.ePr, bankTransactionId: c.tx.PR }), esperado: { status: 409 } });
  await R.http({ id: 'C43', linhas: ['M4-§8.12'], titulo: 'Valor do extrato divergente do lançamento: conciliação bloqueada', quem: 'A:gestor', metodo: 'POST', rota: '/finance/reconciliations', corpo: (c) => ({ financialEntryId: c.eDv, bankTransactionId: c.tx.DV }), esperado: { status: 409, codigo: 'FINANCE_RECONCILIATION_AMOUNT_MISMATCH' } });
  await R.http({ id: 'C44', linhas: ['M4-§11.4'], titulo: 'Ambíguo resolvido por humano escolhendo o lançamento certo', quem: 'A:gestor', metodo: 'POST', rota: '/finance/reconciliations', corpo: (c) => ({ financialEntryId: c.eAm1, bankTransactionId: c.tx.AM }), esperado: { status: 201 } });
  await R.http({ id: 'C45', linhas: ['M4-§5.9', 'M4-FIN-015', 'M4-G§17.5'], titulo: 'Conciliações registradas (banco x lançamento, com método e autor)', quem: 'A:leitura', metodo: 'GET', rota: '/finance/reconciliations', esperado: { status: 200 } });
  await R.http({ id: 'C46', linhas: ['M4-G§20.2'], titulo: 'Tenant B não vê a transação bancária do tenant A', quem: 'B:gestor', metodo: 'GET', rota: (c) => `/finance/bank-transactions/${c.tx.EX}/reconciliation-suggestions`, esperado: { status: 404 } });

  // Conciliação em grupo (um extrato para dois lançamentos), tolerância zero.
  await R.http({ id: 'C50', linhas: ['M4-§21.6'], titulo: 'Grupo: dois lançamentos (R$ 60,00 + R$ 40,00) para um crédito de R$ 100,00', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: receber('Grupo parte 1', '60.00'), esperado: { status: 201 }, guardar: (b, c) => { c.eG1 = b.data.id; } });
  await R.http({ id: 'C51', linhas: ['M4-G§19.F5'], titulo: 'Grupo: segundo lançamento de R$ 40,00', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: receber('Grupo parte 2', '40.00'), esperado: { status: 201 }, guardar: (b, c) => { c.eG2 = b.data.id; } });
  await R.http({ id: 'C52', linhas: ['M4-G§20.7'], titulo: 'Grupo: transação bancária única de R$ 100,00', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-transactions/import', corpo: (c) => ({ bankAccountId: c.baRec, csvText: `externalTransactionId,transactionDate,description,amount\nEXT-GR-${s},${c.hoje},PIX agrupado,100.00\n` }), esperado: { status: 201 }, guardar: (b, c) => { const it = (b.data.imported || [])[0]; c.txG = it && it.id; } });
  await R.http({ id: 'C53', linhas: ['M4-G§1.9'], titulo: 'Conciliação N:1 com soma exata no centavo', quem: 'A:gestor', metodo: 'POST', rota: '/finance/reconciliations/group', corpo: (c) => ({ financialEntryIds: [c.eG1, c.eG2], bankTransactionIds: [c.txG] }), esperado: { status: 201 } });
};
