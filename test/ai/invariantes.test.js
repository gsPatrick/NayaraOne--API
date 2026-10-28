'use strict';

// M9-D001: os 15 princípios constitucionais da NAY (AI-001 a AI-015) como invariantes executáveis.
// Cada teste nomeia o princípio e confere o mecanismo que o garante. Quando o mecanismo pertence a
// outra demanda do Marco 9 e ainda não existe, o teste FALHA dizendo qual (nunca passa vazio).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const guard = require('../../scripts/lib/aiArchGuard');

const API = path.join(__dirname, '..', '..');
const AI = path.join(API, 'src', 'modules', 'ai');

function arquivo(rel, demanda) {
  const p = path.join(AI, rel);
  assert.ok(fs.existsSync(p), `mecanismo ausente: src/modules/ai/${rel} (${demanda}).`);
  return fs.readFileSync(p, 'utf8');
}
function migracoes(re) {
  const dir = path.join(API, 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, txt: fs.readFileSync(path.join(dir, f), 'utf8') })).filter((m) => re.test(m.txt));
}

test('inv_ai_001_modelo_nao_e_fonte_de_verdade', () => {
  const orq = arquivo('orchestrator/AiOrchestrator.js', 'M9-D020');
  arquivo('orchestrator/groundingValidator.js', 'M9-D025');
  arquivo('tools/proposals.js', 'M9-D019');
  // a saída do modelo nunca chega a um model de domínio: o orquestrador não importa models de domínio
  const dominio = /require\(\s*['"][^'"]*(?:features\/(?:finance|legal|people|properties|crm|construction|inventory|procurement|correspondent)|models\/(?!Ai))[^'"]*['"]\s*\)/;
  assert.ok(!dominio.test(orq), 'AiOrchestrator não pode gravar em domínio: só por application service via proposals.js');
});

test('inv_ai_002_provider_so_atras_do_adapter', () => {
  arquivo('providers/AIProviderAdapter.js', 'M9-D010');
  const v = guard.varrerSdkFornecedorNoRestoDoCodigo();
  assert.equal(v.length, 0, `SDK de fornecedor fora de providers/:\n${guard.formatar(v)}`);
  const dentro = guard.varrer().filter((x) => x.regra === 'sdk-fornecedor' || x.regra === 'host-fornecedor');
  assert.equal(dentro.length, 0, guard.formatar(dentro));
});

test('inv_ai_003_agente_exige_purpose_tools_scopes_limites', () => {
  const m = migracoes(/ai['"`]?\s*,\s*['"`]agents['"`]|ai\.agents/);
  assert.ok(m.length > 0, 'migration de ai.agents ausente (M9-D004).');
  const txt = m.map((x) => x.txt).join('\n');
  for (const col of ['purpose', 'tools', 'permissions', 'data_scopes', 'limits']) assert.ok(txt.includes(col), `ai.agents sem a coluna ${col}`);
  assert.match(txt, /CHECK/i, 'ai.agents sem CHECK que recuse agente incompleto');
  arquivo('agents/agentRegistry.service.js', 'M9-D004');
});

test('inv_ai_004_sem_superusuario_e_sem_sql_livre', () => {
  arquivo('orchestrator/executionContext.js', 'M9-D017');
  const v = guard.varrer().filter((x) => ['sql-livre', 'superusuario', 'shell', 'vm', 'eval'].includes(x.regra));
  assert.equal(v.length, 0, guard.formatar(v));
  const ctx = arquivo('orchestrator/executionContext.js', 'M9-D017');
  assert.match(ctx, /req\.auth|auth\./, 'o contexto da tool deve nascer do req.auth (usuário) ou de service identity');
});

test('inv_ai_005_injection_nao_altera_politica', () => {
  const pb = arquivo('orchestrator/promptBuilder.js', 'M9-D021');
  const reg = arquivo('tools/ToolRegistry.js', 'M9-D016');
  // allowlist e política vêm do servidor: o registro não lê nada do texto do modelo/documento
  assert.ok(!/(?:allowlist|policy|permissions?)\s*=\s*(?:modelOutput|completion|response\.text|documentText)/i.test(pb + reg));
  assert.match(pb, /untrusted/, 'prompt deve isolar conteúdo não confiável (M9-D021)');
});

test('inv_ai_006_dado_recuperado_e_nao_confiavel', () => {
  const pb = arquivo('orchestrator/promptBuilder.js', 'M9-D021');
  arquivo('retrieval/RetrievalService.js', 'M9-D023');
  assert.match(pb, /<untrusted|untrusted>|\[untrusted|BEGIN_UNTRUSTED/i, 'trecho recuperado deve entrar em bloco delimitado untrusted');
});

test('inv_ai_007_acao_critica_exige_workflow', () => {
  const prop = arquivo('tools/proposals.js', 'M9-D019');
  const reg = arquivo('tools/ToolRegistry.js', 'M9-D016');
  for (const cat of ['financeira', 'juridica', 'bancaria', 'permissao', 'publicacao']) {
    assert.ok(new RegExp(cat, 'i').test(prop + reg), `categoria crítica sem tratamento: ${cat} (M9-D019/M9-D016)`);
  }
  assert.match(prop + reg, /HIGH/);
  assert.match(prop + reg, /CRITICAL/);
});

test('inv_ai_008_resposta_factual_cita_fontes', () => {
  const g = arquivo('orchestrator/groundingValidator.js', 'M9-D025');
  assert.match(g, /AI_UNGROUNDED_FACT/, 'validador deve recusar resposta factual sem fonte com AI_UNGROUNDED_FACT');
});

test('inv_ai_009_sem_fonte_responde_insuficiencia', () => {
  const g = arquivo('orchestrator/groundingValidator.js', 'M9-D025');
  assert.match(g, /insufici/i, 'validador deve devolver a mensagem padrão de insuficiência');
});

test('inv_ai_010_memoria_estruturada_com_retencao', () => {
  const m = migracoes(/ai['"`]?\s*,\s*['"`]memories['"`]|ai\.memories/);
  assert.ok(m.length > 0, 'migration de ai.memories ausente (M9-D009).');
  const txt = m.map((x) => x.txt).join('\n');
  assert.ok(txt.includes('expires_at'), 'ai.memories sem expires_at');
  assert.ok(!/\b(?:conversation|transcript|chat_text|raw_text|full_text|messages)\b/i.test(txt), 'ai.memories não pode ter coluna de texto livre de conversa');
  arquivo('memory/memory.service.js', 'M9-D009');
});

test('inv_ai_011_pii_minimizada_restricted_so_se_permitido', () => {
  const r = arquivo('security/piiRedactor.js', 'M9-D027');
  arquivo('security/patterns.json', 'M9-D027');
  assert.match(r, /RESTRICTED/, 'redactor deve tratar classificação RESTRICTED');
});

test('inv_ai_012_auditoria_sem_secrets', () => {
  const rec = arquivo('orchestrator/runRecorder.js', 'M9-D028');
  assert.match(rec, /sanitiz|redact|secret/i, 'o registro de auditoria deve gravar versão sanitizada, sem secrets');
  arquivo('tools/toolCallRecorder.js', 'M9-D006');
});

test('inv_ai_013_custo_tem_orcamento_alerta_e_fallback', () => {
  const b = arquivo('budgets/budget.service.js', 'M9-D014');
  for (const pct of ['50', '75', '90', '100']) assert.ok(b.includes(pct), `limiar ${pct}% ausente no orçamento`);
  assert.match(b, /AI_BUDGET|fail.?closed|falha/i, 'sem orçamento resolvível o run deve falhar fechado');
});

test('inv_ai_014_regra_antes_de_modelo_caro', () => {
  const r = arquivo('providers/ModelRouter.js', 'M9-D012');
  assert.match(r, /small|pequeno/i);
  assert.match(r, /advanced|avan[cç]ado/i);
  assert.match(r, /rule|regra|code|c[oó]digo/i);
});

test('inv_ai_015_avaliacao_nao_homologa_sozinha', () => {
  const m = migracoes(/ai['"`]?\s*,\s*['"`]evaluations?['"`]|ai\.evaluation|homolog/i).filter((x) => /ai[._]/.test(x.txt));
  assert.ok(m.length > 0, 'estrutura de avaliação/homologação ausente (M9-D032).');
  assert.match(m.map((x) => x.txt).join('\n'), /approved_by|homologated_by|human/i, 'promoção exige registro de homologação humana');
});
