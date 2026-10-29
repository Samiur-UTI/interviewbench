FROM node:24.13.1-bookworm-slim

# Optional type checking for candidates (`npm run typecheck`); the hidden tests don't need it.
RUN npm install -g typescript@5.8.3 @types/node@24.10.1 && npm cache clean --force

WORKDIR /app
COPY app/ /app/
