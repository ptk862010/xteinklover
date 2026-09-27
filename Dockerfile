# Xteink Lover tự chạy: cùng code với bản Cloudflare, dữ liệu nằm trong /data (SQLite + thư mục sách).
#   docker compose up -d        (xem docker-compose.yml và README, phần "Tự chạy bằng Docker")

# ── Dựng: bộ chuyển đổi chạy trên trình duyệt (public/convert) + server một file (dist/server.mjs)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: không tải workerd của wrangler (chỉ bản Cloudflare cần)
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build:node

# ── Chạy: chỉ Node + 2 thứ vừa dựng, không node_modules
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
COPY --from=build /app/dist/server.mjs dist/server.mjs
COPY --from=build /app/public public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=1m --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthcheck').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# node:sqlite còn gắn nhãn thử nghiệm: tắt dòng cảnh báo cho log gọn
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.mjs"]
