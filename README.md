# Loop

App chat kiểu Discord cho Windows và macOS: máy chủ (server) với kênh chat, tin nhắn riêng, bạn bè, vai trò và quyền, tệp đính kèm, gọi thoại và video.

> **Trạng thái:** server đã xong (đăng nhập, server/kênh, chat realtime, vai trò, bạn bè và DM, tệp, voice/video). App desktop đã có **đăng nhập, máy chủ, kênh, chat text trực tiếp, bạn bè, tin nhắn riêng (DM), chặn, chấm online, tệp đính kèm, kênh thoại (micro + camera) và gọi 1-1 thoại/video trong DM**; màn hình quản lý vai trò và thông báo hệ điều hành đang làm tiếp (chưa có chia sẻ màn hình, chọn thiết bị âm thanh, chuông cuộc gọi).

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

Trong app: bấm **Tạo tài khoản**, nhập email, tên người dùng (chữ thường không dấu, số, `_`, `.`) và mật khẩu từ 8 ký tự. Sau khi đăng nhập, bấm nút **+** ở cột trái để tạo máy chủ (có sẵn kênh `#general`), hoặc nút la bàn để tham gia bằng mã mời. Bấm tên máy chủ ở đầu cột kênh để mời bạn bè (lấy mã), tạo kênh hoặc rời máy chủ. Gõ tin ở ô dưới cùng: Enter để gửi, Shift+Enter để xuống dòng; rê chuột (hoặc Tab) vào một tin để sao chép, sửa hoặc xoá. Bấm nút Loop trên cùng cột trái để vào **Trang chủ**: tab **Bạn bè** (thêm bạn bằng tên người dùng, lời mời đang chờ, danh sách đã chặn) và danh sách tin nhắn riêng; bấm **Nhắn tin** ở một người bạn để mở DM. Bấm kẹp giấy, kéo thả hoặc dán (Ctrl/Cmd+V) để đính kèm tệp (tối đa 25 MB mỗi tệp, 10 tệp mỗi tin; ảnh PNG/JPEG/GIF/WebP, PDF, TXT, ZIP, MP4, MP3); bấm vào ảnh để xem lớn. Bấm một **kênh thoại** để vào ngay (micro bật, dùng thiết bị đã chọn trong Cài đặt, mặc định là của hệ thống; thanh ở cuối cột kênh có nút tắt micro, tắt tiếng nghe, camera và rời); trong DM, nút điện thoại / camera ở đầu cuộc trò chuyện gọi người bạn (chỉ khi hai bạn còn là bạn bè), người nhận thấy hộp thoại Trả lời / Từ chối. Quản trị: nếu bạn là chủ máy chủ hoặc có quyền quản trị, menu máy chủ có **Cài đặt máy chủ** (vai trò và quyền, gán vai trò, đuổi thành viên, quyền theo kênh, và với chủ: chuyển quyền chủ / xoá máy chủ); menu "..." cạnh mỗi kênh để xoá kênh hoặc chỉnh quyền của kênh. Tin chưa đọc: DM in đậm kèm số tin, nút Trang chủ hiện tổng ("9+" khi nhiều), kênh chữ của máy chủ đang mở in đậm kèm chấm, tiêu đề cửa sổ có tiền tố `(n)` và biểu tượng Dock (macOS) hiện số. Khi cửa sổ không được xem, tin nhắn DM và cuộc gọi đến hiện thông báo của hệ điều hành; bấm vào thông báo mở đúng cuộc trò chuyện. Bấm tên của bạn ở góc dưới cột kênh để mở **Cài đặt của bạn**: thông báo (bật/tắt, có hiện nội dung tin hay không), đóng cửa sổ thì thu vào khay (Loop vẫn chạy; thoát hẳn bằng menu biểu tượng khay hoặc Cmd/Ctrl+Q), mở khi đăng nhập máy (chỉ bản đã cài), và chọn micro, loa, camera. Chỉ mở được một cửa sổ Loop: mở lần hai sẽ đưa cửa sổ đang chạy ra phía trước. Lần đầu dùng micro hoặc camera, macOS sẽ hỏi quyền (nếu lỡ từ chối: Cài đặt hệ thống, Quyền riêng tư). Muốn thử với hai người, mở thêm một tài khoản khác bằng `curl` hoặc nhờ bạn cùng chạy (xem `CLAUDE.md` để biết đường dẫn và sự kiện).

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

Địa chỉ server mà app desktop gọi mặc định là `http://localhost:3000`. Đổi bằng biến `VITE_API_URL` lúc chạy hoặc build app. Tệp đính kèm nằm ở kho S3 (MinIO, mặc định `http://localhost:9000`); đổi origin của nó cho app bằng `VITE_STORAGE_ORIGIN`.

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
