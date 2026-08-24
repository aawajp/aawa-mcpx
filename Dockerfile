ARG TARGETARCH

# Use the base image with Bun runtime
FROM aawajp/bun:1.4.0

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
			--no-save \
			--frozen-lockfile \
			--backend=hardlink \
			--ignore-scripts

		echo "✅ Verifying installations..."
		bun pm ls --depth=0
EOF

COPY --chown=1000:1000 . .

# Expose the default port
EXPOSE 4567

ENV PORT=4567

CMD ["src/index.ts"]
