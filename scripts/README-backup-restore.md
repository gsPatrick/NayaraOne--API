# Backup e restore

GAP real corrigido (auditoria Marco 6, 08/10/2026 — cláusula 12ª do contrato "BACKUP, RESTORE E OBSERVABILIDADE").

## Backup

```bash
node scripts/backupDatabase.js [--out <diretorio>]
```

Lê `DATABASE_URL` (ou `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`) do ambiente, gera um dump em formato custom (`pg_dump -Fc`) em `backups/<nome-do-banco>_<timestamp>.dump` (pasta ignorada pelo git).

## Restore

```bash
node scripts/restoreDatabase.js --file <caminho-do-dump> --target-db <banco-destino>
```

Exige um banco de destino explícito e **recusa rodar** se `--target-db` for igual ao banco principal configurado no ambiente (`DB_NAME`/`DATABASE_URL`) — proteção contra sobrescrever produção/dev ao testar um restore.

## Evidência real de execução (08/10/2026)

1. `pg_dump` 17.11 (Homebrew, `postgresql@17`) contra o banco de dev real — dump de 2.01 MB gerado com sucesso.
2. Banco descartável `nayaraone_restore_test` criado via `CREATE DATABASE`.
3. Restore completo via `scripts/restoreDatabase.js`.
4. Contagem de tabelas (`information_schema.tables`, excluindo catálogos): **170 no original, 170 no restaurado**.
5. Contagem de linhas em `core.groups`: **2 no original, 2 no restaurado**.
6. Banco de teste removido (`DROP DATABASE nayaraone_restore_test`) — nenhum resíduo deixado.

## Verificação profunda de dados de Obras (Marco 6) — 08/10/2026

A auditora externa da Nayara pediu que a comprovação de restore não ficasse só em "contagem de
tabelas e linhas de `core.groups`" — exigiu verificação ESPECÍFICA dos dados de Obras (Marco 6).
Foi criado `scripts/verifyRestoreConstructionData.js`, que compara entre um banco de ORIGEM e um
banco de DESTINO (já restaurado):

- Contagem de linhas em `construction.projects`, `construction.budgets`,
  `construction.budget_lines`, `construction.stage_measurements`, `construction.daily_reports`,
  `construction.nonconformities`, `construction.maintenance_cases`.
- Conteúdo campo a campo da primeira obra (`construction.projects`, por `created_at`): `name`,
  `status`, `budgetAmount`, `responsibleUserId`.
- `baselineAmount`/`status` do orçamento (`construction.budgets`) dessa obra, se existir.
- Exit code `1` se qualquer divergência for encontrada.

```bash
node scripts/verifyRestoreConstructionData.js --source-db <banco-origem> --target-db <banco-destino>
```

### Execução real (08/10/2026)

1. `node scripts/backupDatabase.js` contra o banco de dev real
   (`nayaraone--banco@2.25.115.2`) — dump de **2.08 MB** gerado com sucesso
   (`backups/nayaraone--banco_2026-10-08T20-40-10-348Z.dump`).
2. Banco descartável `nayaraone_restore_verify_obras` criado via `CREATE DATABASE`.
3. `node scripts/restoreDatabase.js --file backups/nayaraone--banco_2026-10-08T20-40-10-348Z.dump --target-db nayaraone_restore_verify_obras` — restore concluído com sucesso.
4. `node scripts/verifyRestoreConstructionData.js --source-db "nayaraone--banco" --target-db nayaraone_restore_verify_obras` — output real:

```
=== Comparando "nayaraone--banco" (origem) x "nayaraone_restore_verify_obras" (destino) ===

--- Contagem de linhas por tabela (schema construction) ---
  ✅ idêntico — construction.projects: 123 linhas
  ✅ idêntico — construction.budgets: 15 linhas
  ✅ idêntico — construction.budget_lines: 16 linhas
  ✅ idêntico — construction.stage_measurements: 77 linhas
  ✅ idêntico — construction.daily_reports: 24 linhas
  ✅ idêntico — construction.nonconformities: 8 linhas
  ✅ idêntico — construction.maintenance_cases: 43 linhas

--- Conteúdo campo a campo da primeira obra (construction.projects, por created_at) ---
  Obra de referência: id=c263f7a5-fe73-4c10-9fed-7b1aa5fc2f59
  ✅ idêntico — name: "QA Obra editada 843"
  ✅ idêntico — status: "IN_PROGRESS"
  ✅ idêntico — budgetAmount: "654321.00"
  ✅ idêntico — responsibleUserId: "null"

--- Orçamento da obra (construction.budgets) ---
  (nenhum orçamento encontrado para essa obra na origem — nada a comparar)

=== Resumo ===
11/11 checagens idênticas.
✅ RESULTADO FINAL: nenhuma divergência encontrada entre origem e destino.
```

5. Banco de teste removido (`DROP DATABASE nayaraone_restore_verify_obras`) — nenhum resíduo deixado.

### Observação importante: banco de origem é um ambiente vivo

Numa primeira rodada deste teste (dump das 20:31:32Z, verificado às ~20:39), o script acusou
divergência real nas contagens (ex. `construction.projects`: 123 na origem vs. 116 no destino).
Investigação confirmou que **não era bug de restore**: 7 novas obras foram criadas no banco de
dev (`created_at`/`updated_at` posteriores ao timestamp do dump) durante a janela entre o dump e
a comparação — o banco de dev é um ambiente vivo, com escritas contínuas. Ao gerar um dump novo e
rodar a verificação imediatamente após o restore (passos acima), o resultado foi 100% idêntico
(11/11). **Conclusão prática**: para comparar origem x destino com segurança, a verificação deve
rodar logo após o restore do MESMO dump usado, nunca comparando contra o estado atual (e
potencialmente já alterado) do banco de origem.
