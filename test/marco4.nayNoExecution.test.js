'use strict';

// FIN-TS-014 (Caderno §20: "NAY paga | Tool call direta | Negada") — confirmação explícita,
// nunca tinha teste dedicado. O mesmo argumento contratual já documentado para o Marco 3 (NAY
// Comercial) vale aqui: não existe NENHUMA integração de IA/LLM no projeto (zero menção a
// OpenAI/Anthropic em toda a árvore `src/`, ver personDataQuality.service.js) — a infraestrutura
// real do NAY é entrega do Marco 9 (cláusula 4.10 do contrato). ATUALIZAÇÃO (Marco 9, DI-REG): a IA
// real passou a existir em src/features/ai; a premissa "sem IA" caiu e o item 3 abaixo trava a
// invariante verdadeira (a NAY nunca executa ação financeira sem portão humano). Antes era verdade
// por AUSÊNCIA: não há nenhum caminho de código por onde "NAY" chamaria `executePaymentIntent`,
// `settleFinancialEntry` ou qualquer outra ação que mova dinheiro — todas exigem
// authMiddleware + requirePermission + (quando move dinheiro de verdade) requireRecentMfa, que
// um agente de IA sem sessão de usuário humano nunca teria. Este teste trava essa garantia como
// regressão: se algum dia alguém adicionar um caminho de execução financeira sem passar pelas
// rotas protegidas normais (ex.: um service "nay*.service.js" chamando settle/execute direto),
// o teste falha.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('FIN-TS-014: não existe nenhum módulo de execução financeira acessível por "NAY" fora das rotas HTTP protegidas', () => {
  // O Financeiro vive em src/modules/finance (árvore do Guia do Marco 4, §2): varrido com as subpastas, menos as migrations.
  const financeDir = path.join(__dirname, '..', 'src', 'modules', 'finance');
  const listarJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return full.endsWith(path.join('db', 'migrations')) ? [] : listarJs(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
  const files = listarJs(financeDir).map((full) => path.relative(financeDir, full));

  // 1. Nenhum arquivo do módulo financeiro menciona NAY, IA ou LLM na superfície de execução.
  // Exceções controladas (NAY Financeira, Caderno §18, 19/10/2026): o próprio módulo de leitura
  // finance-nay.service.js (travado pelo item 4 abaixo) e, em finance.routes.js, só a linha da rota
  // GET de leitura — o item 4 confere que essa é a única referência e que ela é GET + finance:read.
  for (const file of files) {
    if (path.basename(file) === 'finance-nay.service.js') continue;
    let content = fs.readFileSync(path.join(financeDir, file), 'utf8');
    if (path.basename(file) === 'finance.routes.js') {
      content = content.split('\n').filter((l) => !/^financeRouter\.get\('\/finance\/nay\/insights', requirePermission\('finance:read'\), financeController\.getFinanceInsights\);$/.test(l)).join('\n');
    }
    // O nome do arquivo de leitura (finance-nay.service, kebab-case desde o M4-D140) não é caminho de execução: o item 4 o trava.
    content = content.replace(/require\((['"])[./]*(?:[\w-]+\/)*finance-nay\.service\1\)/g, 'require(LEITURA)');
    assert.ok(
      !/\bNAY\b/i.test(content.replace(/\/\/.*$/gm, '')), // ignora comentários (podem citar NAY só como documentação)
      `${file} não deveria referenciar NAY fora de comentário — nenhum agente de IA tem caminho de execução no financeiro.`
    );
  }

  // 2. As duas únicas rotas que efetivamente movimentam dinheiro (liquidar lançamento, executar
  // payment intent) exigem auth + permissão + MFA recente — nenhuma rota pública/sem MFA.
  const routesContent = fs.readFileSync(path.join(financeDir, 'presentation', 'http', 'finance.routes.js'), 'utf8');
  const settleLine = routesContent.split('\n').find((l) => l.includes('/finance/entries/:id/settle'));
  const executeLine = routesContent.split('\n').find((l) => l.includes('/finance/payment-intents/:id/execute'));
  assert.ok(settleLine && settleLine.includes('requireRecentMfa'), 'settle de lançamento deve exigir MFA recente.');
  assert.ok(executeLine && executeLine.includes('requireRecentMfa'), 'execução de payment intent deve exigir MFA recente.');

  // 3. Invariante verdadeira desde o Marco 9 (a IA real existe; o que nunca existe é execução financeira
  // sem portão humano): (a) código de provedor de IA (openai/anthropic) só vive em src/features/ai/providers,
  // nunca no módulo financeiro nem no jurídico; (b) nada em src/features/ai referencia as ações que movem
  // dinheiro (liquidar lançamento, aprovar/executar intenção de pagamento, transferência entre empresas,
  // submissão ao banco); a única ponte NAY->financeiro de escrita é createPaymentIntent (cria intenção em
  // aberto, que só se paga por aprovação + execução humana com MFA); (c) toda ferramenta financeira de
  // escrita da NAY exige aprovação humana e nenhuma ferramenta se chama pagar/liquidar/executar.
  const srcDir = path.join(__dirname, '..', 'src');
  const aiDir = path.join(srcDir, 'features', 'ai');
  const stripComments = (c) => c.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (dir, fn) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, fn);
      else if (entry.name.endsWith('.js')) fn(full, stripComments(fs.readFileSync(full, 'utf8')));
    }
  };
  const providerLeaks = [];
  // O Jurídico vive em src/modules/legal (árvore do Guia do Marco 5, §2).
  for (const dir of [path.join(srcDir, 'modules', 'finance'), path.join(srcDir, 'modules', 'legal'), path.join(srcDir, 'features', 'billing')]) {
    walk(dir, (full, content) => {
      if (/openai|anthropic|@anthropic-ai/i.test(content)) providerLeaks.push(path.relative(srcDir, full));
    });
  }
  assert.deepEqual(providerLeaks, [], 'provedor de IA não pode ser chamado de dentro de finance/legal/billing.');

  const FORBIDDEN_MONEY_MOVERS = /\b(settleFinancialEntry|executePaymentIntent|approvePaymentIntent|submitPaymentIntent|createIntercompanyTransfer|reverseFinancialEntry)\b|financialEntries\.service|intercompanyTransfers\.service|finance\/bank\//;
  const moneyMovers = [];
  walk(aiDir, (full, content) => {
    if (FORBIDDEN_MONEY_MOVERS.test(content)) moneyMovers.push(path.relative(srcDir, full));
  });
  assert.deepEqual(moneyMovers, [], 'a NAY não pode chamar nenhuma ação que mova dinheiro.');

  const financeServices = stripComments(fs.readFileSync(path.join(aiDir, 'toolServices', 'finance.services.js'), 'utf8'));
  const piCalls = [...financeServices.matchAll(/paymentIntents\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(piCalls)], ['createPaymentIntent'], 'a única escrita financeira da NAY é criar a intenção (proposta).');

  const { INITIAL_DEFINITIONS } = require('../src/features/ai/tools/definitions');
  const financeTools = INITIAL_DEFINITIONS.filter((t) => t.domain === 'FINANCIAL' || /^finance\./.test(t.name));
  assert.ok(financeTools.length >= 3, 'as ferramentas financeiras da NAY precisam existir para a invariante valer.');
  for (const tool of INITIAL_DEFINITIONS) {
    assert.ok(!/(^|\.)(pay|settle|execute|transfer|approve)/i.test(tool.name), `ferramenta "${tool.name}" não pode executar ação financeira.`);
  }
  for (const tool of financeTools.filter((t) => t.category !== 'READ')) {
    assert.equal(tool.requiresHumanApproval, true, `${tool.name}: escrita financeira da NAY exige aprovação humana.`);
    assert.equal(tool.riskLevel, 'CRITICAL', `${tool.name}: escrita financeira da NAY é risco CRITICAL.`);
  }

  // 4. NAY Financeira (finance-nay.service.js) é SOMENTE LEITURA por construção: só importa o read
  // model, CostCenter, o sequelize para
  // SELECT e o registrador de run por regra (M9-D005); a única escrita é a auditoria da execução
  // em ai.ai_runs, feita só por recordRuleRun. Nenhuma rota de NAY
  // além da GET de leitura.
  const nay = fs.readFileSync(path.join(financeDir, 'application', 'services', 'finance-nay.service.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const requires = [...nay.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  // DEC-007 (DI-DEC007-2): a fonte dos limiares do antifraude é a tela de Configurações; a NAY Financeira não lê mais o resolvedor (o Motor saiu).
  // M4LR: + ledger-sql (saldo em aberto da fila de trabalho: valor menos o realizado pelas baixas; só fragmentos de SQL de leitura).
  assert.deepEqual(requires, ['../../../../models', '../../../../features/ai/orchestrator/runs', '../../../../utils/businessDate', './finance-health.service',
    '../../infrastructure/repositories/ledger-sql'].sort());
  assert.match(nay, /const \{ sequelize, CostCenter \} = require\('\.\.\/\.\.\/\.\.\/\.\.\/models'\)/);
  assert.equal((nay.match(/\.(create|update|save|destroy|bulkCreate|upsert|increment|decrement)\(/g) || []).length, 0, 'nenhuma escrita direta em modelo');
  assert.equal((nay.match(/recordRuleRun\(/g) || []).length, 1, 'a única escrita é o run por regra');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(nay.replace(/'[^']*'/g, '')), 'SQL da NAY é só SELECT');
  assert.ok(!/(INSERT|UPDATE |DELETE|TRUNCATE)/.test((nay.match(/`[^`]*`/g) || []).join(' ')), 'SQL da NAY é só SELECT');
  const routesNay = routesContent.split('\n').filter((l) => /\/nay\//i.test(l));
  assert.deepEqual(routesNay, ["financeRouter.get('/finance/nay/insights', requirePermission('finance:read'), financeController.getFinanceInsights);"]);
});
