'use strict';

const { buildPrompt } = require('../promptBuilder');
const { publishInjectionEvents } = require('../injectionEvents');
const { estimateTokens } = require('./flow.input');

const CITATION_RULE = 'Cite cada afirmação sobre dados da empresa com o número da fonte entre colchetes, como [1], na ordem dos blocos fonte-1, fonte-2 e assim por diante. Sem fonte, diga que não há informação suficiente.';

/** Bloco `untrusted` de uma fonte (ou resultado de tool): origem `TOOL_RESULT` para resultado de ferramenta, `RETRIEVED` para o resto. */
function blockOf(source, index, redactor) {
  return {
    id: `fonte-${index + 1}`,
    origin: source.origin || (source.sourceType === 'TOOL_RESULT' ? 'TOOL_RESULT' : 'RETRIEVED'),
    classification: source.classification,
    text: redactor.text(source.text),
  };
}

/** Histórico do chat (M9-D030): só entrada do run, redigido, antes das fontes; a origem `CONVERSATION` o separa de fonte e de tool. */
const historyBlocks = (history, redactor) => (history || []).map((h, i) => ({
  id: `historico-${i + 1}`, origin: 'CONVERSATION', classification: 'INTERNAL', text: `${h.role === 'assistant' ? 'NAY' : 'Usuário'}: ${redactor.text(h.content)}`,
}));

/**
 * Passo 5: monta o prompt. `system` (política do agente, regra fixa de segurança, regra de citação e a lista das tools da allowlist)
 * fica separado dos blocos `untrusted` (cada fonte e a entrada do usuário rotulados e delimitados, D021). Antes, redaction/
 * minimização (D027): dado pessoal e segredo viram `[REDIGIDO:tipo]` e voltam só para quem perguntou (rehydrate). Trecho com
 * instrução suspeita é removido do contexto (a resposta avisa) e a detecção vira evento na transação do run.
 */
async function assemblePrompt(state) {
  const { agent, toolRegistry, redactor } = state;
  const allowed = (agent.tools || []).filter((t) => t.enabled).map((t) => t.toolName);
  const tools = toolRegistry.promptViewFor(allowed);
  const untrusted = [...historyBlocks(state.parsed.history, redactor), ...state.sources.map((s, i) => blockOf(s, i, redactor))];
  const built = buildPrompt({
    policy: `${agent.systemPolicy || ''}\n\n${CITATION_RULE}`.trim(), tools, untrusted, userInput: redactor.text(state.parsed.input), limits: state.injectionLimits,
  });
  const quarantined = new Set(built.quarantined.map((q) => q.sourceId));
  state.sources.forEach((s, i) => { if (quarantined.has(`fonte-${i + 1}`)) s.usedInAnswer = false; });
  const fresh = built.detections.filter((d) => !state.publishedDetections.has(`${d.sourceId}:${d.action}`));
  fresh.forEach((d) => state.publishedDetections.add(`${d.sourceId}:${d.action}`));
  await publishInjectionEvents(state.ctx, state.runId, fresh, state.transaction);
  if (built.notice && !state.notices.includes(built.notice)) state.notices.push(built.notice);
  state.prompt = built;
  state.untrustedTexts = built.untrustedTexts;
  state.actorTexts = built.actorTexts;
  state.promptTokens = estimateTokens(built.system) + built.messages.reduce((total, m) => total + estimateTokens(m.content), 0);
  return built;
}

module.exports = { assemblePrompt, CITATION_RULE };
