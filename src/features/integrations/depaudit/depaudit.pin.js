'use strict';

const { isSdkPackage, DEFAULT_SDK_DENYLIST } = require('../http/sdkPolicy');

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Versão exata para SDK de fornecedor (M9-D248 3.1 item 1): `^`, `~`, `*`, `latest`, intervalos e tags reprovam. Vale para
 * dependencies e optionalDependencies (devDependencies não chegam à produção). `denylist` é integration.sdk.denylist.
 */
function checkPinnedSdks(pkg, { denylist = DEFAULT_SDK_DENYLIST, pinExact = true } = {}) {
  if (!pinExact) return [];
  const violacoes = [];
  for (const campo of ['dependencies', 'optionalDependencies']) {
    for (const [nome, versao] of Object.entries(pkg?.[campo] || {})) {
      if (isSdkPackage(nome, denylist) && !EXACT.test(String(versao))) {
        violacoes.push({ package: nome, version: String(versao), field: campo, message: `SDK de fornecedor sem versão exata: ${nome}@${versao}.` });
      }
    }
  }
  return violacoes;
}

module.exports = { checkPinnedSdks, EXACT };
