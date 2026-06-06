FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

FROM base AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ pkg-config \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV CODEX_HUB_HOST=0.0.0.0
ENV CODEX_HUB_PORT=8788
ENV CODEX_HUB_DATA_DIR=/data
ENV CODEX_HUB_PLUGIN_DIR=/plugins
ENV CODEX_HUB_LOCAL_MACHINE=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bin ./bin
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-node ./dist-node
COPY --from=build /app/node_modules ./node_modules

RUN mkdir -p /data /plugins

VOLUME ["/data", "/plugins"]
EXPOSE 8788

CMD ["node", "bin/codexhub", "server", "--host", "0.0.0.0"]
