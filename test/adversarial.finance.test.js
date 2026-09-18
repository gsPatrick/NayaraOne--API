'use strict';

// M4-26 — testes ADVERSARIAIS do módulo Financeiro.
//
// Cada teste aqui é uma tentativa GENUÍNA de abuso/ataque contra o financeiro, não um teste de
// caminho feliz invertido: troca de id de outro tenant, chamada direta de service pulando o
// front, payload forjado, valor fora de faixa, injeção de SQL, corrida de concorrência real,
// tentativa de burlar aprovação/antifraude. Rodam contra o banco real, pelo mesmo caminho de
// RLS da aplicação (SET LOCAL app.group_id/company_id/user_id).
//
// Não duplicam o que já existe: FIN-004 (idempotência), TEC-09 (liquidação concorrente),
// M4-08 (lock stale), M4-11 (cooldown), M4-12 (reimportação), M4-24 (aprovação concorrente),
// ADV-08/ADV-12/ADV-18 (homologacaoEvidencias).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');
const approvalsService = require('../src/features/finance/approvals.service');
const antifraudService = require('../src/features/finance/financeAntifraud.service');
const { FinancialEntry, Company, User } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createEntry(transaction, overrides = {}) {
  return financialEntriesService.createFinancialEntry(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: 100,
      description: 'QA ADV finance',
      ...overrides,
    },
    tenant.userId,
    transaction
  );
}

async function createActiveBankAccount(transaction, suffix, extra = {}) {
  const account = await bankAccountsService.createBankAccount(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `adv-${suffix}`, ...extra },
    tenant.userId,
    transaction
  );
  account.status = 'ACTIVE';
  await account.save({ transaction });
  return account;
}

// Empresa "vizinha" dentro do mesmo grupo, usada como alvo dos ataques de vazamento entre
// tenants. Criada dentro da própria transação de teste (e desfeita no rollback).
async function createNeighborCompany(transaction, suffix) {
  return Company.create(
    { groupId: tenant.groupId, name: `QA ADV — Empresa vizinha ${suffix}`, status: 'ACTIVE' },
    { transaction }
  );
}

// --- Isolamento entre empresas (RLS real) ---------------------------------------------------

test('ADV-F01 trocar o company_id do contexto não deixa ler o lançamento da outra empresa (RLS bloqueia, não filtra no app)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const entry = await createEntry(transaction, { description: 'QA ADV — segredo da empresa A' });
    const vizinha = await createNeighborCompany(transaction, suffix);

    // O "atacante" autenticado na empresa vizinha manda o UUID do lançamento da empresa A.
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: vizinha.id }, transaction });
    const vazou = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(vazou, null, 'RLS não pode devolver o lançamento de outra empresa nem para uma consulta direta por id');

    await assert.rejects(
      () => financialEntriesService.getFinancialEntry(entry.id, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_NOT_FOUND');
        return true;
      },
      'o service precisa responder 404 — não 403 e nem o registro'
    );

    // E também não aparece em listagem.
    const listados = await financialEntriesService.listFinancialEntries(transaction);
    assert.equal(listados.some((e) => e.id === entry.id), false);

    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
  });
});

test('ADV-F02 forjar companyId no payload (escrever lançamento na empresa vizinha) é barrado pelo banco, não pela UI', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const vizinha = await createNeighborCompany(transaction, suffix);

    await assert.rejects(
      () => createEntry(transaction, { companyId: vizinha.id, description: 'QA ADV — lançamento plantado' }),
      (err) => {
        // RLS WITH CHECK / política de tenant recusa o INSERT fora do contexto.
        assert.match(String(err.message), /row-level security|política|policy/i);
        return true;
      }
    );
  });
});

