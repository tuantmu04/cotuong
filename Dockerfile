# ---------- Bước 1: build Pikafish từ mã nguồn (kèm file mạng NNUE đúng phiên bản) ----------
FROM debian:bookworm-slim AS pikafish
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ make git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Có thể ghim phiên bản: docker build --build-arg PIKAFISH_REF=<tag hoặc nhánh> .
ARG PIKAFISH_REF=master
# x86-64-avx2 chạy được trên máy chủ Azure; nếu chạy trên máy cũ đổi thành x86-64-sse41-popcnt
ARG PIKAFISH_ARCH=x86-64-avx2
RUN git clone --depth 1 --branch "${PIKAFISH_REF}" https://github.com/official-pikafish/Pikafish.git /pf
WORKDIR /pf/src
# "make build" tự tải pikafish.nnue tương ứng với mã nguồn
RUN make -j"$(nproc)" build ARCH="${PIKAFISH_ARCH}" \
 && strip pikafish \
 && test -s pikafish.nnue

# ---------- Bước 2: image chạy (Node + Pikafish) ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    PIKAFISH_PATH=pikafish/pikafish \
    PIKAFISH_INSTANCES=2 \
    PIKAFISH_THREADS=1 \
    PIKAFISH_HASH=64
WORKDIR /app
COPY --from=pikafish /pf/src/pikafish /app/pikafish/pikafish
COPY --from=pikafish /pf/src/pikafish.nnue /app/pikafish/pikafish.nnue
COPY --from=pikafish /pf/Copying.txt /app/pikafish/LICENSE-Pikafish-GPL3.txt
COPY index.html server.js ./
USER node
EXPOSE 8080
CMD ["node", "server.js"]
