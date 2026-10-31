'use strict';

// M9-D904 (reabertura R3-L2 da rodada 3): só a flag de canary (migracao.setor.<setor>.novo_sistema) é chave protegida. O parâmetro migracao.setor.<setor>.entidades e qualquer outra
// chave do mesmo prefixo não recebem a recusa nem a mensagem do canary. Não precisa de banco: a regra é a função de teste do registro de chaves protegidas.

const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../../../src/features/migration-v2/canary/canary.flag');
const { assertWritable } = require('../../../src/features/core-governance/feature-flags/flags.protected');
const { FLAG_OWNER, flagKey, SECTOR_CODES } = require('../../../src/features/migration-v2/canary/canary.constants');

const codeOf = (key, owner) => { try { assertWritable(key, owner); return null; } catch (err) { return err.code; } };

test('m9d904 R3-L2: a flag de canary de todo setor continua protegida, com a mensagem do canary', () => {
  for (const sector of SECTOR_CODES) {
    assert.equal(codeOf(flagKey(sector)), 'GOV_FLAG_KEY_PROTECTED', sector);
    assert.equal(codeOf(flagKey(sector), FLAG_OWNER), null, 'o dono escreve');
  }
  assert.throws(() => assertWritable(flagKey('ATENDIMENTO')), (err) => /canary/i.test(err.message));
});

test('m9d904 R3-L2: as demais chaves do prefixo migracao.setor. não são protegidas', () => {
  for (const key of ['migracao.setor.atendimento.entidades', 'migracao.setor.atendimento.outra', 'migracao.setor.atendimento.novo_sistema_extra', 'migracao.setor.novo_sistema', 'migracao.setor.a.b.novo_sistema', 'migracao.setor.atendimento.entidades.novo_sistema']) {
    assert.equal(codeOf(key), null, key);
  }
});
