# Triển khai Loop cho người thử nghiệm (miễn phí)

Mục tiêu: dưới 20 người thử dùng Loop qua Internet, không tốn tiền. Máy chủ chạy trong Docker trên một máy Linux luôn bật; thoại/video đi qua LiveKit Cloud; tệp nằm ở Cloudflare R2; bản cài desktop **không ký** (không cần chứng chỉ Apple/Windows).

> Các con số về gói miễn phí dưới đây được ghi nhận ngày 2026-10-12 và có thể đã đổi. **Hãy đối chiếu lại trên trang của từng nhà cung cấp trước khi dựa vào.**

## 1. Tổng quan

```
 Người thử (app Loop đã cài)
   |  HTTPS / WSS  (API + Socket.IO)                    |  WSS + UDP/TCP (thoại, video)
   v                                                    v
 [ Máy Linux luôn bật: Oracle Always Free / máy của bạn ]      [ LiveKit Cloud (gói Build) ]
   Caddy :80/:443  (HTTPS tự động, Let's Encrypt)              ^
     -> server :3000 (Node, chạy migration khi khởi động) ------+  (server gọi API + nhận webhook)
          -> Postgres 16   (mạng nội bộ, không mở ra ngoài)
          -> Redis 7       (mạng nội bộ, không mở ra ngoài)
          -> Cloudflare R2 (tệp đính kèm; app tải lên/xem thẳng từ R2 bằng URL ký sẵn)
```

Chỉ Caddy mở cổng 80/443. Postgres và Redis chỉ nằm trong mạng nội bộ của Docker. Mọi file cấu hình nằm ở thư mục `deploy/`.

## 2. Tài khoản cần tạo (làm tay, mất vài phút mỗi cái)

| Dịch vụ | Dùng để | Cần lấy ra |
|---|---|---|
| Máy chủ luôn bật: **Oracle Cloud Always Free** (VM Ampere A1, ARM64) hoặc máy Linux/Mac khác | chạy server + Postgres + Redis | địa chỉ IP công khai, khoá SSH |
| **DuckDNS** (miễn phí) hoặc tên miền của bạn | tên miền cố định cho HTTPS | tên miền, ví dụ `loop-test.duckdns.org` |
| **Cloudflare R2** | lưu tệp đính kèm | Account ID, tên bucket, Access Key ID, Secret Access Key |
| **LiveKit Cloud** | thoại/video | URL dự án, API Key, API Secret |

Lưu ý cần kiểm tra trên trang nhà cung cấp:
- **Oracle**: hạn mức Always Free của Ampere A1 được báo là đã giảm còn khoảng 2 OCPU / 12 GB RAM (trước đây 4 OCPU / 24 GB), và tạo VM hay báo lỗi **"Out of capacity"**. Cho dưới 20 người, 1-2 OCPU và 6-12 GB là dư. Đăng ký thường đòi thẻ để xác minh. Nếu không tạo được VM, dùng phương án khác ở mục 12.
- **R2**: 10 GB lưu trữ miễn phí, không tính phí băng thông ra; lúc đăng ký có thể bị yêu cầu thêm phương thức thanh toán.
- **LiveKit Cloud** gói Build: khoảng 5.000 phút WebRTC/tháng (chung cho các dự án), 100 kết nối đồng thời, 50 GB tải xuống. **Vượt hạn mức thì các yêu cầu bị từ chối (giới hạn cứng)**, tức là thoại ngừng hoạt động đến kỳ sau. Xem mức dùng ở dashboard.

## 3. Tạo VM và mở cổng 80/443

Với Oracle: Compute -> Instances -> Create. Chọn image **Ubuntu 24.04** (hoặc 22.04), shape **VM.Standard.A1.Flex** (1-2 OCPU, 6-12 GB), dán khoá SSH công khai của bạn. Ghi lại **Public IP**. Chỉ dùng đăng nhập bằng khoá SSH.

Có **hai lớp tường lửa**, phải mở cả hai:

