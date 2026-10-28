'use strict';
// FIXTURE de violação plantada (nunca é carregada pela aplicação): cada linha viola uma regra do archGuard.
const { sequelize } = require('../../../../../src/models');
const { exec } = require('child_process');
const vm = require('node:vm');
const fs = require('fs');
const OpenAI = require('openai');
const vault = require('../../secrets/secretStore');
const banco = require('../../../finance/bankPaymentAdapter');
const conexao = 'postgres://dono:senha@host/db';
async function f(x) {
  await sequelize.query("SELECT * FROM finance.ledger");
  eval(x);
  fs.writeFileSync('/tmp/x', x);
  return new Function(x)();
}
module.exports = { f, exec, vm, OpenAI, vault, banco, conexao };
