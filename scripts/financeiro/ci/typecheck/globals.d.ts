// Marco 4, Guia §17 estágio 2 (typecheck): `tsc --checkJs` em todo src/modules/finance (domínio, serviços, repositórios, banco, HTTP, workers e migrations).
// Com `noResolve` o tsc confere os arquivos do módulo e o que eles importam entre si; o que vem de fora do módulo (models, engines, features, pacotes do
// node_modules) entra como `any`. Estas declarações bastam para o CommonJS do módulo (o repositório é JavaScript, sem @types/node).
declare const require: ((id: string) => any) & { resolve: (id: string) => string };
declare const module: { exports: any };
declare const process: { env: Record<string, string | undefined> };
declare const Buffer: any;
declare const __dirname: string;
declare module 'sequelize';
declare module 'crypto';
declare module 'node:crypto';