1. **Tường lửa của cloud** (Oracle: VCN -> Security Lists -> Default Security List -> Add Ingress Rules): nguồn `0.0.0.0/0`, giao thức TCP, cổng đích `80` rồi thêm một luật `443`. (Tuỳ chọn: UDP `443` cho HTTP/3.) Giữ cổng `22` như có sẵn.
2. **Tường lửa trong VM**: image Oracle thường có sẵn luật iptables chặn mọi thứ trừ SSH. Trên VM:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt-get install -y iptables-persistent   # hỏi lưu luật hiện tại thì chọn Yes
sudo netfilter-persistent save
```

(Nếu VM dùng `ufw`: `sudo ufw allow 80,443/tcp`. Cổng do Docker mở thường vẫn vào được dù luật INPUT, nhưng cứ thêm luật để chắc.)

**Tên miền**: tạo subdomain ở https://www.duckdns.org (đăng nhập bằng tài khoản GitHub/Google), điền IP công khai của VM vào ô `current ip`. Kiểm tra: `ping loop-test.duckdns.org` ra đúng IP. Đây chỉ là cấu hình DNS, code không phụ thuộc DuckDNS; sau này mua tên miền riêng thì đổi `DOMAIN` (và build lại app, xem mục 8).

## 4. Cài Docker trên VM

```bash
ssh ubuntu@<IP>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit      # đăng nhập lại để có quyền docker
ssh ubuntu@<IP> docker compose version     # phải in ra phiên bản
```

Image của Loop chạy được trên cả `linux/arm64` (Oracle A1) và `linux/amd64`; `docker compose build` tự build đúng kiến trúc của máy.

## 5. Đưa mã nguồn lên VM (repo là PRIVATE)

Chọn một trong ba cách. Cách A đơn giản nhất:

**A. Deploy key (khoá chỉ-đọc cho đúng repo này).**
```bash
ssh-keygen -t ed25519 -f ~/.ssh/loop_deploy -N ""        # trên VM
cat ~/.ssh/loop_deploy.pub                               # copy
```
GitHub -> repo -> Settings -> Deploy keys -> Add deploy key, dán khoá (không tích "Allow write access"). Rồi trên VM:
```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/loop_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
git clone git@github.com:<tài-khoản>/<repo>.git loop && cd loop
```

**B. `gh` CLI**: `sudo apt-get install -y gh && gh auth login` (chọn SSH hoặc token), rồi `gh repo clone <tài-khoản>/<repo> loop`.

**C. Không dùng GitHub**: từ máy của bạn `rsync -az --exclude node_modules --exclude .git --exclude 'apps/desktop' ./ ubuntu@<IP>:loop/` (chỉ cần `apps/server`, `packages/shared`, `deploy`, `pnpm-lock.yaml`, các file workspace và `apps/desktop/package.json`).

**Cập nhật về sau**: `cd ~/loop && git pull` (xem mục 9).

## 6. Dịch vụ ngoài: R2 và LiveKit Cloud

### R2 (tệp)
1. Cloudflare dashboard -> R2 -> Create bucket, tên `loop-uploads` (để riêng tư, **không** bật public access).
2. R2 -> Manage API Tokens -> Create API token, quyền **Object Read & Write**, giới hạn cho đúng bucket này. Lưu **Access Key ID** và **Secret Access Key** (chỉ hiện một lần). Endpoint là `https://<Account ID>.r2.cloudflarestorage.com` (Account ID ở trang R2).
3. **CORS** (bắt buộc, không có thì upload/xem ảnh trong app lỗi): bucket -> Settings -> CORS Policy -> Add, dán nội dung `deploy/r2-cors.json` (cho `app://loop`, phương thức GET/PUT/HEAD, header `*`, lộ `ETag`). Dùng CLI: `wrangler r2 bucket cors set loop-uploads --file deploy/r2-cors.json`.

### LiveKit Cloud (thoại/video)
1. https://cloud.livekit.io -> tạo project. Trong Settings lấy **URL** (`wss://<project>.livekit.cloud`), tạo một **API Key** (Settings -> Keys) và ghi lại Key + Secret.
2. **Webhook** (để server biết ai vào/ra phòng và thu hồi quyền): Settings -> Webhooks -> Add webhook, URL là
   `https://<DOMAIN>/livekit/webhook`, chọn đúng API Key bạn đặt trong `deploy/.env`. LiveKit ký nội dung gửi đi bằng key đó; server kiểm chữ ký bằng `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` (đường dẫn nằm ở `apps/server/src/voice/webhook.ts`). Làm bước này **sau khi** server chạy và có HTTPS (mục 7).

## 7. Điền cấu hình và chạy

```bash
cd ~/loop/deploy
cp .env.production.example .env
nano .env        # điền mọi dòng; mỗi biến có chú thích và cách sinh giá trị
```
Sinh bí mật: `openssl rand -hex 24` (mật khẩu Postgres/Redis), `openssl rand -base64 48` (`JWT_SECRET`). **Không bao giờ commit `deploy/.env`** (đã nằm trong `.gitignore`).

```bash
docker compose -f docker-compose.prod.yml up -d --build   # lần đầu build mất vài phút
docker compose -f docker-compose.prod.yml ps               # server phải "healthy"
docker compose -f docker-compose.prod.yml logs -f server   # thấy "Applying migration" rồi "listening"
curl -s https://<DOMAIN>/health                            # {"ok":true}
```
Lần đầu, Caddy xin chứng chỉ Let's Encrypt (cần cổng 80/443 mở và DNS đúng); mất vài chục giây. `/health` trả 200 chỉ khi Postgres và Redis cùng trả lời trong ~1 giây, nếu không là 503 `{"ok":false}`. Server áp dụng migration tự động khi khởi động (container dừng nếu migration lỗi).

Sau đó quay lại mục 6 để khai báo webhook LiveKit.

## 8. Build bản cài desktop với địa chỉ thật

Địa chỉ server/R2/LiveKit được **đóng cứng** vào app lúc build (nên cần địa chỉ HTTPS ổn định trước khi build). Mẫu biến: `apps/desktop/.env.production.example`. Lệnh build từ chối nếu thiếu, không phải https/wss hoặc trỏ về localhost.

