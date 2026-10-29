'use strict';

const { resolveAntivirusAdapter } = require('../../people/adapters/resolveDocumentAdapters');

/**
 * Passo 2 (malware) da ingestão: reutiliza o MESMO antivírus plugável do gate de upload do módulo de arquivos. Arquivo marcado como
 * não limpo no registro, ou que o antivírus não consegue verificar (adapter indisponível), é tratado como NÃO verificado: a ingestão
 * é rejeitada (falha fechada). O conteúdo é conferido de novo na ingestão porque a base de assinaturas muda depois do upload.
 */
async function isClean(tenant, buffer, transaction) {
  try {
    const antivirus = await resolveAntivirusAdapter(tenant, transaction);
    const result = await antivirus.scan(buffer);
    return Boolean(result && result.clean === true);
  } catch (err) {
    return false;
  }
}

/** O registro do arquivo diz que foi verificado e está limpo? (URL e conhecimento não têm esse registro.) */
const registryClean = (file) => !file || file.scanStatus === 'CLEAN';

module.exports = { isClean, registryClean };
