# Checklist Penerimaan Customer — Sotoayam 1.0.0

Isi setiap hasil dengan `PASS` atau `FAIL`. Catat bukti tanpa secret, credential, token, atau external Telegram ID. Semua item wajib `PASS` sebelum handoff dinyatakan diterima.

Customer: ____________________  Domain: ____________________  Release/Git SHA: ____________________

Tanggal: ____________________  Operator: ____________________  Customer approver: ____________________

| Area | Pemeriksaan | Hasil (PASS/FAIL) | Bukti/catatan aman |
|---|---|---|---|
| Instalasi | Arsip release resmi diekstrak dan metadata cocok |  |  |
| Instalasi | Environment production dikonfigurasi dan permission terbatas |  |  |
| Instalasi | Seluruh 25 migrasi diterapkan |  |  |
| Instalasi | `sotoayam.service` aktif |  |  |
| Instalasi | HTTPS/domain dapat diakses |  |  |
| Pertama kali | `/setup` selesai satu kali |  |  |
| Pertama kali | OWNER pertama dibuat dan dapat login |  |  |
| Pertama kali | Pengaturan bisnis dan business actor telah ditinjau |  |  |
| Telegram | Bot customer tersambung dan hanya satu poller aktif |  |  |
| Telegram | Akun customer berhasil dipasangkan |  |  |
| Telegram | Tujuh preferensi notifikasi telah ditinjau |  |  |
| Telegram | Tepat satu notifikasi uji diterima dan satu delivery tercatat |  |  |
| Tugas | Tugas uji dibuat dan detailnya dapat dibuka |  |  |
| Tugas | Tugas uji dapat diubah sesuai izin |  |  |
| Tugas | Status tugas dapat dipindahkan melalui transisi yang tersedia |  |  |
| Tugas | Tugas dapat dibatalkan oleh actor yang berwenang |  |  |
| Operasi | `GET /health` mengembalikan HTTP 200 |  |  |
| Operasi | `GET /ready` mengembalikan HTTP 200 dan `READY` |  |  |
| Operasi | `npm run backup:create` selesai dengan PASS |  |  |
| Operasi | `npm run backup:verify` selesai dengan PASS |  |  |
| Recovery | Prosedur restore ke target recovery bersih telah dipahami |  |  |
| Recovery | Lokasi backup terenkripsi, retensi, dan pemiliknya ditetapkan |  |  |

Keputusan akhir: `DITERIMA / BELUM DITERIMA`

Catatan: ______________________________________________________________________________

Konfirmasi operasional customer: ____________________  Tanggal: ____________________
