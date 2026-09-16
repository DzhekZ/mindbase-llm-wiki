# Runs the MindBase MCP server (stdio) — used by Glama's automated
# evaluation and anyone who prefers a containerized MCP server.
# The web UI is not included; see `npx mindbase-app` for that.
#FROM node:20-slim
#RUN npm install -g mindbase-mcp
#ENTRYPOINT ["mindbase-mcp"]

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g mindbase-app
ENV MINDBASE_DATA_DIR=/data \
    MINDBASE_MDNS=off \
    PORT=4321
VOLUME /data
EXPOSE 4321
CMD ["mindbase-app", "--no-open"]
