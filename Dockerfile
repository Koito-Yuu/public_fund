FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai \
    PORT=8765

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY fundlib ./fundlib
COPY static ./static
RUN mkdir -p data

EXPOSE 8765

# 启动时若配置了 FUND_DB_URL 且本地无缓存，则下载预热库（gzip 压缩）
CMD ["sh", "-c", "if [ -n \"$FUND_DB_URL\" ] && [ ! -s data/fund.db ]; then echo '[start] downloading cache'; curl -fsSL --retry 3 --connect-timeout 20 \"$FUND_DB_URL\" -o /tmp/fund.db.gz && python -c \"import gzip,shutil; shutil.copyfileobj(gzip.open('/tmp/fund.db.gz','rb'), open('data/fund.db','wb'))\"; fi; exec python app.py --host 0.0.0.0 --port ${PORT:-8765}"]
