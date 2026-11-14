'use strict';

// Revisão da saída da NAY Comercial ANTES do aterramento (gancho `reviewAnswer`), nos caminhos de regra e de modelo:
//  - descrição de imóvel (livro do Marco 3 §16, Guia §12, CRM-TS-011): validateGeneratedDescription(output, approvedFacts); frase que afirma
//    metragem, quantidade, valor ou característica fora dos fatos públicos aprovados sai; se não sobra descrição, vale o texto montado
//    pelo código só com os fatos. A explicação vai em `structured.guardaDescricao`;
//  - demais capacidades (livro §12 "Não inferir atributo sensível do cliente"): a frase com atributo sensível sai e a resposta avisa; a
//    explicação (só as categorias, nunca o termo) vai em `structured.atributoSensivelRemovido`;
//  - resumo de mensagem pelo modelo: o texto é marcado como apoio (sugestão, não decisão).
const { TASKS } = require('./comercial.policy');
const { validateGeneratedDescription } = require('./comercial.descriptionGuard');
const { readSensitiveTerms, stripSensitive, distinctCategories } = require('./comercial.sensitive');
const { descriptionTerms } = require('./comercial.capParams');
const { propertyDraftText, BANNER } = require('./comercial.drafts');
const { SUPPORT, OUTBOUND_ONLY } = require('./comercial.messageSummary');
const { recall } = require('./comercial.runStore');

// Sem algarismo no aviso: frase com número e sem fonte seria cortada pelo aterramento. A contagem vai em `structured.guardaDescricao`.
const DESCRIPTION_NOTICE = 'A guarda da descrição tirou o que afirmava algo fora dos fatos públicos aprovados do imóvel (metragem, quantidade, valor, característica, localização ou benefício).';
const CITED = /\[\d+\]/;

const tenantOf = (state) => ({ groupId: state.ctx.groupId, companyId: state.ctx.companyId });
const setStructured = (state, extra) => { state.structured = { ...(state.structured || {}), ...extra }; };

function approvedOf(state) {
  const meta = state.ruleMeta || {};
  if (Array.isArray(meta.approvedFacts)) return { facts: meta.approvedFacts, publicCode: meta.publicCode, propertyId: meta.propertyId };
  return recall(state).property || null;
}

async function reviewDescription(state, text) {
  const approved = approvedOf(state);
  if (!approved) return text;
  const v = validateGeneratedDescription(text, approved.facts, { controlledTerms: await descriptionTerms(tenantOf(state), state.transaction) });
  const byModel = state.decision && state.decision.path !== 'RULE';
  if (byModel) setStructured(state, { rascunho: true, tipo: 'DESCRICAO_IMOVEL', imovel: approved.propertyId, codigoPublico: approved.publicCode, fonte: 'FATOS_PUBLICOS_APROVADOS', redigidoPor: 'MODELO' });
  setStructured(state, { guardaDescricao: { aprovada: v.ok, violacoes: v.violations.map((x) => ({ tipo: x.kind, trecho: x.detail })) } });
  if (v.ok) return String(text).startsWith(BANNER) ? text : `${BANNER}\n${text}`;
  const body = v.text.split('\n').filter((l) => l.trim() && l !== BANNER).join('\n');
  const corrected = CITED.test(body) ? `${BANNER}\n${body}` : propertyDraftText(approved);
  if (!CITED.test(body)) setStructured(state, { guardaDescricao: { aprovada: false, violacoes: v.violations.map((x) => ({ tipo: x.kind, trecho: x.detail })), substituidaPeloTextoDosFatos: true } });
  return `${corrected}\n${DESCRIPTION_NOTICE}`;
}

function markSupport(state, text) {
  if (state.parsed.taskType !== TASKS.MESSAGE_SUMMARY || !state.decision || state.decision.path === 'RULE') return text;
  const facts = recall(state).message;
  if (facts && facts.outbound) return OUTBOUND_ONLY;
  setStructured(state, { apoio: true, tipo: 'RESUMO_MENSAGEM_RECEBIDA', redigidoPor: 'MODELO', alteraCadastro: false, abreOcorrencia: false });
  return String(text).startsWith(SUPPORT) ? text : `${SUPPORT}\n${text}`;
}

/** Gancho `reviewAnswer(state, text)`: devolve o texto revisado (o aterramento e a varredura de saída vêm depois). */
async function reviewComercialAnswer(state, text) {
  if (state.parsed.taskType === TASKS.PROPERTY_DRAFT) return reviewDescription(state, text);
  const stripped = stripSensitive(markSupport(state, text), await readSensitiveTerms(tenantOf(state), state.transaction));
  if (stripped.changed) setStructured(state, { atributoSensivelRemovido: distinctCategories(stripped.removed).map((r) => r.label) });
  return stripped.text;
}

module.exports = { reviewComercialAnswer, DESCRIPTION_NOTICE };
