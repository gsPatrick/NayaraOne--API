'use strict';

// Livro do Marco 3 §12: "Mensagens recebidas podem gerar resumo NAY, sentimento/ocorrência apenas como apoio" e "Não inferir atributo
// sensível do cliente". Capacidade `resumir_mensagem_recebida`: resumo da mensagem RECEBIDA do cliente, sentimento e, quando as palavras
// indicam, a SUGESTÃO de abrir uma ocorrência do §15 (reclamação, elogio, conflito, atendimento inadequado, retorno pendente). Tudo é
// apoio: vira recomendação marcada como tal para quem pediu (comercial.recommend.js); nada altera o cadastro do cliente, a mensagem ou a
// oportunidade, e nenhuma ocorrência é aberta (quem abre é a pessoa, no CRM). As palavras são parâmetros da empresa; o trecho com
// atributo sensível sai do resumo antes de qualquer registro.
const { Message, Opportunity } = require('../../../../models');
const { splitSentences } = require('../../orchestrator/grounding/sentences');
const { semAcento } = require('../../orchestrator/numbers/decimalText');
const { readMessageParams } = require('./comercial.capParams');
const { readSensitiveTerms, stripSensitive, distinctCategories } = require('./comercial.sensitive');
const { assertVisible, notFound } = require('./comercial.scope');
const { dateBR } = require('./comercial.format');

const ORDER = Object.freeze(['CONFLICT', 'POOR_SERVICE', 'COMPLAINT', 'PENDING_RETURN', 'COMPLIMENT']);
const TYPE_LABEL = Object.freeze({ CONFLICT: 'conflito', POOR_SERVICE: 'atendimento inadequado', COMPLAINT: 'reclamação', PENDING_RETURN: 'retorno pendente', COMPLIMENT: 'elogio' });
const SENTIMENT = Object.freeze({ CONFLICT: 'NEGATIVO', POOR_SERVICE: 'NEGATIVO', COMPLAINT: 'NEGATIVO', PENDING_RETURN: 'NEUTRO', COMPLIMENT: 'POSITIVO' });
const SENTIMENT_LABEL = Object.freeze({ NEGATIVO: 'negativo', NEUTRO: 'neutro', POSITIVO: 'positivo' });
const CHANNEL = Object.freeze({ WHATSAPP: 'WhatsApp', EMAIL: 'e-mail', SMS: 'SMS', PHONE: 'telefone', IN_PERSON: 'presencial', PORTAL: 'portal', SITE: 'site', INSTAGRAM: 'Instagram', OTHER: 'outro canal' });
const SUPPORT = 'Apoio da NAY — sugestão, não decisão: não altera o cadastro do cliente nem abre ocorrência; quem decide é você no CRM.';
const OUTBOUND_ONLY = 'A NAY resume apenas mensagens recebidas do cliente; esta mensagem foi enviada pela empresa.';

const norm = (t) => semAcento(String(t || '')).replace(/\s+/g, ' ').trim();
const hit = (text, term) => new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);

/** Sentimento e tipo de ocorrência sugerido pelas palavras da mensagem (primeiro tipo da ordem que casa). */
function classifyMessage(body, terms) {
  const t = norm(body);
  const matched = ORDER.filter((type) => (terms[type] || []).some((term) => hit(t, term)));
  const type = matched[0] || null;
  return { sentiment: type ? SENTIMENT[type] : 'NEUTRO', occurrenceType: type, matched };
}

/** Resumo do texto: as primeiras frases até `max` caracteres (a frase que não cabe é cortada com reticências). */
function summarize(body, max) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const out = [];
  for (const sentence of splitSentences(text)) {
    if ([...out, sentence].join(' ').length > max) break;
    out.push(sentence);
  }
  return out.length ? out.join(' ') : `${text.slice(0, max - 1).trim()}…`;
}

/** Mensagem visível a quem pede: da empresa (RLS) e, no escopo OWN, ligada a uma oportunidade de que ele é responsável. */
async function loadMessage(messageId, transaction, ownerScope) {
  const message = await Message.findByPk(messageId, { transaction });
  if (!message) throw notFound();
  if (ownerScope && ownerScope.mode === 'OWN') {
    const opportunity = message.opportunityId ? await Opportunity.findByPk(message.opportunityId, { attributes: ['id', 'ownerUserId'], transaction }) : null;
    if (!opportunity) throw notFound();
    assertVisible(opportunity, ownerScope);
  }
  return message;
}

