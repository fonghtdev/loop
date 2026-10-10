# Loop

App chat kiểu Discord cho Windows và macOS: máy chủ (server) với kênh chat, tin nhắn riêng, bạn bè, vai trò và quyền, tệp đính kèm, gọi thoại và video.

> **Trạng thái:** server đã xong (đăng nhập, server/kênh, chat realtime, vai trò, bạn bè và DM, tệp, voice/video). App desktop mới có **màn hình đăng nhập/đăng ký và khung giao diện trống**; chat, danh sách server, DM, voice trong app đang làm dần.

## Cần có

| Công cụ | Ghi chú |
|---|---|
| Node.js 22 trở lên | đã chạy thử trên Node 26 |
| pnpm 12 | cài bằng `npm i -g pnpm` (Node 26 không còn kèm corepack) |
| Docker Desktop | chạy Postgres, Redis, MinIO và LiveKit. **Phải bật trước khi bắt đầu** |

## Chạy lần đầu

```bash
# 1. Cài thư viện
pnpm install

# 2. Tạo file cấu hình, rồi đổi JWT_SECRET (ít nhất 32 ký tự)
cp .env.example .env
openssl rand -base64 48        # dán kết quả vào JWT_SECRET trong .env

# 3. Bật Postgres, Redis, MinIO, LiveKit (chờ tới khi healthy)
docker compose up -d --wait

# 4. Build một lần (dựng @loop/shared và sinh Prisma client)
pnpm build

# 5. Tạo bảng trong database
pnpm --filter @loop/server db:deploy
```

## Chạy hằng ngày

Mở **hai cửa sổ terminal**, cả hai ở thư mục gốc dự án.

```bash
# Terminal 1: server (cổng 3000)
pnpm --filter @loop/server dev

# Terminal 2: app desktop (cửa sổ Electron)
pnpm --filter @loop/desktop dev
```

Lần đầu chạy app desktop, Electron tải bộ chạy của nó (vài chục MB), nên hơi lâu.

Trong app: bấm **Tạo tài khoản**, nhập email, tên người dùng (chữ thường không dấu, số, `_`, `.`) và mật khẩu từ 8 ký tự. Đăng nhập xong bạn thấy khung app trống. Chat và danh sách server chưa có giao diện, nhưng server đã đủ API, có thể thử bằng `curl` (xem `CLAUDE.md` để biết đường dẫn và sự kiện).

### Tắt mọi thứ

- Mỗi terminal bấm `Ctrl+C`.
- Tắt dịch vụ nền nhưng **giữ dữ liệu**: `docker compose stop`. Bật lại bằng `docker compose up -d --wait`.

## Kiểm tra

```bash
pnpm lint      # kiểm tra kiểu TypeScript cho shared, server, desktop
pnpm build
pnpm test      # test shared, desktop và server (cần Docker đang chạy)
```

Test server dùng database `loop_test`, Redis index 1 và bucket `loop-test`, nên không đụng dữ liệu dev.

Test end-to-end của app (mở cửa sổ Electron thật, cần server dev đang chạy và Docker bật):

```bash
pnpm --filter @loop/desktop e2e
```

## Cấu trúc

```
apps/server      Fastify + Prisma + Socket.IO (REST, realtime, LiveKit, S3)
apps/desktop     Electron + React + Tailwind (main, preload, renderer)
packages/shared  schema zod, quyền (computePermissions) dùng chung server và app
docker/          cấu hình LiveKit và khởi tạo database test
```

## Cấu hình (`.env`)

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | Postgres |
| `JWT_SECRET` | khóa ký token, ít nhất 32 ký tự, **đừng dùng giá trị mẫu khi chạy thật** |
| `REDIS_URL` | Redis (nối nhiều instance server và trạng thái online) |
| `S3_*` | kho tệp (MinIO khi dev, Cloudflare R2 khi chạy thật) |
| `LIVEKIT_*` | máy chủ voice/video (Docker khi dev, LiveKit Cloud khi chạy thật) |
| `CORS_ORIGINS` | nguồn được gọi API. Dev dùng `http://localhost:5173`, bản đóng gói dùng `app://loop`. Để trống là không cho nguồn nào |

Địa chỉ server mà app desktop gọi mặc định là `http://localhost:3000`. Đổi bằng biến `VITE_API_URL` lúc chạy hoặc build app.

## Gặp lỗi?

| Triệu chứng | Cách xử lý |
|---|---|
| `Cannot connect to the Docker daemon` | bật Docker Desktop rồi chạy lại `docker compose up -d --wait` |
| `Environment variable not found: DATABASE_URL` | chưa có file `.env` ở thư mục gốc (`cp .env.example .env`) |
| Server báo thiếu biến môi trường lúc khởi động | so lại `.env` với `.env.example`, thiếu biến nào server báo biến đó |
| `Bind for 0.0.0.0:5432 failed` (hoặc 6379, 9000, 7880...) | cổng đang bị chương trình khác giữ (ví dụ Postgres cài bằng Homebrew); tắt nó hoặc đổi cổng trong `docker-compose.yml` |
| `ERR_PNPM_IGNORED_BUILDS` khi cài | thêm gói được báo vào `allowBuilds` trong `pnpm-workspace.yaml` |
| Cổng 3000 báo đang bận | còn một server dev cũ chạy nền: `lsof -nP -iTCP:3000 -sTCP:LISTEN`, rồi tắt tiến trình `tsx watch` (cả tiến trình cha) |
| App desktop báo không kết nối được server | server ở terminal 1 chưa chạy, hoặc `CORS_ORIGINS` thiếu `http://localhost:5173` |
| Voice không hiện người tham gia | LiveKit gửi webhook về `http://host.docker.internal:3000`, cần server chạy ở cổng 3000 |

## Xóa sạch dữ liệu dev

```bash
docker compose down -v     # XÓA toàn bộ dữ liệu Postgres, Redis, MinIO, LiveKit của dự án
```

Lệnh này không hoàn tác được. Sau đó chạy lại từ bước 3 ở phần "Chạy lần đầu".

## Ghi chú cho người phát triển

Quy ước, hợp đồng API và sự kiện realtime, luật phân quyền và giới hạn đã biết nằm trong `CLAUDE.md` ở thư mục gốc (file này chỉ dùng cục bộ, không được commit).
