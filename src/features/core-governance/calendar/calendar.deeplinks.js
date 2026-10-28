'use strict';

/** deep_link é rota relativa da origem (ex.: /painel/juridico/prazos/<id>): começa com "/", sem esquema, sem "//" e sem espaço. */
const DEEP_LINK = /^\/[A-Za-z0-9_./-]*$/;

function isValidDeepLink(link) {
  return typeof link === 'string' && DEEP_LINK.test(link) && !link.includes('//');
}

/** Compromisso avulso não tem tela: o link aponta para o próprio recurso da API. */
function commitmentDeepLink(commitmentId) {
  return `/calendar/commitments/${commitmentId}`;
}

module.exports = { isValidDeepLink, commitmentDeepLink };
