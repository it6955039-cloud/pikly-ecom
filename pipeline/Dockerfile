# pipeline/Dockerfile — Python ETL image
FROM python:3.12-slim

RUN pip install --no-cache-dir --upgrade pip

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py .

ENTRYPOINT ["python"]
CMD ["ingest.py", "--help"]
