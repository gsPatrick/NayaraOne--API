'use strict';

// Cofre de arquivo temporário para os testes do Marketing que usam segredo por empresa (person_hash). Não é teste.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileMountedStore, setSecretStoreForTests } = require('../../../src/features/integrations/secrets');

/** Liga o cofre temporário e devolve a função que o desliga e apaga o diretório. */
function useTempSecretStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-cofre-'));
  setSecretStoreForTests(createFileMountedStore({ dir, masterKey: crypto.randomBytes(32).toString('hex') }));
  return () => { setSecretStoreForTests(null); fs.rmSync(dir, { recursive: true, force: true }); };
}

module.exports = { useTempSecretStore };
