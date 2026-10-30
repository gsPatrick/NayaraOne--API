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

const clearReviewRequester = () => { ports.reviewRequester = null; };

module.exports = {
  registerLinkProvider, linkOf, registerRunnerPorts, registerReviewRequester, clearReviewRequester,
  canSend: (...a) => required('canSend')(...a), sendMessage: (...a) => required('sendMessage')(...a), createDraft: (...a) => required('createDraft')(...a),
  requestReview: (...a) => { if (!ports.reviewRequester) throw new Error('Serviço de pedido de avaliação (M9-D424) não registrado.'); return ports.reviewRequester(...a); },
};
