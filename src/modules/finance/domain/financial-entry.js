'use strict';

/**
 * Domínio do lançamento financeiro (Guia M4 §2; Caderno §2, §4, §8, §10 e §13). Regra pura: tipos, naturezas,
 * estados e transições, competência x vencimento, faixa plausível do vencimento, métodos de liquidação e as
 * regras do dinheiro de terceiro. Sem banco, sem HTTP; quem lança o erro de negócio é o serviço.
 *
 * finance.financial_entries É o ledger (não existe uma tabela "finance.ledger" separada — a view finance.ledger
 * mostra só o que foi realizado). Regras duras (FIN-003/FIN-010): "Ledger imutável... correção é sempre por
 * estorno/lançamento compensatório" — nunca há UPDATE em `amount` de um lançamento já SETTLED, e o estorno cria
 * um novo registro em vez de apagar/alterar o original.
 */

const ENTRY_TYPES = ['DEBIT', 'CREDIT'];
// PENDING_CLASSIFICATION (auditoria externa 2026-10-07, contrato bruto, Centro Financeiro §10):
// "Valor excedente nunca é automaticamente tratado como receita; abre pendência de
// classificação." Natureza usada EXCLUSIVAMENTE para o lançamento-filho que representa o valor
// excedente de uma baixa parcial acima do saldo restante — nunca é RECEIVABLE/PAYABLE (não é
// receita/despesa própria até um humano classificar) e fica PENDING até alguém decidir o
// destino (ex.: reclassificar para RECEIVABLE de outro contrato, devolver, etc.).
const NATURES = ['PAYABLE', 'RECEIVABLE', 'TRANSFER', 'ADJUSTMENT', 'PENDING_CLASSIFICATION'];
// PARTIALLY_SETTLED (M4-06): lançamento que já recebeu uma ou mais baixas parciais mas ainda
// tem saldo em aberto. Continua "vivo" (aceita novas baixas) até a soma fechar o total.
const STATUSES = ['PENDING', 'PARTIALLY_SETTLED', 'SETTLED', 'REVERSED', 'CANCELLED'];
// Estados que aceitam baixa parcial e comprovante de baixa.
const OPEN_FOR_SETTLEMENT_STATUSES = ['PENDING', 'PARTIALLY_SETTLED'];
// Estados em que o dinheiro (todo ou parte) já entrou/saiu.
const RECEIVED_STATUSES = ['SETTLED', 'PARTIALLY_SETTLED'];
// Estados que não contam mais (estornado ou cancelado).
const INACTIVE_STATUSES = ['REVERSED', 'CANCELLED'];
// Classificação final de uma pendência de excedente (decisão humana).
const CLASSIFICATION_FINAL_NATURES = ['RECEIVABLE', 'PAYABLE', 'ADJUSTMENT'];

