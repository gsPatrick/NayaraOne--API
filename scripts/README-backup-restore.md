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
