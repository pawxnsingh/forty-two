# syntax=docker/dockerfile:1

FROM node:24.19.0-bookworm-slim

WORKDIR /acceptance
COPY scripts/artifact-helper-acceptance.mjs ./artifact-helper-acceptance.mjs
COPY scripts/test-artifact-helper-daytona-e2e.mjs ./test-artifact-helper-daytona-e2e.mjs

RUN test ! -e /workspace \
  && test ! -e /skills \
  && test ! -e /opt/tfy/skills \
  && test ! -e /acceptance/forty_two_artifacts.py \
  && test -z "$(find / -xdev -type f -name forty_two_artifacts.py -print)" \
  && test -z "$(find / -xdev -type d -path '*/skills/forty-two-artifacts' -print)" \
  && test "$(find /acceptance -type f | wc -l)" -eq 2

USER node
CMD ["node", "test-artifact-helper-daytona-e2e.mjs"]