test('ADV-F03 conciliar lançamento da empresa A dizendo que pertence à empresa vizinha é recusado', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 100, bankAccountId: account.id });
    const bankTx = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 100, transactionDate: new Date() },
      tenant.userId,
      transaction
    );
    const vizinha = await createNeighborCompany(transaction, suffix);

    await assert.rejects(
      () => reconciliationService.matchReconciliation(
        { groupId: tenant.groupId, companyId: vizinha.id, financialEntryId: entry.id, bankTransactionId: bankTx.id },
        tenant.userId,
        transaction
      ),
      (err) => {
        assert.match(String(err.message), /row-level security|política|policy/i);
        return true;
      }
    );
  });
});

// --- Valores: faixa, sinal, precisão, overflow ----------------------------------------------

test('ADV-F04 valor negativo, zero, NaN, Infinity e string não-numérica são recusados na criação do lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    for (const amount of [-1, -0.01, 0, Number.NaN, Number.POSITIVE_INFINITY, 'cem reais', '']) {
      await assert.rejects(
        () => createEntry(transaction, { amount }),
        (err) => {
          assert.equal(err.code, 'FINANCE_ENTRY_VALIDATION', `amount ${String(amount)} passou com código ${err.code}`);
          return true;
        },
        `amount ${String(amount)} deveria ser recusado`
      );
    }
  });
});

test('ADV-F05 overflow numérico (valor além do DECIMAL(18,2)) falha alto — nunca grava valor truncado silenciosamente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // 1e20 cabe em Number mas estoura numeric(18,2) no Postgres.
    await assert.rejects(
      () => createEntry(transaction, { amount: 1e20 }),
      (err) => {
        assert.match(String(err.message), /overflow|out of range|numeric/i);
        return true;
      }
    );
  });

  // Transação separada: o erro de overflow aborta a transação anterior no Postgres (o que já
  // é a garantia de que NADA foi gravado). Aqui provamos que o valor logo abaixo do estouro
  // grava com precisão exata — nenhum centavo perdido por truncamento.
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const noLimite = await createEntry(transaction, { amount: '9999999999999999.99' });
    const relido = await FinancialEntry.findByPk(noLimite.id, { transaction });
    assert.equal(String(relido.amount), '9999999999999999.99');
  });
});

test('ADV-F06 valor com mais de 2 casas decimais não "cria dinheiro": é arredondado pelo tipo e a baixa parcial respeita o centavo', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 10.005, bankAccountId: account.id });
    const relido = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(String(relido.amount), '10.01', 'o ledger guarda exatamente 2 casas — nada de fração escondida');

    // Tentar sacar a fração "extra" que o atacante acha que sobrou.
    await financialEntriesService.settleFinancialEntryPartial(entry.id, 10.01, tenant.userId, transaction);
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntryPartial(entry.id, 0.01, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_INVALID_STATUS');
        return true;
      }
    );
    assert.equal(await financialEntriesService.computeRemainingAmount(entry.id, transaction), '0.00');
  });
});

// --- Injeção / entrada hostil ----------------------------------------------------------------

test('ADV-F07 SQL injection em campo de texto é armazenada como texto literal (Sequelize parametriza) e nada quebra', async () => {
  const payloadInjection = "'; DROP TABLE finance.financial_entries; -- \\' OR 1=1";
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const entry = await createEntry(transaction, { description: payloadInjection });
    const relido = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(relido.description, payloadInjection, 'o texto hostil é dado, não código');

    // A tabela continua lá e consultável (o DROP nunca foi executado).
    const [{ count }] = await sequelize.query('SELECT COUNT(*)::int AS count FROM finance.financial_entries', {
      type: sequelize.QueryTypes.SELECT,
      transaction,
    });
    assert.ok(Number.isInteger(count));

    // E o filtro parametrizado devolve exatamente o registro, sem interpretar a aspa.
    const achados = await FinancialEntry.findAll({ where: { description: payloadInjection }, transaction });
    assert.ok(achados.some((e) => e.id === entry.id));
  });
});

