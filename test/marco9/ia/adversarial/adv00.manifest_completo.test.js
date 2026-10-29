'use strict';

// Suíte adversarial da NAY (M9-D042): o manifesto lista os 15 nomes do livro, cada um existe em seu arquivo e nenhum está pulado; o
// relatório precisa listar os 15 aprovados. Sem banco.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateManifest, validateReport } = require('../../../../scripts/ai-adversarial/gate');
const manifest = require('./adversarial.manifest.json');

const lerArquivo = (f) => (fs.existsSync(path.join(__dirname, f)) ? fs.readFileSync(path.join(__dirname, f), 'utf8') : null);
const NOMES_DO_LIVRO = [
  'adv_documento_manda_ignorar_regras_ignorado', 'adv_usuario_pede_dado_de_outra_empresa_bloqueado', 'adv_nay_tenta_tool_sem_permissao_bloqueada',
  'adv_tool_argumento_fora_do_schema_rejeitado', 'adv_fonte_revogada_nao_usada_como_vigente', 'adv_rag_sem_fonte_suficiente_resposta_de_insuficiencia',
  'adv_modelo_cai_fallback_seguro_ou_falha_fechada', 'adv_budget_estoura_politica_de_degradacao', 'adv_prompt_tenta_obter_secret_bloqueado',
  'adv_nay_tenta_pagar_ou_alterar_banco_vira_proposta_ou_nega', 'adv_memoria_invalidada_nao_reaparece', 'adv_resposta_financeira_bate_com_read_model',
  'adv_troca_de_provider_golden_continua_verde', 'adv_pii_no_log_redaction', 'adv_tool_replay_idempotencia',
];
const relatorioOk = () => ({ testes: manifest.testes.map((t) => ({ nome: t.nome, passou: true, pulado: false })) });

test('adv_manifest_completo', () => {
  assert.deepEqual(manifest.testes.map((t) => t.nome), NOMES_DO_LIVRO, 'os 15 nomes do livro, na ordem do livro');
  assert.deepEqual(validateManifest(manifest, lerArquivo), [], 'cada nome existe em seu arquivo, sem skip, todo nem only');
  assert.deepEqual(validateReport(relatorioOk(), manifest), []);
  // Manifesto com 14 nomes: falha.
  const catorze = { ...manifest, testes: manifest.testes.slice(1) };
  assert.match(validateManifest(catorze, lerArquivo).join(), /14 testes/);
  // Arquivo sem o teste, ou com o teste pulado, também reprova.
  const semTeste = (f) => (f === manifest.testes[0].arquivo ? "'use strict';\n" : lerArquivo(f));
  assert.match(validateManifest(manifest, semTeste).join(), /teste ausente/);
  for (const marca of ["test.skip('x', () => {});", "test('x', { skip: true }, () => {});", "test.todo('x');", "test.only('x', () => {});"]) {
    const pulado = (f) => (f === manifest.testes[1].arquivo ? `${lerArquivo(f)}\n${marca}\n` : lerArquivo(f));
    assert.match(validateManifest(manifest, pulado).join(), /skip, todo ou only/, marca);
  }
  // O relatório precisa listar os 15 aprovados e não pulados.
  const faltando = { testes: relatorioOk().testes.slice(1) };
  assert.match(validateReport(faltando, manifest).join(), /não lista o teste/);
  const reprovado = relatorioOk();
  reprovado.testes[2].passou = false;
  assert.match(validateReport(reprovado, manifest).join(), /reprovado/);
  const pulado = relatorioOk();
  pulado.testes[3].pulado = true;
  assert.match(validateReport(pulado, manifest).join(), /pulado/);
});
