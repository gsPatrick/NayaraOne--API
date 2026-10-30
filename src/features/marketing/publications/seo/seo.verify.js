'use strict';

const { mktError } = require('../../marketing.errors');
const { factual } = require('../../content');

/**
 * M9-D427 regra 2 — metadata informada por uma pessoa (title/description que a publicação do SITE quer usar) só vale se o validador factual
 * (M9-D407) a aprova contra os fatos do cadastro. Dado que não existe no cadastro: 422 MKT_SEO_FIELD_NOT_VERIFIED, com os findings.
 */
function assertSeoFieldsVerified(fields, model, options = {}) {
  const text = [fields && fields.title, fields && fields.description].filter((v) => typeof v === 'string' && v.trim()).join('. ');
  if (!text) return;
  const result = factual.validateAgainstFacts(text, model.payload, options);
  const findings = Array.isArray(result.findings) ? result.findings : [];
  if (!result.ok || findings.length > 0) {
    throw mktError(422, 'MKT_SEO_FIELD_NOT_VERIFIED', 'A metadata cita dado que não existe no cadastro.', { findings });
  }
}

module.exports = { assertSeoFieldsVerified };
