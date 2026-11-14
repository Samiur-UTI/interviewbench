FROM registry.quayside.example/mirror/library/python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY payments/ /app/payments/

USER 10001:10001
EXPOSE 8080

CMD ["python", "-m", "payments.server"]
