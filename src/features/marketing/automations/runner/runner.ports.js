'use strict';

/**
 * M9-D414 — portas do runner. As áreas do Marketing só se tocam pelo index e sem ciclo; o arquivo de entrada do Marketing registra aqui o que o runner chama
 * em outras áreas (canSend da supressão, o envio de mensagem e a criação de rascunho). O pedido de avaliação (REQUEST_REVIEW) é registrado pela M9-D424.
 */
const ports = { canSend: null, sendMessage: null, createDraft: null, reviewRequester: null };
const linkProviders = new Map();

const required = (name) => {
  if (!ports[name]) throw new Error(`Porta do runner não registrada: ${name}. Carregue o módulo de Marketing (src/features/marketing).`);
  return ports[name];
};

function registerRunnerPorts({ canSend, sendMessage, createDraft }) {
  if (canSend) ports.canSend = canSend;
  if (sendMessage) ports.sendMessage = sendMessage;
  if (createDraft) ports.createDraft = createDraft;
}

function registerReviewRequester(fn) {
  if (typeof fn !== 'function') throw new TypeError('O serviço de pedido de avaliação deve ser uma função.');
  ports.reviewRequester = fn;
}

/** Provedor de link de uma mensagem (`linkProvider` da ação): `fn({ tenant, transaction, personId }) -> string|null`. O dono do link (ex.: pesquisa de satisfação do CRM) o registra. */
function registerLinkProvider(name, fn) {
  if (!name || typeof fn !== 'function') throw new TypeError('Informe o nome e a função do provedor de link.');
  linkProviders.set(name, fn);
}
const linkOf = async (name, context) => (linkProviders.has(name) ? linkProviders.get(name)(context) : null);

/**
 * Resolvedores nomeados que as automações prontas registram (M9-D420/D421), no mesmo molde do provedor de link: o runner não conhece cada uma.
 *  - canal (`channel: "NOME"` na ação de envio): `fn({ def, subject, event, tenant, transaction }) -> 'WHATSAPP'|'EMAIL'|null`; null cai na ordem dos canais automáticos;
 *  - variáveis do texto (`variablesProvider`): `fn({ tenant, transaction, personId, event }) -> { chave: valor }`, que preenchem `{chave}` no texto e no assunto;
 *  - responsável da tarefa (`assignee: "NOME"`): `fn({ tenant, transaction, subject, event }) -> userId|null`.
 */
const channelResolvers = new Map();
const variablesProviders = new Map();
const assigneeResolvers = new Map();
const named = (map) => (name, fn) => { if (!name || typeof fn !== 'function') throw new TypeError('Informe o nome e a função.'); map.set(name, fn); };
const registerChannelResolver = named(channelResolvers);
const registerVariablesProvider = named(variablesProviders);
const registerAssigneeResolver = named(assigneeResolvers);
const hasChannelResolver = (name) => channelResolvers.has(name);
const channelResolved = async (name, context) => channelResolvers.get(name)(context);
const variablesOfProvider = async (name, context) => (variablesProviders.has(name) ? variablesProviders.get(name)(context) : {});
const assigneeOf = async (name, context) => (assigneeResolvers.has(name) ? assigneeResolvers.get(name)(context) : null);

const clearReviewRequester = () => { ports.reviewRequester = null; };

module.exports = {
  registerLinkProvider, linkOf, registerChannelResolver, hasChannelResolver, channelResolved, registerVariablesProvider, variablesOfProvider, registerAssigneeResolver, assigneeOf, registerRunnerPorts, registerReviewRequester, clearReviewRequester,
  canSend: (...a) => required('canSend')(...a), sendMessage: (...a) => required('sendMessage')(...a), createDraft: (...a) => required('createDraft')(...a),
  requestReview: (...a) => { if (!ports.reviewRequester) throw new Error('Serviço de pedido de avaliação (M9-D424) não registrado.'); return ports.reviewRequester(...a); },
};
