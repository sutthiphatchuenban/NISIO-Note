# NISIO Note

แอปจดข้อความสำหรับ Windows ใช้ Bun + TypeScript และ `webview-bun` พร้อม UI แบบ vanilla JavaScript และ CodeMirror 6 สำหรับ editor แบบ virtualized ไม่ใช้ Electron, React หรือ web server

โครงการนี้เป็นโอเพนซอร์สภายใต้ [MIT License](LICENSE) ยินดีรับรายงานปัญหาและ pull request ดู [คู่มือการร่วมพัฒนา](CONTRIBUTING.md)

## เริ่มพัฒนา

ต้องมี Bun และ Microsoft Edge WebView2 Runtime ในเครื่อง

```sh
bun install
bun run dev
```

## สร้างแอป Windows

```sh
bun run build
```

เปิด `dist/NISIO Note.exe` ได้โดยไม่ต้องติดตั้ง Bun บนเครื่องปลายทาง แต่ยังต้องมี WebView2 Runtime แอปไม่ได้รวม Chromium ไว้เอง อย่างไรก็ตาม executable มี Bun runtime อยู่ด้วย จึงไม่ควรตีความว่าเล็กเท่าแอป native Notepad และยังไม่ได้ benchmark RAM หรือเวลาเปิดแอป

## สร้าง Setup สำหรับแจก

```sh
bun run setup
```

ได้ไฟล์ **`dist/NISIO-Note-Setup-0.1.0-x64.exe`** (ชื่อเวอร์ชันอ้างอิง `package.json`) ส่งไฟล์นี้ไฟล์เดียวให้ผู้รับได้ รองรับ Windows 10 1809 ขึ้นไปและ Windows 11 แบบ x64

- เลือกโฟลเดอร์ติดตั้งได้ ค่าเริ่มต้นเป็นโฟลเดอร์ Programs ของผู้ใช้
- ติดตั้งเฉพาะผู้ใช้ปัจจุบันได้โดยไม่ต้องเป็น administrator หรือเลือกติดตั้งสำหรับทุกคนด้วยสิทธิ์ administrator
- สร้างทางลัด Start Menu และเลือกเพิ่มทางลัด Desktop ได้
- มีตัวถอนการติดตั้งใน Windows Settings → Apps
- จำตำแหน่งติดตั้งเดิมเมื่อรัน Setup ซ้ำ
- รวม WebView2 Evergreen Standalone Installer ไว้ใน Setup ตรวจและติดตั้งเฉพาะเครื่องที่ยังไม่มี ไม่ต้องลง Bun และไม่ต้องดาวน์โหลด runtime เพิ่มระหว่างติดตั้ง ขนาด Setup ประมาณ 238 MiB
- หลังติดตั้งเลือกเปิดแอปได้ทันที หากส่วนประกอบของระบบต้องรีสตาร์ต Setup จะแจ้งให้ทราบ

ตำแหน่งที่เลือกใน Setup คือ **โฟลเดอร์โปรแกรม** ส่วนโน้ต/รูป/การตั้งค่ายังเก็บใน `%APPDATA%/NISIO Note` ตามเดิม การถอนการติดตั้งจะไม่ลบข้อมูลเหล่านี้หรือ WebView2 ที่แอปอื่นใช้ร่วมกัน

การ build ครั้งแรกต้องใช้อินเทอร์เน็ตเพื่อดาวน์โหลด Inno Setup compiler แบบ portable และ WebView2 จากแหล่งทางการไว้ใน `.tmp/installer-tools` มีการตรวจลายเซ็นผู้เผยแพร่ก่อนใช้ไฟล์ที่ดาวน์โหลด หากมี Inno Setup อยู่แล้วจะใช้ตัวที่พบ หรือกำหนด `ISCC_PATH` ไปยัง `ISCC.exe` ได้

### ทดสอบตัวติดตั้ง

```sh
bun run test:installer
```

