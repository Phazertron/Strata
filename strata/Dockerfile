FROM python:3.12-slim

# ffmpeg is required by yt-dlp to transcode audio
# curl/unzip are needed to install Deno below; git is needed to fetch the
# bgutil PO token provider's generation script
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      curl \
      unzip \
      git \
    && rm -rf /var/lib/apt/lists/*

# Deno is yt-dlp's recommended EJS (External JS Scripts) runtime, required
# since YouTube started gating downloads behind a JS challenge.
# https://github.com/yt-dlp/yt-dlp/wiki/EJS
RUN curl -fsSL https://deno.land/install.sh | sh
ENV PATH="/root/.deno/bin:${PATH}"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# bgutil-ytdlp-pot-provider supplies PO tokens (YouTube's separate anti-bot
# check, on top of EJS) — without it, downloads start but get 403'd mid-stream
# on throttled clients. Script mode just needs the repo's server/ dir + Deno
# on PATH, so no extra server process is required.
# https://github.com/Brainicism/bgutil-ytdlp-pot-provider
RUN git clone --single-branch --branch 1.3.2 --depth 1 \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
      /root/bgutil-ytdlp-pot-provider \
    && cd /root/bgutil-ytdlp-pot-provider/server \
    && deno install --allow-scripts=npm:canvas --frozen

COPY . .

ENV MEDIA_ROOT=/media
ENV FLASK_ENV=production

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--worker-class", "gthread", "--threads", "8", "--timeout", "600", "wsgi:application"]
