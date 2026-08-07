FROM python:3.12-slim

# ffmpeg is required by yt-dlp to transcode audio
# curl/unzip are needed to install Deno below
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      curl \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# Deno is yt-dlp's recommended EJS (External JS Scripts) runtime, required
# since YouTube started gating downloads behind a JS challenge.
# https://github.com/yt-dlp/yt-dlp/wiki/EJS
RUN curl -fsSL https://deno.land/install.sh | sh
ENV PATH="/root/.deno/bin:${PATH}"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV MEDIA_ROOT=/media
ENV FLASK_ENV=production

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--worker-class", "gthread", "--threads", "4", "--timeout", "600", "wsgi:application"]
