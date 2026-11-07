# Reliability and performance audit

ตรวจเมื่อ 7 พฤศจิกายน 2026 บน Windows, Bun 1.4.2

## สิ่งที่ปรับแล้ว

- เรียงคำสั่ง Save เป็นคิว เพื่อให้ Save ซ้อนของโน้ตใหม่ใช้ไฟล์เดียวกัน และละทิ้งผลตอบกลับของโน้ตที่เปลี่ยนไปแล้ว
- เมื่อมีการพิมพ์ระหว่าง Save จะยังแสดงสถานะ unsaved และการเลือก Save ก่อนออกจะไม่ทิ้งข้อความใหม่ที่ยังไม่บันทึก
- ตรวจ modification time ก่อนเขียนไฟล์เดิม ลดโอกาส autosave ทับการแก้ไขจากโปรแกรมอื่น ทั้งนี้การตรวจและ rename ไม่ใช่ transaction ร่วมกับโปรแกรมภายนอก
- ตรวจการเปลี่ยนไฟล์ด้วยเวลาแบบละเอียด แทนการมองข้ามความต่างที่น้อยกว่า 1 วินาที และตรวจเอกสารอีกครั้งหลังรอผลโหลด
- ปฏิเสธ UTF-8 ที่เสีย แทนการแทนไบต์ด้วยอักษร � แล้วเสี่ยงเขียนทับต้นฉบับ
- คง BOM ที่เป็นส่วนของเนื้อหา และตรวจขนาด UTF-8 หลังแปลง EOL/BOM ก่อนบันทึก เพื่อไม่สร้างไฟล์เกิน 20 MB ที่แอปเปิดเองไม่ได้
- แก้ F3/Shift+F3 ที่ข้ามผลค้นหาเมื่อเริ่มจาก caret และทดสอบการวนกลับต้น/ท้าย
- เคารพ sidebar ที่ตั้งค่าไว้ และแก้ absolute `--data-dir`/`NISIO_DATA_DIR`
- ล้าง recovery เก่าเมื่อเอกสารใหม่เกินขีดจำกัด snapshot เพื่อไม่กู้เอกสารเก่าที่ไม่ตรงกับงานล่าสุด
- ส่งกลับเฉพาะ metadata หลัง Save ไม่ส่งเนื้อหาไฟล์ซ้ำผ่าน WebView IPC
- ใช้ฟังก์ชันคำนวณความสูงบรรทัดเดียว ตัดฟังก์ชันชื่อซ้ำที่เรียก `getComputedStyle` ในทางเลื่อนเลขบรรทัด

## ผลวัดที่ทำซ้ำได้

```sh
bun run benchmark
```

ใช้ไฟล์ข้อความ ASCII มี newline ขนาด 1 MiB และ 10 MiB วอร์มอัปแยกก่อนวัด 15 รอบ ใช้โฟลเดอร์ชั่วคราวแล้วล้างทิ้ง การเปรียบเทียบจำลอง response รูปแบบเดิมและใหม่ด้วย `JSON.stringify` ใน process เดียวกัน ไม่ใช่การวัดเวลา Save ทั้งแอป

| ขนาดไฟล์ | Save response เดิม | Save response ใหม่ | serialize เดิม median | serialize ใหม่ median |
| --- | ---: | ---: | ---: | ---: |
| 1 MiB | 1,094,452 bytes | 273 bytes | 1.403 ms | 0.001 ms |
| 10 MiB | 10,941,950 bytes | 275 bytes | 13.676 ms | 0.001 ms |

response 10 MiB ลดขนาดมากกว่า 99.99% ใน fixture นี้ ตัวเลขไม่ได้หมายความว่าแอปทั้งตัวเร็วขึ้นในอัตราเดียวกัน และ fixture ใช้ recents ว่าง ขนาด response จริงขึ้นกับ path และ recents

หลังแก้ การเขียน 10 MiB: median 7.422 ms / p95 10.674 ms; การอ่านและตรวจข้อความ: median 8.345 ms / p95 11.932 ms ตัวเลขขึ้นกับเครื่อง ดิสก์ cache และ antivirus ไม่ใช่ cold-disk benchmark

## การตรวจสอบ

```sh
bun run typecheck
bun run test
bun run smoke
bun run build
```