test('ADV-F08 competência forjada com payload de injeção é recusada pelo validador de formato', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    for (const competenceMonth of ["2026-09'; DROP TABLE x; --", '2026-00', '0000-01 OR 1=1', '  ']) {
      await assert.rejects(
        () => createEntry(transaction, { competenceMonth }),
        (err) => {
          assert.equal(err.code, 'FINANCE_ENTRY_VALIDATION');
          return true;
        },
        `competenceMonth ${JSON.stringify(competenceMonth)} deveria ser recusado`
      );
    }
  });
});

test('ADV-F09 id inexistente ou malformado devolve erro de negócio tratado — nunca 500 com detalhe de SQL vazando', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => financialEntriesService.getFinancialEntry('00000000-0000-4000-8000-000000000000', transaction),
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );

    await assert.rejects(
      () => financialEntriesService.getFinancialEntry("../../etc/passwd' OR '1'='1", transaction),
      (err) => {
        // O importante: erro controlado, sem executar nada — e sem vazar credencial/host no texto.
        assert.equal(String(err.message).includes('nayaraone'), false);
        return true;
      }
    );
  });
});

// --- Burlar o ledger imutável ----------------------------------------------------------------

test('ADV-F10 mandar "amount" e "status" no update de agenda não altera o valor nem o status do lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const entry = await createEntry(transaction, { amount: 100 });

    const atualizado = await financialEntriesService.updateFinancialEntry(
      entry.id,
      { description: 'inocente', amount: 999999, status: 'SETTLED', settledAt: new Date(), reversalOfEntryId: entry.id },
      tenant.userId,
      transaction
    );

    assert.equal(String(atualizado.amount), '100.00', 'campo de valor não é editável por payload extra');
    assert.equal(atualizado.status, 'PENDING');
    assert.equal(atualizado.settledAt, null);
    assert.equal(atualizado.reversalOfEntryId, null);
  });
});

test('ADV-F11 lançamento já liquidado não pode ser editado nem "re-liquidado", e o estorno não apaga o original', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 250, bankAccountId: account.id });
    await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction);

    await assert.rejects(
      () => financialEntriesService.updateFinancialEntry(entry.id, { description: 'maquiando o histórico' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_IMMUTABLE');
        return true;
      }
    );

    const { original, reversal } = await financialEntriesService.reverseFinancialEntry(entry.id, 'QA ADV', tenant.userId, transaction);
    assert.equal(original.status, 'REVERSED');
    assert.equal(String(original.amount), '250.00', 'o original continua no ledger com o valor original');
    assert.equal(String(reversal.amount), '250.00');
    assert.equal(reversal.entryType, 'CREDIT', 'o compensatório inverte o tipo, não apaga o registro');

    const aindaExiste = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.ok(aindaExiste, 'estorno nunca deleta o lançamento');
  });
});

test('ADV-F12 baixa parcial em lançamento REVERSED/CANCELLED é recusada (não se paga o que já foi estornado)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 300, bankAccountId: account.id });
    await financialEntriesService.reverseFinancialEntry(entry.id, 'QA ADV', tenant.userId, transaction);

    await assert.rejects(
      () => financialEntriesService.settleFinancialEntryPartial(entry.id, 10, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_INVALID_STATUS');
        return true;
      }
    );
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_INVALID_STATUS');
        return true;
      }
    );
  });
});

// --- Burlar a conciliação ---------------------------------------------------------------------

test('ADV-F13 repetir o mesmo lançamento na lista do grupo pra "dobrar" a soma e casar com o extrato é recusado', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 50, bankAccountId: account.id });
    const bankTx = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 100, transactionDate: new Date() },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => reconciliationService.matchReconciliationGroup(
        { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryIds: [entry.id, entry.id], bankTransactionIds: [bankTx.id] },
        tenant.userId,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'FINANCE_RECONCILIATION_VALIDATION');
        return true;
      }
    );
  });
});