**Build trên máy của bạn** (macOS tạo được cả bản Windows; cài đặt môi trường theo README):
```bash
export VITE_API_URL=https://loop-test.duckdns.org
export VITE_STORAGE_ORIGIN=https://<account-id>.r2.cloudflarestorage.com
export VITE_LIVEKIT_ORIGIN=wss://<project>.livekit.cloud
pnpm install --frozen-lockfile && pnpm --filter @loop/shared build
pnpm --filter @loop/desktop dist:mac     # .dmg + .zip, kiến trúc của máy bạn
pnpm --filter @loop/desktop dist:win     # Loop Setup x.y.z.exe (x64)
ls apps/desktop/release
```
**Build bằng GitHub Actions** (`.github/workflows/release.yml`, chạy tay hoặc khi đẩy tag `v*`): đặt 3 *Repository variables* `LOOP_API_URL`, `LOOP_STORAGE_ORIGIN`, `LOOP_LIVEKIT_ORIGIN` (không phải secret), rồi Actions -> release -> Run workflow. Installer nằm ở phần *Artifacts* của lần chạy (giữ 14 ngày); workflow **không** tạo Release và không đăng gì. Runner `macos-latest` là Apple Silicon (arm64), nên job `macos-arm64` chỉ chạy native trên máy M1/M2/M3...; job `macos-x64` build bản Intel bằng cross-build trên cùng runner. **Workflow này chưa từng chạy.**

## 9. Phát hành cho người thử

Gợi ý: tạo một repo **công khai riêng** (ví dụ `loop-releases`, chỉ chứa Release, không chứa mã) vì repo chính là private nên người thử không tải được từ đó. Tải artifact về, rồi:
```bash
gh release create v0.1.0 --repo <tài-khoản>/loop-releases --title v0.1.0 *.exe *.dmg *.zip
```
Gửi link trang Release cho người thử. (Hãy hỏi chủ dự án trước khi tạo repo/Release; tài liệu này không tạo gì.) Tự cập nhật: nếu muốn, đặt `VITE_UPDATE_URL`; lưu ý macOS chỉ tự cập nhật với app đã ký, nên với bản không ký hãy gửi bản mới thủ công.

### Cách cài bản KHÔNG ký (gửi kèm cho người thử)
- **macOS**: mở `.dmg`, kéo Loop vào Applications. Lần đầu **chuột phải vào Loop -> Open -> Open**. Nếu hiện "đã bị hỏng/không thể mở": `xattr -cr /Applications/Loop.app` rồi mở lại. Bản `arm64` cho Mac M-series, bản `x64` cho Mac Intel.
- **Windows**: chạy `Loop Setup x.y.z.exe`; khi SmartScreen hiện "Windows protected your PC" bấm **More info -> Run anyway**.
- Lần đầu dùng thoại macOS sẽ hỏi quyền micro/camera.

## 10. Vận hành

**Cập nhật server**
```bash
cd ~/loop && git pull
cd deploy && docker compose -f docker-compose.prod.yml up -d --build   # migration tự chạy khi server khởi động
```
**Quay lui**: trước khi cập nhật, ghi lại commit (`git rev-parse --short HEAD`) và chạy `./backup.sh`. Nếu bản mới lỗi: `git checkout <commit-cũ>` rồi `up -d --build` lại. Migration chỉ thêm (không tự hoàn tác): nếu migration mới đã đổi cấu trúc DB, cần khôi phục bản sao lưu (bên dưới) chứ không chỉ đổi code.

**Sao lưu / khôi phục Postgres**
```bash
./deploy/backup.sh          # tạo deploy/backups/loop-<giờ UTC>.sql.gz, giữ 14 bản mới nhất (KEEP=30 để đổi)
# lịch chạy hằng ngày:  crontab -e  ->  15 3 * * * /home/ubuntu/loop/deploy/backup.sh >> /home/ubuntu/backup.log 2>&1
```
Khôi phục (script in sẵn lệnh): dừng server, nạp file, bật lại:
```bash
cd deploy
docker compose -f docker-compose.prod.yml stop server
gunzip -c backups/loop-<giờ>.sql.gz | docker compose -f docker-compose.prod.yml exec -T postgres psql -U loop -d loop
docker compose -f docker-compose.prod.yml start server
```
Hãy khôi phục thử ít nhất một lần vào DB trống. Nên chép thư mục `backups/` sang nơi khác (máy của bạn). Tệp trong R2 không nằm trong bản sao lưu này.

**Theo dõi**: `docker compose -f docker-compose.prod.yml logs -f server` (log quay vòng 3 x 10 MB), `docker compose ... ps`, `curl https://<DOMAIN>/health`. Tuỳ chọn: monitor miễn phí như UptimeRobot trỏ vào `https://<DOMAIN>/health` (báo khi 503/không phản hồi). Mức dùng LiveKit: dashboard LiveKit Cloud; dung lượng R2: dashboard Cloudflare.

## 11. Giới hạn và chi phí (đối chiếu lại trên trang nhà cung cấp)

| Hạng mục | Ghi nhận ngày 2026-10-12 | Rủi ro |
|---|---|---|
| Oracle Always Free A1 | khoảng 2 OCPU / 12 GB (trước: 4 / 24) | hay báo "Out of capacity"; Oracle có thể thu hồi VM Always Free không hoạt động |
| LiveKit Cloud Build | ~5.000 phút WebRTC/tháng, 100 kết nối, 50 GB | vượt là bị chặn (hard cap) |
| Cloudflare R2 | 10 GB-tháng, không phí egress | có thể đòi phương thức thanh toán lúc đăng ký |
| DuckDNS | miễn phí | dịch vụ cộng đồng, có lúc gián đoạn; có thể đổi sang tên miền riêng |
| Let's Encrypt | miễn phí | giới hạn số chứng chỉ mỗi tuần: **giữ volume `caddy_data`** |

## 12. Phương án thay thế: chạy trên máy luôn bật của bạn (Mac/PC)