- Regression tests: UTF-8 ที่เสีย, ภาษาไทย/emoji/BOM/CRLF, ป้องกันเขียนเกินขนาดและทับ external edit, absolute data directory และ stale recovery
- Smoke tests เปิด WebView จริง รวมการนำทางผลค้นหา Save ซ้อน และผล Save ที่กลับมาหลังเปลี่ยนโน้ต
- ผลตรวจรอบนี้: typecheck ผ่าน, regression 6/6 ผ่าน, smoke ทั้ง source และ compiled `.exe` ผ่าน, build ผ่าน
- ระหว่างปิด smoke ทั้งก่อนและหลังแก้ WebView2 มีข้อความ `Failed to unregister class Chrome_WidgetWin_0. Error = 1412` แม้ผลตรวจผ่านและ exit code เป็น 0 ยังไม่ได้แก้ข้อความจาก native runtime นี้

## ลำดับงานเพื่อเพิ่มประสิทธิภาพต่อ

1. **วัด end-to-end บนเครื่องเป้าหมาย**: cold/warm startup, เวลา keypress → paint (p50/p95), RAM รวมทุก WebView process, idle CPU และการเปิดไฟล์ 1/10/20 MB ใช้ Edge DevTools Performance/Memory และ Windows Performance Recorder
2. **ย้ายงานหนักออกจาก UI loop เมื่อ profiler ยืนยัน**: ค้นหาโน้ตยังอ่านไฟล์แบบ synchronous ส่วน regex find และ Markdown preview ยังทำบน renderer thread รูปแบบ regex ที่ซับซ้อนหรือเอกสารขนาดใหญ่อาจทำให้หน้าต่างค้าง ควรใช้ worker พร้อม cancellation/time budget และจำกัดงาน preview ก่อนเพิ่มขีดจำกัดไฟล์
3. **ลดงานต่อ keystroke สำหรับเอกสารใหญ่**: เปลี่ยนเป็น CodeMirror document tree และ viewport rendering แล้ว (รายละเอียดด้านล่าง) งาน preview/find/recovery ยังควรวัดต่อแยกจาก editor
4. **ขยายเคสตรวจความน่าเชื่อถือ**: disk full/permission denied, ปิดโปรเซสระหว่าง Save, IME ภาษาไทย, undo/redo, เอกสารพร้อมรูปจำนวนมาก และการเปลี่ยนเอกสารระหว่าง async operations อื่น

การตรวจครั้งนี้ลดบั๊กที่ระบุและมี regression coverage แต่ไม่สามารถรับประกันว่าไม่มีบั๊กทุกกรณี หรือสรุปว่า startup/RAM/typing latency เร็วขึ้นโดยยังไม่วัด

## แก้อาการหลายบรรทัดค้างและ scrollbar มองไม่เห็น

หลังรับรายงานจากหน้าต่างจริง เปลี่ยนจาก native textarea เป็น CodeMirror 6 โดย bundle รวมใน executable ไม่มี CDN:

- วาดเฉพาะบรรทัดใกล้ viewport แทนการให้ textarea จัดวางข้อความทั้งเอกสาร
- ใช้ document tree สำหรับจำนวนบรรทัด/หา offset ไม่ rebuild array ตำแหน่งบรรทัดทั้งไฟล์ทุกครั้งที่แก้ไข
- ไม่แปลง document เป็น string ทั้งไฟล์เพื่ออัปเดตชื่อโน้ตทุก keystroke ใช้บรรทัดแรกจาก tree โดยตรง และ cache string สำหรับงานบันทึก/ค้นหา
- กำหนด scroll container ชัดเจน พร้อม scrollbar 14px สีตัดกับพื้นหลัง ทั้งแนวตั้งและแนวนอน
- ย้าย selection, insertion, clipboard และ undo/redo ไปใช้ transaction ของ editor รวมถึง normalize CRLF จากคลิปบอร์ด

Smoke test เพิ่มเคสเปิด 12,000 บรรทัด, วาง clipboard 100,000 บรรทัด (มีภาษาไทย), เลื่อนไปท้าย/ต้น, ตรวจว่าบรรทัดที่ render น้อยกว่า 200, แก้ไข 20 ครั้ง, undo/redo, wrap, horizontal scroll, Enter/Tab และ replace selection

ผลวัด source WebView ในเครื่องนี้: fixture 12,000 บรรทัดก่อนเปลี่ยน editor ใช้ 178 ms หลังเปลี่ยนใช้ 18 ms; paste 100,000 บรรทัดใช้ 17 ms; edit transaction ของเอกสาร 100,000 บรรทัด p95 ประมาณ 1 ms (20 ครั้ง) เป็นเวลา synchronous JS/editor transaction ไม่ใช่เวลา keypress-to-paint หรือ input จริงจากระบบปฏิบัติการ ค่าขึ้นกับเครื่องและความยาวแต่ละบรรทัด

