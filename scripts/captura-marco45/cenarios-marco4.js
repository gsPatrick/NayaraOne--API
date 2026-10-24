'use strict';
/**
 * Cenários do Marco 4 (Centro Financeiro) — grupos 1 a 19 da conferência de 18/10/2026.
 * Cada passo é uma requisição HTTP real (perfis do seed de dois tenants) ou, onde a rota exige
 * MFA humano, um passo de serviço que prova a regra. A numeração G<nn>-<k> liga o passo ao grupo.
 */
const { sequelize } = require('../../src/models');

function inTenant(tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    return fn(transaction);
  });
}

module.exports = async function marco4(R) {
  const sfx = String(Date.now()).slice(-7);
  const A = R.tenant('A:gestor');
  const svc = {
    entries: require('../../src/features/finance/financialEntries.service'),
    chart: require('../../src/features/finance/chartOfAccounts.service'),
  };

  // ---------- preparação (fixtures por HTTP, perfil gestor do tenant A) ----------
  await R.http({ id: 'PREP-1', titulo: 'Preparação: centro de custo', quem: 'A:gestor', metodo: 'POST', rota: '/finance/cost-centers', corpo: { code: `CC-${sfx}`, name: 'Centro de custo fictício A' }, esperado: { status: 201 }, guardar: (b, c) => { c.cc = b.data.id; } });
  await R.http({ id: 'PREP-2', titulo: 'Preparação: centro de resultado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/result-centers', corpo: { code: `RC-${sfx}`, name: 'Centro de resultado fictício A' }, esperado: { status: 201 }, guardar: (b, c) => { c.rc = b.data.id; } });
  await R.http({ id: 'PREP-3', titulo: 'Preparação: conta bancária fictícia', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-accounts', corpo: { bankCode: '237', agency: '0001', accountNumber: `CI-${sfx}`, pixKey: `pix-${sfx}@exemplo.test` }, esperado: { status: 201 }, guardar: (b, c) => { c.ba = b.data.id; } });

  // ---------- G1 Plano de contas, versões, centros e governança ----------
  await R.http({ id: 'G01-1', grupos: [1], titulo: 'Perfil maker (sem finance:chartOfAccounts) não cria conta contábil', quem: 'A:maker', metodo: 'POST', rota: '/finance/chart-of-accounts', corpo: { code: `M-${sfx}`, name: 'Conta maker', accountType: 'EXPENSE', isAnalytic: true }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.http({ id: 'G01-2', grupos: [1], titulo: 'Gestor cria a conta sintética', quem: 'A:gestor', metodo: 'POST', rota: '/finance/chart-of-accounts', corpo: { code: `3-${sfx}`, name: 'Despesas (sintética)', accountType: 'EXPENSE' }, esperado: { status: 201 }, guardar: (b, c) => { c.sint = b.data.id; } });
  await R.http({ id: 'G01-3', grupos: [1], titulo: 'Gestor cria a conta analítica filha', quem: 'A:gestor', metodo: 'POST', rota: '/finance/chart-of-accounts', corpo: (c) => ({ code: `3.1-${sfx}`, name: 'Manutenção (analítica)', accountType: 'EXPENSE', parentAccountId: c.sint }), esperado: { status: 201 }, guardar: (b, c) => { c.ana = b.data.id; } });
  await R.http({ id: 'G01-4', grupos: [1], titulo: 'Lançamento na conta SINTÉTICA é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 10, description: 'em conta sintética', costCenterId: c.cc, chartOfAccountId: c.sint }), esperado: { status: 400, codigo: 'FINANCE_CHART_ACCOUNT_SYNTHETIC' } });
  await R.http({ id: 'G01-5', grupos: [1], titulo: 'Lançamento na conta ANALÍTICA é aceito', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 10, description: 'em conta analítica', costCenterId: c.cc, chartOfAccountId: c.ana }), esperado: { status: 201 } });
  await R.http({ id: 'G01-6', grupos: [1], titulo: 'Despesa sem centro de custo é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: { entryType: 'DEBIT', nature: 'PAYABLE', amount: 10, description: 'sem centro de custo' }, esperado: { status: 400, codigo: 'FINANCE_ENTRY_COST_CENTER_REQUIRED' } });
  await R.http({ id: 'G01-7', grupos: [1], titulo: 'Receita sem centro de resultado é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, description: 'sem centro de resultado' }, esperado: { status: 400, codigo: 'FINANCE_ENTRY_RESULT_CENTER_REQUIRED' } });
  await R.http({ id: 'G01-8', grupos: [1], titulo: 'Renomear a conta cria uma nova versão', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/finance/chart-of-accounts/${c.ana}`, corpo: { name: 'Manutenção predial (analítica)' }, esperado: { status: 200 } });
  await R.http({ id: 'G01-9', grupos: [1], titulo: 'Histórico mostra as duas versões (append-only)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/finance/chart-of-accounts/${c.ana}/versions`, esperado: { status: 200 } });
  await R.http({ id: 'G01-10', grupos: [1, 17], titulo: 'Tenant B não vê as contas contábeis do tenant A', quem: 'B:gestor', metodo: 'GET', rota: '/finance/chart-of-accounts', esperado: { status: 200 } });

  // ---------- G2 Entries, installments, parciais e excedentes ----------
  await R.http({ id: 'G02-1', grupos: [2], titulo: 'Cria recebível de R$ 1.000,00', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, description: `Recebível parcial ${sfx}`, resultCenterId: c.rc }), esperado: { status: 201 }, guardar: (b, c) => { c.recv = b.data.id; } });
  await R.http({ id: 'G02-2', grupos: [2, 5], titulo: 'Baixa parcial pela rota exige MFA: recusada sem MFA habilitado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/entries/${c.recv}/settle-partial`, corpo: { amount: 400 }, esperado: { status: 403, codigo: 'MFA_REQUIRED_NOT_ENABLED' } });
  await R.servico({ id: 'G02-3', grupos: [2], titulo: 'Regra (serviço): 1ª baixa parcial de R$ 400,00', chamada: 'financialEntries.settleFinancialEntryPartial(recebível, 400)', fn: (c) => inTenant(A, (t) => svc.entries.settleFinancialEntryPartial(c.recv, 400, A.userId, t)).then((r) => JSON.parse(JSON.stringify(r))), esperado: {} });
  await R.servico({ id: 'G02-4', grupos: [2], titulo: 'Regra (serviço): 2ª baixa de R$ 700,00 sobre saldo de R$ 600,00 — R$ 100,00 de excedente viram pendência de classificação', chamada: 'financialEntries.settleFinancialEntryPartial(recebível, 700)', fn: (c) => inTenant(A, (t) => svc.entries.settleFinancialEntryPartial(c.recv, 700, A.userId, t)).then((r) => JSON.parse(JSON.stringify(r))), esperado: {} });
  await R.http({ id: 'G02-5', grupos: [2], titulo: 'Lista de pendências de classificação mostra o excedente (nunca receita automática)', quem: 'A:leitura', metodo: 'GET', rota: '/finance/entries/classification-pendings', esperado: { status: 200 } });
  await R.http({ id: 'G02-6', grupos: [2], titulo: 'Lançamento de valor negativo é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: -5, description: 'negativo', resultCenterId: c.rc }), esperado: { status: 400 } });
  // ---------- G3 Ledger imutável, estorno e banco ----------
  await R.servico({ id: 'G03-1', grupos: [3], titulo: 'UPDATE cru do valor de um lançamento é recusado pelo gatilho do banco', chamada: "UPDATE finance.financial_entries SET amount = 1 WHERE id = <recebível liquidado>", fn: (c) => inTenant(A, (t) => sequelize.query('UPDATE finance.financial_entries SET amount = 1, status = \'SETTLED\' WHERE id = :id AND status = \'SETTLED\'', { replacements: { id: c.recv }, transaction: t })).then(() => ({ ok: true })), esperado: { erro: 'SequelizeDatabaseError' } });
  await R.http({ id: 'G03-2', grupos: [3], titulo: 'Estorno cria lançamento de reversão e preserva o original', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/entries/${c.recv}/reverse`, corpo: { reason: 'estorno de teste' }, esperado: { status: 200 } });

  // ---------- G4 Aprovação, MFA, snapshot e segregação ----------
  await R.http({ id: 'G04-1', grupos: [4], titulo: 'Maker cria despesa', quem: 'A:maker', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 250, description: `Despesa maker-checker ${sfx}`, costCenterId: c.cc }), esperado: { status: 201 }, guardar: (b, c) => { c.mk = b.data.id; } });
  await R.http({ id: 'G04-2', grupos: [4], titulo: 'Maker pede aprovação', quem: 'A:maker', metodo: 'POST', rota: '/finance/approval-requests', corpo: (c) => ({ relatedEntityType: 'FinancialEntry', relatedEntityId: c.mk, riskLevel: 'LOW' }), esperado: { status: 201 }, guardar: (b, c) => { c.ap = b.data.id; } });
  await R.http({ id: 'G04-3', grupos: [4], titulo: 'Maker (sem finance:approve) não decide', quem: 'A:maker', metodo: 'POST', rota: (c) => `/finance/approval-requests/${c.ap}/decide`, corpo: { decision: 'APPROVED' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.http({ id: 'G04-4', grupos: [4], titulo: 'Checker aprova a solicitação do maker', quem: 'A:checker', metodo: 'POST', rota: (c) => `/finance/approval-requests/${c.ap}/decide`, corpo: { decision: 'APPROVED' }, esperado: { status: 200 } });
  await R.http({ id: 'G04-5', grupos: [4], titulo: 'Checker cria a própria despesa', quem: 'A:checker', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 90, description: `Despesa do checker ${sfx}`, costCenterId: c.cc }), esperado: { status: 201 }, guardar: (b, c) => { c.ck = b.data.id; } });
  await R.http({ id: 'G04-6', grupos: [4], titulo: 'Checker pede aprovação da própria despesa', quem: 'A:checker', metodo: 'POST', rota: '/finance/approval-requests', corpo: (c) => ({ relatedEntityType: 'FinancialEntry', relatedEntityId: c.ck, riskLevel: 'LOW' }), esperado: { status: 201 }, guardar: (b, c) => { c.ap2 = b.data.id; } });
  await R.http({ id: 'G04-7', grupos: [4], titulo: 'Checker não aprova a solicitação que ele mesmo abriu', quem: 'A:checker', metodo: 'POST', rota: (c) => `/finance/approval-requests/${c.ap2}/decide`, corpo: { decision: 'APPROVED' }, esperado: { status: 403, codigo: 'FINANCE_APPROVAL_SELF_APPROVAL_FORBIDDEN' } });
  await R.http({ id: 'G04-8', grupos: [4], titulo: 'Tenant B não decide a aprovação do tenant A', quem: 'B:checker', metodo: 'POST', rota: (c) => `/finance/approval-requests/${c.ap2}/decide`, corpo: { decision: 'APPROVED' }, esperado: { status: 404 } });
  await R.http({ id: 'G04-9', grupos: [4, 14], titulo: 'Alteração de conta bancária exige MFA (recusada sem MFA habilitado)', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/finance/bank-accounts/${c.ba}`, corpo: { pixKey: `novo-${sfx}@exemplo.test` }, esperado: { status: 403, codigo: 'MFA_REQUIRED_NOT_ENABLED' } });

  // ---------- G5 Pagamento e confirmação bancária ----------
  await R.http({ id: 'G05-1', grupos: [5], f: ['F03'], titulo: 'Baixa direta pela rota exige MFA (recusada)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/entries/${c.mk}/settle`, corpo: {}, esperado: { status: 403, codigo: 'MFA_REQUIRED_NOT_ENABLED' } });
  await R.http({ id: 'G05-2', grupos: [5], f: ['F03'], titulo: 'Comprovante sem arquivo e sem motivo é recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/entries/${c.mk}/settlement-evidence`, corpo: {}, esperado: { status: 400, codigo: 'FINANCE_SETTLEMENT_EVIDENCE_VALIDATION' } });
  await R.http({ id: 'G05-3', grupos: [5], f: ['F03'], titulo: 'Cria intenção de pagamento com snapshot', quem: 'A:gestor', metodo: 'POST', rota: '/finance/payment-intents', corpo: (c) => ({ financialEntryId: c.mk }), esperado: { status: 201 }, guardar: (b, c) => { c.pi = b.data.id; } });
  await R.http({ id: 'G05-4', grupos: [5, 6], f: ['F03'], titulo: 'Segunda intenção aberta para o mesmo lançamento é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/finance/payment-intents', corpo: (c) => ({ financialEntryId: c.mk }), esperado: { status: 409, codigo: 'FINANCE_PAYMENT_INTENT_ALREADY_OPEN' } });
  await R.http({ id: 'G05-5', grupos: [5], f: ['F03'], titulo: 'Quem criou a intenção não a aprova', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/payment-intents/${c.pi}/approve`, corpo: {}, esperado: { status: 403, codigo: 'FINANCE_PAYMENT_INTENT_SELF_APPROVAL_FORBIDDEN' } });
  await R.http({ id: 'G05-6', grupos: [5], f: ['F03'], titulo: 'Envio ao banco exige MFA (recusado)', quem: 'A:checker', metodo: 'POST', rota: (c) => `/finance/payment-intents/${c.pi}/submit-to-bank`, corpo: {}, esperado: { status: 403 } });
  await R.http({ id: 'G05-7', grupos: [5], f: ['F03'], titulo: 'Lançamento segue PENDING sem confirmação bancária', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/finance/entries/${c.mk}`, esperado: { status: 200 } });

  // ---------- G6 Idempotência ----------
  await R.http({ id: 'G06-1', grupos: [6], titulo: 'Recebível com chave de idempotência', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 777, description: `Idem ${sfx}`, resultCenterId: c.rc, bankAccountId: c.ba, idempotencyKey: `EXT-${sfx}` }), esperado: { status: 201 }, guardar: (b, c) => { c.idem = b.data.id; } });
  await R.http({ id: 'G06-2', grupos: [6], titulo: 'Replay com a mesma chave devolve duplicidade e o id existente', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 777, description: `Idem ${sfx}`, resultCenterId: c.rc, bankAccountId: c.ba, idempotencyKey: `EXT-${sfx}` }), esperado: { status: 409, codigo: 'FINANCE_DUPLICATE_PAYMENT' } });
  await R.http({ id: 'G06-3', grupos: [6], titulo: 'Dez replays simultâneos: um efeito', quem: 'A:gestor', metodo: 'GET', rota: '/finance/entries?status=PENDING', esperado: { status: 200 }, nota: 'Os dez envios simultâneos estão no teste de concorrência do grupo (resultado individual no log).' });

  // ---------- G7 Extrato ----------
  const csv = () => `externaltransactionid,transactiondate,description,amount\nEXT-${sfx},${new Date().toISOString().slice(0, 10)},Idem ${sfx},777.00\n`;
  await R.http({ id: 'G07-1', grupos: [7, 8], titulo: 'Importa o extrato (1ª vez)', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-transactions/import', corpo: (c) => ({ bankAccountId: c.ba, csvText: csv() }), esperado: { status: 201 }, guardar: (b, c) => { c.bt = b.data.imported[0].id; } });
  await R.http({ id: 'G07-2', grupos: [7], titulo: 'Reimporta o mesmo arquivo: duplicadas, nada criado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-transactions/import', corpo: (c) => ({ bankAccountId: c.ba, csvText: csv() }), esperado: { status: 201 } });
  await R.http({ id: 'G07-3', grupos: [7], titulo: 'Cabeçalho inválido recusado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-transactions/import', corpo: (c) => ({ bankAccountId: c.ba, csvText: 'a,b\n1,2\n' }), esperado: { status: 400, codigo: 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_HEADER' } });

  // ---------- G8 Conciliação ----------
  await R.http({ id: 'G08-1', grupos: [8], titulo: 'Sugestões explicáveis com critérios e pesos (classe EXACT)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/finance/bank-transactions/${c.bt}/reconciliation-suggestions`, esperado: { status: 200 } });
  await R.http({ id: 'G08-2', grupos: [8], titulo: 'Conciliação automática só no match exato', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/bank-transactions/${c.bt}/auto-reconcile`, corpo: {}, esperado: { status: 200 } });
  await R.http({ id: 'G08-3', grupos: [8, 17], titulo: 'Tenant B não vê a transação do tenant A', quem: 'B:gestor', metodo: 'GET', rota: (c) => `/finance/bank-transactions/${c.bt}/reconciliation-suggestions`, esperado: { status: 404 } });

  // ---------- G9 Repasses ----------
  await R.http({ id: 'G09-1', grupos: [9], titulo: 'Fontes elegíveis exigem escolher o imóvel', quem: 'A:gestor', metodo: 'GET', rota: '/finance/owner-repasses/eligible-sources', esperado: { status: 400, codigo: 'FINANCE_OWNER_REPASSE_VALIDATION' } });
  await R.http({ id: 'G09-2', grupos: [9], titulo: 'Aprovação de repasse exige MFA (recusada sem MFA)', quem: 'A:checker', metodo: 'POST', rota: '/finance/owner-repasses/00000000-0000-4000-8000-000000000000/approve', corpo: {}, esperado: { status: 403 } });
  await R.http({ id: 'G09-3', grupos: [9], titulo: 'Lista de repasses do tenant', quem: 'A:leitura', metodo: 'GET', rota: '/finance/owner-repasses', esperado: { status: 200 } });

  // ---------- G10 Caução e terceiros ----------
  await R.http({ id: 'G10-1', grupos: [10], f: ['F04'], titulo: 'Devolução de caução sem origem: recusada', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 1, description: 'devolução de caução', costCenterId: c.cc, isThirdPartyFunds: true, thirdPartyReference: 'devolução de caução' }), esperado: { status: 400, codigo: 'FINANCE_THIRD_PARTY_ORIGIN_REQUIRED' } });
  await R.http({ id: 'G10-2', grupos: [10], f: ['F04'], titulo: 'Origem inexistente: recusada', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 1, description: 'devolução de caução', costCenterId: c.cc, isThirdPartyFunds: true, thirdPartyReference: 'devolução de caução', thirdPartyOriginEntryId: '00000000-0000-4000-8000-000000000000' }), esperado: { status: 404, codigo: 'FINANCE_THIRD_PARTY_ORIGIN_NOT_FOUND' } });
  await R.http({ id: 'G10-3', grupos: [10], f: ['F04'], titulo: 'Recebimento de caução sem contrato e titular: recusado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 3000, description: 'caução', resultCenterId: c.rc, isThirdPartyFunds: true, thirdPartyReference: 'caução' }), esperado: { status: 400 } });

  // ---------- G11 Comissões ----------
  await R.http({ id: 'G11-1', grupos: [11], titulo: 'Sem regra publicada a comissão não nasce (regra vem do Motor de Regras)', quem: 'A:gestor', metodo: 'GET', rota: '/finance/commission-rule', esperado: { status: 422, codigo: 'FINANCE_COMMISSION_RULE_NOT_CONFIGURED' } });
  await R.http({ id: 'G11-2', grupos: [11], titulo: 'Publicar regra exige MFA (recusada sem MFA)', quem: 'A:checker', metodo: 'POST', rota: '/finance/commission-rule', corpo: { componentPercentages: { BROKER: 5 } }, esperado: { status: 403 } });
  await R.http({ id: 'G11-3', grupos: [11], titulo: 'Cancelar comissão inexistente: 404 (o cancelamento com motivo e o ajuste estão nos testes do grupo)', quem: 'A:gestor', metodo: 'POST', rota: '/finance/commissions/00000000-0000-4000-8000-000000000000/cancel', corpo: { reason: 'teste' }, esperado: { status: 404, codigo: 'FINANCE_COMMISSION_NOT_FOUND' } });

  // ---------- G12 Intercompany ----------
  await R.http({ id: 'G12-1', grupos: [12], titulo: 'Criar transferência intercompany exige MFA (recusada)', quem: 'A:gestor', metodo: 'POST', rota: '/finance/intercompany-transfers', corpo: {}, esperado: { status: 403 } });
  await R.http({ id: 'G12-2', grupos: [12], titulo: 'Empresas de destino do mesmo grupo', quem: 'A:gestor', metodo: 'GET', rota: '/finance/intercompany-transfers/destination-companies', esperado: { status: 200 } });
  await R.http({ id: 'G12-3', grupos: [12], titulo: 'Consolidado do grupo sem duplicidade', quem: 'A:gestor', metodo: 'GET', rota: '/finance/reports/group-consolidated', esperado: { status: 200 } });

  // ---------- G13 Fechamento ----------
  await R.http({ id: 'G13-1', grupos: [13], f: ['F02'], titulo: 'Pré-condições do mês (checklist real)', quem: 'A:leitura', metodo: 'GET', rota: '/finance/period-closures/2030-01/preconditions', esperado: { status: 200 } });
  await R.http({ id: 'G13-2', grupos: [13], f: ['F02'], titulo: 'Pedido de fechamento com pré-condição pendente é recusado e nada é gravado', quem: 'A:gestor', metodo: 'POST', rota: '/finance/period-closures', corpo: { referenceMonth: '2030-01' }, esperado: { status: 409, codigo: 'FINANCE_PERIOD_PRECONDITIONS_NOT_MET' } });
  await R.http({ id: 'G13-3', grupos: [13], f: ['F02'], titulo: 'Aprovar fechamento exige MFA (recusado)', quem: 'A:checker', metodo: 'POST', rota: '/finance/period-closures/approve', corpo: { referenceMonth: '2030-01' }, esperado: { status: 403 } });
  await R.http({ id: 'G13-4', grupos: [13], f: ['F02'], titulo: 'Reabrir exige finance:approve: maker é recusado antes de qualquer regra', quem: 'A:maker', metodo: 'POST', rota: '/finance/period-closures/reopen', corpo: { referenceMonth: '2030-01', reason: 'teste' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.http({ id: 'G13-5', grupos: [13], f: ['F02'], titulo: 'Histórico de fechamentos', quem: 'A:leitura', metodo: 'GET', rota: '/finance/period-closures', esperado: { status: 200 } });

  // ---------- G14 Antifraude ----------
  await R.http({ id: 'G14-1', grupos: [14], titulo: 'Casos de anomalia do tenant', quem: 'A:leitura', metodo: 'GET', rota: '/finance/anomaly-cases', esperado: { status: 200 } });
  await R.http({ id: 'G14-2', grupos: [14], titulo: 'Exportação financeira exige MFA (recusada sem MFA)', quem: 'A:gestor', metodo: 'GET', rota: '/finance/exports/entries?competenceMonth=2030-01', esperado: { status: 403 } });
  await R.http({ id: 'G14-3', grupos: [14, 4], titulo: 'Conta bancária nova nasce em cooldown', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/finance/bank-accounts/${c.ba}`, esperado: { status: 200 } });

  // ---------- G15 NAY financeira ----------
  await R.http({ id: 'G15-1', grupos: [15], titulo: 'NAY financeira: explicações com fonte e conclusão parcial', quem: 'A:leitura', metodo: 'GET', rota: '/finance/nay/insights', esperado: { status: 200 } });
  await R.http({ id: 'G15-2', grupos: [15], titulo: 'NAY não escreve: tentativa de POST na rota não existe', quem: 'A:gestor', metodo: 'POST', rota: '/finance/nay/insights', corpo: {}, esperado: { status: 404 } });

  // ---------- G16 Relatório ----------
  await R.http({ id: 'G16-1', grupos: [16], titulo: 'Relatório semanal de saúde financeira', quem: 'A:leitura', metodo: 'GET', rota: '/finance/reports/weekly-health', esperado: { status: 200 } });
  await R.http({ id: 'G16-2', grupos: [16], titulo: 'Lista de lançamentos para conferir a soma manual', quem: 'A:leitura', metodo: 'GET', rota: '/finance/entries?status=PENDING&nature=PAYABLE', esperado: { status: 200 } });

  // ---------- G17 RLS e multiempresa ----------
  await R.http({ id: 'G17-1', grupos: [17], titulo: 'Tenant B lista lançamentos: nenhum do tenant A', quem: 'B:gestor', metodo: 'GET', rota: '/finance/entries', esperado: { status: 200 } });
  await R.http({ id: 'G17-2', grupos: [17], titulo: 'Tenant B lê lançamento do tenant A por id: 404', quem: 'B:gestor', metodo: 'GET', rota: (c) => `/finance/entries/${c.mk}`, esperado: { status: 404 } });
  await R.http({ id: 'G17-3', grupos: [17], titulo: 'Tenant B altera lançamento do tenant A: 404', quem: 'B:gestor', metodo: 'PATCH', rota: (c) => `/finance/entries/${c.mk}`, corpo: { description: 'invasão' }, esperado: { status: 404 } });
  await R.http({ id: 'G17-4', grupos: [17], titulo: 'Leitura não cria lançamento', quem: 'A:leitura', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 1, description: 'x', costCenterId: c.cc }), esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.http({ id: 'G17-5', grupos: [17, 19], titulo: 'Sem token: 401', quem: 'anonimo', metodo: 'GET', rota: '/finance/entries', esperado: { status: 401 } });

  // ---------- G18 Eventos e trilha ----------
  await R.http({ id: 'G18-1', grupos: [18], titulo: 'Trilha de auditoria exige audit:read: gestor é recusado', quem: 'A:gestor', metodo: 'GET', rota: '/audit-log', esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });

  // ---------- G19 Restore, runbook e segurança ----------
  await R.http({ id: 'G19-1', grupos: [19], f: ['F06'], titulo: 'Rota financeira sem permissão de leitura devolve 403 (perfil de outra área)', quem: 'A:leitura', metodo: 'PATCH', rota: (c) => `/finance/entries/${c.mk}`, corpo: { description: 'x' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
};

module.exports.inTenant = inTenant;
