# FlowKit Bridge — Hướng Dẫn Chạy

FlowKit là Python bridge chạy local ở port **8100**, cầu nối giữa app Electron và Google Flow để generate thumbnail 4K.

---

## 1. Cài đặt lần đầu

```bash
cd /Users/macbook/Documents/youtube-channel/flow-kit-tool/flowkit

# Tạo virtual environment
python3 -m venv venv

# Kích hoạt venv
source venv/bin/activate

# Cài dependencies
pip install -r requirements.txt
```

---

## 2. Chạy FlowKit thủ công

```bash
cd /Users/macbook/Documents/youtube-channel/flow-kit-tool/flowkit
source venv/bin/activate

export FLOW_PROJECT_ID="0989c87f-1a61-4e7e-8a03-1977ec3c1650"
export MEDIA_PROVIDER="flow"

python -m agent.main
```

> Server khởi động tại: `http://127.0.0.1:8100`

---

## 3. Khi bị lỗi port đã dùng (EADDRINUSE :8100)

```bash
# Kill process đang chiếm port 8100
lsof -ti :8100 | xargs kill -9

# Sau đó chạy lại agent
python -m agent.main
```

---

## 4. Chạy app chính (tự động start FlowKit)

```bash
cd /Users/macbook/Documents/Auto-edit/Auto-edit-capcut
npm run dev
```

App sẽ **tự động spawn** FlowKit bridge khi khởi động (mode `managed`).
Không cần chạy `python -m agent.main` thủ công trừ khi cần debug riêng.

---

## 5. Kiểm tra bridge đang chạy

```bash
curl http://127.0.0.1:8100/health
# → {"status":"ok","extension_connected":true,...}

curl http://127.0.0.1:8100/api/providers/status
# → {"default":"flow","providers":[{"name":"flow","available":true,...}]}
```

---

## 6. Yêu cầu để Thumbnail Generation hoạt động

| Điều kiện                            | Cách kiểm tra                            |
| ------------------------------------ | ---------------------------------------- |
| FlowKit bridge chạy ở port 8100      | `curl localhost:8100/health`             |
| Chrome extension đã kết nối          | `extension_connected: true` trong health |
| Tab Google Flow đang mở trong Chrome | Mở flow.google.com                       |
| Đã đăng nhập Google Flow             | Check UI: "Google Flow Signed In" ✅     |

---

## 7. Flow Project ID

Project ID được lưu vào settings của app.
Nếu cần set thủ công:

```bash
export FLOW_PROJECT_ID="<uuid-từ-url-của-project>"
```

Lấy UUID từ URL khi mở project trên flow.google.com:
`https://flow.google.com/projects/<UUID-ở-đây>/...`
