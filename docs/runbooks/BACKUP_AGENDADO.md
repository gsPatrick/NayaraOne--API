# Backup agendado e PITR — Nayara One (API)

Fecha a pendência do `docs/evidencias/RUNBOOK_RESTORE.md` §6 ("RPO não garantido — backup
manual"). Duas camadas:

| Camada | O que dá | RPO | Onde está |
|---|---|---|---|
| A. Dump lógico cifrado agendado (`scripts/scheduledBackup.js`) | cópia completa, portátil, verificada a cada execução | intervalo do agendamento (ex.: 1 h) | **no repositório**, pronto |
| B. WAL archiving + base backup (PITR) | restaurar para qualquer instante | segundos/≤ 1 min (meta do caderno p/ Financeiro) | **servidor** — só o Patrick pode ligar (seção 4) |

Sem a camada B a meta "Financeiro ≤ 1 min" **continua não atendida**; a camada A reduz o RPO de
"desde o último backup manual" para o intervalo do agendamento.

## 1. O que o script faz (testado em 19/10/2026, cluster descartável)

1. `pg_dump -Fc` pelo script real (`scripts/backupDatabase.js`, credencial de DDL só no dump),
   num diretório temporário privado.
2. `pg_restore --list` no dump em claro (lê o catálogo inteiro — 2200 objetos no teste).
3. Cifra AES-256-GCM com `BACKUP_ENCRYPTION_KEY` → `<banco>_<data>.dump.enc` + `.sha256`
   (permissão 0600); apaga o dump em claro.
4. Decifra para um temporário, confere tag GCM + SHA-256 contra o original e roda `pg_restore
   --list` de novo.
5. Cópia externa opcional (`BACKUP_OFFSITE_CMD`, `{file}` = caminho do cifrado).
6. Retenção: apaga `.dump.enc` com mais de `BACKUP_RETENTION_DAYS` (padrão 14), mantendo no
   mínimo `BACKUP_MIN_KEEP` (padrão 3).
7. Grava `last-backup.json` (data, arquivo, bytes, sha256, duração). Qualquer falha → exit 1.

Provas da execução (`docs/evidencias/marco7/backup-agendado-execucao-2026-10-19.log`):
backup + verificação em 0,3 s; decifragem confere; arquivo com 1 byte alterado → decifragem
recusada (exit 1); sem chave → recusa (exit 1); retenção removeu o arquivo antigo.

Restore a partir do cifrado:

```bash
BACKUP_ENCRYPTION_KEY=<chave> node scripts/decryptBackup.js --in <arquivo.dump.enc> --out /tmp/restore.dump
npm run restore -- --file /tmp/restore.dump --target-db <banco-novo>   # passos do RUNBOOK_RESTORE.md §4
```

## 2. Variáveis (arquivo `/etc/nayara/backup.env`, dono root, modo 0600)

```
DATABASE_URL=<url da role de runtime>          # host/porta/banco
DB_MIGRATION_USER=<usuário de DDL>             # pg_dump precisa de BYPASSRLS
DB_MIGRATION_PASSWORD=<senha de DDL>
BACKUP_DIR=/var/backups/nayara
BACKUP_ENCRYPTION_KEY=<openssl rand -hex 32>   # cópia OBRIGATÓRIA no cofre, fora do servidor
BACKUP_RETENTION_DAYS=14
BACKUP_MIN_KEEP=3
BACKUP_OFFSITE_CMD=rclone copy {file} nayara-offsite:nayara-backups/db
```

Perder a `BACKUP_ENCRYPTION_KEY` = perder todos os backups cifrados com ela.

## 3. Agendamento

### systemd (recomendado)

`/etc/systemd/system/nayara-backup.service`:

```ini
[Unit]
Description=Nayara One - backup cifrado do banco
After=network-online.target

[Service]
Type=oneshot
User=nayara
WorkingDirectory=/opt/nayara/NayaraOne--API
EnvironmentFile=/etc/nayara/backup.env
ExecStart=/usr/bin/node scripts/scheduledBackup.js
```

`/etc/systemd/system/nayara-backup.timer`:

```ini
[Unit]
Description=Nayara One - backup de hora em hora

[Timer]
OnCalendar=hourly
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nayara-backup.timer
systemctl list-timers nayara-backup.timer      # próxima execução
journalctl -u nayara-backup.service -n 50      # saída da última
```

### cron (alternativa)

```cron
# /etc/cron.d/nayara-backup
15 * * * * nayara cd /opt/nayara/NayaraOne--API && set -a && . /etc/nayara/backup.env && set +a && /usr/bin/node scripts/scheduledBackup.js >> /var/log/nayara-backup.log 2>&1
```

Monitoramento mínimo: alertar se `last-backup.json` tiver `date` mais velho que 2× o intervalo.

## 4. O que SÓ o Patrick pode ligar no servidor (PITR / WAL archiving)

Nada abaixo pode ser feito pelo repositório: exige acesso de administrador ao servidor/provedor
do PostgreSQL 17 de homologação/produção.

**Se o banco for gerenciado (painel do provedor):** ligar "Point-in-time recovery"/"backups
contínuos" com retenção ≥ 7 dias e anotar no RUNBOOK_RESTORE.md o RPO que o provedor garante.
Nesse caso os passos abaixo não se aplicam.

**Se o PostgreSQL for próprio (VM):**

1. Criar o destino do arquivo de WAL, fora do disco do banco:
   `sudo mkdir -p /var/lib/pgwal-archive && sudo chown postgres:postgres /var/lib/pgwal-archive && sudo chmod 700 /var/lib/pgwal-archive`
   (ideal: volume/bucket separado, ex. `pgbackrest` ou `wal-g` para S3.)
2. Em `postgresql.conf`:
   ```
   wal_level = replica
   archive_mode = on
   archive_command = 'test ! -f /var/lib/pgwal-archive/%f && cp %p /var/lib/pgwal-archive/%f'
   archive_timeout = 60          # fecha segmento a cada 60 s → RPO ≤ ~1 min
   ```
3. Reiniciar (`archive_mode` exige restart): `sudo systemctl restart postgresql@17-main`
4. Conferir: `SELECT archived_count, failed_count, last_archived_time FROM pg_stat_archiver;`
   (`failed_count` deve ficar em 0 e `last_archived_time` andar a cada minuto.)
5. Base backup inicial e semanal (cron do usuário postgres):
   `pg_basebackup -D /var/lib/pgbase/$(date +%F) -Ft -z -X none -c fast`
6. Retenção do WAL: apagar segmentos anteriores ao base backup mais antigo mantido
   (`pg_archivecleanup /var/lib/pgwal-archive <segmento do .backup mais antigo>`).
7. Ensaiar uma vez num servidor descartável: restaurar o base backup, criar `recovery.signal`,
   `restore_command = 'cp /var/lib/pgwal-archive/%f %p'` e
   `recovery_target_time = '<instante>'`; subir e conferir com
   `npm run verify-restore:inventory-procurement` / `verify-restore:finance-legal`.
8. Registrar o RPO medido no RUNBOOK_RESTORE.md §6.

Também só no servidor: instalar o timer da seção 3, criar `/etc/nayara/backup.env`, gerar a
`BACKUP_ENCRYPTION_KEY` e guardá-la no cofre, e configurar o remoto do `rclone`.
