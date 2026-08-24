# Onboarding — Nayara One API

## Pré-requisitos

- Node.js >= 20
- PostgreSQL 18 (ou LTS suportada) acessível localmente ou via container
- npm

## Passo a passo

1. **Instalar dependências**

   ```bash
   npm install
   ```

2. **Configurar variáveis de ambiente**

   ```bash
   cp .env.example .env
   ```

   Preencha `DATABASE_URL` (ou `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`)
   apontando para um PostgreSQL local de desenvolvimento. Nunca usar dados reais em
   ambiente de desenvolvimento (regra explícita do Caderno Técnico).

3. **Rodar as migrations**

   ```bash
   npm run migrate
   ```

   Isso cria os 11 schemas físicos e todas as tabelas modeladas, habilita
   Row-Level Security (`ENABLE` + `FORCE`) e cria a política `tenant_isolation`
   em cada tabela multiempresa.

   Para reverter a última migration: `npm run migrate:undo`.
   Para reverter todas: `npm run migrate:undo:all`.

4. **Subir o servidor em desenvolvimento**

   ```bash
   npm run dev
   ```

   Usa `node --watch` para reiniciar automaticamente a cada alteração de arquivo.
   Para produção: `npm start`.

5. **Verificar que subiu corretamente**

   ```bash
   curl http://localhost:3000/health
   ```

   Deve retornar `{"success":true,"data":{"status":"ok", ...}}`.

   Alternativamente, com o servidor já no ar:

   ```bash
   npm run smoke:test
   ```

## Logs

Nesta etapa (Fundação Executável) os logs são emitidos via `console.log`/`console.error`
para stdout/stderr, sem PII, seguindo o padrão de observabilidade estruturada que será
expandido no Marco 2 (Núcleo Técnico — Motor de Eventos e observabilidade completa).
Erros operacionais (`AppError`) são logados com `code` e mensagem; erros não tratados
são logados por completo em ambiente não produtivo e de forma resumida em produção
(`NODE_ENV=production`), para não vazar detalhes internos ao cliente HTTP.

## Autenticação e contexto de tenant (multiempresa)

A autenticação é feita via JWT (`src/features/auth/`, ver
`src/documentacao/features/Auth.md`): `POST /v1/auth/login` retorna um `accessToken` que
carrega `group_id`/`company_id`/`roles`/`permissions` como claims. Toda rota protegida usa
`src/middlewares/auth.middleware.js` (popula `req.auth`) e, quando toca tabela multiempresa,
também `src/middlewares/tenant.middleware.js` (abre transação com
`SET LOCAL app.group_id/app.company_id/app.user_id` a partir de `req.auth` — nunca de header
cru do cliente). A ausência desse contexto bloqueia a operação (fail closed), conforme
`Maturacao/01_ARQUITETURA_E_INVARIANTES.md` §2.4 e `02_BANCO_DE_DADOS_E_RLS.md` §3.3.

## Seed de desenvolvimento

```bash
npm run seed
```

Cria um group, uma company, um papel `ADMIN` com as permissões CRUD de group/company/unit/
user/membership, e um usuário admin (`admin@nayaraone.dev` / `DevAdmin#2026` — credenciais
de **desenvolvimento apenas**, nunca usar em ambientes reais). Use essas credenciais em
`POST /api/v1/auth/login` para obter um `accessToken` e testar o restante da API — ver
exemplos completos em `src/documentacao/features/Auth.md`.

## Estrutura de pastas

```
NayaraOne--API/
├── app.js                 # entrada única do processo
├── migrations/             # uma migration por tabela
└── src/
    ├── config/              # Sequelize (runtime + sequelize-cli)
    ├── models/              # um model por tabela + index.js (associações)
    ├── features/            # health, auth, groups, companies, units, users, memberships
    ├── engines/             # motores transversais: rules (Motor de Regras), events (Outbox/Inbox)
    ├── routes/               # agregador único de rotas
    ├── middlewares/          # error handler, auth (JWT), tenant (RLS)
    ├── providers/            # adapters de sistemas externos (vazio nesta etapa)
    ├── utils/                # AppError, catchAsync, resposta HTTP padronizada, jwt
    └── documentacao/          # esta documentação (+ features/*.md por módulo)
```
