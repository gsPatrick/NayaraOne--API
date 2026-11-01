'use strict';

// Apoio dos testes M9-D833 (não é teste): pagamento emergencial registrado por um usuário e importado por outro, linhas de extrato e leitura das tabelas da demanda.
const env = require('./m9d832Env');
const bankAccounts = require('../../../src/features/finance/bankAccounts.service');
const bankTransactions = require('../../../src/features/finance/bankTransactions.service');
const { SPEC } = require('./m9d834Spec');

const APPROVE = 'governance:bcp:approve';
const IMPORT = 'governance:bcp:import';
const RECORD = 'governance:bcp:record';
const ROLES = ['CI GESTOR', 'CI MAKER'];
const SECTORS = Object.fromEntries([...new Set(SPEC.map((item) => item.sector))].map((sector) => [sector, ROLES]));
let seq = 0;

/** Perfis: o gestor confere (approve), o maker prepara e importa mas NÃO confere. Devolve a função que desfaz. */
async function prepare(tenant) {
  await env.prepare(tenant);
  await env.setSectorRoles(tenant, SECTORS);
  return env.withRolePermissions({ 'CI GESTOR': { [RECORD]: true, [IMPORT]: true, [APPROVE]: true }, 'CI MAKER': { [RECORD]: true, [IMPORT]: true, [APPROVE]: false } });
}

/** Registra um pagamento emergencial (quem prepara = maker, salvo indicação) e devolve a operação. */
async function recordPayment(tenant, ctx, payloadOver = {}, over = {}) {
  const preparer = over.actorUserId || await env.otherUserId();
  return env.recordAction(tenant, 'EMERGENCY_PAYMENT', ctx, payloadOver, { ...over, actorUserId: preparer });
}

const checksOf = async (operationId) => (await env.adminQuery('SELECT * FROM governance.manual_operation_checks WHERE manual_operation_id = $1 ORDER BY role', [operationId])).rows;
const pendingOf = async (operationId) => (await env.adminQuery('SELECT * FROM governance.bcp_payment_pendings WHERE manual_operation_id = $1', [operationId])).rows[0] || null;
const entriesOf = async (reference) => (await env.adminQuery('SELECT id FROM finance.financial_entries WHERE origin_ref = $1', [`bcp:${reference}`])).rows;

/** Conta bancária da empresa (criada de verdade, uma vez por chamada). */
const bankAccount = (tenant) => env.inTx(tenant, async (tx) => {
  seq += 1;
  const account = await bankAccounts.createBankAccount({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `m9d833-${Date.now()}-${seq}` }, tenant.userId, tx);
  return account.id;
}, tenant.userId);

/** Linha de extrato; `cents` negativo = saída. */
const bankLine = (tenant, accountId, cents, date) => env.inTx(tenant, async (tx) => {
  seq += 1;
  const line = await bankTransactions.createBankTransaction({
    groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: accountId, externalTransactionId: `m9d833-${Date.now()}-${seq}`, amount: cents / 100, transactionDate: date, description: 'QA-M9 linha',
  }, tenant.userId, tx);
  return line.id;
}, tenant.userId);

const alertsOf = async (reference) => (await env.adminQuery("SELECT user_id, title, body, created_at FROM core.notifications WHERE title LIKE $1 ORDER BY created_at", [`%${reference}%`])).rows;

async function clean833() {
  await env.adminQuery('DELETE FROM governance.bcp_payment_pendings');
  await env.adminQuery('DELETE FROM governance.manual_operation_checks');
  // linhas de extrato e contas que o teste criou (a conciliação casa por valor e data: sobras de uma execução anterior seriam casadas no lugar da linha nova)
  await env.adminQuery("DELETE FROM finance.bank_transactions WHERE external_transaction_id LIKE 'm9d833-%'");
  await env.adminQuery("DELETE FROM finance.bank_accounts WHERE account_number LIKE 'm9d833-%'");
  await env.adminQuery("DELETE FROM core.tenant_settings WHERE key = 'governanca.calendario.feriados'");
  await env.cleanImports();
}

module.exports = { ...env, prepare833: prepare, recordPayment, checksOf, pendingOf, entriesOf, bankAccount, bankLine, alertsOf, clean833, APPROVE };
