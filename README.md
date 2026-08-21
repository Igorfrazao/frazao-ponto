# Frazão Iluminação & Elétrica — Controle de Ponto

Sistema de ponto mobile-first com cadastro de funcionários (com PIN de 4 dígitos),
cadastro de obras, registro de ponto com GPS, troca de obra no mesmo dia, cálculo
automático de horas, painel administrativo protegido por senha e exportação
CSV/Excel.

Os dados ficam salvos no **Supabase** (banco Postgres gratuito), então funcionam
em qualquer celular, de qualquer lugar, e não se perdem ao atualizar a página.

## Rodando localmente

```bash
npm install
cp .env.example .env       # depois preencha com as chaves do seu projeto Supabase
npm run dev
```

## Configurando o banco (Supabase)

1. Crie uma conta gratuita em https://supabase.com e um novo projeto.
2. Abra **SQL Editor** → **New query**, cole o conteúdo de `supabase.sql` e clique em **Run**.
3. Em **Project Settings → API**, copie a **Project URL** e a **anon public key**.
4. Cole esses valores no `.env` (local) e nas variáveis de ambiente do Netlify (produção).

## Senha do administrador e PIN dos funcionários

- Senha padrão do painel administrativo: `frazao2026` — troque assim que possível em
  **Painel Administrativo → Configurações**.
- Cada funcionário pode ter um PIN de 4 dígitos, definido em
  **Painel Administrativo → Funcionários**. O PIN serve para confirmar que é a
  pessoa certa batendo o ponto — não é um mecanismo de segurança forte (fica salvo
  sem criptografia), mas evita erro de toque acidental ou pessoa errada.
- Nesta v1 não há login individual real (conforme solicitado). Isso pode ser
  adicionado no futuro sem precisar refazer o sistema.

## Publicando no Netlify

Veja o passo a passo completo na conversa com o Claude, ou resumidamente:
build command `npm run build`, publish directory `dist`, e configure as variáveis
`VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` no painel do Netlify.
