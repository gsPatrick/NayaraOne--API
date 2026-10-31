'use strict';

const { validateAgainstFacts } = require('./pipeline.factualPort');
const { readFactualConfig } = require('./factual/settings');
const { companyDateParts } = require('./pipeline.time');
const { checkBlog, readBlogConfig } = require('./blog');
const video = require('./video');
const { checkInternalReference } = require('./factual/internalRef');
const { DEFAULT_INTERNAL_TERMS, parseTerms } = require('./factual/settings');
const security = require('../security');

/** Blog educativo (M9-D427): fontes, parágrafos factuais com referência e qualidade mínima, sobre o texto e as fontes da versão corrente. */
async function blogFindings({ item, version, tenant, transaction }) {
  if (!item || item.type !== 'EDUCATIONAL_BLOG') return { findings: [], sources: undefined };
  const body = version.body_json || {};
  const result = checkBlog({ texto: body.texto, fontes: body.fontes, nayGenerated: Boolean(version.model_name || version.nay_run_id) }, await readBlogConfig(tenant, transaction));
  return { findings: result.findings, sources: result.sources };
}

/** URL reprovada pela regra única de URL externa (M9-D433), como finding do validador. */
const urlFinding = ({ url, reasons }) => ({ kind: 'URL', claim: url, expected: null, found: reasons.join(','), severity: 'BLOCK', reason: 'URL_NOT_ALLOWED', message: 'O texto traz uma URL externa não permitida.' });

/**
 * M9-D406 função 3 / M9-D407 — validação factual do texto da versão corrente contra os fatos gravados na própria versão. A
 * tolerância de área, o dicionário de características e os telefones da empresa vêm dos parâmetros da empresa; a data do conteúdo é
 * o dia de hoje no fuso da empresa. Ok leva a FACT_CHECKED; qualquer finding, a FACT_CHECK_FAILED com os findings gravados.
 * M9-D427: o blog educativo soma os checks de fonte e de qualidade (findings com `code` MKT_BLOG_*).
 */
async function factualStep({ item, version, tenant, transaction, now }) {
  const body = version.body_json || {};
  // M9-D426: legenda, roteiro e descrição do reel passam juntos pelo validador factual (preço divergente ou endereço restrito em qualquer um reprova).
  const text = item && video.isVideo(item.type) ? video.videoTexts(body).join('\n') : (typeof body.texto === 'string' ? body.texto : '');
  const config = await readFactualConfig(tenant, transaction);
  const options = { ...config, contentDate: await companyDateParts(now || new Date(), tenant, transaction) };
  // As URLs saem do texto antes da conferência dos fatos: o número de um endereço ("/imovel/1") não é afirmação sobre o imóvel; elas têm a própria regra, abaixo.
  const result = validateAgainstFacts(security.extractUrls(text, await security.readUrlConfig(tenant, transaction)).reduce((acc, url) => acc.split(url).join(' '), text), version.facts_snapshot_json || {}, options);
  const isBlog = Boolean(item && item.type === 'EDUCATIONAL_BLOG');
  // M9-D433: ocorrência/reclamação interna no texto e URL externa fora da regra reprovam (o blog tem a regra própria de fontes da M9-D427).
  const guardFindings = isBlog ? [] : [
    ...checkInternalReference(text, options.termosInternos || parseTerms(DEFAULT_INTERNAL_TERMS)),
    ...(await security.findDisallowedUrls(text, { tenant, transaction })).map(urlFinding),
  ];
  const blog = await blogFindings({ item, version, tenant, transaction });
  const own = Array.isArray(result.findings) ? result.findings : [];
  // Blog não tem imóvel como fonte: as comparações com o cadastro (preço, área, número solto) não se aplicam; a afirmação factual é controlada pela
  // regra das fontes (parágrafo com número precisa de referência [n]). A suspeita de injeção continua valendo (DI-D427-6).
  const findings = [...(blog.sources ? own.filter((f) => f.reason === 'INJECTION') : own), ...guardFindings, ...blog.findings];
  const ok = findings.length === 0 && (blog.sources ? true : Boolean(result.ok));
  return { ok, to: ok ? 'FACT_CHECKED' : 'FACT_CHECK_FAILED', detalhes: { findings, ...(blog.sources ? { fontes: blog.sources } : {}) } };
}

module.exports = { factualStep };
