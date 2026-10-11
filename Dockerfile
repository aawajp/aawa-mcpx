ARG TARGETARCH

FROM aawajp/bun:1.4.3 AS build

SHELL ["/bin/ash", "-eu", "-o", "pipefail", "-c"]

COPY --chown=1000:1000 bun.lock package.json ./

ARG TARGETARCH

RUN --mount=type=cache,id=bun-install-cache-${TARGETARCH},target="/home/app/.bun/install/cache",uid=1000,gid=1000,sharing=locked \
	--mount=type=cache,id=bun-global-cache-${TARGETARCH},target="/home/app/.bun/cache",uid=1000,gid=1000,sharing=locked \
	--mount=type=tmpfs,target=/tmp <<-EOF
		bun install \
			--no-save \
			--frozen-lockfile \
			--ignore-scripts
EOF

COPY --chown=1000:1000 src src

RUN bun run css



# Use the base image with Bun runtime
FROM aawajp/bun:1.4.3

SHELL ["/bin/ash", "-eu", "-o", "pipefail", "-c"]

# Create db directory for SQLite
RUN <<-EOF
	install -d -o 1000 -g 1000 db
EOF

COPY --chown=1000:1000 bun.lock package.json ./

ARG TARGETARCH

RUN --mount=type=cache,id=bun-install-cache-${TARGETARCH},target="/home/app/.bun/install/cache",uid=1000,gid=1000,sharing=locked \
	--mount=type=cache,id=bun-global-cache-${TARGETARCH},target="/home/app/.bun/cache",uid=1000,gid=1000,sharing=locked \
	--mount=type=tmpfs,target=/tmp <<-EOF
		echo "🔍 Running security audit..."
		bun audit --audit-level moderate || echo "⚠️  Audit warnings detected"

		echo "📦 Installing dependencies..."
		time bun install \
			--production \
			--no-save \
			--frozen-lockfile \
			--ignore-scripts

		echo "✅ Verifying installations..."
		bun pm ls --depth=0
EOF

COPY --link --chown=1000:1000 . .

COPY --link --from=build --chown=1000:1000 /home/app/.tailwind .tailwind

# Expose the default port
EXPOSE 4567

ENV PORT=4567

CMD ["src/server/index.ts"]
