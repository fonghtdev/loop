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

## Đóng gói và phát hành

Bản đóng gói **chưa ký** (chưa có chữ ký số, chưa notarize): chạy được để thử, nhưng chưa nên phát cho người dùng thật.

```bash
# Cần: địa chỉ server thật, được "đóng cứng" vào app lúc build (xem bảng dưới)
export VITE_API_URL=https://api.example.com VITE_STORAGE_ORIGIN=https://files.example.com VITE_LIVEKIT_ORIGIN=wss://xxx.livekit.cloud
pnpm --filter @loop/desktop dist        # máy đang dùng: macOS -> .dmg + .zip, Windows -> installer
pnpm --filter @loop/desktop dist:dir    # chỉ thư mục chạy được (nhanh nhất), để thử
pnpm --filter @loop/desktop dist:mac    # dmg + zip (kiến trúc của máy build)
pnpm --filter @loop/desktop dist:win    # NSIS x64 (build được từ macOS, chưa chạy thử trên Windows)
```

Kết quả nằm ở `apps/desktop/release/` (đã git-ignore). Build thử trên máy với server cục bộ: thêm `LOOP_ALLOW_LOCAL=1`.

| Biến (lúc build) | Ý nghĩa |
| --- | --- |
| `VITE_API_URL` | địa chỉ server (`https://`) |
| `VITE_STORAGE_ORIGIN` | địa chỉ S3/R2 chứa tệp đính kèm (`https://`) |
| `VITE_LIVEKIT_ORIGIN` | LiveKit (`wss://`) |
| `VITE_UPDATE_URL` | (tuỳ chọn) thư mục `https://` chứa bản cập nhật; không đặt = app KHÔNG tự cập nhật và không gọi mạng để kiểm tra |

`apps/desktop/scripts/check-release-env.mjs` chạy trước mỗi `dist*`: thiếu biến, dùng `http://`/`ws://` hoặc trỏ về localhost thì dừng build với thông báo rõ. `LOOP_ALLOW_LOCAL=1` bỏ qua. `appId` (`app.loop.desktop`) là giá trị tạm; đổi cùng lúc ở `apps/desktop/electron-builder.yml` và `apps/desktop/src/shared/app-id.ts` (có test giữ hai nơi bằng nhau).

Nếu `dist` báo `spawn ENOEXEC` khi "searching for node modules": file `pnpm` trên máy bạn là script không có dòng `#!`; chạy lại với một wrapper `#!/bin/sh` + `exec pnpm "$@"` đứng đầu `PATH`.

### Ký và notarize (bạn cần tự làm; chưa bước nào được chạy)

- **macOS**: cần tài khoản Apple Developer (Developer ID Application certificate). Bỏ dòng `identity: null` trong `electron-builder.yml`, đặt `CSC_LINK` (đường dẫn/base64 file .p12) + `CSC_KEY_PASSWORD`; notarize thêm `mac.notarize: true` và `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. File `apps/desktop/build/entitlements.mac.plist` (JIT, micro, camera) chỉ có tác dụng khi app được ký. Chưa ký thì Gatekeeper chặn lần mở đầu (chuột phải > Open).
- **Windows**: chứng chỉ ký code (`CSC_LINK`, `CSC_KEY_PASSWORD`). Chưa ký thì SmartScreen cảnh báo, nhưng cập nhật tự động vẫn chạy.

### Cập nhật tự động

Dùng `electron-updater` (provider `generic`). Chỉ bật khi app đã cài (`app.isPackaged`) VÀ lúc build có `VITE_UPDATE_URL` (https). Kiểm tra sau khi mở 30 giây rồi mỗi 6 giờ, tải nền, tự cài khi thoát app, không bao giờ ép khởi động lại (nút "Khởi động lại để cập nhật" ở Cài đặt > Cập nhật).

Phát hành bản mới: tăng `version` trong `apps/desktop/package.json`, build với cùng các biến `VITE_*`, rồi tải lên `VITE_UPDATE_URL` (S3/R2 công khai, GitHub Pages hay web tĩnh bất kỳ) các file trong `release/`: `latest.yml`, `latest-mac.yml`, `.exe`, `.zip`, `.dmg` và các `.blockmap`. Lưu ý: **macOS chỉ tự cập nhật được với app đã ký** (Squirrel.Mac), bản chưa ký sẽ báo lỗi; Windows NSIS cập nhật được cả khi chưa ký. Luồng cập nhật thật chưa được thử vì chưa có feed.

### Danh sách kiểm tra khi đưa server lên production

- `JWT_SECRET` dài, ngẫu nhiên (>= 32 ký tự), khác dev.
- `CORS_ORIGINS` phải có `app://loop` (origin của app đóng gói).
- Bucket S3/R2: bật CORS cho `PUT` và `GET` từ `app://loop`, nếu không upload/hiện ảnh trong app sẽ lỗi.
- LiveKit Cloud: đặt `LIVEKIT_URL`, `LIVEKIT_API_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`; client `livekit-client` đang ghim **2.9.9** cho server LiveKit **1.9.0**, nâng một bên thì kiểm tra lại cặp phiên bản.
- Mọi thứ qua HTTPS/WSS (API, storage, LiveKit, feed cập nhật).
- Rate limit (cần Redis, cùng `REDIS_URL`; đếm chung giữa các instance): **bật mặc định**, chỉ `RATE_LIMIT=off` mới tắt (chỉ dev/e2e/test, KHÔNG đặt trên production). Mặc định: toàn cục 300 yêu cầu/phút/người dùng (IP nếu chưa đăng nhập); đăng nhập 10/phút/IP và 5 lần/5 phút cho mỗi cặp (IP, email); đăng ký 5/giờ/IP; refresh 30/phút/IP; gửi tin 60/phút (và 10 trong 5 giây)/người dùng; kết bạn 20/giờ; vào invite 20/giờ; tạo guild 10/giờ; tạo upload 60/10 phút; token voice 30/phút; kết nối socket 60/phút/IP. Vượt thì 429 kèm `Retry-After`. Webhook LiveKit không bị giới hạn. Nếu Redis chết, giới hạn tạm tắt (server vẫn chạy, có log lỗi).
- **`TRUST_PROXY`**: sau reverse proxy/CDN BẮT BUỘC đặt đúng, nếu không mọi người dùng chưa đăng nhập chung một IP của proxy (bị giới hạn chung) hoặc client giả được `X-Forwarded-For` để né giới hạn. Dùng số proxy tin cậy (`TRUST_PROXY=1`) khi biết chính xác số lớp proxy; `true` chỉ đúng khi proxy ghi đè header. Không đặt khi server nhận kết nối trực tiếp.
- Sao lưu Postgres (và Redis nếu cần) định kỳ; thử khôi phục ít nhất một lần.

## Ghi chú cho người phát triển

Quy ước, hợp đồng API và sự kiện realtime, luật phân quyền và giới hạn đã biết nằm trong `CLAUDE.md` ở thư mục gốc (file này chỉ dùng cục bộ, không được commit).