/** Fonte da mensagem (o que o modelo lê no caminho de modelo e o que a resposta cita). O corpo já vem sem o trecho sensível. */
const messageSource = (m, safeBody, asOf) => ({
  sourceType: 'READ_MODEL', sourceRef: `crm.messages:${m.id}`, title: 'crm.messages', retrievedAt: asOf,
  text: `Mensagem recebida por ${CHANNEL[m.channel] || m.channel} em ${dateBR(m.occurredAt || m.get('created_at'))}. Texto: ${safeBody || '(sem texto)'}`,
});

/** Fatos da mensagem para as duas rotas (regra e modelo): corpo sem atributo sensível, classificação e o que saiu. */
async function messageFacts(messageId, { tenant, transaction, ownerScope, now }) {
  const m = await loadMessage(messageId, transaction, ownerScope);
  if (m.direction !== 'INBOUND') return { outbound: true, message: m };
  const params = await readMessageParams(tenant, transaction);
  const sensitive = stripSensitive(m.body, await readSensitiveTerms(tenant, transaction), { notice: false });
  const asOf = now.toISOString();
  return { outbound: false, message: m, safeBody: sensitive.text, removed: distinctCategories(sensitive.removed), params, classification: classifyMessage(sensitive.text, params.terms), asOf, source: messageSource(m, sensitive.text, asOf) };
}

/** Resposta do caminho de regra (o texto do resumo é montado pelo código a partir do corpo da mensagem). */
function messageSummaryResult(f) {
  if (f.outbound) return { answer: OUTBOUND_ONLY, meta: { recommend: false }, sources: [] };
  const resumo = summarize(f.safeBody, f.params.summaryChars);
  const c = f.classification;
  const linhas = [
    SUPPORT,
    `Resumo da mensagem recebida [1]: ${resumo || 'mensagem sem texto'}`,
    `Sentimento (indício pelas palavras da mensagem): ${SENTIMENT_LABEL[c.sentiment]}.`,
    c.occurrenceType ? `Sugestão: avaliar abrir uma ocorrência de ${TYPE_LABEL[c.occurrenceType]}; a ocorrência só é aberta por uma pessoa.` : 'Nenhuma ocorrência sugerida.',
    f.removed.length ? 'Um trecho da mensagem com dado pessoal sensível do cliente ficou fora do resumo (LGPD, art. 5º, II).' : null,
  ].filter(Boolean);
  const structured = {
    apoio: true, tipo: 'RESUMO_MENSAGEM_RECEBIDA', mensagem: f.message.id, oportunidade: f.message.opportunityId || null, resumo, sentimento: c.sentiment,
    ocorrenciaSugerida: c.occurrenceType ? { tipo: c.occurrenceType, rotulo: TYPE_LABEL[c.occurrenceType] } : null, sensivelRemovido: f.removed.map((r) => r.label),
    alteraCadastro: false, abreOcorrencia: false,
  };
  return { answer: linhas.join('\n'), snapshotAt: f.asOf, structured, meta: { recommendation: messageRecommendation(f, resumo) }, sources: [f.source] };
}

/** Recomendação de apoio (sem ação proposta: aceitar só marca como vista). */
function messageRecommendation(f, resumo, origin = 'RULE') {
  const c = f.classification;
  return {
    type: 'RESUMO_MENSAGEM', entityType: 'CRM_MESSAGE', entityId: f.message.id, riskLevel: 'LOW',
    title: c.occurrenceType ? `Mensagem recebida: sugestão de ocorrência de ${TYPE_LABEL[c.occurrenceType]}` : 'Resumo de mensagem recebida',
    rationale: `Apoio da NAY: ${resumo || 'mensagem sem texto'}`.slice(0, 1000),
    payload: { apoio: true, origem: origin, resumo, sentimento: c.sentiment, ocorrenciaSugerida: c.occurrenceType, oportunidade: f.message.opportunityId || null, alteraCadastro: false, abreOcorrencia: false },
  };
}

module.exports = { messageFacts, messageSummaryResult, messageRecommendation, classifyMessage, summarize, SUPPORT, OUTBOUND_ONLY };
