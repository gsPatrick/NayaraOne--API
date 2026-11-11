'use strict';

// Fontes que o SERVIDOR entrega ao modelo nas capacidades de redação da NAY Comercial (gancho `serverSources`, caminho de modelo; liga com
// `ia.comercial.redacao_por_modelo`). Guia do Marcelo §12: buildPropertyPrompt(propertyReadModel) = { facts: onlyApprovedPublicFacts(...),
// instruction }. O modelo recebe SÓ os fatos públicos aprovados do imóvel (ou a mensagem recebida, já sem o trecho sensível) e a instrução
// fixa; quem escolhe o que entra é o servidor, com a permissão de quem pede e o escopo de carteira conferidos antes.
const { TASKS } = require('./comercial.policy');
const { assertCan, nowOf } = require('./comercial.access');
const { loadApprovedFacts, buildPropertyPrompt } = require('./comercial.publicFacts');
const { propertySource } = require('./comercial.drafts');
const { messageFacts } = require('./comercial.messageSummary');
const { scopeOfActor } = require('./comercial.scope');
const { remember } = require('./comercial.runStore');

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const MESSAGE_INSTRUCTION = 'Resuma a mensagem recebida do cliente só com o que está nela, como apoio ao corretor. Não infira religião, origem, saúde, opinião política, vida sexual ou outro atributo sensível do cliente. Não abra ocorrência nem altere dados.';

/** Id do assunto do pedido (context.entityType/entityId) do tipo pedido, ou o primeiro UUID do texto. */
function subjectId(parsed, types) {
  const s = parsed.subject;
  if (s && types.includes(String(s.type).toLowerCase()) && UUID.test(String(s.id))) return String(s.id).toLowerCase();
  const m = UUID.exec(String(parsed.input || ''));
  return m ? m[0].toLowerCase() : null;
}

const actorOf = (state) => ({ userId: state.ctx.userId, permissions: state.ctx.permissions || [] });
const asSource = (s) => ({ ...s, classification: 'INTERNAL', statusAtRetrieval: 'VIGENTE', relevanceScore: 1 });

async function propertySources(state) {
  assertCan(actorOf(state), 'properties:read');
  const id = subjectId(state.parsed, ['property', 'imovel', 'properties']);
  if (!id) return [];
  const approved = await loadApprovedFacts(id, state.transaction);
  const prompt = buildPropertyPrompt(approved);
  remember(state, { property: approved });
  state.toolNotes.push(prompt.instruction); // vai ao system do modelo (hint), nunca a um bloco não confiável
  return [asSource(propertySource(approved, new Date(state.clock()).toISOString()))];
}

async function messageSources(state) {
  const actor = actorOf(state);
  assertCan(actor, 'crm:opportunities:read', 'people:read');
  const id = subjectId(state.parsed, ['crmmessage', 'crm.message', 'message', 'mensagem']);
  if (!id) return [];
  const facts = await messageFacts(id, { tenant: { groupId: state.ctx.groupId, companyId: state.ctx.companyId }, transaction: state.transaction, ownerScope: scopeOfActor(actor), now: nowOf({ now: new Date(state.clock()) }) });
  remember(state, { message: facts });
  if (facts.outbound) return [];
  state.toolNotes.push(MESSAGE_INSTRUCTION);
  return [asSource(facts.source)];
}

/** Gancho `serverSources(state)`: fontes do servidor para a redação por modelo (vazio nas demais tarefas). */
async function comercialServerSources(state) {
  if (state.parsed.taskType === TASKS.PROPERTY_DRAFT) return propertySources(state);
  if (state.parsed.taskType === TASKS.MESSAGE_SUMMARY) return messageSources(state);
  return [];
}

module.exports = { comercialServerSources, subjectId, MESSAGE_INSTRUCTION };