ยืนยัน compiled `.exe` หลัง build: smoke ผ่านทุกเคส รวมเอกสารใหญ่; fixture 12,000 บรรทัด 18 ms, paste 100,000 บรรทัด 15 ms, edit transaction p95 1 ms ส่วน typecheck และ regression 6/6 ผ่าน

## แก้ Show in Explorer ไม่แสดงหน้าต่าง

พบ Explorer windows ของโน้ตอยู่ใน Shell แต่ `Visible=false` โค้ดเดิมใช้ `Bun.spawn` พร้อม `windowsHide: true` แล้วถือว่าเปิดสำเร็จทันที เปลี่ยนเป็น native `SHOpenFolderAndSelectItems` สำหรับเลือกไฟล์ และ `ShellExecuteW` แบบ `SW_SHOWNORMAL` สำหรับโฟลเดอร์ พร้อมตรวจ Shell view ให้ `Visible=true` และเรียก restore/foreground เนื่องจาก Windows อาจนำหน้าต่างที่ซ่อนจากรุ่นเก่ากลับมาใช้

การค้นหา Shell view ใช้ Windows PowerShell COM bridge แบบ synchronous และส่ง path เป็น UTF-16 base64 เพื่อรองรับภาษาไทย/ช่องว่าง/คอมมา โดยเลือกหน้าต่างที่ตรงทั้งโฟลเดอร์และไฟล์ที่เลือก เมนู UI แสดง error หากไม่พบไฟล์หรือเปิด Explorer ไม่สำเร็จ

`bun run test:shell` ผ่านการตรวจหน้าต่างจริงและ selection ด้วย Shell.Application; regression เพิ่มเคส path หาย/ว่าง/null และ renderer smoke ตรวจว่าคลิกเมนูส่ง path ถูกต้องและ error แสดงบน UI

## แก้ไอคอน executable เบลอหลังติดตั้ง

ตรวจ PE resources ของ executable ที่ build ด้วย Bun 1.4.2 พบว่า group `IDI_MYICON`
ยังระบุภาพ 256×256 และอ้างถึง image ID 1 ซึ่งถูกแทนด้วยภาพ 16×16 ของแอปแล้ว
ส่วน group ID 0 มี byte length ของภาพ 128/256 ไม่ตรงกับ DIB ที่ฝังจริง
จึงเกิดการเลือก/ขยายภาพผิดแม้ `assets/icon.ico` มีภาพครบทุกขนาด การตรวจ hash
ของ installed exe กับ dist ยืนยันได้เพียงว่าเป็นไฟล์เดียวกัน ไม่ได้ยืนยันว่า icon resources ถูกต้อง

`bun run build` เรียก `scripts/windows-icons.ts` หลัง compile เพื่อสร้าง icon directory
ของทุก group ใหม่ด้วย Win32 resource API โดยจับคู่ image bytes กับต้นฉบับ ICO
และตรวจ width/height/bit depth/byte length/image ID ทุก entry ก่อนแทนที่ executable
ขั้นตอน packaging ตรวจทั้ง app และ setup; installer smoke ตรวจ binary หลังติดตั้งด้วย
การตรวจ executable แบบไม่แก้ไขทำได้ด้วย:

```sh
bun scripts/windows-icons.ts "dist/NISIO Note.exe" assets/icon.ico --check
```

อ้างอิงรูปแบบ `RT_GROUP_ICON`/`RT_ICON`:
[Microsoft: The format of icon resources](https://devblogs.microsoft.com/oldnewthing/20120720-00/?p=7083)
และ [Using Resources](https://learn.microsoft.com/en-us/windows/win32/menurc/using-resources)

## แหล่งอ้างอิงเพิ่มเติม

- [Microsoft: Performance best practices for WebView2 apps](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance) — ลด IPC/data copying, หลีกเลี่ยง layout thrashing และใช้ profiler วัด workload จริง
- [MDN: TextDecoder.fatal](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/fatal) — fatal mode ปฏิเสธข้อมูลผิด encoding แทนการแทนด้วย replacement character
- [Microsoft: SHOpenFolderAndSelectItems](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenfolderandselectitems) — เปิด Explorer และเลือกไฟล์ผ่าน Windows Shell
