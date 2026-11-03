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

  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || Math.abs(amountNumber) >= 1e16) {
    throw AppError.badRequest('O valor da transação do extrato precisa ser um número válido.', 'FINANCE_BANK_TRANSACTION_VALIDATION');
  }
  // F-09: data de dia (AAAA-MM-DD) é gravada ao meio-dia de São Paulo — à meia-noite UTC o
  // dia aparecia como o anterior (20/10 virava 19/10) para quem lê no fuso de São Paulo.
  const storedDate = DATE_ONLY_REGEX.test(String(transactionDate).trim()) ? `${String(transactionDate).trim()}${NOON_SAO_PAULO_SUFFIX}` : transactionDate;

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
      amount: amountNumber,
      transactionDate: storedDate,
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
const CSV_EXPECTED_HEADER = ['externaltransactionid', 'transactiondate', 'description', 'amount'];
const NOON_SAO_PAULO_SUFFIX = 'T12:00:00-03:00';

/**
 * splitCsv — leitor de CSV com aspas ("" dentro de um campo vira "), delimitador vírgula ou ponto
 * e vírgula (decidido pela primeira linha) e quebra de linha dentro de campo entre aspas.
 * Devolve as linhas já separadas em campos; linhas totalmente vazias são ignoradas.
 */
function splitCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/)[0] || '';
  const delimiter = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let fieldWasQuoted = false;
  const pushField = () => { row.push(fieldWasQuoted ? field : field.trim()); field = ''; fieldWasQuoted = false; };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else { field += ch; }
    } else if (ch === '"' && field.trim() === '') { quoted = true; fieldWasQuoted = true; field = ''; }
    else if (ch === delimiter) { pushField(); }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      pushField();
      if (row.some((c) => String(c).trim() !== '')) rows.push(row);
      row = [];
    } else { field += ch; }
  }
  if (quoted) {
    throw AppError.badRequest('O arquivo tem um campo entre aspas que nunca foi fechado. Corrija o arquivo e importe de novo.', 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_ROW');
  }
  pushField();
  if (row.some((c) => String(c).trim() !== '')) rows.push(row);
  return { rows, delimiter };
}

/**
 * parseStatementAmount — valor do extrato em formato EXPLÍCITO, sem adivinhar:
 *   - ponto decimal:  1234.56 · -1234.5 · 1234                (sem separador de milhar)
 *   - formato BR:     1.234,56 · -1.234,56 · 1234,56 · R$ 1.234,56
 * Aceita até 2 casas decimais. "1.234" (ponto com 3 dígitos) é ambíguo e é recusado: nunca vira
 * 1,23 nem 1234 por palpite. Texto, NaN, Infinity e valores acima de 16 dígitos são recusados.
 */
function parseStatementAmount(raw) {
  let text = String(raw === undefined || raw === null ? '' : raw).trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
  if (!text) return { error: 'o valor está vazio' };
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); } else if (text.startsWith('+')) text = text.slice(1);
  let normalized;
  if (/^\d+(\.\d{1,2})?$/.test(text)) normalized = text;
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(text) || /^\d+,\d{1,2}$/.test(text)) normalized = text.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) return { error: `o valor "${raw}" é ambíguo (ponto com 3 dígitos): escreva 1234.56 ou 1.234,56` };
  else return { error: `o valor "${raw}" não é um número válido (use 1234.56 ou 1.234,56)` };
  const value = Number(normalized);
  if (!Number.isFinite(value) || Math.abs(value) >= 1e16) return { error: `o valor "${raw}" está fora do limite permitido` };
  return { value: negative ? -value : value };
}

function normalizeStatementDate(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const candidate = br ? `${br[3]}-${br[2]}-${br[1]}` : text;
  if (DATE_ONLY_REGEX.test(candidate)) {
    const [y, m, d] = candidate.split('-').map(Number);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
    return candidate;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(candidate) && !Number.isNaN(new Date(candidate).getTime())) return candidate;
  return null;
}

function parseStatementCsv(csvText) {
  const { rows: table, delimiter } = splitCsv(csvText);
  if (table.length === 0) {
    throw AppError.badRequest('Arquivo de extrato vazio.', 'FINANCE_BANK_STATEMENT_IMPORT_EMPTY');
  }
  const header = table[0].map((h) => String(h).trim().toLowerCase());
  if (header.join(',') !== CSV_EXPECTED_HEADER.join(',')) {
    throw AppError.badRequest(
      'Cabeçalho do CSV inválido — esperado exatamente: externalTransactionId,transactionDate,description,amount.',
      'FINANCE_BANK_STATEMENT_IMPORT_INVALID_HEADER'
    );
  }
  const errors = [];
  const parsed = [];
  table.slice(1).forEach((cols, idx) => {
    const line = idx + 2;
    if (cols.length !== 4) {
      errors.push({ linha: line, erro: cols.length > 4
        ? `a linha tem ${cols.length} colunas em vez de 4; se o valor usa vírgula decimal (1.234,56), coloque-o entre aspas ou use ponto e vírgula como separador`
        : `a linha tem ${cols.length} colunas em vez de 4` });
      return;
    }
    const [externalTransactionId, transactionDate, description, amountRaw] = cols;
    const date = normalizeStatementDate(transactionDate);
    const amount = parseStatementAmount(amountRaw);
    if (!String(externalTransactionId).trim()) errors.push({ linha: line, code: 'FINANCE_BANK_STATEMENT_IMPORT_MISSING_EXTERNAL_ID', erro: 'falta o identificador externo da transação (é ele que impede duplicar linhas ao reimportar)' });
    else if (!date) errors.push({ linha: line, code: 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_DATE', erro: `a data "${transactionDate}" é inválida (use AAAA-MM-DD ou DD/MM/AAAA)` });
    else if (amount.error) errors.push({ linha: line, erro: amount.error });
    else parsed.push({ externalTransactionId: String(externalTransactionId).trim(), transactionDate: date, description: String(description).trim(), amount: amount.value });
  });
  if (errors.length > 0) {
    // O lote inteiro é recusado: nenhuma linha boa entra enquanto houver linha inválida.
    throw AppError.badRequest(
      `O extrato não foi importado: linha ${errors[0].linha} — ${errors[0].erro}${errors.length > 1 ? ` (e mais ${errors.length - 1} linha(s) com problema)` : ''}. Nenhuma linha foi gravada.`,
      errors[0].code || 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_ROW',
      { linhasComProblema: errors.slice(0, 20), delimitador: delimiter }
    );
  }
  return parsed;
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
