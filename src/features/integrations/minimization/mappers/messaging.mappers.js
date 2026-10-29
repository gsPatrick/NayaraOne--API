'use strict';

const { defineMapper } = require('../defineMapper');

/**
 * Mensageria e e-mail (M9-D219): o destinatário recebe nome e telefone/e-mail (PERSONAL); o CPF e qualquer dado interno ficam
 * de fora. Texto livre passa por redactFreeText. Anexo: a classificação do documento (escala de documentos) manda; RESTRICTED
 * vale SENSITIVE e é bloqueado nesta família (teto PERSONAL).
 */
const recipient = [
  { name: 'to', classification: 'PERSONAL', required: true },
  { name: 'recipientName', classification: 'PERSONAL' },
];

module.exports = {
  messaging: {
    sendText: defineMapper({ purpose: 'CUSTOMER_MESSAGE', fields: [...recipient, { name: 'text', classification: 'PUBLIC', freeText: true, required: true }] }),
    sendTemplate: defineMapper({
      purpose: 'CUSTOMER_MESSAGE',
      fields: [...recipient, { name: 'templateName', classification: 'PUBLIC', required: true }, { name: 'templateVars', classification: 'PERSONAL' }],
    }),
    sendMedia: defineMapper({
      purpose: 'CUSTOMER_MESSAGE',
      fields: [...recipient, { name: 'mediaRef', classification: 'PUBLIC', classificationFrom: 'mediaClassification', personalData: true, required: true }, { name: 'caption', classification: 'PUBLIC', freeText: true }],
    }),
  },
  email: {
    sendEmail: defineMapper({
      purpose: 'CUSTOMER_MESSAGE',
      fields: [
        ...recipient,
        { name: 'subject', classification: 'PUBLIC', freeText: true, required: true },
        { name: 'body', classification: 'PUBLIC', freeText: true, required: true },
        { name: 'attachmentRef', classification: 'PUBLIC', classificationFrom: 'attachmentClassification', personalData: true },
      ],
    }),
  },
};
