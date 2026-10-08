FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends procps curl && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir fastapi==0.115.* uvicorn==0.30.*
WORKDIR /app
COPY app/ /app/
RUN mkdir -p /opt/app/logs /data /opt/opspilot
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
