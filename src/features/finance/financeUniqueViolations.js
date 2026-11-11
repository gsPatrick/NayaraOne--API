'use strict';

/**
 * Tradução das violações de unicidade do schema finance para o código de negócio (Caderno M4
 * FIN-004 / FIN-TS-001). Quando duas requisições concorrentes passam juntas pela checagem
 * "já existe?" e a segunda só é barrada pelo UNIQUE do banco, quem perde recebia o 409 genérico
 * UNIQUE_CONSTRAINT_VIOLATION ("Violação de restrição de unicidade"). Agora recebe o mesmo
 * código e a mesma mensagem da checagem do serviço. Devolve null quando a violação não é uma das
 * conhecidas (o tratamento genérico continua valendo).
 */
const RULES = [
  {
    table: 'financial_entries',
    columns: ['idempotency_key'],
    constraints: ['financial_entries_company_idempotency_uk', 'financial_entries_idempotency_key_key'],
    code: 'FINANCE_DUPLICATE_PAYMENT',
    message: 'Já existe um lançamento com esta mesma chave de idempotência — pagamento/recebimento duplicado bloqueado.',
  },
  {
    table: 'owner_repasses',
    columns: ['idempotency_key'],
    constraints: ['owner_repasses_company_idempotency_uk', 'owner_repasses_idempotency_key_key'],
    code: 'FINANCE_DUPLICATE_PAYMENT',
    message: 'Já existe um repasse com esta mesma chave de idempotência — repasse duplicado bloqueado.',
  },
  {
    table: 'bank_transactions',
    columns: ['external_transaction_id', 'fingerprint'],
    constraints: ['bank_transactions_account_external_id_uk', 'bank_transactions_account_fingerprint_uk', 'bank_transactions_external_transaction_id_key'],
    code: 'FINANCE_BANK_TRANSACTION_DUPLICATE',
    message: 'Já existe uma transação importada com este mesmo identificador externo nesta conta — import duplicado bloqueado.',
  },
];

function violatedColumns(err) {
  const fields = err && err.fields && typeof err.fields === 'object' ? Object.keys(err.fields) : [];
  const fromErrors = Array.isArray(err && err.errors) ? err.errors.map((e) => e.path).filter(Boolean) : [];
  return new Set([...fields, ...fromErrors].map((f) => String(f).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)));
}

function mapFinanceUniqueViolation(err) {
  if (!err || err.name !== 'SequelizeUniqueConstraintError') return null;
  const parent = err.parent || err.original || {};
  const table = parent.table || '';
  const constraint = String(parent.constraint || '');
  const cols = violatedColumns(err);
  // O detalhe do Postgres ("Key (company_id, idempotency_key)=(...) already exists.") também nomeia as colunas.
  const detail = String(parent.detail || '');
  for (const rule of RULES) {
    const sameTable = table === rule.table || constraint.startsWith(`${rule.table}_`);
    const byName = rule.constraints.includes(constraint);
    if (byName || (sameTable && rule.columns.some((c) => cols.has(c) || constraint.includes(c) || detail.includes(c)))) {
      return { statusCode: 409, code: rule.code, message: rule.message };
    }
  }
  return null;
}

module.exports = { mapFinanceUniqueViolation };
