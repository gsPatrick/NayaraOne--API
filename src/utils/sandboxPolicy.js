'use strict';

/**
 * Política única de uso dos providers/emissores "sandbox" (simulação determinística).
 *
 * O sandbox só é recusado em PRODUÇÃO REAL, onde ele viraria um banco ou uma nota fiscal falsos
 * gravados como oficiais. Em desenvolvimento, CI e homologação (inclusive quando a imagem roda com
 * NODE_ENV=production) ele fica disponível, porque é o que a equipe da cliente testa.
 *
 * Produção real é identificada por DEPLOY_ENVIRONMENT=production. Se esse ambiente precisar do
 * sandbox por alguma razão operacional, a variável ALLOW_SANDBOX_PROVIDERS=true libera de forma
 * explícita e consciente.
 */
function isSandboxBlocked(env = process.env) {
  if (env.DEPLOY_ENVIRONMENT !== 'production') return false;
  return env.ALLOW_SANDBOX_PROVIDERS !== 'true';
}

module.exports = { isSandboxBlocked };
