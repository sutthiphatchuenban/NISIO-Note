# Contributing to NISIO Note

ขอบคุณที่สนใจร่วมพัฒนา! รายงานบั๊ก เสนอฟีเจอร์ ปรับเอกสาร และส่ง pull request ได้ทั้งภาษาไทยและภาษาอังกฤษ

## เริ่มต้น

1. ตรวจสอบ [issues](https://github.com/sutthiphatchuenban/NISIO-Note/issues) ก่อนสร้าง issue ใหม่ หากเป็นการเปลี่ยนแปลงขนาดใหญ่ ควรเปิด issue อธิบายแนวทางก่อน
2. Fork repository และสร้าง branch สำหรับงานของคุณ
3. ใช้ Windows x64, [Bun](https://bun.sh/) และ Microsoft Edge WebView2 Runtime จากนั้นรัน:

   ```sh
   bun install --frozen-lockfile
   bun run dev
   ```

   ดูวิธีสร้างแอปและตัวติดตั้งใน [README](README.md) คำสั่ง Setup ดาวน์โหลดเครื่องมือและ WebView2 จากผู้เผยแพร่โดยตรง; เครื่องมือและ dependencies มี license ของตนเอง
4. ตรวจสอบการเปลี่ยนแปลงตามความเหมาะสม:

   ```sh
   bun run typecheck
   bun run test
   bun run smoke
   ```

   `smoke` เปิดหน้าต่าง WebView จริงและเขียนข้อมูลทดสอบใน `.tmp/smoke-data` ส่วน `bun run test:shell` เปิด File Explorer และ `bun run test:installer` ติดตั้ง/ถอน **สำเนาทดสอบ** บนเครื่อง ดูรายละเอียดใน README
5. ส่ง pull request โดยระบุปัญหา วิธีแก้ และผลการทดสอบ พร้อมภาพหน้าจอเมื่อมีการเปลี่ยน UI หลีกเลี่ยงการใส่ไฟล์โน้ตจริง ข้อมูลส่วนตัว secrets และไฟล์ build ใน commit

## รายงานบั๊ก

โปรดระบุรุ่น Windows, รุ่น NISIO Note, ขั้นตอนที่ทำให้เกิดปัญหา, ผลที่คาดหวังและผลที่เกิดขึ้น หากแนบภาพหรือไฟล์ตัวอย่างให้ลบข้อมูลส่วนตัวก่อน

## License

เมื่อส่ง contribution คุณตกลงให้เผยแพร่ contribution ของคุณภายใต้ [MIT License](LICENSE) ของโปรเจกต์ และรับผิดชอบว่าเนื้อหาที่ส่งสามารถเผยแพร่ภายใต้ license นี้ได้
