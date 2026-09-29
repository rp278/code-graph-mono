# Dependencies only. The graphify source (including docker-entrypoint.sh) is
# bind-mounted at /app by docker-compose.yml, so code changes take effect
# without a rebuild.
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir networkx tree-sitter tree-sitter-javascript \
    tree-sitter-typescript tree-sitter-java neo4j
ENTRYPOINT ["/app/docker-entrypoint.sh"]
