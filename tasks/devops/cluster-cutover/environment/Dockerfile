FROM python:3.12-slim

# The hidden tests and the repo's own tests need pytest and PyYAML, nothing else: no kubectl, no
# Vault binary, no network.
RUN pip install --no-cache-dir pytest==8.4.1 pyyaml==6.0.2

WORKDIR /app
COPY app/ /app/