สร้าง installer ทดสอบด้วย AppId/ชื่อทางลัดแยกจากแอปจริง ติดตั้งเงียบลงโฟลเดอร์ทดสอบชื่อภาษาไทย ตรวจ binary/ทางลัด/รายการถอนการติดตั้ง เปิด smoke test จากแอปที่ติดตั้ง ติดตั้งซ้ำ แล้วถอนและตรวจว่าโน้ตยังอยู่ เก็บ log ใน `.tmp/installer-smoke-*` เครื่องที่ใช้ตรวจรอบนี้มี WebView2 อยู่แล้ว จึงทดสอบเส้นทางข้าม runtime installer ส่วนเส้นทางลง runtime ใหม่ควรตรวจเพิ่มใน Windows VM ที่ไม่มี WebView2

## ฟีเจอร์

- เปิด/บันทึกข้อความ UTF-8 สูงสุด 20 MB พร้อม LF/CRLF และ UTF-8 BOM
- Editor วาดเฉพาะบรรทัดใกล้ viewport พร้อม scrollbar แนวตั้ง/แนวนอนที่เห็นชัด และดัชนีบรรทัดแบบ tree สำหรับเอกสารหลายหมื่นบรรทัด
- Save (Ctrl+S) สำหรับโน้ตใหม่สร้างไฟล์ชื่อไม่ซ้ำใน `%APPDATA%/NISIO Note/Notes` โดยไม่ถามตำแหน่ง; กดซ้ำบันทึกไฟล์เดิม
- Save as (Ctrl+Shift+S) เปิด file picker เพื่อเลือกชื่อและตำแหน่งอื่น หลังจากนั้น Save จะบันทึกที่ตำแหน่งใหม่
- Find/replace, regex, go to line และปรับขนาดตัวอักษร
- ธีมสว่าง/มืด/ตามระบบ, sidebar และ Markdown preview แบบพื้นฐาน
- ฟอนต์เริ่มต้นเป็น **Consolas** ขนาด 15px (ใกล้เคียง 11pt ของ Windows Notepad) เปลี่ยนได้ใน View → Font settings…
- Recent files, command palette และ file picker ภายในแอป
- หลังติดตั้ง เลือก NISIO Note จาก Windows Open with สำหรับ `.txt`, `.md`, `.log`, `.json`, `.csv`, `.ini`, `.yaml` และ `.yml` ได้ โดยไม่เปลี่ยนแอปเริ่มต้น
- ลากไฟล์ข้อความเข้าแอปแล้วเลือกไฟล์ต้นฉบับในหน้าต่าง Open เพื่อบันทึกกลับไฟล์เดิมได้: WebView2 ยังไม่ส่ง path ของไฟล์ที่ลากให้ UI โดยตรง จึงต้องเลือกยืนยันตำแหน่ง ส่วนรูปที่ลากยังใช้แนบในโน้ต
- วางหรือลากรูปภาพ (Ctrl+V) เพื่อแนบรูปในโน้ต เก็บเป็น PNG ขนาดไม่เกิน 10 MB ใน `%APPDATA%/NISIO Note/Attachments` และแสดงใน Markdown preview
- Autosave สำหรับไฟล์ที่เคยบันทึกแล้ว (เปิดเป็นค่าเริ่มต้น ปิดได้ใน View)
- Recovery snapshot สูงสุด 1,500,000 ตัวอักษร เขียนหลังหยุดพิมพ์ประมาณ 700 ms ไม่ใช่การรับประกันว่าข้อมูลทั้งหมดจะรอดจากการปิดกะทันหัน

ไฟล์ต้องเป็น UTF-8; ยังไม่รองรับการตรวจ encoding แบบ legacy หรือ UTF-16 อย่าใช้แก้ไขไฟล์ encoding อื่นโดยไม่มีสำเนาสำรอง

รูปที่แนบจะอ้างอิง `nisio-asset:` ไปยังโฟลเดอร์ Attachments ของแอป จึงไม่ถูกคัดลอกตามเมื่อใช้ Save as ไปยังที่อื่น และการย้ายโฟลเดอร์ข้อมูลอาจทำให้รูปในโน้ตหายได้ ข้อความ Markdown ยังเปิดได้ในโปรแกรมอื่น แต่รูปจะแสดงเฉพาะใน NISIO Note

## คีย์ลัด

