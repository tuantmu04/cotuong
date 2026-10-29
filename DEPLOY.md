# Deploy Cờ Tướng Coach lên Azure Container Apps + tên miền riêng

Kết quả: bạn bè mở `https://cotuong.tenmiencuaban.com`, nhập mật khẩu chung rồi chơi được ngay với Pikafish và AI Foundry. Khi không ai dùng, container tự tắt nên gần như không tốn tiền.

```
Máy bạn ──git push──▶ GitHub ──(Actions tự build)──▶ ghcr.io (kho image miễn phí)
                                                         │
Bạn bè ──https──▶ tên miền ──▶ Azure Container Apps ◀────┘ (kéo image về chạy)
                                   └─ server.js + Pikafish ──▶ Azure AI Foundry
```

Thời gian: khoảng 30–45 phút cho lần đầu.

---

## 0. Chuẩn bị

- Tài khoản **GitHub** và tài khoản **Azure** có subscription (pay-as-you-go).
- Tên miền, và quyền sửa DNS ở nơi bạn mua (Mắt Bão, PA Việt Nam, Cloudflare, Namecheap...).
- **Đổi key Foundry trước tiên.** Nếu key từng nằm trong file bạn gửi đi hoặc đưa lên mạng, vào Foundry portal → deployment → **Regenerate key**, rồi dùng key mới ở các bước dưới.

---

## 1. Đưa code lên GitHub

Thư mục cần có:
```
cotuong/
├─ .github/workflows/docker.yml
├─ .dockerignore
├─ .gitignore          ← chặn config.json và thư mục pikafish/ (không đưa key lên GitHub)
├─ Dockerfile
├─ index.html
├─ server.js
├─ config.example.json
├─ README.md
└─ DEPLOY.md
```

1. Tạo repo mới trên GitHub, ví dụ `cotuong`. Để **Private** cũng được.
2. Mở terminal trong thư mục `cotuong` rồi chạy:
   ```bash
   git init
   git add .
   git status            # KIỂM TRA: không được có config.json và pikafish/ trong danh sách
   git commit -m "Cờ Tướng Coach"
   git branch -M main
   git remote add origin https://github.com/<user-github>/cotuong.git
   git push -u origin main
   ```
   (Không quen dòng lệnh thì dùng GitHub Desktop cũng được.)

## 2. GitHub tự build image

1. Vào repo → tab **Actions** → workflow **Build image** sẽ tự chạy. Lần đầu mất khoảng 5–10 phút vì phải build Pikafish.
2. Khi chạy xong (dấu ✓ xanh), image nằm ở `ghcr.io/<user-github>/cotuong`.
3. Cho Azure kéo được image: vào `https://github.com/<user-github>?tab=packages` → chọn **cotuong** → **Package settings** → **Change visibility** → **Public**.
   Image không chứa key hay mật khẩu (những thứ đó nằm trong Azure), nên để public là an toàn.
4. Ghi lại tag dạng `sha-xxxxxxx` hiện trong trang package. Lúc cập nhật về sau sẽ cần.

## 3. Tạo Container App (dùng Azure Cloud Shell)

Vào https://portal.azure.com → bấm biểu tượng **Cloud Shell** `>_` trên thanh trên cùng → chọn **Bash**.

Sửa các giá trị trong `< >` rồi dán **từng khối** vào Cloud Shell:

```bash
# ---- Thông số (sửa cho đúng) ----
RG=rg-cotuong
LOC=southeastasia                      # Singapore, gần Việt Nam nhất
ENV=cotuong-env
APP=cotuong
IMG=ghcr.io/<user-github>/cotuong:latest
APP_PASSWORD='<mat-khau-chung-cho-ban-be>'
FOUNDRY_URL='https://<ten-resource>.services.ai.azure.com/openai/v1/responses'
FOUNDRY_KEY='<key-moi-cua-foundry>'
FOUNDRY_MODEL='<ten-deployment>'
```

```bash
# ---- Cài/cập nhật công cụ và đăng ký dịch vụ (chỉ cần 1 lần) ----
az extension add --name containerapp --upgrade
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait
```

```bash
# ---- Tạo nhóm tài nguyên + môi trường (không lưu log để khỏi tốn tiền) ----
az group create -n $RG -l $LOC
az containerapp env create -n $ENV -g $RG -l $LOC --logs-destination none
```

```bash
# ---- Tạo app ----
az containerapp create -n $APP -g $RG --environment $ENV \
  --image $IMG \
  --ingress external --target-port 8080 \
  --cpu 0.5 --memory 1.0Gi \
  --min-replicas 0 --max-replicas 1 \
  --secrets app-password="$APP_PASSWORD" foundry-key="$FOUNDRY_KEY" \
  --env-vars APP_PASSWORD=secretref:app-password FOUNDRY_KEY=secretref:foundry-key \
             FOUNDRY_URL="$FOUNDRY_URL" FOUNDRY_MODEL="$FOUNDRY_MODEL" \
             PIKAFISH_INSTANCES=2 PIKAFISH_THREADS=1 PIKAFISH_HASH=64 CHAT_LIMIT_PER_HOUR=60

# Lấy địa chỉ web
az containerapp show -n $APP -g $RG --query properties.configuration.ingress.fqdn -o tsv
```

