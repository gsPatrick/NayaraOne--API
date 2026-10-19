# Runbook de backup e restore — Nayara One (API)

Frente 7 (Marcos 4/5). Passo a passo usando os scripts que existem no repositório, testado
ponta a ponta pelo drill `npm run restore-drill:legal-full` em 19/10/2026 (saída abaixo).
Nenhum segredo, host ou connection string aparece neste documento.

## 1. Quem executa

| Papel | Responsabilidade |
|---|---|
| Responsável técnico (hoje: Patrick, dono da infraestrutura e das credenciais) | Executa backup/restore em ambiente real; guarda as chaves; decide o ponto de restauração |
| Segunda pessoa (aprovador do negócio / Nayara) | Autoriza restore em produção e confere a validação funcional (passo 5) |
| Drill automatizado | Qualquer dev, só em clusters locais descartáveis (`scripts/restoreDrill/drillGuard.js` recusa outro banco) |

Restore sobre o banco principal é bloqueado pelo próprio script (`--target-db` igual ao banco do
ambiente → recusado). Restaurar sempre num banco novo e depois trocar a aplicação para ele.

## 2. Pré-requisitos

- Binários `pg_dump`/`pg_restore` da **mesma major** do servidor (homologação: PostgreSQL 17).
- Credencial de DDL (`DB_MIGRATION_USER`/`DB_MIGRATION_PASSWORD` em `.env.migration.local`) —
  o backup e o restore usam essa credencial; a de runtime não cria schemas.
- **`FILES_ENCRYPTION_KEY` de produção** guardada fora do servidor (cofre). Sem ela os arquivos
  restaurados (AES-256-GCM) são ilegíveis. Idem `MFA_ENCRYPTION_KEY` (segredos TOTP) e
  `PII_HASH_SECRET` (buscas por documento). Perder essas chaves = perda de dado, mesmo com backup.

## 3. Backup

```bash
npm run backup                                   # pg_dump -Fc → backups/<banco>_<timestamp>.dump
node scripts/backupStorage.js --out <dir>        # cópia do storage + manifesto SHA-256 por arquivo
```

Guardar o `.dump` e o diretório do storage juntos (mesmo timestamp), fora do servidor do banco.

## 4. Restore

1. Criar no destino as roles que o dump referencia, **antes** do restore:
   `nayara_runtime` (LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB) e
   `nayara_migration` (dona dos objetos). Sem elas o restore **falha** e diz qual role falta
   (comportamento provado no passo 4a do drill — antes da correção ele "concluía" sem GRANTs).
2. Criar banco de destino vazio (nome novo).
3. `npm run restore -- --file <dump> --target-db <banco-novo>`
4. `node scripts/restoreStorage.js` para um diretório novo — confere cada arquivo contra o
   manifesto SHA-256; divergência aborta.
5. Configurar a aplicação com as **mesmas** chaves de produção (passo 2) e apontar
   `DATABASE_URL`/`UPLOADS_DIR` para os restaurados.

## 5. Como validar

- Role: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='nayara_runtime'` → `false/false`.
- Segurança: `node scripts/generateSecurityMap.js --out <tmp>` contra o banco restaurado e
  comparar com `docs/evidencias/MAPA_SEGURANCA.md` (mesmas tabelas com RLS FORCE e políticas).
- Dados: `npm run verify-restore:finance-legal` e `npm run verify-restore:construction`
  (origem × destino, campo a campo, com `SET LOCAL` de tenant).
- Funcional (segunda pessoa): login, abrir um contrato assinado e baixar o PDF, abrir extrato
  financeiro de um tenant; tentar acessar dado de outro tenant → negado.

## 6. RPO / RTO

| Métrica | Medido | Observação |
|---|---|---|
| RTO — drill jurídico completo (19/10/2026) | **14,5 s** de ponta a ponta (2 clusters, 289 migrations, backup, restore com falha esperada + restore correto, 133 checagens, teardown) | Dump de 0,95 MB — dado de fixture, não volume real |
| RTO — banco de dev real (09/10/2026, `scripts/README-backup-restore.md`) | **470 s** (backup 33 s + restore 437 s), dump ~2 MB | Referência mais realista de volume; meta do caderno ≤ 4 h |
| RPO | **Não garantido** | Backup é manual (`npm run backup`); não há job agendado nem WAL/PITR configurado no repositório. O RPO real é o tempo desde o último backup manual. Meta do caderno (Financeiro ≤ 1 min) **não é atendida** sem backup contínuo do provedor (PITR) — decisão de infraestrutura pendente. |

## 7. Saída real do drill (19/10/2026)

Comando: `node scripts/restoreDrill/legalFullDrill.js --port 5462 --report-dir <scratch>`
(clusters locais descartáveis, chaves temporárias geradas pelo drill; banco de homologação não
tocado). Commit `1d51126` com árvore suja (alterações de outras frentes em paralelo).
Exit code 0. Trechos:

```
### 1. Cluster de ORIGEM descartável (porta 5462)
  role nayara_runtime NOSUPERUSER/NOBYPASSRLS; 289 migrations; seeds base; GRANT em 14 schemas.
### 3. Backup com os scripts reais do projeto (npm run backup + scripts/backupStorage.js)
  Backup gerado com sucesso: .../backup/drill_source_2026-10-19T11-44-35-210Z.dump (0.95 MB)
### 4. Cluster de DESTINO NOVO (porta 5463, outro initdb — a role de runtime não existe)
  role nayara_runtime no cluster novo antes do restore: ausente
  4a. npm run restore SEM a role de runtime no destino:
      → falhou apontando as roles ausentes ✅ (nayara_runtime)
  4b. Procedimento do runbook: cria as roles que o dump referencia (nayara_runtime e nayara_migration), recria o banco vazio, refaz o restore:
      → role nayara_runtime no destino: superuser/bypassrls = false/false
### 5. Verificação pós-restore
  ✅ drill-contrato-assinado.pdf: blob cifrado restaurado idêntico ao de origem (4214 bytes)
  ✅ bytes do documento assinado restaurado (4179 bytes) = SHA-256 independente
  ✅ controle positivo: tenant A COM legal:read → HTTP 200, export íntegro contra o hash pré-backup
  ✅ um byte alterado no blob restaurado é detectado no arquivo (autenticação AES-GCM / checksum)
  ✅ a API recusa servir o arquivo adulterado → HTTP 409
  ... (24 objetos comparados campo a campo: legal.*, people.*, finance.*, audit.audit_log, bytes)
133/133 checagens aprovadas.
✅ RESULTADO FINAL: restore jurídico íntegro (dados, bytes, documento assinado, relações, auditoria, exportação, permissões, replay e adulteração, inclusive recusa pela API).
### 6. Teardown
  clusters parados e diretório temporário apagado — nenhum resíduo.
real 14,45
```

## 8. Limites conhecidos

- Drill usa volume pequeno; RTO de produção deve ser remedido com dump do tamanho real.
- Sem backup agendado/PITR (RPO acima).
- `audit.audit_log`: a role de runtime tem UPDATE/DELETE e não há trigger de imutabilidade
  (ver MAPA_SEGURANCA.md §8) — a trilha não é append-only no banco.
