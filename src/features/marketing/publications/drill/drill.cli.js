'use strict';

const path = require('node:path');
const { checkLocalDatabase } = require('../../../integrations/contingency/drill/drill.guard');
const { EXIT } = require('./drill.constants');

/**
 * M9-D442 — lógica do `npm run marketing:drill -- --canal=X` (o script em scripts/marketingDrill.js só chama `runCli`). Opções: --canal=<CANAL|todos>, --empresa=<uuid>, --registrar
 * (grava a evidência FAILURE_DRILL de cada canal), --saida=<pasta> (relatório JSON), --permitir-banco-nao-local. O ensaio desfaz tudo o que cria e só confirma a evidência quando
 * há --registrar, mas ainda assim só roda contra banco local por padrão. Saída: 0 aprovado; 1 divergência (MKT_DRILL_FAILED); 2 uso incorreto ou banco não permitido.
 */
function parseArgs(argv) {
  const opts = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) opts[m[1]] = m[2] === undefined ? true : m[2];
  }
  return opts;
}

const DEFAULT_DIR = path.join(__dirname, '..', '..', '..', '..', '..', 'docs', 'evidencias', 'marketing-drill');

async function runCli(argv, { env = process.env, out = console.log, err = console.error, impl = null } = {}) {
  const adapters = require('../adapters');
  const opts = parseArgs(argv);
  const channels = !opts.canal || opts.canal === true || String(opts.canal).toLowerCase() === 'todos' ? adapters.CHANNELS : [String(opts.canal).toUpperCase()];
  const unknown = channels.filter((c) => !adapters.CHANNELS.includes(c));
  if (unknown.length) {
    err(`Canal desconhecido: ${unknown.join(', ')}. Use um de: ${adapters.CHANNELS.join(', ')} ou todos.`);
    return EXIT.USAGE;
  }
  if (!checkLocalDatabase(env).ok && !opts['permitir-banco-nao-local']) {
    err('Recusado: o ensaio só roda contra banco local (127.0.0.1). Use: node scripts/withDisposableDb.js -- node scripts/marketingDrill.js ...');
    return EXIT.USAGE;
  }
  const drill = impl || require('./index');
  const { report, recorded } = await drill.runDrill({
    channels, companyId: typeof opts.empresa === 'string' ? opts.empresa : null, register: Boolean(opts.registrar),
    onRow: (r) => out(`${r.aprovado ? 'APROVADO ' : 'REPROVADO'} ${r.canal.padEnd(10)} ${r.cenario}`),
  });
  out(drill.toText(report));
  (recorded || []).forEach((r) => out(`Evidência FAILURE_DRILL gravada: ${r.channel} ok=${r.ok} (${r.scenarios.length} cenários do sandbox)`));
  out(`Relatório: ${drill.writeReport(report, typeof opts.saida === 'string' ? opts.saida : DEFAULT_DIR)}`);
  return report.passed ? EXIT.OK : EXIT.DIVERGENCE;
}

module.exports = { runCli, parseArgs, DEFAULT_DIR };