Cùng bộ `deploy/` chạy được trên Mac/PC có Docker. Nhưng:
- Máy **phải bật và có mạng** mọi lúc người thử dùng; ngủ máy/mất mạng là server chết.
- Cần một **URL HTTPS ổn định** vì địa chỉ được đóng cứng vào bản cài. Cách làm: mở cổng 80/443 trên router (cổng chuyển tiếp) + DuckDNS cập nhật IP (IP nhà thường đổi; dùng tool cập nhật của DuckDNS), hoặc **Cloudflare Tunnel**: tunnel có tên và địa chỉ ổn định cần một tên miền nằm trên Cloudflare (tunnel nhanh `trycloudflare.com` đổi địa chỉ mỗi lần, không dùng được), hoặc **Tailscale**: không cần mở cổng nhưng **mọi người thử phải cài Tailscale** và được mời vào mạng của bạn.
- Dùng Cloudflare Tunnel thì Caddy không cần xin chứng chỉ: đặt `DOMAIN=http://localhost` cho Caddy và trỏ tunnel vào `http://localhost:<HTTP_PORT>`; vẫn giữ `TRUST_PROXY=1` chỉ khi đúng một lớp proxy (xem lại số lớp, vì Cloudflare thêm một lớp nữa: kiểm tra lại giới hạn tốc độ theo IP sau khi đổi).

## 13. Danh sách kiểm tra bảo mật

- [ ] Mật khẩu Postgres/Redis và `JWT_SECRET` sinh ngẫu nhiên, dài; `deploy/.env` quyền `chmod 600`, không commit.
- [ ] SSH chỉ bằng khoá (`PasswordAuthentication no` trong `/etc/ssh/sshd_config`), không đăng nhập root.
- [ ] Chỉ mở 22, 80, 443 (cả tường lửa cloud lẫn trong VM). Postgres/Redis không có cổng công khai (kiểm: `docker compose ... ps` không hiện `0.0.0.0` cho chúng).
- [ ] Bật cập nhật bảo mật tự động: `sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`.
- [ ] Sao lưu chạy định kỳ và đã thử khôi phục.
- [ ] `RATE_LIMIT` bật (compose cố định `on`), `TRUST_PROXY=1` (đúng một proxy là Caddy; thêm CDN phía trước thì phải đổi).
- [ ] Xem trước liên kết (`LINK_PREVIEWS`, mặc định bật; `off` để tắt): server tự tải trang web mà người dùng dán vào tin nhắn, nên IP của VM/Render xuất hiện trong log của các trang đó và VM cần đi ra internet (cổng 80/443). Bộ tải (`apps/server/src/embeds/fetch.ts`) chặn mọi địa chỉ nội bộ/metadata, nhưng nếu nhà cung cấp có dịch vụ nội bộ trên địa chỉ công khai, hãy chặn ở tường lửa đi ra, hoặc tắt tính năng. Không đặt `NODE_USE_ENV_PROXY`/proxy đi ra cho tiến trình server (proxy tự phân giải tên và vô hiệu hoá việc ghim IP).
- [ ] Ảnh GIF trong khung soạn tin (`GIPHY_API_KEY`, tuỳ chọn; không đặt = tắt hẳn, desktop ẩn nút GIF): lấy khoá miễn phí ở https://developers.giphy.com (đăng nhập, *Create an App*, chọn *API*; khoá beta giới hạn khoảng 100 lượt gọi/giờ, đủ cho nhóm nhỏ; muốn hơn thì xin lên *Production* và phải làm đúng quy định hiển thị của GIPHY). Server tự cache 5 phút mỗi truy vấn và giới hạn 60 lượt/phút/người để tiết kiệm hạn mức. Bắt buộc của GIPHY: hiện nhãn "Powered by GIPHY" (đã có trong cửa sổ chọn GIF). **Riêng tư:** ảnh GIF tải thẳng từ CDN của GIPHY (`media0`..`media4.giphy.com`, `i.giphy.com`) về máy người xem, nên GIPHY thấy IP của họ (người dùng có thể tắt ở Cài đặt, "Hiện ảnh GIF"); khoá API chỉ nằm ở server. Phương án thay thế nếu GIPHY đổi điều khoản: Tenor (cùng dạng tìm kiếm + nổi bật; cần viết lại `apps/server/src/gifs/giphy.ts` và danh sách máy chủ ảnh trong `packages/shared/src/gifs.ts` cùng CSP ở `apps/desktop/src/main/security.ts`).
  - Render: Dashboard -> service `loop-server` -> *Environment* -> *Add Environment Variable* `GIPHY_API_KEY` = khoá -> *Save, rebuild and deploy*. VM/compose: thêm `GIPHY_API_KEY=...` vào `deploy/.env`, rồi `docker compose up -d`.
- [ ] Bucket R2 riêng tư; token R2 chỉ cho bucket đó; token LiveKit chỉ nằm trong `.env`.
- [ ] Cập nhật image định kỳ: `docker compose ... pull && up -d --build`.

