'use strict';

const { defineMapper } = require('../defineMapper');

/** Redes sociais, analytics e IA (M9-D219): só dado PUBLIC; analytics e IA aceitam dado pseudonimizado quando o campo é marcado. */
module.exports = {
  social: {
    publishPost: defineMapper({
      purpose: 'SOCIAL_PUBLICATION',
      fields: [
        { name: 'text', classification: 'PUBLIC', freeText: true, required: true }, { name: 'mediaRefs', classification: 'PUBLIC' }, { name: 'link', classification: 'PUBLIC' },
        // M9-D239: a referência do conteúdo aprovado (item, versão e hash) e o horário agendado acompanham o post.
        { name: 'contentRef', classification: 'PUBLIC' }, { name: 'scheduledAt', classification: 'PUBLIC' },
      ],
    }),
  },
  analytics: {
    emitEvent: defineMapper({
      purpose: 'ANALYTICS_EVENT',
      fields: [{ name: 'name', from: 'eventName', classification: 'PUBLIC', required: true }, { name: 'properties', classification: 'PUBLIC' }, { name: 'personHash', classification: 'PERSONAL', pseudonymized: true }],
    }),
    emitMetric: defineMapper({
      purpose: 'ANALYTICS_EVENT',
      fields: [{ name: 'name', from: 'metricName', classification: 'PUBLIC', required: true }, { name: 'value', classification: 'PUBLIC', required: true }, { name: 'tags', classification: 'PUBLIC' }],
    }),
  },
  ai: {
    generate: defineMapper({
      purpose: 'AI_GENERATION',
      fields: [{ name: 'prompt', classification: 'PUBLIC', freeText: true, required: true }, { name: 'subjectHash', classification: 'PERSONAL', pseudonymized: true }],
    }),
  },
};
