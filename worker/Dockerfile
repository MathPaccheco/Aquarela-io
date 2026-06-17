# Aquarela.io - Worker (Python)
# Single-stage build: install deps -> copy source -> run

FROM python:3.12-slim

WORKDIR /app

# Install system-level build dependencies for psycopg2
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "src/main.py"]
