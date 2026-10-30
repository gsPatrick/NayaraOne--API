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
    sendText: defineMapper({ purpose: 'CUSTOMER_MESSAGE', fields: [...recipient, { name: 'text', classification: 'PUBLIC', freeText: true, required: true }, { name: 'conversationId', classification: 'PUBLIC' }] }),
    sendTemplate: defineMapper({
      purpose: 'CUSTOMER_MESSAGE',
      fields: [...recipient, { name: 'templateName', classification: 'PUBLIC', required: true }, { name: 'templateVars', classification: 'PERSONAL' }, { name: 'language', classification: 'PUBLIC' }, { name: 'conversationId', classification: 'PUBLIC' }],
    }),
    sendMedia: defineMapper({
      purpose: 'CUSTOMER_MESSAGE',
      fields: [...recipient, { name: 'mediaRef', classification: 'PUBLIC', classificationFrom: 'mediaClassification', personalData: true, required: true }, { name: 'caption', classification: 'PUBLIC', freeText: true }, { name: 'mimeType', classification: 'PUBLIC' }, { name: 'conversationId', classification: 'PUBLIC' }],
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
        // M9-D234: cópia, cópia oculta, resposta, versão HTML e anexos (referência do arquivo, sem o conteúdo; a classificação do documento manda em cada anexo).
        { name: 'cc', classification: 'PERSONAL' },
        { name: 'bcc', classification: 'PERSONAL' },
        { name: 'replyTo', classification: 'PERSONAL' },
        { name: 'bodyHtml', classification: 'PUBLIC', freeText: true },
        {
          name: 'attachments',
          classification: 'PUBLIC',
          items: [
            { name: 'fileId', classification: 'PUBLIC', classificationFrom: 'classification', personalData: true, required: true },
            { name: 'fileName', classification: 'INTERNAL' },
            { name: 'mimeType', classification: 'INTERNAL' },
            { name: 'sizeBytes', classification: 'INTERNAL' },
            { name: 'sha256', classification: 'INTERNAL' },
          ],
    }),
  },
};
