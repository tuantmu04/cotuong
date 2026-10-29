# Cờ Tướng Coach — tập chơi cờ tướng với AI hướng dẫn

Web chơi cờ tướng với máy, có **huấn luyện viên** bên phía bạn: gợi ý nước đi, giải thích vì sao nên đi, chấm điểm nước bạn vừa đi và giải thích ý đồ nước đi của máy.

- **Engine**: [Pikafish](https://github.com/official-pikafish/Pikafish), engine cờ tướng mã nguồn mở mạnh nhất, miễn phí (GPL-3.0). Nếu chưa cài Pikafish, trang tự dùng engine JS tích hợp sẵn.
- **AI giải thích**: Azure AI Foundry (tùy chọn), dùng để giải thích sâu hơn và hỏi đáp tự do.

## Cài đặt (khoảng 5 phút)

Cấu trúc thư mục sau khi cài:

```
cotuong/
├─ index.html
├─ server.js
├─ config.json        ← copy từ config.example.json (chỉ cần nếu dùng Foundry)
└─ pikafish/          ← giải nén bản release Pikafish vào đây
   ├─ pikafish.nnue
   └─ Windows/ Linux/ MacOS/ ... (các file chạy)
```

1. Cài **Node.js 18+**: https://nodejs.org
2. Tải Pikafish bản mới nhất ở https://github.com/official-pikafish/Pikafish/releases, rồi giải nén vào thư mục `pikafish/` như trên. File release là `.7z`; trên Windows dùng 7-Zip để giải nén.
   - Server tự tìm file chạy phù hợp với máy bạn (ưu tiên bản `avx2`; nếu CPU không hỗ trợ sẽ tự thử bản khác).
   - Nếu trong bộ giải nén không có `pikafish.nnue`, tải nó ở https://github.com/official-pikafish/Networks/releases (bản `master-net`) rồi bỏ vào `pikafish/`.
   - Trên macOS: nếu bị chặn, chạy `xattr -dr com.apple.quarantine pikafish` một lần.
3. Chạy server:
   ```bash
   node server.js
   ```

   Log hiện `✓ Pikafish: ...` là thành công. Mở **http://localhost:8080**.

Không có Node/Pikafish? Nhấp đúp `index.html` vẫn chơi được bằng engine JS (yếu hơn, nhưng vẫn đủ để tập).

## Đưa lên web cho bạn bè dùng

Xem **[DEPLOY.md](DEPLOY.md)**: hướng dẫn từng bước deploy lên Azure Container Apps (gần như miễn phí), đặt mật khẩu chung và gắn tên miền riêng.

## Gắn Azure AI Foundry

1. Vào https://ai.azure.com → project → **Models + endpoints** → chọn deployment (vd `gpt-4o-mini`, `gpt-4.1`, `DeepSeek-V3`...).
2. Copy **Target URI** và **Key**.
3. Có hai cách gắn:
   - **Khuyên dùng:** điền vào `config.json` (`url`, `key`, `model`), chạy lại `node server.js`. Trang sẽ tự dùng chế độ proxy, key không lộ ra trình duyệt và không bị lỗi CORS.
   - Hoặc trong trang bấm ⚙ → *Gọi trực tiếp*, dán URL + key.

Các dạng URL thường gặp:

| Loại                                        | URL                                                                                                           | Header      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------- |
| Azure OpenAI (deployment)                    | `https://<res>.openai.azure.com/openai/deployments/<dep>/chat/completions?api-version=2024-10-21`           | `api-key` |
| Azure OpenAI v1                              | `https://<res>.openai.azure.com/openai/v1/chat/completions` (điền model = tên deployment)                | `api-key` |
| Foundry Models (DeepSeek, Llama, Mistral...) | `https://<res>.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview` (điền model) | `api-key` |

## Tính năng

- Chọn engine (Pikafish / JS), 4 mức độ khó, cầm Đỏ hoặc Đen, chữ Hán hoặc chữ Việt trên quân.
  - Pikafish không có chế độ giảm sức. Ở mức *Dễ* và *Vừa*, máy tính nông hơn và chọn ngẫu nhiên trong vài nước gần tốt nhất. Ở *Khó* và *Rất khó*, máy đánh hết sức (1 giây / 3 giây mỗi nước).
- Huấn luyện viên:
  - Gợi ý nước tốt nhất (mũi tên + ký hiệu kiểu Việt Nam `P2-5`, `M8.7`...), kèm **2 phương án khác** và điểm từng phương án.
  - Giải thích bằng luật: ăn quân/đổi quân, chiếu, thoát chiếu, bảo vệ quân bị đe dọa, bắt đôi, nguyên tắc khai cuộc.
  - Sổ khai cuộc nhỏ (Pháo đầu, Bình phong Mã, Khởi Mã, Tiên nhân chỉ lộ, Phi Tượng).
  - Cảnh báo quân của bạn đang bị đe dọa.
  - Chấm điểm nước bạn vừa đi (Tuyệt / Tốt / Tạm được / Chưa chính xác / Sai lầm) và chỉ ra nước tốt hơn.
  - Giải thích ý đồ nước đi của máy, và diễn biến dự kiến vài nước tiếp theo.
- AI Foundry: giải thích sâu từng gợi ý, và chat hỏi tự do. AI nhận thế cờ cùng dữ liệu engine nên trả lời đúng ngữ cảnh.
- Đi lại, bày thế cờ bằng FEN để tập thế cờ tàn.

## Tùy chỉnh trong config.json

| Khóa               | Ý nghĩa                                                             |
| ------------------- | --------------------------------------------------------------------- |
| `pikafishPath`    | Đường dẫn file chạy Pikafish, nếu không muốn server tự tìm  |
| `pikafishNnue`    | Đường dẫn `pikafish.nnue`, nếu để chỗ khác                 |
| `password`        | Mật khẩu chung để vào trang (bỏ trống = không cần đăng nhập). Nên đặt khi đưa lên web |
| `chatLimitPerHour` | Số lần hỏi AI tối đa mỗi giờ cho mỗi IP (mặc định 60) |
| `pikafishInstances` | Số tiến trình Pikafish chạy song song (mỗi người chơi dùng 1 khi máy đang tính) |
| `pikafishThreads` | Số luồng CPU cho Pikafish (mặc định: số nhân − 1, tối đa 4) |
| `pikafishHash`    | Bộ nhớ bảng băm, tính bằng MB (mặc định 128)                 |

## Ghi chú

- Pikafish theo giấy phép GPL-3.0. Tự dùng thì thoải mái; nếu đóng gói phát hành kèm Pikafish thì phải tuân theo GPL.
- Engine JS tích hợp đơn giản hóa luật lặp nước: lặp 3 lần là hòa. Pikafish tự xử lý luật chiếu dai/bắt dai khi tính toán.