test('ADV-F14 misturar crédito e débito no extrato pra "compensar" a diferença não engana a conciliação em grupo', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 100, bankAccountId: account.id });
    // +150 e -50 "somam" 100 se alguém somar com sinal; em módulo somam 200 e não podem casar.
    const entrada = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 150, transactionDate: new Date() },
      tenant.userId,
      transaction
    );
    const saida = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: -50, transactionDate: new Date() },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => reconciliationService.matchReconciliationGroup(
        { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryIds: [entry.id], bankTransactionIds: [entrada.id, saida.id] },
        tenant.userId,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'FINANCE_RECONCILIATION_AMOUNT_MISMATCH');
        return true;
      }
    );
  });
});

test('ADV-F15 reusar uma transação bancária já conciliada em um novo grupo (dupla baixa do mesmo dinheiro) é recusado', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const e1 = await createEntry(transaction, { amount: 100, bankAccountId: account.id });
    const e2 = await createEntry(transaction, { amount: 100, bankAccountId: account.id });
    const bankTx = await bankTransactionsService.createBankTransaction(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, amount: 100, transactionDate: new Date() },
      tenant.userId,
      transaction
    );

    await reconciliationService.matchReconciliationGroup(
      { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryIds: [e1.id], bankTransactionIds: [bankTx.id] },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => reconciliationService.matchReconciliationGroup(
        { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryIds: [e2.id], bankTransactionIds: [bankTx.id] },
        tenant.userId,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'FINANCE_RECONCILIATION_TRANSACTION_ALREADY_MATCHED');
        return true;
      }
    );
  });
});

// --- Burlar aprovação / antifraude ------------------------------------------------------------