## 14. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Không có chứng chỉ HTTPS / trình duyệt báo không an toàn | DNS chưa trỏ đúng IP, cổng 80/443 bị chặn (cloud HOẶC iptables trong VM), sai `DOMAIN` | `docker compose ... logs caddy`; `dig +short <DOMAIN>`; kiểm tra hai lớp tường lửa (mục 3) |
| App báo lỗi mạng/CORS khi đăng nhập | `CORS_ORIGINS` không có `app://loop`; app build với `VITE_API_URL` sai | xem `.env` và địa chỉ đã đóng cứng (`strings` trong bản build), build lại |
| Tải tệp/ảnh lên lỗi | thiếu CORS ở R2, sai khoá R2, `S3_ENDPOINT` sai, `VITE_STORAGE_ORIGIN` khác endpoint | áp `deploy/r2-cors.json`; kiểm tra token có quyền Read & Write; origin trong app phải trùng host của `S3_ENDPOINT` |
| Vào kênh thoại không được / không nghe | `LIVEKIT_URL`/`LIVEKIT_API_URL` sai, `VITE_LIVEKIT_ORIGIN` khác URL, hết 5.000 phút, thiếu webhook | kiểm tra dashboard LiveKit (mức dùng, webhook delivery), log server (`voice ... failed`) |
| Nhiều người cùng bị 429 "Too many requests" | `TRUST_PROXY` sai nên mọi người chung IP của proxy | compose đặt `TRUST_PROXY=1`; nếu có thêm CDN/tunnel phía trước thì tăng số lớp |
| `/health` trả 503 | Postgres hoặc Redis chưa sẵn sàng/đã chết | `docker compose ... ps`, `logs postgres redis` |
| Server dừng ngay sau khi bật | thiếu biến trong `.env`, hoặc migration lỗi | `logs server` (compose in rõ biến thiếu) |
| Oracle: `Out of capacity for shape VM.Standard.A1.Flex` | hết chỗ trong region | thử lại giờ khác, đổi availability domain, hạ cấu hình (1 OCPU / 6 GB), hoặc dùng phương án mục 12 |
| macOS: "Loop is damaged" / không mở được | Gatekeeper với app không ký | `xattr -cr /Applications/Loop.app` hoặc chuột phải -> Open |

## 15. Đã kiểm chứng và chưa kiểm chứng

**Đã chạy thật trên máy phát triển (macOS arm64, Docker Desktop), với giá trị thử:** image build được (kiến trúc máy, ~775 MB trên đĩa, ~170 MB nén); entrypoint áp 8 migration lên DB trống; `/health` 200 qua Caddy, 503 khi dừng Redis, 200 lại khi bật; đăng ký/đăng nhập/refresh/`/me` qua proxy; giới hạn tốc độ tính theo IP thật mà Caddy thấy và **bỏ qua** `X-Forwarded-For` do client tự gửi; Socket.IO (WebSocket) qua Caddy nhận tin nhắn thật; dữ liệu còn sau `restart` và `--force-recreate`; server chạy user không phải root; Postgres/Redis không công bố cổng ra máy chủ; Caddy cấp chứng chỉ nội bộ cho `localhost` (HTTPS).

**Chưa kiểm chứng:** VM Oracle thật và cổng 80/443 từ Internet; DuckDNS; Let's Encrypt; R2 thật (presigned URL, CORS); LiveKit Cloud thật (token, webhook); workflow GitHub Actions (chưa chạy; chỉ lint YAML bằng actionlint); runner Windows/macOS; cài và chạy bản không ký trên máy sạch; tự cập nhật; kiểm tra khôi phục sao lưu trên VM thật.

## 16. Phương án miễn phí: Render + Neon (không cần VM)

Thay cho mục 3-7: server chạy trong **một container** trên Render (gói Web Service miễn phí), Postgres ở **Neon**, Redis chạy **ngay trong container** (không lưu đĩa, chỉ nghe `127.0.0.1`, mật khẩu ngẫu nhiên sinh mỗi lần khởi động). Không có Caddy: Render tự lo HTTPS. R2 và LiveKit Cloud giữ nguyên (mục 6). File: `render.yaml` (gốc repo), `deploy/render/Dockerfile`, `apps/server/docker-entrypoint.render.sh`.

```
 app Loop --HTTPS/WSS--> [Render free web service: 1 container, 512 MB]
                           tini -> redis-server (127.0.0.1) + node server :$PORT
                              -> Neon Postgres (SSL, ngoài container)   -> Cloudflare R2   <-> LiveKit Cloud
```

