FROM alpine:3.21 AS su-exec
RUN apk add --no-cache gcc musl-dev \
    && wget -qO /tmp/su-exec.c https://raw.githubusercontent.com/ncopa/su-exec/v0.2/su-exec.c \
    && cc -static -Os -o /su-exec /tmp/su-exec.c

FROM nixos/nix:2.31.2

RUN printf '%s\n' \
    'experimental-features = nix-command flakes' \
    'filter-syscalls = false' \
    'accept-flake-config = true' \
    >> /etc/nix/nix.conf \
    && mkdir -p /bin /usr/bin /run/postgresql \
    && ln -sf "$(command -v bash)" /bin/sh \
    && ln -sf "$(command -v bash)" /bin/bash \
    && ln -sf "$(command -v env)" /usr/bin/env \
    && chmod 1777 /run/postgresql

ARG UID=1000
ARG GID=1000
ENV AQUA_UID=${UID}
ENV AQUA_GID=${GID}
COPY --from=su-exec /su-exec /usr/local/bin/su-exec
RUN tmp="$(mktemp)" \
    && cat /etc/passwd > "$tmp" \
    && printf '%s\n' "aqua:x:${UID}:${GID}:Aqua:/home/aqua:/bin/sh" >> "$tmp" \
    && rm -f /etc/passwd \
    && cp "$tmp" /etc/passwd \
    && if [ -L /etc/group ] || [ ! -w /etc/group ]; then \
         gtmp="$(mktemp)" \
         && cat /etc/group > "$gtmp" \
         && rm -f /etc/group \
         && cp "$gtmp" /etc/group; \
       fi \
    && if ! grep -q ":${GID}:$" /etc/group; then printf '%s\n' "aqua:x:${GID}:" >> /etc/group; fi \
    && chmod 644 /etc/passwd /etc/group \
    && mkdir -p /home/aqua \
    && chown -R "${UID}:${GID}" /nix /home/aqua

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
WORKDIR /workspace
ENTRYPOINT ["sh", "/usr/local/bin/docker-entrypoint.sh"]