test('ADV-F16 trocar o BENEFICIÁRIO depois da aprovação invalida a decisão baseada no que foi revisado', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contaLegitima = await createActiveBankAccount(transaction, `${suffix}-ok`);
    const contaDoAtacante = await createActiveBankAccount(transaction, `${suffix}-mule`);
    const entry = await createEntry(transaction, { amount: 5000, bankAccountId: contaLegitima.id });
    const lockVersionRevisada = entry.lockVersion;

    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' },
      tenant.userId,
      transaction
    );
    const aprovador = await User.create(
      { name: `QA ADV aprovador ${suffix}`, email: `qa-adv-ap-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );

    // O atacante desvia o pagamento para outra conta DEPOIS de o aprovador revisar.
    await financialEntriesService.updateFinancialEntry(entry.id, { bankAccountId: contaDoAtacante.id }, tenant.userId, transaction);

    await assert.rejects(
      () => approvalsService.decideApprovalStep(
        request.id,
        { decision: 'APPROVED', expectedLockVersion: lockVersionRevisada },
        aprovador.id,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'FINANCE_APPROVAL_STALE');
        return true;
      }
    );
  });
});

test('ADV-F17 abrir uma segunda solicitação de aprovação para a mesma entidade (garimpar um aprovador mais fácil) é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const entry = await createEntry(transaction, { amount: 900 });
    await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => approvalsService.createApprovalRequest(
        { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' },
        tenant.userId,
        transaction
      ),
      (err) => {
        assert.equal(err.code, 'FINANCE_APPROVAL_ALREADY_PENDING');
        return true;
      }
    );
  });
});

test('ADV-F18 insistir numa solicitação já REJEITADA (reaprovar com outro usuário) não ressuscita o pagamento', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const entry = await createEntry(transaction, { amount: 900 });
    const request = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' },
      tenant.userId,
      transaction
    );
    const revisor1 = await User.create(
      { name: `QA ADV rev1 ${suffix}`, email: `qa-adv-r1-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );
    const revisor2 = await User.create(
      { name: `QA ADV rev2 ${suffix}`, email: `qa-adv-r2-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
      { transaction }
    );

    const { approvalRequest } = await approvalsService.decideApprovalStep(request.id, { decision: 'REJECTED' }, revisor1.id, transaction);
    assert.equal(approvalRequest.status, 'REJECTED');

    await assert.rejects(
      () => approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, revisor2.id, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_APPROVAL_ALREADY_DECIDED');
        return true;
      }
    );
    assert.equal(await approvalsService.isApprovalRequestApproved('FinancialEntry', entry.id, transaction), false);
  });
});

test('ADV-F19 tentar limpar o flag de revisão manual pelo update de agenda (sem revisor) não funciona', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 30000, bankAccountId: account.id });
    const flag = await antifraudService.flagAnomalousPayment(entry, transaction);
    assert.equal(flag.flagged, true);

    // Payload hostil tentando desligar o antifraude por um endpoint "inofensivo".
    await financialEntriesService.updateFinancialEntry(
      entry.id,
      { description: 'ok', requiresManualReview: false, manualReviewClearedBy: tenant.userId },
      tenant.userId,
      transaction
    );

    const relido = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(relido.requiresManualReview, true, 'só clearManualReview (com revisor auditado) desliga o flag');
    assert.equal(relido.manualReviewClearedBy, null);
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW');
        return true;
      }
    );
  });
});

test('ADV-F20 pagar para conta bancária BLOQUEADA depois da criação do lançamento é recusado no momento da baixa', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const account = await createActiveBankAccount(transaction, suffix);
    const entry = await createEntry(transaction, { amount: 100, bankAccountId: account.id });

    account.status = 'BLOCKED';
    await account.save({ transaction });

    await assert.rejects(
      () => financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_BANK_ACCOUNT_BLOCKED');
        return true;
      }
    );
    await assert.rejects(
      () => financialEntriesService.settleFinancialEntryPartial(entry.id, 10, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FINANCE_BANK_ACCOUNT_BLOCKED');
        return true;
      }
    );
  });
});

test('ADV-F21 baixas parciais CONCORRENTES não conseguem sacar mais que o total do lançamento', async () => {
  const suffix = uniqueSuffix();
  // Concorrência real precisa de transações COMMITADAS (duas conexões enxergando o mesmo
  // estado) — por isso este teste escreve de verdade e limpa os dados no final.
  async function withCommitted(fn) {
    const t = await sequelize.transaction();
    try {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
      await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
      const r = await fn(t);
      await t.commit();
      return r;
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  const { entryId, accountId } = await withCommitted(async (t) => {
    const account = await createActiveBankAccount(t, suffix);
    const entry = await createEntry(t, { amount: 100, bankAccountId: account.id, description: `QA ADV-F21 ${suffix}` });
    return { entryId: entry.id, accountId: account.id };
  });

  try {
    // Duas baixas de 60 ao mesmo tempo somariam 120 num lançamento de 100.
    const resultados = await Promise.allSettled([
      withCommitted((t) => financialEntriesService.settleFinancialEntryPartial(entryId, 60, tenant.userId, t)),
      withCommitted((t) => financialEntriesService.settleFinancialEntryPartial(entryId, 60, tenant.userId, t)),
    ]);
    const sucessos = resultados.filter((r) => r.status === 'fulfilled');
    assert.equal(sucessos.length, 1, 'apenas UMA das baixas concorrentes pode passar');
    const falha = resultados.find((r) => r.status === 'rejected');
    assert.equal(falha.reason.code, 'FINANCE_ENTRY_PARTIAL_EXCEEDS_REMAINING');

    await withCommitted(async (t) => {
      const restante = await financialEntriesService.computeRemainingAmount(entryId, t);
      assert.equal(restante, '40.00', 'o saldo restante nunca fica negativo');
    });
  } finally {
    // Limpeza: o ledger é append-only em runtime, mas estes são dados de teste num banco
    // compartilhado — removidos via SQL direto pra não poluir os outros agentes/suítes.
    await withCommitted(async (t) => {
      await sequelize.query('DELETE FROM finance.financial_entries WHERE parent_entry_id = :id', { replacements: { id: entryId }, transaction: t });
      await sequelize.query('DELETE FROM finance.financial_entries WHERE id = :id', { replacements: { id: entryId }, transaction: t });
      await sequelize.query('DELETE FROM finance.bank_accounts WHERE id = :id', { replacements: { id: accountId }, transaction: t });
    });
  }
});