### Các bước
1. **Neon** (https://neon.tech): tạo project, chọn region gần Render (Singapore nếu có). Trong *Connection Details* có hai chuỗi, copy **cả hai** (bật/tắt công tắc *Connection pooling*):
   - **pooled** (host có `-pooler`) -> sẽ là `DATABASE_URL`. Thêm `&pgbouncer=true` vào cuối, ví dụ `postgresql://USER:PASS@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require&pgbouncer=true`.
   - **direct** (host KHÔNG có `-pooler`) -> sẽ là `DIRECT_URL`, ví dụ `postgresql://USER:PASS@ep-xxx.REGION.aws.neon.tech/neondb?sslmode=require`.
   Vì sao hai chuỗi: `prisma migrate deploy` cần khoá advisory và phiên riêng nên **không chạy được qua pooler (pgbouncer)**. Entrypoint dùng `DIRECT_URL` cho migration (nếu bỏ trống thì dùng `DATABASE_URL`, đúng khi bạn dùng chuỗi direct cho cả hai), còn server chạy bằng `DATABASE_URL`. Không cần sửa schema Prisma. Nếu không muốn dùng pooler, đặt `DATABASE_URL` = chuỗi direct và bỏ `DIRECT_URL` (với < 20 người vẫn đủ kết nối; kiểm tra giới hạn kết nối của gói Neon).
2. **R2 và LiveKit Cloud**: làm mục 6 (bucket, token, CORS). Chưa khai webhook LiveKit vội (bước 5).
3. **Render** (https://render.com): đưa repo private lên GitHub rồi *New -> Blueprint*, cấp quyền cho đúng repo, Render đọc `render.yaml` và tạo service `loop-server` (gói free, runtime docker, region Singapore, health check `/health`). Render hỏi giá trị cho các biến `sync: false`; điền theo bảng dưới. Lần build đầu mất vài phút.
4. Khi service **Live**: `curl https://<service>.onrender.com/health` phải ra `{"ok":true}` (lần đầu có thể chậm do đang đánh thức). Log phải có `All migrations have been successfully applied.` rồi `Server listening`.
5. **Webhook LiveKit**: Settings -> Webhooks -> URL `https://<service>.onrender.com/livekit/webhook`, chọn đúng API Key đã đặt trong Render.
6. **Build app desktop** (mục 8) với địa chỉ này: đặt *Repository variables* `LOOP_API_URL=https://<service>.onrender.com`, `LOOP_STORAGE_ORIGIN`, `LOOP_LIVEKIT_ORIGIN` rồi chạy workflow release.

### Biến môi trường
| Biến | Giá trị | Ghi chú |
|---|---|---|
| `DATABASE_URL` | chuỗi **pooled** Neon + `sslmode=require&pgbouncer=true` | secret, điền tay |
| `DIRECT_URL` | chuỗi **direct** Neon + `sslmode=require` | secret, chỉ dùng cho migration |
| `JWT_SECRET` | `openssl rand -base64 48` | secret |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | từ R2 (mục 6) | secret; `S3_REGION=auto` đã cố định |
| `LIVEKIT_URL` / `LIVEKIT_API_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | từ LiveKit Cloud (mục 6) | secret |
| `RATE_LIMIT=on`, `TRUST_PROXY=1`, `CORS_ORIGINS=app://loop` | cố định trong `render.yaml` | `TRUST_PROXY=1` vì chỉ có một proxy (Render) phía trước; chưa kiểm chứng trên Render thật, hãy thử `X-Forwarded-For` giả sau khi lên |
| `PORT` | Render tự đặt (mặc định 10000) | server đọc `PORT`, không đặt tay |
| `REDIS_URL` | **không đặt** | entrypoint tự tạo, trỏ `127.0.0.1` |

### Giới hạn của phương án này (ghi nhận 2026-10-12, đối chiếu lại trên trang Render/Neon)
| Hạng mục | Ghi nhận | Hệ quả |
|---|---|---|
| Ngủ khi rảnh | ngủ sau 15 phút không có request vào | request đầu sau khi ngủ chờ ~1 phút; mọi socket bị ngắt khi ngủ, app phải kết nối lại; Redis (và bộ đếm giới hạn tốc độ) mất khi ngủ/khởi động lại |
| Giờ miễn phí | 750 giờ/tháng mỗi workspace | một service chạy liên tục vừa đủ cả tháng; nhiều service dùng chung hạn mức |
| RAM | 512 MB | đã đo: ~90 MB (xem dưới); Node giới hạn heap 256 MB, Redis tối đa 64 MB |
| Đĩa | tạm thời (mất khi deploy/khởi động lại) | không sao: tệp ở R2, dữ liệu ở Neon, Redis không cần lưu |
| Độ tin cậy | Render khuyên không dùng gói free cho production | chỉ dùng cho người thử |
| Neon free | dung lượng và giờ compute có hạn, DB tự tạm dừng khi rảnh | truy vấn đầu sau khi DB ngủ chậm thêm vài giây |
| Một instance | Redis trong container nên không chia sẻ được | không được tăng số instance (mỗi instance có Redis riêng, sự kiện realtime sẽ không xuyên instance) |

### Đã kiểm chứng và chưa kiểm chứng (phương án này)
**Đã chạy trên Mac (Docker, arm64), với Postgres 16 tạm có bật SSL tự ký, MinIO và LiveKit dev:** image build được; container chạy user `node` (không root), redis-server cũng user `node`; migration áp đủ (cả khi `DATABASE_URL` hỏng và chỉ `DIRECT_URL` đúng); kết nối Postgres dùng SSL (`pg_stat_ssl.ssl = t`) với `sslmode=require&pgbouncer=true`; `/health` 200; đăng ký/đăng nhập; tin nhắn Socket.IO tới đủ 10/10 socket; Redis không có cổng công bố, container khác cùng mạng không kết nối được, và trong container vẫn đòi mật khẩu; `docker stop` xong trong ~0,15 giây (exit 143 do SIGTERM); không đặt `PORT` thì nghe 3000, đặt `PORT=10000` thì nghe 10000; RAM container ~87 MiB lúc rảnh, ~94 MiB với 10 socket đang nối.
**Chưa kiểm chứng:** Render và Neon thật (build trên Render, `render.yaml` chưa được Render đọc thử, health check, ngủ/đánh thức thực tế); region Singapore có sẵn cho gói free hay không; đăng ký có dùng được từ Việt Nam hay đòi thẻ; Neon pooler thật (chỉ giả lập bằng tham số `pgbouncer=true`, không có pgbouncer thật) và chứng chỉ SSL công khai của Neon (thử mới với chứng chỉ tự ký, `sslmode=require` không xác minh chứng chỉ); hành vi `TRUST_PROXY=1` sau proxy của Render; R2/LiveKit Cloud thật.

## 17. Bot nhạc trên Render (workspace riêng)

Bot nhạc (`packages/bots/music`) chạy thành một web service free **trong workspace Render khác** với server (mỗi workspace có 750 giờ/tháng riêng; hai service chung workspace sẽ cạn giờ giữa tháng). Bot là client của server: đăng nhập bằng token bot, nối Socket.IO + LiveKit. File: `deploy/render-bot/Dockerfile` (cài `ffmpeg` bằng apt, `yt-dlp` bản binary), `deploy/render-bot/render.yaml`.

1. **Tạo bot**: đăng nhập app, lấy access token, `POST /bots {"name":"music_bot"}` lên server production → lưu `token` (chỉ hiện một lần). Cho bot vào máy chủ bằng lời mời và cấp quyền như `packages/bots/music/README.md`.
2. **Render**: chuyển sang workspace `loop-bot` → *New → Blueprint*, chọn repo, ở ô đường dẫn Blueprint nhập `deploy/render-bot/render.yaml` (hoặc *New → Web Service* runtime Docker, Dockerfile `deploy/render-bot/Dockerfile`, context `.`, gói Free). Điền `LOOP_API_URL=https://<loop-server>.onrender.com` và `LOOP_BOT_TOKEN`. `PORT` Render tự đặt.
3. **Giữ thức**: service free ngủ sau 15 phút không có request vào, bot chỉ kết nối đi ra nên không tự giữ được. Đăng ký UptimeRobot (free), thêm monitor HTTP(s) tới `https://<loop-music-bot>.onrender.com/` mỗi 5 phút. Server Loop cũng cần được ping `/health` như vậy, nếu không nó ngủ và bot không còn ai để phục vụ.
4. **Kiểm**: log có `[music] ready`; trong app, vào kênh thoại rồi gõ `!play never gonna give you up` ở kênh text.

Bot chưa kết nối được server (đang ngủ) thì thử lại mỗi 15 giây, không thoát.

**YouTube chặn máy chủ ("Sign in to confirm you're not a bot"):** địa chỉ IP của Render (data centre) thường bị YouTube đòi đăng nhập. Log hiện `[music] yt-dlp: exit 1 ERROR: ... Sign in to confirm you’re not a bot` và bot báo "YouTube đang chặn máy chủ của bot". Cách duy nhất không đổi máy: cho `yt-dlp` cookie của một tài khoản Google.
1. **Dùng tài khoản Google riêng, bỏ đi được** (không dùng tài khoản chính: YouTube có thể khoá tài khoản bị dùng cho bot).
2. Xuất cookie đúng cách (theo wiki của yt-dlp, "Exporting YouTube cookies"): mở **cửa sổ ẩn danh**, đăng nhập tài khoản đó, vào `https://www.youtube.com/robots.txt` (cùng cửa sổ), dùng tiện ích xuất `cookies.txt` (định dạng Netscape, ví dụ "Get cookies.txt LOCALLY") chỉ cho youtube.com, rồi **đóng cửa sổ ẩn danh** để YouTube không xoay cookie.
3. Trên Render (service `loop-music-bot`): **Environment → Secret Files → Add**, tên `cookies.txt`, dán nội dung; thêm biến `YTDLP_COOKIES` = `/etc/secrets/cookies.txt`; deploy lại. Bot sao chép file ra thư mục tạm (Secret File chỉ đọc, còn yt-dlp ghi lại cookie khi thoát).
4. Giới hạn: cookie hết hạn hoặc bị xoay sau một thời gian (phải xuất lại), YouTube có thể vẫn chặn IP data centre dù có cookie, và việc dùng tài khoản cho bot có thể vi phạm điều khoản của Google. **Chưa kiểm được trên Render thật** (máy tôi không bị chặn). Chạy bot trên máy ở nhà/IP dân cư thì thường không cần cookie.

**Giới hạn đã đo (2026-10-15, Docker ép `--cpus=0.1 --memory=512m`, linux/amd64 giả lập trên Mac):** `yt-dlp` mất ~38 s chỉ để khởi động và ~180 s cho một lần tìm bài đầy đủ (1 CPU: 8 s). Giới hạn chờ cũ 30 s làm tiến trình bị kill và log `[music] yt-dlp:` rỗng. Giờ chờ tối đa 5 phút, báo "Đang tìm bài..." sau 4 s và ghi mã thoát/tín hiệu vào log; nhưng trên gói free một `!play` vẫn có thể mất vài phút (số đo bị giả lập làm chậm thêm, máy Render thật có thể nhanh hơn). Muốn phát nhạc mượt cần máy có ít nhất ~0,5 CPU (gói trả phí hoặc máy khác).

**Nguồn nhạc, bộ nhớ đệm, chuẩn bị bài kế (2026-10-15):**
- `!play <tên>` tìm YouTube trước; nếu `yt-dlp` báo bị chặn (bot check, 403/429, rate-limit) bot nhắn "YouTube chặn máy chủ, đang thử SoundCloud..." rồi tìm bằng `scsearch1:` và ghi `(SoundCloud)` cạnh tên bài. `!play sc <tên>` chỉ tìm SoundCloud; link SoundCloud hoặc link http(s) công khai khác (không phải IP/tên nội bộ) được đưa nguyên cho `yt-dlp`. Video không khả dụng hoặc quá chậm thì KHÔNG chuyển nguồn.
- Mỗi bài chỉ tốn MỘT lần chạy `yt-dlp` (tên + link luồng cùng lúc); phát bằng `ffmpeg` đọc thẳng link luồng (có header của `yt-dlp`), không chạy `yt-dlp` lần hai. Link luồng quá 20 phút hoặc `ffmpeg` không đọc được thì tự quay về cách cũ `yt-dlp | ffmpeg`. Kết quả tìm được nhớ 6 giờ (100 mục, không nhớ link luồng); khi bài đang phát, bot chuẩn bị bài kế (một việc nền một lúc, huỷ khi `!stop`).
- Biến môi trường (đều tuỳ chọn, đặt ở *Environment* của service): `MUSIC_SOURCES` (mặc định `youtube,soundcloud`; `soundcloud,youtube` đổi thứ tự; `soundcloud` tắt YouTube, nên dùng khi YouTube luôn chặn để khỏi tốn một lượt chạy), `YTDLP_COOKIES` (đường dẫn secret file, xem trên), `YTDLP_YT_CLIENT` (client YouTube của yt-dlp, vd `android_vr`; chưa kiểm tác dụng chống chặn).
- **Cập nhật bot**: đẩy commit lên GitHub; nếu service đang để *Auto-Deploy: On Commit* Render tự build lại. Nếu để *Off*: *Manual Deploy → Deploy latest commit*. Cookie/secret file và biến môi trường giữ nguyên qua các lần deploy (chỉ cần sửa khi cookie hết hạn: thay nội dung Secret File rồi deploy lại).

**Số đo cục bộ (Docker Mac, `linux/amd64` giả lập, 2026-10-15; thời gian dao động theo tải máy, đo một lần mỗi ô):**

| | binary PyInstaller (đang dùng) | pip trong venv + `compileall` |
|---|---|---|
| `--version`, `--cpus=0.1`, container mới | 20 s, 23 s | 6 s, 12 s |
| `--version` lần 2 trong cùng container | 30 s (lần 1: 30 s) | 13 s (lần 1: 14 s) |
| `scsearch1:` đầy đủ (`--print`, 0,1 CPU) | 20 s | 13 s |
| `ytsearch1:` đầy đủ (`--print`, 0,1 CPU) | 23 s | 17 s |
| CPU đầy: `scsearch1:` / `ytsearch1:` | 2-4 s / 3-5 s | |
| Có 2 s PCM đầu tiên (CPU đầy), `open()` thật, link luồng có sẵn | SoundCloud (m3u8) 1,1 s; YouTube 0,3 s | |
| Như trên nhưng qua `yt-dlp \| ffmpeg` (cách cũ) | SoundCloud 2,5 s; YouTube 6,1 s | |

Kết luận đo được: bản pip khởi động nhanh hơn ~1,5-3 lần; link luồng bỏ được lần chạy `yt-dlp` thứ hai (2,5-6 s ở CPU đầy, và ở 0,1 CPU là toàn bộ 20+ s khởi động); các client YouTube (`android_vr`, `tv`, `web_safari`, mặc định) không khác tốc độ (2,4-2,9 s), `tv`/`web_safari` còn lỗi khi không có cookie. Chạy `--version` lần hai không nhanh hơn lần đầu nên bot không có bước "khởi động trước". Số 180 s đo trước đó không tái hiện lại ở lần đo này (20-23 s); chưa rõ nguyên nhân (tải máy lúc đo, hay khác biệt giữa lần chạy), nên đừng coi con số nào là của Render thật.

**Đã áp dụng trong `deploy/render-bot/Dockerfile`:** bản pip đã biên dịch sẵn thay cho binary, thêm `python3 python3-venv`:
```
RUN python3 -m venv /opt/ytdlp && /opt/ytdlp/bin/pip install --no-cache-dir "yt-dlp[default]" \
 && /opt/ytdlp/bin/python -m compileall -q /opt/ytdlp/lib >/dev/null \
 && ln -s /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp
```
(`[default]` kéo theo `yt-dlp-ejs` để giải thử thách JS của YouTube cùng `--js-runtimes node` trong `/etc/yt-dlp.conf`; image lớn thêm khoảng 100 MB; pip lấy bản mới nhất lúc build nên cần build lại khi YouTube đổi.) Chưa kiểm trên Render thật.

**Đã kiểm (Docker trên Mac, ép `linux/amd64` như Render):** image build; chạy user `node`; `yt-dlp` 2026.08.19 và `ffmpeg` 5.1 chạy được; `--js-runtimes node` được `yt-dlp` chấp nhận; `ytsearch1:` tìm ra video; ống `yt-dlp | ffmpeg` ra đúng 3 giây PCM 48k mono (287376 byte); cổng `PORT` trả 200 `ok`; mất server thì bot ghi log và thử lại; SIGTERM thoát (143).
**Chưa kiểm:** Render thật (Blueprint, workspace, build); YouTube có chặn IP của Render ("Sign in to confirm you're not a bot"; khi đó bot tự chuyển SoundCloud, cookie là tuỳ chọn) và SoundCloud có chặn IP Render hay không — thử trên máy nhà chỉ chứng minh IP nhà; tốc độ thật trên 0,1 CPU của Render sau tối ưu (chỉ đo giả lập Docker); phát tiếng thật trong phòng LiveKit với server production; 0,1 CPU của gói free có đủ để phát không giật; ngưỡng "lưu lượng ra ngoài cao bất thường" mà Render có thể khoá; điều khoản Render về nhiều workspace.
