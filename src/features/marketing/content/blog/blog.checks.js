'use strict';

const { parseSources } = require('./blog.sources');
const { splitParagraphs, factualSignals, referencesOf, countWords } = require('./blog.paragraphs');

const CODE_SOURCES = 'MKT_BLOG_SOURCES_REQUIRED';
const CODE_QUALITY = 'MKT_BLOG_QUALITY_FAILED';

const finding = (code, reason, extra = {}) => ({ kind: 'BLOG', code, reason, severity: 'BLOCK', ...extra });

/** Fontes: sem nenhuma, ou alguma inválida / fora dos domínios permitidos, bloqueia. */
function checkSources(fontes, config) {
  const list = parseSources(fontes, config.allowedDomains);
  if (list.length === 0) return { sources: list, findings: [finding(CODE_SOURCES, 'NO_SOURCES')] };
  const findings = list.filter((s) => s.problem).map((s) => finding(CODE_SOURCES, s.problem, { source: s.index, found: s.host || s.raw }));
  return { sources: list, findings };
}

/** Todo parágrafo factual cita ao menos uma referência que existe em sources[] (e a fonte citada é permitida). */
function checkParagraphs(text, sources) {
  const findings = [];
  splitParagraphs(text).forEach((paragraph, i) => {
    const signals = factualSignals(paragraph);
    if (signals.length === 0) return;
    const refs = referencesOf(paragraph);
    const unknown = refs.filter((n) => !sources.some((s) => s.index === n));
    const valid = refs.filter((n) => sources.some((s) => s.index === n && !s.problem));
    if (unknown.length > 0) findings.push(finding(CODE_SOURCES, 'REFERENCE_UNKNOWN', { paragraph: i + 1, found: unknown.map((n) => `[${n}]`).join(', ') }));
    else if (valid.length === 0) findings.push(finding(CODE_SOURCES, 'PARAGRAPH_WITHOUT_SOURCE', { paragraph: i + 1, signals, claim: paragraph.slice(0, 80) }));
  });
  return findings;
}

/** Qualidade mínima: tamanho e, no texto gerado pela NAY, o aviso de apoio de IA. */
function checkQuality(text, { nayGenerated }, config) {
  const findings = [];
  const words = countWords(text);
  if (words < config.minWords) findings.push(finding(CODE_QUALITY, 'TOO_SHORT', { expected: config.minWords, found: words }));
  if (nayGenerated && !String(text || '').toLowerCase().includes(config.aiNotice.toLowerCase())) findings.push(finding(CODE_QUALITY, 'AI_NOTICE_MISSING', { expected: config.aiNotice }));
  return findings;
}

/**
 * source/quality checks do blog (M9-D427 regra 5), função pura: { ok, findings, sources }. `config` = { allowedDomains, minWords, aiNotice }.
 * Fonte e parágrafo sem referência dão MKT_BLOG_SOURCES_REQUIRED; tamanho e aviso de IA dão MKT_BLOG_QUALITY_FAILED.
 */
function checkBlog({ texto, fontes, nayGenerated = false }, config) {
  const { sources, findings: sourceFindings } = checkSources(fontes, config);
  const findings = [...sourceFindings, ...checkParagraphs(texto, sources), ...checkQuality(texto, { nayGenerated }, config)];
  return { ok: findings.length === 0, findings, sources: sources.filter((s) => !s.problem).map(({ index, url, accessedAt }) => ({ index, url, accessedAt })) };
}

module.exports = { checkBlog, CODE_SOURCES, CODE_QUALITY };
