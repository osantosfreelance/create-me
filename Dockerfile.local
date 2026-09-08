FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

RUN apk add --no-cache openssl && \
    mkdir -p /app/server && \
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout /app/server/key.pem \
      -out /app/server/cert.pem \
      -days 3650 \
      -subj "/CN=create-me" \
      -addext "subjectAltName=IP:0.0.0.0,DNS:localhost" && \
    chmod 644 /app/server/cert.pem && \
    chmod 640 /app/server/key.pem

# Run as a non-root user; no volumes are declared since the app never
# writes photos, results, or logs containing image data to disk.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown appuser:appgroup /app/server/cert.pem /app/server/key.pem
USER appuser

ENV PORT=3000
ENV container=docker
EXPOSE 3000

CMD ["node", "server/index.js"]
