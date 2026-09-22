# md2pdf — an HTML -> PDF service.
#
# Its own image, not a layer on the mdbook one: a browser is ~400MB and most
# installations never enable PDF export. Deployments that want it add this
# service alongside their docs container.
#
#   docker build -t ghcr.io/helex-solutions/md2pdf .
#   docker run -p 18509:18509 ghcr.io/helex-solutions/md2pdf
FROM node:22-alpine

# Chromium from the distribution, so puppeteer-core drives a browser that gets
# security updates with the base image instead of one pinned inside node_modules.
#
# The fonts are not optional. A filed document that renders "Propouštěcí zpráva"
# with substituted glyphs is wrong, not merely ugly (OWLIKI.06 §2.6), and a
# container with no fonts at all silently prints boxes:
#   font-noto        Latin incl. Czech/Estonian/Lithuanian diacritics, Greek, Cyrillic
#   font-noto-cjk    CJK
#   font-noto-emoji  emoji used as page/callout icons
#   ttf-dejavu       a monospace face for code blocks
RUN apk add --no-cache \
      chromium \
      font-noto font-noto-cjk font-noto-emoji ttf-dejavu \
      tini \
    && fc-cache -f

WORKDIR /opt/md2pdf
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY render.mjs server.mjs themes.mjs ./
COPY themes ./themes
COPY public ./public

RUN addgroup -g 10002 md2pdf && adduser -u 10002 -G md2pdf -s /bin/sh -D md2pdf
USER md2pdf

# MD2PDF_THEMES_DIR is deliberately unset: extra themes are MOUNTED, not baked
# in. A theme carrying another organisation's wordmark, palette and address is
# theirs, and shipping one in a public image would let anyone render a document
# that looks as though it came from them.
#   -v /srv/brand-themes:/themes:ro -e MD2PDF_THEMES_DIR=/themes
ENV MD2PDF_CHROMIUM=/usr/bin/chromium-browser \
    MD2PDF_PORT=18509 \
    MD2PDF_HOST=0.0.0.0 \
    MD2PDF_CONCURRENCY=2
EXPOSE 18509

# Answers 503 until a browser can actually be launched, so an image whose
# Chromium is broken is unhealthy rather than quietly failing per request.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MD2PDF_PORT||18509)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "node", "/opt/md2pdf/server.mjs"]
