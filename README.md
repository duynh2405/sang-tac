# 🎹 Hát ra nhạc

Hát vài câu, app tự tạo **giai điệu**, **hợp âm piano tay trái** và **sheet nhạc piano kèm lời tiếng Việt**.
Miễn phí, mã nguồn mở, chạy hoàn toàn trên trình duyệt: giọng hát của bạn không bị gửi đi đâu.

**Dùng thử:** https://duynh2405.github.io/sang-tac/

## Làm được gì

1. **Hát vào micro** theo máy đếm nhịp (hoặc tải file ghi âm lên).
2. App nhận **cao độ và nhịp** của từng nốt, tự nhận **giọng** (Đô trưởng, La thứ...).
3. Tự **hòa âm**: gán hợp âm cho từng ô nhịp, tạo phần đệm tay trái (bass – hợp âm, rải ballad, ngân, valse).
4. **Nhận lời hát tiếng Việt** bằng AI Whisper chạy ngay trên máy, hoặc gõ lời. Mỗi chữ gán vào một nốt.
5. **Sửa mọi thứ**: kéo nốt đổi cao độ/thời điểm, kéo mép đổi độ dài, tách/gộp nốt, sửa lời, đổi hợp âm, đổi tông, hoàn tác.
6. **Gợi ý dấu thanh**: báo chỗ giai điệu đi ngược hướng dấu tiếng Việt (dễ bị nghe sai chữ khi hát).
7. **Tải về**: file MIDI (2 track: tay phải giai điệu, tay trái hợp âm), MusicXML (mở bằng MuseScore), in hoặc lưu PDF.

Bài hát được lưu ngay trên trình duyệt của bạn.

## Chạy trên máy

```bash
npm install
npm run dev      # mở http://localhost:5173
npm test         # chạy kiểm thử
npm run build    # bản build tĩnh trong thư mục dist/
```

## Công nghệ

- Dò cao độ: thuật toán YIN tự viết (TypeScript), chạy trên máy người dùng.
- Hòa âm: luật nhạc lý + thuật toán Viterbi trên các hợp âm trong giọng.
- Nhận lời: [Transformers.js](https://github.com/huggingface/transformers.js) với mô hình Whisper (WebGPU/WASM).
- Sheet nhạc: [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/) từ MusicXML.
- Âm thanh piano: [Tone.js](https://tonejs.github.io/) với bộ mẫu Salamander Grand Piano.

## Kế hoạch

- [ ] Bản Android (AAB) đóng gói bằng Capacitor
- [ ] Cài như app (PWA), dùng offline

## Giấy phép

MIT
