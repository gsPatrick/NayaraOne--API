'use strict';

const { BankTransaction, BankStatementImport } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { businessDateKey } = require('../../utils/businessDate');

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function dateKeyOf(value, fieldLabel) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest(`Data inválida em ${fieldLabel}: "${value}".`, 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_DATE');
  }
  // Data só (YYYY-MM-DD) é dia de calendário; instante é convertido para o dia em São Paulo.
  return DATE_ONLY_REGEX.test(String(value).trim()) ? String(value).trim() : businessDateKey(parsed);
}

// finance.bank_transactions representa linhas de extrato importadas. `externalTransactionId`
// (UNIQUE) é a idempotência natural de um import — reprocessar o mesmo arquivo/webhook não
// duplica a linha (FIN-004), então createBankTransaction checa antes de inserir e explica o
// motivo do 409 em vez de deixar estourar a constraint de banco crua.

async function createBankTransaction(payload, actorUserId, transaction) {
  const { groupId, companyId, bankAccountId, externalTransactionId, amount, transactionDate, description } = payload;
  if (!groupId || !companyId || !bankAccountId || amount === undefined || amount === null || !transactionDate) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "bankAccountId", "amount" e "transactionDate" são obrigatórios.',
      'FINANCE_BANK_TRANSACTION_VALIDATION'
    );
  }

  if (externalTransactionId) {
    const existing = await BankTransaction.findOne({ where: { externalTransactionId }, transaction });
    if (existing) {
      throw AppError.conflict(
        'Já existe uma transação importada com este mesmo identificador externo — import duplicado bloqueado.',
        'FINANCE_BANK_TRANSACTION_DUPLICATE',
        { existingId: existing.id }
      );
    }
  }

  const bankTransaction = await BankTransaction.create(
    {
      groupId,
      companyId,
      bankAccountId,
      externalTransactionId: externalTransactionId || null,
      amount,
      transactionDate,
      description: description || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.bank_transaction.create',
      entityType: 'BankTransaction',
      entityId: bankTransaction.id,
      afterJson: bankTransaction.toJSON(),
      reason: `Transação de extrato de ${amount} importada.`,
    },
    transaction
  );

  return bankTransaction;
}

// FIX FIN-TS-007 (auditoria externa Abacus AI, 11/10/2026): "Nenhuma tela de importação
// OFX/CSV encontrada". createBankTransaction já existia e já era idempotente por
// externalTransactionId, mas só criava UMA transação por chamada (API/webhook) — não existia
// nenhum caminho de IMPORTAÇÃO DE ARQUIVO (lote de linhas de extrato de uma vez). Formato
// suportado: CSV com colunas "externalTransactionId,transactionDate,description,amount"
// (cabeçalho obrigatório, nessa ordem — escopo desta rodada: CSV, não OFX binário/SGML, que
// exigiria um parser bem maior; a REGRA DE NEGÓCIO — idempotência por linha, reimportar o
// MESMO arquivo não duplica nada — é a mesma independente do formato de origem).
function parseStatementCsv(csvText) {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw AppError.badRequest('Arquivo de extrato vazio.', 'FINANCE_BANK_STATEMENT_IMPORT_EMPTY');
  }
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const expected = ['externaltransactionid', 'transactiondate', 'description', 'amount'];
  if (header.join(',') !== expected.join(',')) {
    throw AppError.badRequest(
      `Cabeçalho do CSV inválido — esperado exatamente: ${expected.join(',')}.`,
      'FINANCE_BANK_STATEMENT_IMPORT_INVALID_HEADER'
    );
  }
  return lines.slice(1).map((line, idx) => {
    const cols = line.split(',');
    if (cols.length < 4) {
      throw AppError.badRequest(`Linha ${idx + 2} do CSV com número de colunas inválido.`, 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_ROW');
    }
    const [externalTransactionId, transactionDate, description, amount] = cols;
    return {
      externalTransactionId: externalTransactionId.trim(),
      transactionDate: transactionDate.trim(),
      description: description.trim(),
      amount: Number(amount.trim()),
    };
  });
}

/**
 * importBankStatement — importação em LOTE, idempotente linha a linha. Reimportar o MESMO
 * arquivo (mesmos externalTransactionId) não duplica nada: cada linha já importada antes
 * volta marcada "duplicate" no relatório, em vez de abortar o lote inteiro (diferente de
 * createBankTransaction isolado, que lança 409 — aqui isso seria o comportamento normal e
 * esperado de reimportar um arquivo que já foi processado em parte).
 */