// M4-03 — COMPETÊNCIA x VENCIMENTO.
// `competenceMonth` ("YYYY-MM") é o mês contábil a que o lançamento pertence e pode ser
// diferente do mês de vencimento (ex.: energia consumida em setembro que vence em outubro).
// REGRA DE DERIVAÇÃO (quando o campo não é informado):
//   1. se houver `dueAt`, usa o ano-mês do vencimento (em UTC);
//   2. senão, usa o ano-mês de "agora" (momento da criação do lançamento = created_at).
// Nunca derivamos de settledAt: competência é definida na origem da obrigação, não na baixa.
const COMPETENCE_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function toCompetenceMonth(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isCompetenceInformed(competenceMonth) {
  return competenceMonth !== undefined && competenceMonth !== null && competenceMonth !== '';
}

function isValidCompetenceMonth(normalized) {
  return COMPETENCE_MONTH_REGEX.test(normalized);
}

/** Competência derivada quando não informada: mês do vencimento ou, sem vencimento, mês de agora. */
function deriveCompetenceMonth(dueAt) {
  if (dueAt) return toCompetenceMonth(dueAt);
  return toCompetenceMonth(new Date());
}

// FIN-008 (verificação M4 11/11/2026, sonda P1): "1e-3" passava como valor positivo e o numeric(18,2) gravava 0,00 em
// silêncio. Dinheiro só entra como decimal simples (texto "123.45" ou número finito): notação científica, hexadecimal,
// vírgula ou espaço no meio são recusados, e o valor precisa valer pelo menos 1 centavo depois do arredondamento ao
// centavo — nada vira 0,00 no banco. Chamadas internas que CALCULAM valores (rateio, juros) continuam podendo passar
// números com mais casas: o arredondamento ao centavo é delas (ver money-precision.middleware.js).
const PLAIN_DECIMAL_TEXT = /^[+-]?\d+(?:\.\d+)?$/;

/** Centavos inteiros de um valor monetário, ou null quando o formato não é decimal simples. */
function parseAmountCents(amount) {
  if (typeof amount === 'number') return Number.isFinite(amount) ? Math.round(amount * 100) : null;
  if (typeof amount !== 'string') return null;
  const text = amount.trim();
  if (!PLAIN_DECIMAL_TEXT.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

function isPlainDecimalAmount(amount) {
  return parseAmountCents(amount) !== null;
}

/** Positivo de verdade: decimal simples que vale pelo menos R$ 0,01 depois do arredondamento ao centavo. */
function isPositiveAmount(amount) {
  const cents = parseAmountCents(amount);
  return cents !== null && cents >= 1;
}

// FIX AUD-2026-09-14 (reportado pela cliente: sistema aceitou vencimento no ano "92026"): fail
// closed — vencimento precisa estar num intervalo humano plausível (100 anos atrás a 50 anos à
// frente), nunca um valor literalmente impossível.
const DUE_DATE_MIN_YEAR = new Date().getUTCFullYear() - 100;
const DUE_DATE_MAX_YEAR = new Date().getUTCFullYear() + 50;

function isDueYearPlausible(year) {
  return !(year < DUE_DATE_MIN_YEAR || year > DUE_DATE_MAX_YEAR);
}

// F03 (conferência Nayara 18/10/2026) — baixa direta versus confirmação bancária. Caderno
// Financeiro §8: "integração bancária retorna estado; sistema nunca presume sucesso;
// confirmação efetiva cria ledger". Um PAYABLE só vira SETTLED por um destes caminhos, e o
// caminho fica gravado no lançamento (settlementMethod):
//   BANK_CONFIRMED        confirmação efetiva do banco (payment.service#confirmBankPayment, webhook
//                         ou polling do provider).
//   MANUAL_WITH_EVIDENCE  exceção formal para pagamento feito fora da integração (ex.: TED
//                         digitada no internet banking): exige comprovante (arquivo real já
//                         enviado), motivo, e a aprovação prévia de outro usuário. Nunca é
//                         apresentado como confirmação bancária.
//   SANDBOX_CONFIRMED     confirmação vinda do provedor SANDBOX (simulação): nunca é apresentada
//                         como confirmação de um banco real (revisão independente, B5).
//   COMPENSATION          saída de dinheiro de terceiro que abate dívida do próprio titular —
//                         não move caixa; exige aprovação de outro usuário (revisão, D3).
const SETTLEMENT_METHODS = {
  BANK_CONFIRMED: 'BANK_CONFIRMED',
  SANDBOX_CONFIRMED: 'SANDBOX_CONFIRMED',
  MANUAL_WITH_EVIDENCE: 'MANUAL_WITH_EVIDENCE',
  COMPENSATION: 'COMPENSATION',
};

// A4 (revisão independente): o comprovante da baixa manual é PDF ou imagem.
const SETTLEMENT_EVIDENCE_MIME_PREFIXES = ['application/pdf', 'image/'];

function isAcceptedEvidenceMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  return SETTLEMENT_EVIDENCE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function settlementAuditSuffix(settlementInfo) {
  if (!settlementInfo) return '';
  switch (settlementInfo.method) {
    case SETTLEMENT_METHODS.BANK_CONFIRMED:
      return ' Confirmado pelo banco.';
    case SETTLEMENT_METHODS.SANDBOX_CONFIRMED:
      return ' Confirmado pelo provedor SANDBOX (simulação) — não é confirmação de banco real.';
    case SETTLEMENT_METHODS.COMPENSATION:
      return ' Compensação com dívida do titular — sem movimento de caixa.';
    default:
      return ` Baixa manual com comprovante (arquivo ${settlementInfo.evidenceFileId}) — motivo: ${settlementInfo.reason}. Não é confirmação bancária.`;
  }
}

// D2 (revisão independente): caução/depósito de garantia é dinheiro de quem a entrega: o
// locatário/comprador ou o fiador — nunca o proprietário/vendedor.
const THIRD_PARTY_HOLDER_ROLES = ['TENANT', 'GUARANTOR', 'BUYER'];
// D3 (revisão independente): devolução (RETURN, sai dinheiro) e compensação (COMPENSATION, abate
// dívida do titular, sem caixa).
const THIRD_PARTY_RELEASE_TYPES = ['RETURN', 'COMPENSATION'];

/** Saída de dinheiro de terceiro vinculada a uma caução de origem (devolução ou compensação). */
function isThirdPartyRelease(entry) {
  return Boolean(entry.nature === 'PAYABLE' && entry.isThirdPartyFunds && entry.thirdPartyOriginEntryId);
}

/** Estorno: lançamento compensatório com o tipo invertido. */
function compensatingEntryType(entryType) {
  return entryType === 'DEBIT' ? 'CREDIT' : 'DEBIT';
}

module.exports = {
  ENTRY_TYPES,
  NATURES,
  STATUSES,
  OPEN_FOR_SETTLEMENT_STATUSES,
  RECEIVED_STATUSES,
  INACTIVE_STATUSES,
  CLASSIFICATION_FINAL_NATURES,
  COMPETENCE_MONTH_REGEX,
  toCompetenceMonth,
  isCompetenceInformed,
  isValidCompetenceMonth,
  deriveCompetenceMonth,
  isPositiveAmount,
  parseAmountCents,
  isPlainDecimalAmount,
  DUE_DATE_MIN_YEAR,
  DUE_DATE_MAX_YEAR,
  isDueYearPlausible,
  SETTLEMENT_METHODS,
  SETTLEMENT_EVIDENCE_MIME_PREFIXES,
  isAcceptedEvidenceMime,
  settlementAuditSuffix,
  THIRD_PARTY_HOLDER_ROLES,
  THIRD_PARTY_RELEASE_TYPES,
  isThirdPartyRelease,
  compensatingEntryType,
};
