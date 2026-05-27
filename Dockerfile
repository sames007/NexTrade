FROM node:20-bookworm-slim AS frontend-build

WORKDIR /app
COPY frontend/package*.json ./frontend/
RUN npm ci --prefix frontend
COPY frontend ./frontend
RUN npm run build --prefix frontend

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json requirements.txt ./
RUN npm ci --omit=dev \
  && python3 -m venv /opt/nextrade-venv \
  && /opt/nextrade-venv/bin/pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY ai ./ai
COPY --from=frontend-build /app/frontend/out ./frontend/out

ENV NODE_ENV=production
ENV PYTHON_BIN=/opt/nextrade-venv/bin/python
ENV PORT=10000

EXPOSE 10000
CMD ["node", "backend/server.js"]
