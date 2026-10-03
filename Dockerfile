# AlphaPulse: Node 22 + Chromium (Playwright) + ffmpeg, everything the agents need to work.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY . .
RUN bash setup.sh
ENV OFFICE_DATA=/data PORT=8080
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server.mjs"]
