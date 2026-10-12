# Connecteur Granulink : image minimale, sans dépendance
FROM node:22-alpine

WORKDIR /app
COPY granulink-agent.mjs ./

# Le jeton obtenu à l'appairage est conservé dans ce volume (accessible à l'utilisateur node)
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
CMD ["node", "/app/granulink-agent.mjs"]
