'use strict';

const { sequelize } = require('../../../models');

/**
 * Inventário inicial das operações externas (M9-D907 §3.1, regra inferida do contexto: o livro pede o plano sem listar as operações). Cada tipo traz a compensação, o
 * procedimento e o responsável, e as operações de envio externo (`operations`, os nomes das operações dos ports) e a entidade da migração a que pertence (a que liga o
 * tipo ao setor do canary, M9-D904). Tudo editável por PUT /migration/external-ops; o código do tipo não muda.
 */
const SEEDS = Object.freeze([
  {
    code: 'PAYMENT_SENT', module: 'FINANCE', reversibility: 'IRREVERSIBLE', entity: 'FINANCIAL_ENTRY', operations: ['submitPayment'], owner: 'Financeiro',
    compensation: 'Pagamento bancário ou PIX enviado: solicitar a devolução ao banco; a compensação é o estorno, sujeita ao aceite do banco.',
    procedure: 'Conferir o pagamento no extrato, abrir a solicitação de devolução (estorno) no banco e acompanhar o aceite; seguir o runbook banco-indisponivel-pagamento-incerto-estorno.',
  },
  {
    code: 'BILLING_ISSUED', module: 'FINANCE', reversibility: 'COMPENSABLE', entity: 'FINANCIAL_ENTRY', operations: [], owner: 'Financeiro',
    compensation: 'Boleto ou cobrança emitida: baixa ou cancelamento no banco.',
    procedure: 'Cancelar (baixar) a cobrança no banco e confirmar a baixa no extrato antes de reemitir no sistema que ficar.',
  },
  {
    code: 'MESSAGE_SENT', module: 'CRM', reversibility: 'IRREVERSIBLE', entity: 'LEAD', operations: ['sendText', 'sendTemplate', 'sendMedia', 'sendEmail'], owner: 'Atendimento',
    compensation: 'Mensagem de WhatsApp, e-mail ou SMS enviada: mensagem corretiva ao destinatário.',
    procedure: 'Listar os destinatários do relatório, enviar a mensagem corretiva pelo mesmo canal e registrar a data do envio.',
  },
  {
    code: 'SIGNATURE_ENVELOPE_SENT', module: 'LEGAL', reversibility: 'IRREVERSIBLE', entity: 'CONTRACT', operations: ['createEnvelope'], owner: 'Jurídico',
    compensation: 'Envelope de assinatura enviado ou assinado: aditivo ou distrato.',
    procedure: 'Cancelar o envelope se ainda não assinado; se assinado, formalizar aditivo ou distrato com a parte e arquivar no dossiê do contrato.',
  },
  {
    code: 'FISCAL_OBLIGATION_TRANSMITTED', module: 'FISCAL', reversibility: 'IRREVERSIBLE', entity: 'FINANCIAL_ENTRY', operations: ['issueNfse', 'cancelNfse'], owner: 'Fiscal',
    compensation: 'Obrigação fiscal ou DIMOB transmitida: declaração retificadora.',
    procedure: 'Preparar e transmitir a retificadora (ou cancelar a nota no prazo da prefeitura) e guardar o novo protocolo.',
  },
  {
    code: 'FINANCING_PROPOSAL_SENT', module: 'CORRESPONDENT', reversibility: 'COMPENSABLE', entity: 'FINANCING_PROCESS', operations: ['submitCase', 'requestAppraisal'], owner: 'Correspondente',
    compensation: 'Proposta de financiamento enviada ao banco: cancelamento.',
    procedure: 'Pedir o cancelamento da proposta ao banco, confirmar o status e reabrir o processo no sistema que ficar.',
  },
  {
    code: 'PUBLICATION_PUBLISHED', module: 'MARKETING', reversibility: 'COMPENSABLE', entity: null, operations: ['publishPost', 'publishPage', 'publishListing'], owner: 'Marketing',
    compensation: 'Publicação em portal, site ou rede social: despublicar.',
    procedure: 'Despublicar cada item no destino e conferir que a página ou o post saiu do ar.',
  },
  {
    code: 'INSURANCE_PROPOSAL_SENT', module: 'PROCUREMENT', reversibility: 'COMPENSABLE', entity: null, operations: ['propose', 'submitClaim'], owner: 'Compras',
    compensation: 'Proposta ou sinistro enviado à seguradora: cancelamento.',
    procedure: 'Pedir o cancelamento à seguradora e anexar o comprovante no cadastro da apólice.',
  },
]);

/** Garante o inventário da empresa (idempotente; nunca sobrescreve o que o administrador já ajustou). */
async function ensureTypes(tenant, transaction) {
  for (const seed of SEEDS) {
    await sequelize.query(
      `INSERT INTO governance.external_op_types (group_id, company_id, code, module, reversibility, compensation, procedure, owner, entity, operations)
       VALUES (:groupId, :companyId, :code, :module, :reversibility, :compensation, :procedure, :owner, :entity, CAST(:operations AS text[]))
       ON CONFLICT (company_id, code) DO NOTHING`,
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, ...seed, operations: `{${seed.operations.join(',')}}` } }
    );
  }
}

module.exports = { SEEDS, ensureTypes };
