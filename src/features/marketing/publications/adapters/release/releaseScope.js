'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * M9-D430 — escopo "estou dentro do serviço de liberação". Só releaseChannel/revokeChannelRelease abrem; a trava do parâmetro
 * `marketing.channel.<canal>.liberado` só deixa gravar dentro dele (nenhum outro caminho, nem a tela de Parâmetros, escreve a liberação).
 */
const store = new AsyncLocalStorage();

const runAsReleaseService = (fn) => store.run(true, fn);
const insideReleaseService = () => store.getStore() === true;

module.exports = { runAsReleaseService, insideReleaseService };