Mở `https://<địa-chỉ-vừa-in>`. Lần đầu chờ 10–30 giây để container khởi động, rồi trang đăng nhập hiện ra. Nhập mật khẩu là chơi được. Dòng dưới ô chọn Engine phải hiện **● Đang dùng Pikafish**.

Giải thích các tham số quan trọng:

| Tham số | Ý nghĩa |
|---|---|
| `--min-replicas 0` | Không ai dùng thì tắt hẳn → không tính tiền. **Đừng đổi thành 1** (chạy 24/7 sẽ mất phí) |
| `--max-replicas 1` | Chỉ 1 container. Đủ cho vài người chơi cùng lúc |
| `--cpu 0.5 --memory 1.0Gi` | Phần miễn phí mỗi tháng đủ cho khoảng 100 giờ chạy |
| `PIKAFISH_INSTANCES=2` | 2 người cùng bấm “máy nghĩ” một lúc thì không phải chờ nhau |
| `secrets` | Mật khẩu và key lưu dạng bí mật trong Azure, không nằm trong code hay image |

## 4. Gắn tên miền riêng

Nên dùng **subdomain**, ví dụ `cotuong.tenmiencuaban.com`. Gắn tên miền gốc (không có `cotuong.`) phức tạp hơn.

```bash
DOMAIN=cotuong.<tenmiencuaban.com>
az containerapp show -n $APP -g $RG --query properties.configuration.ingress.fqdn -o tsv      # (A) địa chỉ Azure
az containerapp show -n $APP -g $RG --query properties.customDomainVerificationId -o tsv     # (B) mã xác minh
```

Vào trang quản lý DNS của tên miền, thêm 2 bản ghi:

| Loại | Tên / Host | Giá trị |
|---|---|---|
| `CNAME` | `cotuong` | (A), ví dụ `cotuong.xxxx.southeastasia.azurecontainerapps.io` |
| `TXT` | `asuid.cotuong` | (B) |

> Dùng **Cloudflare**? Để bản ghi CNAME ở chế độ **DNS only** (đám mây xám), nếu không Azure không cấp được chứng chỉ.

Chờ DNS cập nhật (thường vài phút, có khi tới 1 giờ). Kiểm tra bằng `nslookup cotuong.<tenmien>`. Sau đó chạy:

```bash
az containerapp hostname add  -n $APP -g $RG --hostname $DOMAIN
az containerapp hostname bind -n $APP -g $RG --hostname $DOMAIN --environment $ENV --validation-method CNAME
```

Lệnh `bind` tự xin **chứng chỉ SSL miễn phí**, mất khoảng 5–20 phút. Xong thì `https://cotuong.<tenmien>` dùng được, gửi link + mật khẩu cho bạn bè là xong.

## 5. Đặt cảnh báo chi phí (nên làm)

Portal → **Cost Management + Billing** → **Budgets** → **Add**: đặt 2 USD/tháng, cảnh báo qua email ở mức 50% và 100%.
Phí gọi Foundry (token AI) cũng tính vào subscription. `CHAT_LIMIT_PER_HOUR` giúp chặn bị lạm dụng.

## 6. Cập nhật khi sửa code

1. Sửa code → `git add . && git commit -m "..." && git push`
2. Chờ Actions build xong, lấy tag mới `sha-xxxxxxx` trong trang package.
3. Trong Cloud Shell:
   ```bash
   az containerapp update -n cotuong -g rg-cotuong --image ghcr.io/<user-github>/cotuong:sha-xxxxxxx
   ```

Đổi mật khẩu hoặc key Foundry:
```bash
az containerapp secret set -n cotuong -g rg-cotuong --secrets app-password='<mat-khau-moi>'
az containerapp update -n cotuong -g rg-cotuong --revision-suffix pw$(date +%m%d%H%M)   # tạo bản chạy mới để nhận mật khẩu mới
```

## 7. Gỡ lỗi

- **Xem log trực tiếp:** `az containerapp logs show -n cotuong -g rg-cotuong --follow`
  Log khởi động bình thường sẽ có `✓ Pikafish: ...` và `🔒 Bật mật khẩu chung`.
- **Trang báo dùng “Engine JS” thay vì Pikafish:** xem log. Nếu thấy `Illegal instruction` thì máy chủ không hỗ trợ AVX2. Sửa `ARG PIKAFISH_ARCH=x86-64-sse41-popcnt` trong `Dockerfile`, push lại rồi update như bước 6.
- **AI báo lỗi 401/404:** kiểm tra `FOUNDRY_URL`, `FOUNDRY_MODEL` và key. URL kết thúc bằng `/responses` thì server tự dùng Responses API, còn lại dùng Chat Completions.
- **Không kéo được image** (`unauthorized`/`denied`): kiểm tra package trên GitHub đã để **Public** chưa (bước 2.3).
- **Mở trang thấy chậm lần đầu:** đó là container đang khởi động sau khi tắt. Các lần sau trong lúc có người dùng sẽ nhanh.

## Xóa toàn bộ (khi không dùng nữa)

```bash
az group delete -n rg-cotuong --yes
```
