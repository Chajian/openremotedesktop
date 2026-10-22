FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.12.3 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/install-windows.ps1 scripts/install-macos.sh ./scripts/

RUN pnpm --filter @open-desktop-remote/server... install --prod --frozen-lockfile

EXPOSE 3000
VOLUME ["/data"]

CMD ["pnpm", "--filter", "@open-desktop-remote/server", "start"]