async function importBankStatement(payload, actorUserId, transaction) {
  const { groupId, companyId, bankAccountId, csvText } = payload;
  if (!groupId || !companyId || !bankAccountId || !csvText) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "bankAccountId" e "csvText" são obrigatórios.',
      'FINANCE_BANK_STATEMENT_IMPORT_VALIDATION'
    );
  }
  const rows = parseStatementCsv(csvText);
  if (!rows.every((r) => r.externalTransactionId)) {
    throw AppError.badRequest(
      'Toda linha do extrato precisa de um "externalTransactionId" — é o que garante que reimportar o mesmo arquivo não duplica nada.',
      'FINANCE_BANK_STATEMENT_IMPORT_MISSING_EXTERNAL_ID'
    );
  }

  // F02 (2ª rodada) — o período que o extrato cobre. Declarado por quem importa (periodStart/
  // periodEnd, YYYY-MM-DD) ou, se não declarado, deduzido da primeira e da última linha. É o que
  // a pré-condição "extratos importados" do fechamento confere: o mês inteiro precisa estar
  // coberto por alguma importação — uma transação solta no mês não basta.
  const rowDateKeys = rows.map((row, idx) => dateKeyOf(row.transactionDate, `linha ${idx + 2}`));
  const firstLine = rowDateKeys.reduce((a, b) => (a < b ? a : b));
  const lastLine = rowDateKeys.reduce((a, b) => (a > b ? a : b));
  const periodDeclared = Boolean(payload.periodStart || payload.periodEnd);
  if (periodDeclared && !(payload.periodStart && payload.periodEnd)) {
    throw AppError.badRequest(
      'Informe o início e o fim do período do extrato (ou nenhum dos dois, para usar as datas das linhas).',
      'FINANCE_BANK_STATEMENT_IMPORT_PERIOD_INCOMPLETE'
    );
  }
  const periodStart = periodDeclared ? dateKeyOf(payload.periodStart, 'periodStart') : firstLine;
  const periodEnd = periodDeclared ? dateKeyOf(payload.periodEnd, 'periodEnd') : lastLine;
  if (periodEnd < periodStart) {
    throw AppError.badRequest('O fim do período do extrato não pode ser anterior ao início.', 'FINANCE_BANK_STATEMENT_IMPORT_PERIOD_INVALID');
  }
  if (firstLine < periodStart || lastLine > periodEnd) {
    throw AppError.badRequest(
      `O extrato tem linhas fora do período declarado (${periodStart} a ${periodEnd}): de ${firstLine} a ${lastLine}.`,
      'FINANCE_BANK_STATEMENT_IMPORT_LINE_OUTSIDE_PERIOD'
    );
  }
  let closingBalance = null;
  if (payload.closingBalance !== undefined && payload.closingBalance !== null && payload.closingBalance !== '') {
    closingBalance = Number(payload.closingBalance);
    if (!Number.isFinite(closingBalance)) {
      throw AppError.badRequest('O saldo final do extrato precisa ser um número.', 'FINANCE_BANK_STATEMENT_IMPORT_VALIDATION');
    }
  }

  const result = { imported: [], duplicates: [], total: rows.length };
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await BankTransaction.findOne({ where: { externalTransactionId: row.externalTransactionId }, transaction });
    if (existing) {
      result.duplicates.push({ externalTransactionId: row.externalTransactionId, existingId: existing.id });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const created = await createBankTransaction(
      { groupId, companyId, bankAccountId, ...row },
      actorUserId,
      transaction
    );
    result.imported.push(created);
  }

  const statementImport = await BankStatementImport.create(
    {
      groupId,
      companyId,
      bankAccountId,
      periodStart,
      periodEnd,
      periodDeclared,
      closingBalance: closingBalance === null ? null : closingBalance.toFixed(2),
      linesTotal: result.total,
      linesImported: result.imported.length,
      createdBy: actorUserId || null,
    },
    { transaction }
  );
  result.statementImport = statementImport;

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.bank_statement.import',
      entityType: 'BankAccount',
      entityId: bankAccountId,
      afterJson: {
        total: result.total,
        importedCount: result.imported.length,
        duplicateCount: result.duplicates.length,
        statementImportId: statementImport.id,
        periodStart,
        periodEnd,
        periodDeclared,
        closingBalance: statementImport.closingBalance,
      },
      reason: `Extrato importado (${periodStart} a ${periodEnd}): ${result.imported.length} nova(s) linha(s), ${result.duplicates.length} já existente(s) (ignoradas).`,
    },
    transaction
  );

  return result;
}

async function listBankTransactions(transaction, filters = {}) {
  const where = {};
  if (filters.bankAccountId) where.bankAccountId = filters.bankAccountId;
  return BankTransaction.findAll({ where, order: [['transaction_date', 'DESC']], transaction });
}

async function getBankTransaction(id, transaction) {
  const bankTransaction = await BankTransaction.findByPk(id, { transaction });
  if (!bankTransaction) throw AppError.notFound('Transação bancária não encontrada.', 'FINANCE_BANK_TRANSACTION_NOT_FOUND');
  return bankTransaction;
}

module.exports = { createBankTransaction, listBankTransactions, getBankTransaction, importBankStatement };
