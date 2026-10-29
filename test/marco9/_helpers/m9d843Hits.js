'use strict';

// Processo-filho dos testes M9-D843 (não é teste): conta N acessos na mesma chave do contador compartilhado e imprime o maior valor visto. Uso: node m9d843Hits.js <chave> <n>
const counter = require('../../../src/features/core-governance/api-governance/standards/rateLimit.counter');

(async () => {
  const [key, n] = [process.argv[2], Number(process.argv[3])];
  let last = 0;
  for (let i = 0; i < n; i += 1) last = (await counter.hit(key)).count;
  console.log(JSON.stringify({ last }));
  await require('../../../src/models').sequelize.close();
})().catch((err) => { console.error(err.message); process.exit(1); });