| คำสั่ง | คีย์ลัด |
| --- | --- |
| New / Open / Save | Ctrl+N / Ctrl+O / Ctrl+S |
| Save as | Ctrl+Shift+S |
| Quick open / Command palette | Ctrl+P / Ctrl+Shift+P |
| Find / Replace / Go to line | Ctrl+F / Ctrl+H / Ctrl+G |
| Markdown preview | Ctrl+Shift+V |
| Word wrap | Alt+Z |
| Sidebar | Ctrl+B |
| ธีม | Ctrl+Shift+D |
| คีย์ลัดทั้งหมด | F1 |

## ตรวจสอบ

```sh
bun run typecheck
bun run test
bun run test:shell
bun run smoke
bun run benchmark
bun run build
```

Smoke test เปิดหน้าต่างจริงแล้วปิดเอง ตรวจการเชื่อมต่อ Bun/WebView, DOM, CSS และ Markdown เบื้องต้น ไม่ใช่การทดสอบทุกฟีเจอร์

รวมเคสเปิด 12,000 บรรทัดและวางข้อความ 100,000 บรรทัด ตรวจ viewport rendering, scrollbar, แก้ไข/undo/redo, word wrap และการเลือกข้อความ โดยรายงานเวลา transaction (ไม่ใช่ keypress-to-paint) ในผล smoke ด้วย

Regression test ตรวจความถูกต้องของไฟล์ UTF-8, BOM/CRLF, การบันทึกเกินขนาด, ไฟล์ที่ถูกแก้จากภายนอก และ recovery ส่วน benchmark วัดการอ่าน/เขียนไฟล์และการ serialize ผล Save แบบสังเคราะห์ รายละเอียดผลวัดและแนวทางปรับต่ออยู่ที่ [PERFORMANCE.md](PERFORMANCE.md)

`test:shell` ใช้ Windows Explorer จริง ตรวจว่าหน้าต่างแสดงและเลือกไฟล์ชื่อภาษาไทย/ช่องว่าง/คอมมาได้ แล้วปิดหน้าต่างของ fixture ทดสอบ สามารถตรวจ binding ใน executable เพิ่มด้วย `"dist/NISIO Note.exe" --smoke --shell-smoke --data-dir .tmp/compiled-shell-smoke`

ข้อมูลการตั้งค่า recent files และ recovery อยู่ที่ `%APPDATA%/NISIO Note` ใช้ `--data-dir` หรือ `NISIO_DATA_DIR` เพื่อแยกข้อมูลทดสอบ ข้อความใน snapshot เป็น plain text บนดิสก์

## โครงสร้าง

- `src/main.ts`: หน้าต่าง desktop และ renderer bindings
- `src/files.ts`: การอ่าน/เขียนไฟล์และเรียก file manager
- `src/store.ts`: settings, recents และ recovery
- `src/ui/`: UI ไม่ใช้ framework หรือ CDN
- `src/ui/editor.js`: CodeMirror adapter สำหรับ document tree, selection, undo และ viewport rendering
- `scripts/make-icon.ts`: สร้างไอคอนโดยไม่เพิ่ม dependency
- `installer/NISIO-Note.iss`: ตัวติดตั้ง Inno Setup พร้อมตรวจ WebView2
- `scripts/build-installer.ts`: เตรียม compiler/runtime และสร้าง Setup
- `scripts/installer-smoke.ts`: ทดสอบติดตั้ง ติดตั้งซ้ำ เปิดแอป และถอนการติดตั้ง

คำสั่ง dev/start/smoke/build จะ bundle renderer ให้อัตโนมัติ หากเรียก `bun src/main.ts` โดยตรง ให้รัน `bun run ui` ก่อนเพื่อสร้าง `src/ui/app.bundle.js`

แอปไม่มี telemetry หรือการโหลด resource จากเครือข่าย ลิงก์ HTTP/HTTPS ใน preview เปิดผ่านแอปภายนอกเมื่อผู้ใช้คลิก

## License

ซอร์สโค้ดของ NISIO Note เผยแพร่ภายใต้ [MIT License](LICENSE) ส่วน dependencies และเครื่องมือภายนอก รวมถึง Bun, CodeMirror, webview-bun, Inno Setup และ WebView2 มี license และเงื่อนไขของแต่ละโครงการ
