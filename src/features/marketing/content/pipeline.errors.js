'use strict';

const { mktError } = require('../marketing.errors');
const { blogSourcesRequired, blogQualityFailed } = require('./blog/blog.errors');

/** Erros do pipeline de conteúdo (M9-D406). Mensagens em português; o detalhe técnico fica em details. */
const nayUnavailable = (details) =>
  mktError(503, 'MKT_NAY_UNAVAILABLE', 'A NAY está indisponível; escreva o conteúdo manualmente ou tente de novo.', details);
const scheduleTooSoon = (details) => mktError(422, 'MKT_SCHEDULE_TOO_SOON', 'O agendamento exige antecedência mínima configurada.', details);
const stepRequired = (details) => mktError(409, 'MKT_PIPELINE_STEP_REQUIRED', 'Conclua a validação anterior antes de continuar.', details);
const contentNotFound = () => mktError(404, 'MKT_NOT_FOUND', 'Conteúdo não encontrado.');
const contentInvalid = (message, details) => mktError(400, 'MKT_VALIDATION', message, details);
const contentNotApproved = (details) => mktError(409, 'MKT_CONTENT_NOT_APPROVED', 'O conteúdo precisa estar aprovado para ser agendado.', details);
const separationOfDuties = () => mktError(403, 'MKT_FORBIDDEN', 'Quem gerou o conteúdo não pode aprová-lo.', { reason: 'SEPARATION_OF_DUTIES' });
const variableMissing = (names) => mktError(422, 'MKT_TEMPLATE_UNKNOWN_VARIABLE', 'O template usa uma variável sem valor.', { variables: names });

/**
 * M9-D407 — texto reprovado pelo validador factual: 422 com os findings. Injeção vence (revisão humana), depois divergência,
 * depois dado inexistente; afirmação sem lastro (número solto, superlativo) conta como divergência.
 */
function factCheckFailed(findings, details) {
  const reasons = new Set(findings.map((f) => f.reason));
  const body = { ...details, findings };
  // M9-D427: blog educativo sem fonte (ou parágrafo factual sem referência) e blog abaixo da qualidade mínima têm código próprio.
  if (findings.some((f) => f.code === 'MKT_BLOG_SOURCES_REQUIRED')) return blogSourcesRequired(body);
  if (findings.some((f) => f.code === 'MKT_BLOG_QUALITY_FAILED')) return blogQualityFailed(body);
  if (reasons.has('INJECTION')) return mktError(422, 'MKT_INJECTION_SUSPECT', 'Há instrução suspeita no texto de origem; revisão humana necessária.', body);
  if (reasons.has('MISMATCH') || reasons.has('UNEXPLAINED') || !reasons.has('MISSING')) {
    return mktError(422, 'MKT_FACT_MISMATCH', 'O texto afirma algo diferente do cadastro do imóvel.', body);
  }
  return mktError(422, 'MKT_FACT_MISSING', 'O texto cita um dado que não existe no cadastro.', body);
}

module.exports = { factCheckFailed, nayUnavailable, scheduleTooSoon, stepRequired, contentNotFound, contentInvalid, contentNotApproved, separationOfDuties, variableMissing };
