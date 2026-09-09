FROM nixos/nix:2.31.2

RUN printf '%s\n' \
    'experimental-features = nix-command flakes' \
    'filter-syscalls = false' \
    'accept-flake-config = true' \
    >> /etc/nix/nix.conf

ARG UID=1000
ARG GID=1000
RUN apk add --no-cache su-exec \
    && if getent group "${GID}" >/dev/null; then \
         adduser -D -u "${UID}" -G "$(getent group "${GID}" | cut -d: -f1)" -h /home/aqua aqua; \
       else \
         addgroup -g "${GID}" aqua \
         && adduser -D -u "${UID}" -G aqua -h /home/aqua aqua; \
       fi \
    && mkdir -p /home/aqua \
    && chown -R aqua:aqua /nix /home/aqua

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
